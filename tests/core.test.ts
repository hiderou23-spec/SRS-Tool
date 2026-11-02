import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase, saveSettings } from '../src/db/db';
import { decodeBytes, detectDelimiter, guessColumns, parseRows } from '../src/import/parse';
import { analyzeImport, commitImport, fileHashOf } from '../src/import/importer';
import { cleanEnglish, cleanText, normalizeKey } from '../src/import/clean';
import { schedule, newCardData, previewIntervals } from '../src/srs/scheduler';
import { DEFAULT_SETTINGS, type ImportMapping } from '../src/db/types';
import { answerCard, startOrResumeSession, undoLast, previewToday, excludeExpression, restoreExpression } from '../src/srs/session';
import { createBackup, restoreBackup, validateBackup, buildCsv } from '../src/lib/backup';
import { planQueue } from '../src/srs/queue';

let n = 0;
beforeEach(async () => {
  await db.close();
  useDatabase('test-' + n++);
  await db.open();
});

const CSV = `問題,答え,メモ
hammer out,"協議して合意する、詳細を詰める",
Flesh out,<b>肉付けする</b><br>具体化する,"memo, with comma"
push back,反対する,
push back,反対する,
Push back,延期する,
align on,,
,英語なし,
ＡＢＣ　test,テスト,
`;

async function importCsv(text: string, name = 'remindo.csv') {
  const bytes = new TextEncoder().encode(text);
  const decoded = decodeBytes(bytes);
  const delimiter = detectDelimiter(decoded.text);
  const rows = parseRows(decoded.text, delimiter);
  const g = guessColumns(rows);
  const mapping: ImportMapping = { hasHeader: g.hasHeader, delimiter, encoding: decoded.encoding, englishCol: g.englishCol, japaneseCol: g.japaneseCol, notesCols: [2] };
  const fh = await fileHashOf(bytes);
  const analysis = await analyzeImport(rows, mapping, fh);
  return { analysis, mapping, fh, commit: () => commitImport(analysis, mapping, name, fh) };
}

describe('cleaning', () => {
  it('strips html, entities, full-width', () => {
    expect(cleanText('<b>肉付け</b><br>具体化&amp;')).toBe('肉付け\n具体化&');
    expect(cleanEnglish('ＡＢＣ　test')).toBe('ABC test');
    expect(cleanEnglish('don’t')).toBe("don't");
    expect(normalizeKey('Push back on sth.')).toBe('push back on');
  });
});

describe('import', () => {
  it('parses, detects columns, reports stats', async () => {
    const { analysis } = await importCsv(CSV);
    const s = analysis.stats;
    expect(s.totalRows).toBe(8); // header excluded
    expect(s.failed).toBe(1); // ",英語なし" row
    expect(s.exactDuplicateRows).toBe(1); // second "push back,反対する"
    expect(s.missingMeaning).toBe(1); // align on
    expect(s.duplicateCandidates).toBe(2); // push back(反対) + Push back(延期)
    expect(s.imported).toBe(6);
  });

  it('is idempotent on re-import and keeps raw rows', async () => {
    const first = await importCsv(CSV);
    await first.commit();
    expect(await db.expressions.count()).toBe(6);
    expect(await db.cards.count()).toBe(12);
    const flesh = (await db.expressions.toArray()).find((e) => e.normalized === 'flesh out')!;
    expect(flesh.meaning).toBe('肉付けする\n具体化する');
    expect(flesh.notes).toBe('memo, with comma');
    const raw = await db.rawRows.get(`${flesh.source!.importId}:${flesh.source!.rowIndex}`);
    expect(raw!.cells[1]).toBe('<b>肉付けする</b><br>具体化する');

    const second = await importCsv(CSV);
    expect(second.analysis.fileAlreadyImported).toBe(true);
    expect(second.analysis.stats.imported).toBe(0);
    expect(second.analysis.stats.skippedAlreadyImported).toBe(7);
    await second.commit();
    expect(await db.expressions.count()).toBe(6);
    expect((await db.duplicates.toArray()).map((d) => d.id)).toEqual(['push back']);
  });

  it('handles TSV and Shift_JIS', async () => {
    const tsv = 'go over\t見直す\nbreak down\t分解する\n';
    expect(detectDelimiter(tsv)).toBe('\t');
    // "テスト" in Shift_JIS
    const sjis = new Uint8Array([0x61, 0x2c, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
    expect(decodeBytes(sjis)).toEqual({ text: 'a,テスト', encoding: 'shift_jis' });
  });
});

describe('FSRS', () => {
  it('schedules via ts-fsrs and grows intervals', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const s = { ...DEFAULT_SETTINGS, enableFuzz: false };
    let c = newCardData(now);
    c = schedule(s, c, 3, now); // Good → learning step
    expect(c.state).toBe(1);
    const t2 = new Date(c.due);
    c = schedule(s, c, 3, t2); // Good → review
    expect(c.state).toBe(2);
    const p = previewIntervals(s, c, new Date(c.due));
    expect(p[1]).toBeLessThan(p[2]);
    expect(p[2]).toBeLessThan(p[3]);
    expect(p[3]).toBeLessThan(p[4]);
  });

  it('higher desired retention → shorter intervals', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const base = schedule({ ...DEFAULT_SETTINGS, enableFuzz: false }, newCardData(now), 4, now);
    const i90 = previewIntervals({ ...DEFAULT_SETTINGS, desiredRetention: 0.9 }, base, new Date(base.due))[3];
    const i97 = previewIntervals({ ...DEFAULT_SETTINGS, desiredRetention: 0.97 }, base, new Date(base.due))[3];
    expect(i97).toBeLessThan(i90);
  });
});

describe('session', () => {
  it('excludes an expression from study without deleting anything, and can undo', async () => {
    await (await importCsv(CSV)).commit();
    const session = await startOrResumeSession();
    const cardId = session.queue[1];
    const exprId = (await db.cards.get(cardId))!.expressionId;
    const before = { exprs: await db.expressions.count(), cards: await db.cards.count() };

    const res = await excludeExpression(session.id, exprId);
    expect(res!.session.queue.some((id) => id.startsWith(exprId + ':'))).toBe(false);
    expect((await db.expressions.get(exprId))!.suspended).toBe(true);
    expect(await db.expressions.count()).toBe(before.exprs);
    expect(await db.cards.count()).toBe(before.cards);
    // A fresh plan no longer picks it.
    expect((await previewToday()).queue.some((id) => id.startsWith(exprId + ':'))).toBe(false);

    const restored = await restoreExpression(session.id, exprId, res!.prevQueue);
    expect(restored!.queue).toEqual(session.queue);
    expect((await db.expressions.get(exprId))!.suspended).toBe(false);
  });

  it('answers persist, undo restores, backup roundtrip', async () => {
    await (await importCsv(CSV)).commit();
    const session = await startOrResumeSession();
    expect(session.queue.length).toBeGreaterThan(0);
    const cardId = session.queue[0];
    const res = await answerCard(session.id, cardId, 3, 8000);
    expect(res.card.introducedAt).not.toBeNull();
    expect(res.card.fsrs.reps).toBe(1);
    expect(await db.logs.count()).toBe(1);

    // resume (simulated app reopen) returns same session
    const resumed = await startOrResumeSession();
    expect(resumed.id).toBe(session.id);

    await undoLast(session.id);
    expect(await db.logs.count()).toBe(0);
    expect((await db.cards.get(cardId))!.introducedAt).toBeNull();

    await answerCard(session.id, cardId, 4, 5000);
    const backup = JSON.parse(JSON.stringify(await createBackup()));
    expect(validateBackup(backup).ok).toBe(true);
    await db.expressions.clear();
    await db.cards.clear();
    await db.logs.clear();
    await restoreBackup(backup);
    expect(await db.expressions.count()).toBe(6);
    expect(await db.logs.count()).toBe(1);
    expect((await db.cards.get(cardId))!.fsrs.reps).toBe(1);
    expect(validateBackup({ format: 'x' }).ok).toBe(false);
    const csv = await buildCsv();
    expect(csv).toContain('hammer out');
  });

  it('suppresses new cards when backlog exceeds capacity', async () => {
    await (await importCsv(CSV)).commit();
    await saveSettings({ newPerDay: 10 });
    const cards = await db.cards.toArray();
    const exprs = new Map((await db.expressions.toArray()).map((e) => [e.id, e]));
    const past = new Date('2025-01-01T00:00:00Z');
    // make all recognition cards overdue reviews
    const reviewed = cards.map((c) => c.mode === 'recognition'
      ? { ...c, introducedAt: past.toISOString(), state: 2, due: past.toISOString(), fsrs: { ...c.fsrs, state: 2, due: past.toISOString(), stability: 3, last_review: '2024-12-29T00:00:00Z', scheduled_days: 3 } }
      : c);
    const plan = planQueue({ cards: reviewed, expressions: exprs, settings: { ...DEFAULT_SETTINGS }, now: new Date(), introducedToday: 0, secondsPerReview: 60, minutes: 5 });
    expect(plan.capacity).toBe(5);
    expect(plan.dueTotal).toBe(6);
    expect(plan.backlog).toBe(1);
    expect(plan.newInQueue).toBe(0);
    expect(plan.newSuppressed).toBe(true);
    const p = await previewToday();
    expect(p.newInQueue).toBeGreaterThan(0);
  });
});

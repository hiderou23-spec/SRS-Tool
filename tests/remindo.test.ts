import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase, saveSettings } from '../src/db/db';
import { decodeBytes, detectDelimiter, detectUnquoted, guessColumns, parseRows } from '../src/import/parse';
import { analyzeImport, commitImport } from '../src/import/importer';
import { applyAiAssessment, validateAiFile } from '../src/lib/aiAssessment';
import { planQueue } from '../src/srs/queue';
import { DEFAULT_SETTINGS } from '../src/db/types';

let n = 0;
beforeEach(async () => {
  await db.close();
  useDatabase('remindo-' + n++);
  await db.open();
});

// Synthetic sample mimicking reminDO's export quirks (no quoting at all).
const lines = [
  'reminDOは勉強したこと全て忘れなくします。<br>忘れない為に,',
  'Inane,Lacking sense, silly, empty',
  'vociferate,〔抗議〕～と大声で言う<br>・"Shut up," vociferated the old man.',
  '"deserted him" following his plea,放棄する',
  "Definition of: 'inadvertently' is: 'http://www.dictionary.com/browse/inadvertently'. Learn more,",
  'ペルー,',
  'Hammer out,',
  'Hammer out,協議して合意する',
];
for (let i = 0; i < 30; i++) lines.push(`word${i},意味${i}`);
const TEXT = lines.join('\n') + '\n';

async function load() {
  const d = decodeBytes(new TextEncoder().encode(TEXT));
  const delim = detectDelimiter(d.text);
  const quotes = !detectUnquoted(d.text, delim);
  const rows = parseRows(d.text, delim, quotes);
  const g = guessColumns(rows);
  const mapping = { hasHeader: false, delimiter: delim, encoding: d.encoding, englishCol: g.englishCol, japaneseCol: g.japaneseCol, notesCols: [], joinRestIntoMeaning: g.unquotedCommas || !quotes, quotes };
  return { quotes, rows, mapping, analysis: await analyzeImport(rows, mapping, 'h') };
}

describe('reminDO format', () => {
  it('treats each line as a record and rejoins commas in the answer', async () => {
    const { quotes, rows, analysis } = await load();
    expect(quotes).toBe(false);
    expect(rows.length).toBe(lines.length);
    const by = (t: string) => analysis.rows.find((r) => r.english === t)!;
    expect(by('Inane').meaning).toBe('Lacking sense, silly, empty');
    expect(by('vociferate').meaning).toContain('"Shut up," vociferated the old man.');
    expect(by('inadvertently')).toBeTruthy();
    const failed = analysis.rows.filter((r) => r.status === 'failed').map((r) => r.reason);
    expect(failed).toEqual(['英語表現ではありません（日本語が中心）', '英語表現ではありません（日本語が中心）']);
    expect(analysis.stats.duplicateCandidates).toBe(2); // Hammer out ×2 (empty vs filled meaning)
  });

  it('applies an AI assessment file without touching user values', async () => {
    const { analysis, mapping } = await load();
    await commitImport(analysis, mapping, 'remindo.txt', 'h');
    const e = (await db.expressions.toArray()).find((x) => x.normalized === 'word1')!;
    await db.expressions.update(e.id, { importance: 10 });
    const file = { format: 'english-mastery-ai-assessment', version: 1, model: 'test', items: [
      { key: 'hammer out', text: 'Hammer out', category: 'phrasal_verb', importance: 95 },
      { key: 'word1', text: 'word1', category: 'low_priority', importance: 5 },
      { key: 'nonexistent', text: 'x', category: 'daily', importance: 50 },
    ] };
    const v = validateAiFile(file);
    expect(v.ok).toBe(true);
    const r = await applyAiAssessment((v as { ok: true; file: never }).file);
    expect(r).toEqual({ items: 3, matchedExpressions: 3, unmatchedItems: 1, userOverridesKept: 1 });
    const after = await db.expressions.get(e.id);
    expect(after!.importance).toBe(10); // user value kept
    expect(after!.ai!.importance).toBe(5);
    expect(validateAiFile({ format: 'x' }).ok).toBe(false);

    // New cards are introduced by importance: Hammer out first.
    await saveSettings({ newPerDay: 2 });
    const plan = planQueue({
      cards: await db.cards.toArray(),
      expressions: new Map((await db.expressions.toArray()).map((x) => [x.id, x])),
      settings: { ...DEFAULT_SETTINGS, newPerDay: 2 }, now: new Date(), introducedToday: 0,
    });
    const firstExpr = await db.expressions.get(plan.queue[0].split(':')[0]);
    expect(firstExpr!.normalized).toBe('hammer out');
  });
});

describe('duplicate bulk merge', () => {
  it('merges non-destructively, keeping meaning from all members', async () => {
    const { analysis, mapping } = await load();
    await commitImport(analysis, mapping, 'remindo.txt', 'h');
    const { mergeAllPending } = await import('../src/lib/duplicates');
    const before = await db.expressions.count();
    expect(await mergeAllPending()).toBe(1);
    expect(await db.expressions.count()).toBe(before);
    const hammer = (await db.expressions.toArray()).filter((e) => e.normalized === 'hammer out');
    const active = hammer.filter((e) => !e.suspended);
    expect(active).toHaveLength(1);
    expect(active[0].meaning).toBe('協議して合意する');
    expect(hammer.find((e) => e.suspended)!.tags).toContain('merged');
  });
});

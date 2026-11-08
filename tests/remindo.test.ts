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
    expect(failed).toEqual(['reminDOアプリの説明文（学習データではありません）']);
    expect(by('ペルー').lang).toBe('ja');
    expect(analysis.stats.japaneseTerms).toBe(1);
    expect(analysis.stats.duplicateCandidates).toBe(2); // Hammer out ×2 (empty vs filled meaning)
  });

  it('applies an AI assessment file without touching user values', async () => {
    const { analysis, mapping } = await load();
    await commitImport(analysis, mapping, 'remindo.txt', 'h');
    const e = (await db.expressions.toArray()).find((x) => x.normalized === 'word1')!;
    await db.expressions.update(e.id, { importance: 10 });
    const file = { format: 'english-mastery-ai-assessment', version: 1, model: 'test', items: [
      { key: 'hammer out', text: 'Hammer out', category: 'phrasal_verb', importance: 95, examples: [{ kind: 'business', en: 'We need to hammer out the details.', ja: '詳細を詰める必要がある。' }] },
      { key: 'word1', text: 'word1', category: 'low_priority', importance: 5 },
      { key: 'nonexistent', text: 'x', category: 'daily', importance: 50 },
      { key: 'ペルー', text: 'ペルー', category: 'daily', importance: 99, meaning: '南米の国\nEnglish: Peru' },
    ] };
    const v = validateAiFile(file);
    expect(v.ok).toBe(true);
    const r = await applyAiAssessment((v as { ok: true; file: never }).file);
    expect(r).toEqual({ items: 4, matchedExpressions: 4, unmatchedItems: 1, userOverridesKept: 1, examplesAdded: 2, pronunciationsAdded: 0 });
    const hammers = (await db.expressions.toArray()).filter((x) => x.normalized === 'hammer out');
    expect(hammers[0].examples[0]).toMatchObject({ origin: 'ai', status: 'unverified', kind: 'business' });
    const again = await applyAiAssessment((v as { ok: true; file: never }).file);
    expect(again.examplesAdded).toBe(0); // idempotent: never duplicates or overwrites
    // A later file can attach a pronunciation guide to an existing example.
    const withPron = { ...file, items: [{ ...file.items[0], examples: [{ kind: 'business', en: 'We need to hammer out the details.', ja: 'x', pronunciation: { level1: { ipa: '/x/' }, level2: { text: 'We nee-tuh hamme-rout' } } }] }] };
    const r3 = await applyAiAssessment((validateAiFile(withPron) as { ok: true; file: never }).file);
    expect(r3.pronunciationsAdded).toBe(2);
    const h = (await db.expressions.toArray()).find((x) => x.normalized === 'hammer out')!;
    expect(h.examples[0].pronunciation).toMatchObject({ origin: 'ai', status: 'needs_review', level2: { text: 'We nee-tuh hamme-rout' } });
    const r4 = await applyAiAssessment((validateAiFile(withPron) as { ok: true; file: never }).file);
    expect(r4.pronunciationsAdded).toBe(0);
    const peru = (await db.expressions.toArray()).find((x) => x.normalized === 'ペルー')!;
    expect(peru.ai!.meaning).toContain('Peru');
    expect(peru.meaning).toBe(''); // AI meaning never overwrites the user's field
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
    expect(firstExpr!.normalized).toBe('ペルー'); // importance 99
    // Japanese terms never get a Speaking card in the queue
    const unlocked = (await db.cards.toArray()).map((c) => c.id === `${peru.id}:recognition` ? { ...c, introducedAt: '2025-01-01', state: 2, fsrs: { ...c.fsrs, state: 2, stability: 30, last_review: '2025-01-01T00:00:00Z' } } : c);
    const plan2 = planQueue({ cards: unlocked, expressions: new Map((await db.expressions.toArray()).map((x) => [x.id, x])), settings: { ...DEFAULT_SETTINGS, newPerDay: 50 }, now: new Date(), introducedToday: 0, minutes: 30 });
    expect(plan2.queue).not.toContain(`${peru.id}:production`);
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

describe('AI data file that fills in examples', () => {
  it('fills up to 3 examples, adds missing guides, keeps everything already there', async () => {
    const { db: d } = await import('../src/db/db');
    const id = 'fill-1';
    const ts = '2026-01-01T00:00:00Z';
    await d.expressions.put({
      id, text: 'circulate', normalized: 'circulate', meaning: '', notes: '', kind: 'word', tags: [], suspended: false, usedInRealLife: [], createdAt: ts, updatedAt: ts,
      ai: { category: 'business', importance: 70, meaning: '回覧する', model: 'old', generatedAt: ts },
      examples: [{ id: 'mine', kind: 'business', en: 'We circulated the deck.', ja: '資料を回覧した。', origin: 'user', status: 'verified' }],
    });
    const file = { format: 'english-mastery-ai-assessment', version: 1, model: 'claude', items: [{
      key: 'circulate', text: 'circulate',
      examples: [
        { kind: 'business', en: 'We circulated the deck.', ja: 'x', pronunciation: { level1: { text: 'We circulated the deck.', ipa: '/wi/' } } },
        { kind: 'daily', en: 'Rumors circulate fast.', ja: '噂はすぐ広まる。', pronunciation: { level1: { text: 'Rumors circulate fast.' } } },
        { kind: 'alternative', en: 'Blood circulates.', ja: '血液が循環する。' },
        { kind: 'daily', en: 'One too many.', ja: '余分' },
      ],
    }] };
    const v = validateAiFile(file);
    expect(v.ok).toBe(true);
    const r = await applyAiAssessment((v as { ok: true; file: never }).file);
    expect(r).toMatchObject({ matchedExpressions: 1, examplesAdded: 1, pronunciationsAdded: 2 });
    const e = (await d.expressions.get(id))!;
    expect(e.examples.map((x) => [x.id === 'mine' ? 'mine' : x.origin, x.en])).toEqual([
      ['mine', 'We circulated the deck.'], ['ai', 'Rumors circulate fast.'], ['ai', 'Blood circulates.'],
    ]);
    expect(e.examples[0]).toMatchObject({ ja: '資料を回覧した。', status: 'verified' }); // own sentence untouched
    expect(e.examples[0].pronunciation).toMatchObject({ origin: 'ai', status: 'needs_review' });
    expect(e.examples[1].pronunciation).toBeTruthy();
    expect(e.ai).toMatchObject({ category: 'business', importance: 70, meaning: '回覧する', model: 'claude' }); // kept, not erased
    // Applying the same file again changes nothing.
    const again = await applyAiAssessment((v as { ok: true; file: never }).file);
    expect(again).toMatchObject({ examplesAdded: 0, pronunciationsAdded: 0 });
    expect((await d.expressions.get(id))!.examples).toHaveLength(3);
  });

  it('still rejects a wrong category or importance', () => {
    expect(validateAiFile({ format: 'english-mastery-ai-assessment', version: 1, items: [{ text: 'x', category: 'nope' }] }).ok).toBe(false);
    expect(validateAiFile({ format: 'english-mastery-ai-assessment', version: 1, items: [{ text: 'x', importance: 'high' }] }).ok).toBe(false);
  });
});

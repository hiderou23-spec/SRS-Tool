import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import {
  addBatch, addCaptured, applyCaptureAi, CAPTURED_IMPORTANCE, CAPTURE_TAG, findExisting, libraryKeys, pendingAiIds, planBatch, runsOf, selectionText, sentenceAround, toggleToken, tokenize, unstartedCount, type CaptureAi,
} from '../src/lib/capture';
import { addSampleDeck } from '../src/lib/sample';
import { startOrResumeSession } from '../src/srs/session';

const TEXT = "Thanks all. Can we table the discussion on pricing until we have the merchant data? I don't want to boil the ocean here, e.g. by redoing every model.";

describe('picking words from pasted text', () => {
  const tokens = tokenize(TEXT);
  it('splits on whitespace and keeps punctuation attached', () => {
    expect(tokenize('  a\n\tb  c. ')).toEqual(['a', 'b', 'c.']);
    expect(tokens[2]).toBe('Can');
  });
  it('tap toggles; neighbouring words form one expression; runs stop at a sentence end', () => {
    let sel = new Set<number>();
    for (const i of [4, 5, 6, 14]) sel = toggleToken(sel, i); // table the discussion … data?
    expect(runsOf(tokens, sel).map((r) => selectionText(tokens, r))).toEqual(['table the discussion', 'data']);
    sel = toggleToken(sel, 5); // un-tap "the"
    expect(runsOf(tokens, sel).map((r) => selectionText(tokens, r))).toEqual(['table', 'discussion', 'data']);
    // "data?" ends a sentence: "data? I" stays two items.
    expect(runsOf(tokens, new Set([14, 15])).map((r) => selectionText(tokens, r))).toEqual(['data', 'I']);
    expect(runsOf(tokens, new Set([99]))).toEqual([]);
  });
  it('plans a batch: new, already in the library, twice in the batch', () => {
    const t = tokenize('We should circulate it. Please circulate the memo and leverage the data.');
    const runs = runsOf(t, new Set([2, 5, 9]));
    const plan = planBatch(t, runs, new Set(['leverage']));
    expect(plan.map((p) => [p.text, p.status])).toEqual([['circulate', 'new'], ['circulate', 'dup'], ['leverage', 'exists']]);
    expect(plan[0].sentence).toBe('We should circulate it.');
    expect(plan[1].sentence).toBe('Please circulate the memo and leverage the data.');
  });
  it('strips punctuation and quotes around the selection only', () => {
    expect(selectionText(['"boil', 'the', 'ocean,"'], { a: 0, b: 2 })).toBe('boil the ocean');
    expect(selectionText(["don't"], { a: 0, b: 0 })).toBe("don't");
    expect(selectionText(tokens, null)).toBe('');
  });
  it('keeps only the sentence around the selection, not the whole paste', () => {
    expect(sentenceAround(tokens, { a: 4, b: 6 })).toBe('Can we table the discussion on pricing until we have the merchant data?');
    const boil = tokens.indexOf('boil');
    expect(sentenceAround(tokens, { a: boil, b: boil + 2 })).toBe("I don't want to boil the ocean here, e.g. by redoing every model.");
    expect(sentenceAround(['no', 'end', 'mark'], { a: 1, b: 1 })).toBe('no end mark');
  });
});

describe('adding a captured expression', () => {
  let n = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('capture-test-' + n++);
    await db.open();
  });

  const ai: CaptureAi = {
    baseForm: 'table the discussion', meaning: '議論を保留する', category: 'business', importance: 70,
    sentenceJa: '加盟店データが揃うまで価格の議論は保留にできますか？',
    examples: [
      { kind: 'daily', en: "Let's table this until Monday.", ja: '月曜まで保留にしよう。' },
      { kind: 'alternative', en: 'They tabled the motion.', ja: '彼らは動議を棚上げした。' },
      { kind: 'daily', en: 'Extra one.', ja: '余分' },
    ],
    model: 'test',
  };
  const sentence = 'Can we table the discussion on pricing until we have the merchant data?';

  it('with AI: found sentence first, then up to 2 AI examples; high importance; cards made', async () => {
    const id = await addCaptured({ text: 'table the discussion', sentence, keepSentence: true, ai });
    const e = (await db.expressions.get(id))!;
    expect(e).toMatchObject({ text: 'table the discussion', meaning: '', importance: CAPTURED_IMPORTANCE, tags: [CAPTURE_TAG], lang: 'en' });
    expect(e.ai).toMatchObject({ meaning: '議論を保留する', category: 'business', importance: 70 });
    expect(e.examples.map((x) => [x.origin, x.en])).toEqual([
      ['user', sentence],
      ['ai', "Let's table this until Monday."],
      ['ai', 'They tabled the motion.'],
    ]);
    expect(e.examples[0].ja).toBe(ai.sentenceJa);
    expect(await db.cards.where('expressionId').equals(id).count()).toBe(2);
  });

  it('manual: own meaning, the sentence as the only example, or none', async () => {
    const id = await addCaptured({ text: 'boil the ocean', sentence: 'x y z.', keepSentence: true, meaning: '手を広げすぎる' });
    const e = (await db.expressions.get(id))!;
    expect(e.meaning).toBe('手を広げすぎる');
    expect(e.examples).toHaveLength(1);
    expect(e.examples[0]).toMatchObject({ origin: 'user', status: 'verified', ja: '' });
    const id2 = await addCaptured({ text: 'circulate', sentence: 'x.', keepSentence: false });
    expect((await db.expressions.get(id2))!.examples).toEqual([]);
  });

  it('refuses duplicates and empty text', async () => {
    await addCaptured({ text: 'circulate', sentence: 'x.', keepSentence: false });
    expect((await findExisting('Circulate'))?.text).toBe('circulate');
    await expect(addCaptured({ text: 'CIRCULATE', sentence: 'x.', keepSentence: false })).rejects.toThrow('すでに');
    await expect(addCaptured({ text: '  ', sentence: 'x.', keepSentence: false })).rejects.toThrow();
  });

  it('is introduced before the rest of the unstarted pile', async () => {
    await addSampleDeck();
    const before = await unstartedCount();
    const id = await addCaptured({ text: 'circulate', sentence: 'x.', keepSentence: false });
    expect(await unstartedCount()).toBe(before + 1);
    const s = await startOrResumeSession(10);
    expect(s.queue[0]).toBe(`${id}:recognition`);
  });
});

describe('batch registration', () => {
  let k = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('capture-batch-' + k++);
    await db.open();
  });

  it('registers the new items now and leaves them pending for the AI', async () => {
    await addCaptured({ text: 'leverage', sentence: 'x.', keepSentence: false, meaning: '活用する' });
    const t = tokenize('We circulated it. Please leverage the data. They tabled the discussion.');
    const plan = planBatch(t, runsOf(t, new Set([1, 4, 8, 9, 10])), await libraryKeys());
    expect(plan.map((p) => p.status)).toEqual(['new', 'exists', 'new']);
    const ids = await addBatch(plan);
    expect(ids).toHaveLength(2);
    const e = (await db.expressions.get(ids[0]))!;
    expect(e).toMatchObject({ text: 'circulated', meaning: '', tags: [CAPTURE_TAG] });
    expect(e.examples).toEqual([expect.objectContaining({ en: 'We circulated it.', origin: 'user' })]);
    expect(await pendingAiIds()).toEqual(ids);
  });

  it('applies the AI: base form, meaning, sentence translation + guide, 2 more examples', async () => {
    const [id] = await addBatch([{ text: 'circulated', sentence: 'We circulated it.', status: 'new' }]);
    const ai: CaptureAi = {
      baseForm: 'circulate', meaning: '回覧する', category: 'business', importance: 70, sentenceJa: '回覧した。',
      examples: [{ kind: 'daily', en: 'Rumors circulate.', ja: '噂が広まる。' }, { kind: 'alternative', en: 'Blood circulates.', ja: '血液が循環する。' }],
      pronunciation: { level1: { text: 'We circulated it.' }, origin: 'ai', status: 'needs_review' }, model: 't',
    };
    expect(await applyCaptureAi(id, ai)).toEqual({ from: 'circulated', to: 'circulate' });
    const e = (await db.expressions.get(id))!;
    expect(e).toMatchObject({ text: 'circulate', normalized: 'circulate' });
    expect(e.ai?.meaning).toBe('回覧する');
    expect(e.examples.map((x) => x.origin)).toEqual(['user', 'ai', 'ai']);
    expect(e.examples[0]).toMatchObject({ ja: '回覧した。', status: 'unverified' });
    expect(e.examples[0].pronunciation?.level1.text).toBe('We circulated it.');
    expect(await pendingAiIds()).toEqual([]);
  });

  it('keeps the selected text when the base form is already another expression', async () => {
    await addCaptured({ text: 'circulate', sentence: 'x.', keepSentence: false });
    const [id] = await addBatch([{ text: 'circulated', sentence: 'We circulated it.', status: 'new' }]);
    const ai: CaptureAi = { baseForm: 'circulate', meaning: 'm', category: 'business', importance: 50, sentenceJa: '', examples: [], model: 't' };
    expect(await applyCaptureAi(id, ai)).toBeNull();
    expect((await db.expressions.get(id))!.text).toBe('circulated');
  });
});

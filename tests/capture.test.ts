import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import {
  addCaptured, CAPTURED_IMPORTANCE, CAPTURE_TAG, findExisting, nextSelection, selectionText, sentenceAround, tokenize, unstartedCount, type CaptureAi,
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
  it('tap selects, a second tap extends, a third starts over', () => {
    let sel = nextSelection(null, 4); // table
    expect(sel).toEqual({ a: 4, b: 4 });
    sel = nextSelection(sel, 6); // discussion
    expect(selectionText(tokens, sel)).toBe('table the discussion');
    expect(nextSelection(sel, 9)).toEqual({ a: 9, b: 9 });
    expect(nextSelection({ a: 4, b: 4 }, 4)).toBeNull();
    expect(nextSelection({ a: 6, b: 6 }, 4)).toEqual({ a: 4, b: 6 });
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

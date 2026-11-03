import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import type { Example } from '../src/db/types';
import { findExpression, hintSteps, maskWords } from '../src/srs/hint';
import { answerCard, startOrResumeSession } from '../src/srs/session';
import { addSampleDeck } from '../src/lib/sample';

const ex = (en: string): Example => ({ id: 'e', kind: 'business', en, ja: '詳細を詰める必要がある', origin: 'ai', status: 'unverified' });

describe('masking', () => {
  it('shows first letters, then about half, keeping spaces and punctuation', () => {
    expect(maskWords('hammer out', 1)).toBe('h_____ o__');
    expect(maskWords('hammer out', 2)).toBe('ham___ ou_');
    expect(maskWords("get one's ducks in a row", 1)).toBe("g__ o__'s d____ i_ a r__");
    expect(maskWords('buy-in', 2)).toBe('bu_-i_');
  });
  it('finds inflected forms in a sentence', () => {
    const s = 'We hammered out the details yesterday.';
    const m = findExpression(s, 'hammer out')!;
    expect(s.slice(m.index, m.index + m.length)).toBe('hammered out');
    expect(findExpression('Nothing here.', 'hammer out')).toBeNull();
  });
});

describe('hint steps', () => {
  it('Speaking: two masks, plus the masked sentence in sentence mode', () => {
    const steps = hintSteps({ isProd: true, exprText: 'hammer out', example: ex('We need to hammer out the details.'), sentenceMode: true });
    expect(steps.map((s) => s.kind)).toEqual(['mask', 'mask', 'sentence-mask']);
    expect(steps[2]).toEqual({ kind: 'sentence-mask', before: 'We need to ', masked: 'ham___ ou_', after: ' the details.' });
    // The answer itself never appears in a hint.
    expect(JSON.stringify(steps)).not.toContain('hammer out');
  });
  it('Speaking without an example: masks only', () => {
    expect(hintSteps({ isProd: true, exprText: 'push back', sentenceMode: false }).map((s) => s.kind)).toEqual(['mask', 'mask']);
  });
  it('Reading: the English example as context, or nothing', () => {
    expect(hintSteps({ isProd: false, exprText: 'push back', example: ex('They pushed back on the plan.'), sentenceMode: false })).toEqual([
      { kind: 'context', sentence: 'They pushed back on the plan.' },
    ]);
    expect(hintSteps({ isProd: false, exprText: 'push back', sentenceMode: false })).toEqual([]);
  });
});

describe('recording hint use', () => {
  let n = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('hint-test-' + n++);
    await db.open();
  });
  it('stores how many hint steps were shown', async () => {
    await addSampleDeck();
    const s = await startOrResumeSession(10);
    const res = await answerCard(s.id, s.queue[0], 2, 5000, new Date(), { hintsUsed: 2 });
    expect(res.log.hintsUsed).toBe(2);
    const res2 = await answerCard(s.id, res.session.queue[0], 3, 5000);
    expect(res2.log.hintsUsed).toBeUndefined();
  });
});

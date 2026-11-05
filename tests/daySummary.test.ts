import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import type { Expression, ReviewLogEntry } from '../src/db/types';
import { loadTodaySummary, setSuspended, summarizeDay } from '../src/srs/daySummary';
import { answerCard, startOrResumeSession } from '../src/srs/session';
import { addSampleDeck } from '../src/lib/sample';

const expr = (id: string): Expression => ({
  id, text: id, normalized: id, meaning: 'm', notes: '', kind: 'phrase', examples: [], tags: [],
  suspended: false, usedInRealLife: [], createdAt: '', updatedAt: '',
});
type L = Pick<ReviewLogEntry, 'expressionId' | 'mode' | 'rating' | 'hintsUsed' | 'wasIntroduction' | 'reviewedAt'>;
const log = (expressionId: string, rating: L['rating'], extra: Partial<L> = {}): L => ({
  expressionId, rating, mode: 'recognition', wasIntroduction: false, reviewedAt: '2026-11-05T01:00:00Z', ...extra,
});

describe('today summary', () => {
  const exprs = new Map(['ok', 'hard', 'hint', 'again', 'twice'].map((id) => [id, expr(id)]));

  it('orders hardest first and counts what needs review', () => {
    const s = summarizeDay(
      [
        log('ok', 3),
        log('hard', 2),
        log('hint', 3, { hintsUsed: 2 }),
        log('again', 1, { wasIntroduction: true }),
        log('again', 3, { mode: 'production' }),
        log('twice', 3), log('twice', 4),
        log('deleted', 1),
      ],
      exprs,
    );
    expect(s.items.map((i) => [i.expression.id, i.tier])).toEqual([
      ['again', 'again'], ['hint', 'hint'], ['hard', 'hard'], ['twice', 'ok'], ['ok', 'ok'],
    ]);
    expect(s.needsReview).toBe(3);
    const again = s.items[0];
    expect(again).toMatchObject({ isNew: true, answers: 2, modes: ['production', 'recognition'] });
  });

  it('is empty when nothing was studied', () => {
    expect(summarizeDay([], exprs)).toEqual({ items: [], needsReview: 0 });
  });
});

describe('loading today', () => {
  let n = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('day-test-' + n++);
    await db.open();
  });
  it("lists today's answers and can take one out of study", async () => {
    await addSampleDeck();
    const s = await startOrResumeSession(10);
    const first = s.queue[0];
    let res = await answerCard(s.id, first, 1, 5000);
    res = await answerCard(s.id, res.session.queue[0], 3, 5000);
    const sum = await loadTodaySummary();
    expect(sum.items).toHaveLength(2);
    expect(sum.items[0].tier).toBe('again');
    expect(sum.needsReview).toBe(1);
    const id = sum.items[0].expression.id;
    await setSuspended(id, true);
    expect((await db.expressions.get(id))!.suspended).toBe(true);
    await setSuspended(id, false);
    expect((await db.expressions.get(id))!.suspended).toBe(false);
  });
});

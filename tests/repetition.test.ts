import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import { DEFAULT_SETTINGS, type Expression, type ReviewCard } from '../src/db/types';
import { planQueue } from '../src/srs/queue';
import { answerCard, requeuePosition, startOrResumeSession } from '../src/srs/session';
import { newCardData } from '../src/srs/scheduler';

const NOW = new Date('2026-06-01T12:00:00Z');
const expr = (id: string): Expression => ({
  id, text: id, normalized: id, meaning: 'm', notes: '', kind: 'phrase', examples: [], tags: [],
  suspended: false, usedInRealLife: [], createdAt: '', updatedAt: '',
});
const reviewCard = (exprId: string, mode: ReviewCard['mode'], state = 2, dueMinAgo = 60 * 24): ReviewCard => {
  const due = new Date(NOW.getTime() - dueMinAgo * 60_000).toISOString();
  return {
    id: `${exprId}:${mode}`, expressionId: exprId, mode, introducedAt: '2026-05-01T00:00:00Z', due, state,
    fsrs: { ...newCardData(), due, state, stability: 10, difficulty: 5, reps: 3, scheduled_days: 10, last_review: '2026-05-20T00:00:00Z' },
  };
};

describe('learning-step re-show timing', () => {
  it('comes back about when FSRS asked, not 4 cards later', () => {
    expect(requeuePosition(10 * 60_000, 60, 15)).toBe(40); // 10-minute step at 15 s/card
    expect(requeuePosition(60_000, 60, 15)).toBe(4); // Again: 1 minute
    expect(requeuePosition(1_000, 60, 15)).toBe(3); // never right away
  });
  it('is left for a later session when the queue ends first', () => {
    expect(requeuePosition(10 * 60_000, 12, 15)).toBeNull();
    expect(requeuePosition(60_000, 2, 15)).toBe(2); // Again near the end: at the end
    expect(requeuePosition(60_000, 0, 15)).toBeNull(); // never as the very next card
  });
});

describe('one mode per expression per day', () => {
  const exprs = new Map(['a', 'b'].map((id) => [id, expr(id)]));
  const base = { expressions: exprs, settings: { ...DEFAULT_SETTINGS }, now: NOW, introducedToday: 0, secondsPerReview: 15, minutes: 10 };

  it('asks only one of Reading / Speaking when both are due', () => {
    const plan = planQueue({ ...base, cards: [reviewCard('a', 'recognition'), reviewCard('a', 'production'), reviewCard('b', 'recognition')] });
    expect(plan.queue).toHaveLength(2);
    expect(new Set(plan.queue.map((id) => id.split(':')[0]))).toEqual(new Set(['a', 'b']));
    expect(plan.buried).toBe(1);
  });

  it('holds a review whose expression was already studied today', () => {
    const plan = planQueue({ ...base, cards: [reviewCard('a', 'production'), reviewCard('b', 'recognition')], todaysLogs: [{ expressionId: 'a' }] });
    expect(plan.queue).toEqual(['b:recognition']);
  });

  it('never holds back a learning-step card', () => {
    const plan = planQueue({ ...base, cards: [reviewCard('a', 'recognition', 3, 1)], todaysLogs: [{ expressionId: 'a' }] });
    expect(plan.queue).toEqual(['a:recognition']);
  });
});

describe('a study session', () => {
  let n = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('rep-test-' + n++);
    await db.open();
  });

  it('shows each new expression once when answered Good (its 10-minute step comes later)', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 'e' + i);
    await db.expressions.bulkPut(ids.map(expr));
    await db.cards.bulkPut(ids.map((id) => ({ id: `${id}:recognition`, expressionId: id, mode: 'recognition' as const, fsrs: newCardData(), introducedAt: null, due: newCardData().due, state: 0 })));
    let s = await startOrResumeSession(10);
    const shown: string[] = [];
    let t = Date.now();
    while (s.queue.length && shown.length < 100) {
      shown.push(s.queue[0]);
      t += 15_000;
      s = (await answerCard(s.id, s.queue[0], 3, 15_000, new Date(t))).session;
    }
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown).size).toBe(shown.length); // previously every card was shown twice
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import type { Expression, FsrsCardData, ReviewCard } from '../src/db/types';
import { computeVocab, sessionLearnedDelta } from '../src/srs/vocab';
import { planQueue, QUICK_MINUTES } from '../src/srs/queue';
import { DEFAULT_SETTINGS } from '../src/db/types';
import { answerCard, getActiveSession, startOrResumeSession, startQuickSession } from '../src/srs/session';
import { addSampleDeck } from '../src/lib/sample';

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86400_000;

const expr = (id: string, suspended = false): Expression => ({
  id, text: id, normalized: id, meaning: '', notes: '', kind: 'phrase', examples: [], tags: [],
  suspended, usedInRealLife: [], createdAt: '', updatedAt: '',
});
const fsrs = (state: number, stability = 1): FsrsCardData => ({
  due: NOW.toISOString(), stability, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state,
});
const card = (exprId: string, state: number, stability = 1, mode: ReviewCard['mode'] = 'recognition'): ReviewCard => ({
  id: `${exprId}:${mode}`, expressionId: exprId, mode, fsrs: fsrs(state, stability),
  introducedAt: state === 0 ? null : '2026-05-01T00:00:00Z', due: NOW.toISOString(), state,
});

describe('vocabulary counter', () => {
  const expressions = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => expr(id)).concat(expr('s', true));
  const cards = [
    card('a', 2, 30), // learned, established
    card('b', 2, 3), // learned
    card('c', 3, 1), // relearning: not counted as learned
    card('d', 1), // learning
    card('e', 0), // new
    card('s', 2, 30), // suspended: ignored
    card('a', 2, 30, 'production'), // production ignored
  ];

  it('counts learned / established / learning / not started', () => {
    const v = computeVocab({ cards, expressions, recentLogs: [], firstReviewAt: null, settings: { newPerDay: 10 }, now: NOW });
    expect(v).toMatchObject({ learned: 2, established: 1, learning: 2, notStarted: 2, total: 6 });
  });

  it('falls back to the new-per-day setting without history', () => {
    const v = computeVocab({ cards, expressions, recentLogs: [], firstReviewAt: null, settings: { newPerDay: 10 }, now: NOW });
    expect(v.paceSource).toBe('setting');
    expect(v.pacePerDay).toBe(10);
    expect(v.projections[0]).toEqual({ days: 30, learned: 6 }); // capped by library size
    expect(v.daysToAll).toBe(1);
  });

  it('projects from the recent pace of new Reading cards', () => {
    const intro = (daysAgo: number, mode: ReviewCard['mode'] = 'recognition') => ({ reviewedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), mode, wasIntroduction: true });
    const big = Array.from({ length: 1000 }, (_, i) => expr('x' + i));
    // 10 days of history, 5 new Reading cards (+ production intros that must not count).
    const recentLogs = [intro(1), intro(2), intro(3), intro(4), intro(9), intro(2, 'production'), { ...intro(1), wasIntroduction: false }];
    const v = computeVocab({ cards, expressions: big.concat(expressions), recentLogs, firstReviewAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), settings: { newPerDay: 10 }, now: NOW });
    expect(v.paceSource).toBe('recent');
    expect(v.pacePerDay).toBeCloseTo(0.5);
    expect(v.projections.map((p) => p.learned)).toEqual([4 + 15, 4 + 45, 4 + 183]);
    expect(v.daysToAll).toBe(Math.ceil(1002 / 0.5));
  });

  it('has no completion date when no new expressions are being started', () => {
    const v = computeVocab({ cards, expressions, recentLogs: [], firstReviewAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), settings: { newPerDay: 10 }, now: NOW });
    expect(v.pacePerDay).toBe(0);
    expect(v.daysToAll).toBeNull();
  });

  it('computes the net change of one session', () => {
    const log = (cardId: string, t: number, before: number, after: number, mode: ReviewCard['mode'] = 'recognition') =>
      ({ cardId, mode, reviewedAt: new Date(t).toISOString(), before: fsrs(before), after: fsrs(after) });
    expect(sessionLearnedDelta([
      log('n', 1, 0, 1), log('n', 2, 1, 2), // new → learned: +1
      log('l', 3, 2, 3), // lapse: −1
      log('k', 4, 2, 2), // kept: 0
      log('p', 5, 0, 2, 'production'), // production: ignored
    ])).toBe(0);
    expect(sessionLearnedDelta([log('n', 2, 1, 2), log('n', 1, 0, 1)])).toBe(1);
  });
});

describe('1-minute mode', () => {
  let n = 0;
  beforeEach(async () => {
    await db.close();
    useDatabase('vocab-test-' + n++);
    await db.open();
  });

  it('keeps the queue short', () => {
    const many = Array.from({ length: 20 }, (_, i) => expr('q' + i));
    const due = many.map((e) => ({ ...card(e.id, 2, 3), due: '2026-05-30T00:00:00Z' }));
    const plan = planQueue({ cards: due, expressions: new Map(many.map((e) => [e.id, e])), settings: { ...DEFAULT_SETTINGS }, now: NOW, introducedToday: 0, secondsPerReview: 30, minutes: QUICK_MINUTES });
    expect(plan.capacity).toBe(3);
    expect(plan.queue).toHaveLength(3);
  });

  it('closes the open session and starts a quick one', async () => {
    await addSampleDeck();
    const normal = await startOrResumeSession(10);
    await answerCard(normal.id, normal.queue[0], 3, 5000);
    const quick = await startQuickSession();
    expect(quick.quick).toBe(true);
    expect(quick.targetMinutes).toBe(1);
    expect(quick.queue.length).toBeGreaterThan(0);
    expect((await db.sessions.get(normal.id))!.endedAt).not.toBeNull();
    expect((await getActiveSession())!.id).toBe(quick.id);
  });
});

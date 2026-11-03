/**
 * Study session persistence. Every answer is committed to IndexedDB in a single
 * transaction (card state + review log + session progress), so closing the app
 * mid-session never loses progress.
 */
import { db, getSettings } from '../db/db';
import type { RatingValue, ReviewCard, ReviewLogEntry, StudySession } from '../db/types';
import { dayKey, nowIso, uid } from '../lib/util';
import { planQueue, type QueuePlan, DEFAULT_SECONDS_PER_REVIEW, QUICK_MINUTES } from './queue';
import { retrievability, schedule, State } from './scheduler';

/** Per-card active time cap so an idle screen doesn't inflate stats. */
export const MAX_CARD_MS = 60_000;

export async function loadPlanInputs(now = new Date()) {
  const settings = await getSettings();
  const [cards, exprs] = await Promise.all([db.cards.toArray(), db.expressions.toArray()]);
  const expressions = new Map(exprs.map((e) => [e.id, e]));
  const today = dayKey(now, settings.dayStartHour);
  const todaysLogs = await logsForDay(today, settings.dayStartHour);
  const introducedToday = todaysLogs.filter((l) => l.wasIntroduction).length;
  const secondsPerReview = await estimateSecondsPerReview();
  return { settings, cards, expressions, introducedToday, secondsPerReview, today, todaysLogs };
}

export async function logsForDay(day: string, dayStartHour: number): Promise<ReviewLogEntry[]> {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, dayStartHour).toISOString();
  const end = new Date(y, m - 1, d + 1, dayStartHour).toISOString();
  return db.logs.where('reviewedAt').between(start, end, true, false).toArray();
}

export async function estimateSecondsPerReview(): Promise<number> {
  const recent = await db.logs.orderBy('reviewedAt').reverse().limit(200).toArray();
  if (recent.length < 20) return DEFAULT_SECONDS_PER_REVIEW;
  const sorted = recent.map((l) => l.durationMs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] / 1000;
  // Add a little overhead for reading examples / tapping.
  return Math.min(45, Math.max(6, median * 1.15));
}

export async function previewToday(now = new Date()): Promise<QueuePlan & { todayReviews: number; todayMs: number; activeSession: StudySession | null }> {
  const inp = await loadPlanInputs(now);
  const active = await getActiveSession(inp.today);
  const exclude = new Set(active?.done ?? []);
  const plan = planQueue({ ...inp, now, exclude });
  const todayMs = inp.todaysLogs.reduce((s, l) => s + l.durationMs, 0);
  return { ...plan, todayReviews: inp.todaysLogs.length, todayMs, activeSession: active };
}

export async function getActiveSession(today?: string): Promise<StudySession | null> {
  const settings = await getSettings();
  const day = today ?? dayKey(new Date(), settings.dayStartHour);
  const sessions = await db.sessions.where('day').equals(day).toArray();
  return sessions.find((s) => s.endedAt === null) ?? null;
}

/** Resume today's open session, or create a new one from the plan. */
export async function startOrResumeSession(minutes?: number, now = new Date()): Promise<StudySession> {
  const inp = await loadPlanInputs(now);
  const existing = await getActiveSession(inp.today);
  if (existing && existing.queue.length > 0) return existing;

  const plan = planQueue({ ...inp, now, minutes, exclude: new Set(existing?.done ?? []) });
  if (existing) {
    existing.queue = plan.queue;
    existing.targetMinutes = minutes ?? existing.targetMinutes;
    await db.sessions.put(existing);
    return existing;
  }
  const session: StudySession = {
    id: uid(),
    startedAt: nowIso(),
    endedAt: null,
    targetMinutes: minutes ?? inp.settings.sessionMinutes,
    activeMs: 0,
    queue: plan.queue,
    done: [],
    reviewedCount: 0,
    newCount: 0,
    day: inp.today,
  };
  await db.sessions.put(session);
  return session;
}

/**
 * 1-minute mode: a fresh, very short session. An open session from earlier
 * today is closed first; nothing is lost because every answer is already
 * saved and its unanswered cards stay due.
 */
export async function startQuickSession(now = new Date()): Promise<StudySession> {
  const inp = await loadPlanInputs(now);
  const existing = await getActiveSession(inp.today);
  if (existing) {
    existing.endedAt = now.toISOString();
    await db.sessions.put(existing);
  }
  const plan = planQueue({ ...inp, now, minutes: QUICK_MINUTES });
  const session: StudySession = {
    id: uid(),
    startedAt: now.toISOString(),
    endedAt: null,
    targetMinutes: QUICK_MINUTES,
    activeMs: 0,
    queue: plan.queue,
    done: [],
    reviewedCount: 0,
    newCount: 0,
    day: inp.today,
    quick: true,
  };
  await db.sessions.put(session);
  return session;
}

/** Add more cards to the current session ("continue for N more minutes"). */
export async function extendSession(sessionId: string, extraMinutes: number, now = new Date()): Promise<StudySession> {
  const inp = await loadPlanInputs(now);
  const s = await db.sessions.get(sessionId);
  if (!s) throw new Error('session not found');
  const exclude = new Set([...s.done, ...s.queue]);
  // The user explicitly asked for more: allow another day's worth of new cards
  // (still suppressed automatically when reviews are backlogged).
  const plan = planQueue({ ...inp, now, minutes: extraMinutes, exclude, introducedToday: 0 });
  s.queue = [...s.queue, ...plan.queue];
  s.targetMinutes += extraMinutes;
  s.endedAt = null;
  await db.sessions.put(s);
  return s;
}

/** Never bring a card back sooner than this many cards later. */
export const MIN_REQUEUE_GAP = 3;

/**
 * Where to re-insert a learning-step card so it comes back roughly when it is
 * due (estimated from seconds per card). null = it wouldn't be due before the
 * remaining queue ends, so it is left for a later session.
 */
export function requeuePosition(msUntilDue: number, queueLength: number, secondsPerCard: number): number | null {
  const cardsUntilDue = Math.max(MIN_REQUEUE_GAP, Math.ceil(msUntilDue / (secondsPerCard * 1000)));
  if (cardsUntilDue <= queueLength) return cardsUntilDue;
  // Only a few cards left: an "Again" (1-minute step) still comes back at the
  // end — but not as the very next card when nothing else is left.
  if (msUntilDue <= 2 * 60_000 && queueLength > 0) return queueLength;
  return null;
}

export interface AnswerResult {
  session: StudySession;
  card: ReviewCard;
  log: ReviewLogEntry;
}

export async function answerCard(
  sessionId: string,
  cardId: string,
  rating: RatingValue,
  durationMs: number,
  now = new Date(),
  opts: { hintsUsed?: number } = {},
): Promise<AnswerResult> {
  const settings = await getSettings();
  const secondsPerCard = await estimateSecondsPerReview();
  return db.transaction('rw', db.cards, db.logs, db.sessions, async () => {
    const card = await db.cards.get(cardId);
    const session = await db.sessions.get(sessionId);
    if (!card || !session) throw new Error('card or session missing');

    const before = card.fsrs;
    const after = schedule(settings, before, rating, now);
    const wasIntroduction = card.introducedAt === null;
    const updated: ReviewCard = {
      ...card,
      fsrs: after,
      due: after.due,
      state: after.state,
      introducedAt: card.introducedAt ?? now.toISOString(),
    };
    const log: ReviewLogEntry = {
      id: uid(),
      cardId,
      expressionId: card.expressionId,
      mode: card.mode,
      rating,
      reviewedAt: now.toISOString(),
      durationMs: Math.min(MAX_CARD_MS, Math.max(0, Math.round(durationMs))),
      sessionId,
      before,
      after,
      retrievability: retrievability(settings, before, now),
      wasIntroduction,
      ...(opts.hintsUsed ? { hintsUsed: opts.hintsUsed } : {}),
    };
    await db.cards.put(updated);
    await db.logs.add(log);

    // Session bookkeeping.
    session.queue = session.queue.filter((id) => id !== cardId);
    session.activeMs += log.durationMs;
    if (wasIntroduction) session.newCount++;
    else session.reviewedCount++;
    const shortTerm = after.state === State.Learning || after.state === State.Relearning;
    const pos = shortTerm ? requeuePosition(new Date(after.due).getTime() - now.getTime(), session.queue.length, secondsPerCard) : null;
    if (pos !== null) {
      // Learning step that falls due within this session: bring it back about
      // when FSRS asked for it, not straight away.
      session.queue.splice(pos, 0, cardId);
    } else if (!shortTerm && !session.done.includes(cardId)) {
      session.done.push(cardId);
    }
    // A learning card not due before this session's queue runs out is left out
    // of both queue and done: it stays due and the next plan picks it up.
    await db.sessions.put(session);
    return { session, card: updated, log };
  });
}

/**
 * Take an expression out of study from the study screen. Nothing is deleted:
 * the expression is only marked suspended (same as the Library toggle), its
 * review history is kept, and its cards leave today's queue. Returns the queue
 * as it was so the action can be undone.
 */
export async function excludeExpression(sessionId: string, expressionId: string): Promise<{ session: StudySession; prevQueue: string[] } | null> {
  return db.transaction('rw', db.expressions, db.sessions, async () => {
    const session = await db.sessions.get(sessionId);
    const expr = await db.expressions.get(expressionId);
    if (!session || !expr) return null;
    await db.expressions.put({ ...expr, suspended: true, updatedAt: nowIso() });
    const prevQueue = [...session.queue];
    session.queue = session.queue.filter((id) => !id.startsWith(`${expressionId}:`));
    await db.sessions.put(session);
    return { session, prevQueue };
  });
}

/** Undo excludeExpression: back into study and back into today's queue. */
export async function restoreExpression(sessionId: string, expressionId: string, prevQueue: string[]): Promise<StudySession | null> {
  return db.transaction('rw', db.expressions, db.sessions, async () => {
    const session = await db.sessions.get(sessionId);
    const expr = await db.expressions.get(expressionId);
    if (!session || !expr) return null;
    await db.expressions.put({ ...expr, suspended: false, updatedAt: nowIso() });
    const current = new Set(session.queue);
    // Restore the excluded cards at their original positions; keep any other changes.
    const restored = prevQueue.filter((id) => current.has(id) || id.startsWith(`${expressionId}:`));
    session.queue = [...restored, ...session.queue.filter((id) => !restored.includes(id))];
    session.endedAt = null;
    await db.sessions.put(session);
    return session;
  });
}

/** Undo the most recent answer in this session. */
export async function undoLast(sessionId: string): Promise<StudySession | null> {
  return db.transaction('rw', db.cards, db.logs, db.sessions, async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) return null;
    const logs = await db.logs.where('sessionId').equals(sessionId).toArray();
    if (logs.length === 0) return session;
    logs.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    const last = logs[logs.length - 1];
    const card = await db.cards.get(last.cardId);
    if (!card) return session;
    await db.cards.put({
      ...card,
      fsrs: last.before,
      due: last.before.due,
      state: last.before.state,
      introducedAt: last.wasIntroduction ? null : card.introducedAt,
    });
    await db.logs.delete(last.id);
    session.queue = [last.cardId, ...session.queue.filter((id) => id !== last.cardId)];
    session.done = session.done.filter((id) => id !== last.cardId);
    session.activeMs = Math.max(0, session.activeMs - last.durationMs);
    if (last.wasIntroduction) session.newCount = Math.max(0, session.newCount - 1);
    else session.reviewedCount = Math.max(0, session.reviewedCount - 1);
    session.endedAt = null;
    await db.sessions.put(session);
    return session;
  });
}

export async function finishSession(sessionId: string): Promise<void> {
  const s = await db.sessions.get(sessionId);
  if (!s) return;
  s.endedAt = nowIso();
  await db.sessions.put(s);
}

/** Persist time spent looking at a card without answering (e.g. app closed). */
export async function addActiveTime(sessionId: string, ms: number) {
  const s = await db.sessions.get(sessionId);
  if (!s) return;
  s.activeMs += Math.min(MAX_CARD_MS, ms);
  await db.sessions.put(s);
}

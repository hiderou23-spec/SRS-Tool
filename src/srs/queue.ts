/**
 * Daily queue planning (pure functions, no I/O).
 *
 * FSRS decides *when* each card is due. This module decides *which* due cards
 * fit into today's time budget. When the backlog exceeds the budget the
 * remainder simply stays due (FSRS handles overdue cards correctly when they
 * are eventually reviewed) and is reported honestly via `backlog`.
 */
import type { Expression, ReviewCard, Settings } from '../db/types';
import { State } from 'ts-fsrs';
import { retrievability } from './scheduler';
import { endOfStudyDay } from '../lib/util';

export const DEFAULT_IMPORTANCE = 50;
export const DEFAULT_SECONDS_PER_REVIEW = 15;
/** A new card costs more time than a review (first exposure + learning steps). */
export const NEW_CARD_COST = 2.5;

export function effectiveImportance(e: Pick<Expression, 'importance' | 'ai'> | undefined): number {
  if (!e) return DEFAULT_IMPORTANCE;
  return e.importance ?? e.ai?.importance ?? DEFAULT_IMPORTANCE;
}

export interface QueuePlan {
  queue: string[];
  /** Number of due (introduced) cards today, including those not fitting the budget. */
  dueTotal: number;
  /** Due cards that are past their due date by at least one day. */
  overdue: number;
  /** Due cards that did not fit into today's session. */
  backlog: number;
  dueInQueue: number;
  newInQueue: number;
  /** Estimated number of card-reviews fitting into the session. */
  capacity: number;
  newSuppressed: boolean;
  newAllowedToday: number;
}

export interface PlanInput {
  cards: ReviewCard[];
  expressions: Map<string, Expression>;
  settings: Settings;
  now: Date;
  /** Cards introduced (first studied) today, any mode. */
  introducedToday: number;
  /** Median seconds per review from history (defaults if unknown). */
  secondsPerReview?: number;
  /** Card ids to exclude (already answered in this session). */
  exclude?: Set<string>;
  /** Override minutes (e.g. "continue +5 min"). */
  minutes?: number;
}

/**
 * Priority of a due card: higher = study first.
 * - Learning/relearning cards (short-term steps) always first.
 * - Otherwise blend importance (0–100) with forgetting risk (1 − R) and how
 *   overdue the card is relative to its interval.
 */
export function duePriority(card: ReviewCard, expr: Expression | undefined, settings: Settings, now: Date): number {
  if (card.state === State.Learning || card.state === State.Relearning) return 10;
  const imp = effectiveImportance(expr) / 100;
  const r = retrievability(settings, card.fsrs, now) ?? settings.desiredRetention;
  const risk = Math.max(0, settings.desiredRetention - r) / settings.desiredRetention; // 0..1
  const interval = Math.max(1, card.fsrs.scheduled_days);
  const overdueDays = (now.getTime() - new Date(card.due).getTime()) / 86400_000;
  const relOverdue = Math.min(1, Math.max(0, overdueDays / interval));
  // Production cards are the main goal (speaking) — slight boost.
  const modeBoost = card.mode === 'production' ? 0.05 : 0;
  return imp * 0.55 + risk * 0.25 + relOverdue * 0.15 + modeBoost;
}

export function planQueue(input: PlanInput): QueuePlan {
  const { cards, expressions, settings, now } = input;
  const minutes = input.minutes ?? settings.sessionMinutes;
  const spr = input.secondsPerReview ?? DEFAULT_SECONDS_PER_REVIEW;
  const capacity = Math.max(5, Math.floor((minutes * 60) / spr));
  const exclude = input.exclude ?? new Set<string>();
  const dayEnd = endOfStudyDay(now, settings.dayStartHour);

  const recognitionById = new Map<string, ReviewCard>();
  for (const c of cards) if (c.mode === 'recognition') recognitionById.set(c.expressionId, c);

  const due: ReviewCard[] = [];
  const newRecognition: ReviewCard[] = [];
  const newProduction: ReviewCard[] = [];
  let overdue = 0;

  for (const c of cards) {
    if (exclude.has(c.id)) continue;
    if (c.mode === 'listening') continue; // Phase 3
    const expr = expressions.get(c.expressionId);
    if (!expr || expr.suspended) continue;

    if (c.introducedAt === null || c.state === State.New) {
      if (c.mode === 'recognition') newRecognition.push(c);
      else if (c.mode === 'production' && expr.lang !== 'ja') {
        const rec = recognitionById.get(c.expressionId);
        if (rec && rec.state === State.Review && rec.fsrs.stability >= settings.productionUnlockStabilityDays) {
          newProduction.push(c);
        }
      }
      continue;
    }

    const dueAt = new Date(c.due);
    const isShortTerm = c.state === State.Learning || c.state === State.Relearning;
    if (isShortTerm ? dueAt.getTime() <= now.getTime() + 20 * 60_000 : dueAt <= dayEnd) {
      due.push(c);
      if (now.getTime() - dueAt.getTime() >= 86400_000) overdue++;
    }
  }

  const prio = new Map<string, number>();
  for (const c of due) prio.set(c.id, duePriority(c, expressions.get(c.expressionId), settings, now));
  due.sort((a, b) => prio.get(b.id)! - prio.get(a.id)!);

  const dueInQueue = due.slice(0, capacity);
  const remaining = capacity - dueInQueue.length;

  // New cards: limited by daily limit and suppressed when the backlog doesn't fit.
  const newAllowedToday = Math.max(0, settings.newPerDay - input.introducedToday);
  let newSlots = Math.min(newAllowedToday, Math.floor(remaining / NEW_CARD_COST));
  const newSuppressed = due.length >= capacity && newAllowedToday > 0;
  if (newSuppressed) newSlots = 0;

  const byImportance = (a: ReviewCard, b: ReviewCard) => {
    const ea = expressions.get(a.expressionId);
    const eb = expressions.get(b.expressionId);
    const d = effectiveImportance(eb) - effectiveImportance(ea);
    if (d !== 0) return d;
    // Stable: original import order.
    return (ea?.source?.rowIndex ?? 0) - (eb?.source?.rowIndex ?? 0) || (ea?.createdAt ?? '').localeCompare(eb?.createdAt ?? '');
  };
  newProduction.sort(byImportance);
  newRecognition.sort(byImportance);

  // Up to half of new slots go to newly-unlocked production cards.
  const prodSlots = Math.min(newProduction.length, Math.ceil(newSlots / 2));
  const chosenNew = [
    ...newProduction.slice(0, prodSlots),
    ...newRecognition.slice(0, newSlots - prodSlots),
  ];
  if (chosenNew.length < newSlots) {
    chosenNew.push(...newProduction.slice(prodSlots, prodSlots + (newSlots - chosenNew.length)));
  }

  // Interleave new cards evenly among reviews; avoid two modes of the same expression back-to-back.
  const queue: string[] = [];
  const reviews = dueInQueue.map((c) => c.id);
  const news = chosenNew.map((c) => c.id);
  if (news.length === 0) queue.push(...reviews);
  else {
    const step = Math.max(1, Math.floor(reviews.length / news.length));
    let ri = 0;
    for (const n of news) {
      for (let k = 0; k < step && ri < reviews.length; k++) queue.push(reviews[ri++]);
      queue.push(n);
    }
    while (ri < reviews.length) queue.push(reviews[ri++]);
  }

  return {
    queue: spreadSiblings(queue),
    dueTotal: due.length,
    overdue,
    backlog: due.length - dueInQueue.length,
    dueInQueue: dueInQueue.length,
    newInQueue: chosenNew.length,
    capacity,
    newSuppressed,
    newAllowedToday,
  };
}

/** Avoid showing recognition and production of the same expression consecutively. */
function spreadSiblings(ids: string[]): string[] {
  const out = [...ids];
  const exprOf = (id: string) => id.slice(0, id.lastIndexOf(':'));
  for (let i = 1; i < out.length; i++) {
    if (exprOf(out[i]) === exprOf(out[i - 1])) {
      const j = out.findIndex((x, k) => k > i && exprOf(x) !== exprOf(out[i - 1]));
      if (j > 0) [out[i], out[j]] = [out[j], out[i]];
    }
  }
  return out;
}

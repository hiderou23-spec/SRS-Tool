/**
 * Vocabulary counter and growth forecast.
 *
 * "覚えた表現" (learned) = an active expression whose Reading card has finished
 * its learning steps (FSRS state Review). A card that lapses drops out until it
 * is relearned, so the number tracks what you can actually read today.
 * "定着" (established) uses the same threshold as the Progress page.
 *
 * The forecast is a deliberately simple projection: learned + still-learning
 * cards + (recent pace of new expressions × days), capped by what is in the
 * library. It is a guide, not a promise, and the UI says so.
 */
import { db, getSettings } from '../db/db';
import type { Expression, ReviewCard, ReviewLogEntry, Settings } from '../db/types';
import { State } from './scheduler';
import { ESTABLISHED_DAYS } from './stats';

const DAY = 86400_000;
/** Look-back window for the pace of new expressions. */
export const PACE_WINDOW_DAYS = 28;
/** With less history than this, the forecast uses the "new per day" setting. */
export const MIN_HISTORY_DAYS = 3;
export const HORIZONS = [30, 90, 365] as const;

export interface VocabForecast {
  /** Expressions learned now (Reading card graduated). */
  learned: number;
  /** Of those, established (stability ≥ ESTABLISHED_DAYS). */
  established: number;
  /** Introduced but still in learning steps / relearning. */
  learning: number;
  /** Not started yet. */
  notStarted: number;
  total: number;
  /** New expressions per calendar day used for the projection. */
  pacePerDay: number;
  /** 'recent' = measured from your history; 'setting' = assumed from settings. */
  paceSource: 'recent' | 'setting';
  projections: { days: number; learned: number }[];
  /** Days until every expression in the library is learned; null if pace is 0. 0 = all started. */
  daysToAll: number | null;
}

export function isLearned(c: Pick<ReviewCard, 'state'> | undefined): boolean {
  return !!c && c.state === State.Review;
}

export interface VocabInput {
  cards: ReviewCard[];
  expressions: Expression[];
  /** Logs from (at least) the last PACE_WINDOW_DAYS days. */
  recentLogs: Pick<ReviewLogEntry, 'reviewedAt' | 'mode' | 'wasIntroduction'>[];
  /** Time of the very first review ever (null = never studied). */
  firstReviewAt: string | null;
  settings: Pick<Settings, 'newPerDay'>;
  now: Date;
}

export function computeVocab(input: VocabInput): VocabForecast {
  const { now } = input;
  const active = input.expressions.filter((e) => !e.suspended);
  const rec = new Map<string, ReviewCard>();
  for (const c of input.cards) if (c.mode === 'recognition') rec.set(c.expressionId, c);

  let learned = 0, established = 0, learning = 0, notStarted = 0;
  for (const e of active) {
    const c = rec.get(e.id);
    if (!c || c.introducedAt === null || c.state === State.New) notStarted++;
    else if (isLearned(c)) {
      learned++;
      if (c.fsrs.stability >= ESTABLISHED_DAYS) established++;
    } else learning++;
  }
  const total = active.length;

  // Pace: new Reading cards per calendar day over the recent window.
  const historyDays = input.firstReviewAt ? (now.getTime() - new Date(input.firstReviewAt).getTime()) / DAY : 0;
  let pacePerDay: number;
  let paceSource: VocabForecast['paceSource'];
  if (historyDays >= MIN_HISTORY_DAYS) {
    const span = Math.min(PACE_WINDOW_DAYS, historyDays);
    const since = now.getTime() - span * DAY;
    const intros = input.recentLogs.filter(
      (l) => l.wasIntroduction && l.mode === 'recognition' && new Date(l.reviewedAt).getTime() >= since,
    ).length;
    pacePerDay = intros / span;
    paceSource = 'recent';
  } else {
    pacePerDay = input.settings.newPerDay;
    paceSource = 'setting';
  }

  const projections = HORIZONS.map((days) => ({
    days,
    learned: Math.min(total, Math.round(learned + learning + pacePerDay * days)),
  }));
  const daysToAll = notStarted === 0 ? 0 : pacePerDay > 0 ? Math.ceil(notStarted / pacePerDay) : null;

  return { learned, established, learning, notStarted, total, pacePerDay, paceSource, projections, daysToAll };
}

export async function loadVocab(now = new Date()): Promise<VocabForecast> {
  const settings = await getSettings();
  const since = new Date(now.getTime() - PACE_WINDOW_DAYS * DAY).toISOString();
  const [cards, expressions, recentLogs, first] = await Promise.all([
    db.cards.where('mode').equals('recognition').toArray(),
    db.expressions.toArray(),
    db.logs.where('reviewedAt').aboveOrEqual(since).toArray(),
    db.logs.orderBy('reviewedAt').first(),
  ]);
  return computeVocab({ cards, expressions, recentLogs, firstReviewAt: first?.reviewedAt ?? null, settings, now });
}

/**
 * Net change in learned expressions caused by one session: for every Reading
 * card answered, compare its state before the first answer with its state
 * after the last one.
 */
export function sessionLearnedDelta(logs: Pick<ReviewLogEntry, 'cardId' | 'mode' | 'reviewedAt' | 'before' | 'after'>[]): number {
  const byCard = new Map<string, typeof logs>();
  for (const l of logs) {
    if (l.mode !== 'recognition') continue;
    const xs = byCard.get(l.cardId) ?? [];
    xs.push(l);
    byCard.set(l.cardId, xs);
  }
  let delta = 0;
  for (const xs of byCard.values()) {
    xs.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    delta += Number(xs[xs.length - 1].after.state === State.Review) - Number(xs[0].before.state === State.Review);
  }
  return delta;
}

export async function loadSessionDelta(sessionId: string): Promise<number> {
  return sessionLearnedDelta(await db.logs.where('sessionId').equals(sessionId).toArray());
}

/** "2027年2月" style label for a date `days` from now. */
export function monthLabel(days: number, now = new Date()): string {
  const d = new Date(now.getTime() + days * DAY);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

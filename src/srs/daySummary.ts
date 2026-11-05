/**
 * "今日の表現": what was studied today, hardest first.
 *
 * Meant for a quick look back, not for re-studying: the UI keeps it folded,
 * hides meanings until tapped, and offers edit / exclude actions only.
 */
import { db, getSettings } from '../db/db';
import type { Expression, ReviewLogEntry, StudyMode } from '../db/types';
import { dayKey, nowIso } from '../lib/util';
import { logsForDay } from './session';

/** Worst outcome of the day for an expression, hardest first. */
export type DayTier = 'again' | 'hint' | 'hard' | 'ok';
const TIER_ORDER: DayTier[] = ['again', 'hint', 'hard', 'ok'];

export interface DayItem {
  expression: Expression;
  tier: DayTier;
  modes: StudyMode[];
  /** First studied today. */
  isNew: boolean;
  answers: number;
  lastAt: string;
}

export interface DaySummary {
  items: DayItem[];
  /** Items that weren't answered smoothly (Again, hint or Hard). */
  needsReview: number;
}

function tierOf(logs: Pick<ReviewLogEntry, 'rating' | 'hintsUsed'>[]): DayTier {
  if (logs.some((l) => l.rating === 1)) return 'again';
  if (logs.some((l) => (l.hintsUsed ?? 0) > 0)) return 'hint';
  if (logs.some((l) => l.rating === 2)) return 'hard';
  return 'ok';
}

export function summarizeDay(
  logs: Pick<ReviewLogEntry, 'expressionId' | 'mode' | 'rating' | 'hintsUsed' | 'wasIntroduction' | 'reviewedAt'>[],
  expressions: Map<string, Expression>,
): DaySummary {
  const byExpr = new Map<string, typeof logs>();
  for (const l of logs) byExpr.set(l.expressionId, [...(byExpr.get(l.expressionId) ?? []), l]);
  const items: DayItem[] = [];
  for (const [id, xs] of byExpr) {
    const expression = expressions.get(id);
    if (!expression) continue; // deleted since
    items.push({
      expression,
      tier: tierOf(xs),
      modes: [...new Set(xs.map((l) => l.mode))].sort() as StudyMode[],
      isNew: xs.some((l) => l.wasIntroduction),
      answers: xs.length,
      lastAt: xs.reduce((m, l) => (l.reviewedAt > m ? l.reviewedAt : m), ''),
    });
  }
  items.sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.answers - a.answers || b.lastAt.localeCompare(a.lastAt),
  );
  return { items, needsReview: items.filter((i) => i.tier !== 'ok').length };
}

export async function loadTodaySummary(now = new Date()): Promise<DaySummary> {
  const settings = await getSettings();
  const logs = await logsForDay(dayKey(now, settings.dayStartHour), settings.dayStartHour);
  const ids = [...new Set(logs.map((l) => l.expressionId))];
  const exprs = (await db.expressions.bulkGet(ids)).filter((e): e is Expression => !!e);
  return summarizeDay(logs, new Map(exprs.map((e) => [e.id, e])));
}

/** Take an expression out of study (or back in). Nothing is deleted. */
export async function setSuspended(expressionId: string, suspended: boolean): Promise<void> {
  const e = await db.expressions.get(expressionId);
  if (e) await db.expressions.put({ ...e, suspended, updatedAt: nowIso() });
}

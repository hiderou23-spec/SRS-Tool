import { db, getSettings } from '../db/db';
import { CATEGORY_LABELS, type Category, type Expression, type ReviewCard } from '../db/types';
import { dayKey } from '../lib/util';
import { retrievability, State } from './scheduler';

/** Stability (days) at which we call a card "established" (定着). */
export const ESTABLISHED_DAYS = 21;

export interface ModeProgress {
  notStarted: number;
  learning: number; // introduced, stability < ESTABLISHED_DAYS
  established: number; // stability >= ESTABLISHED_DAYS
}

export interface ProgressStats {
  totalExpressions: number;
  activeExpressions: number;
  studyDays: number;
  streak: number;
  totalMs: number;
  totalReviews: number;
  /** Share of non-Again answers on mature reviews (last 30 days). */
  accuracy30: number | null;
  /** Mean predicted recall probability over all reviewed cards right now. */
  estimatedRetention: number | null;
  reading: ModeProgress;
  speaking: ModeProgress;
  usedInRealLife: number;
  ladder: { canRead: number; canRecall: number; used: number };
  weak: { expression: Expression; lapses: number; mode: string }[];
  categories: { key: Category | 'uncategorized'; label: string; total: number; established: number }[];
  last14: { day: string; ms: number; reviews: number }[];
  dueBacklog: { dueNow: number; overdue7: number };
}

function modeProgress(cards: ReviewCard[]): ModeProgress {
  const p: ModeProgress = { notStarted: 0, learning: 0, established: 0 };
  for (const c of cards) {
    if (c.introducedAt === null || c.state === State.New) p.notStarted++;
    else if (c.state === State.Review && c.fsrs.stability >= ESTABLISHED_DAYS) p.established++;
    else p.learning++;
  }
  return p;
}

export async function computeProgress(now = new Date()): Promise<ProgressStats> {
  const settings = await getSettings();
  const [exprs, cards, logs] = await Promise.all([db.expressions.toArray(), db.cards.toArray(), db.logs.toArray()]);
  const active = exprs.filter((e) => !e.suspended);
  const activeIds = new Set(active.map((e) => e.id));
  const activeCards = cards.filter((c) => activeIds.has(c.expressionId));
  const rec = activeCards.filter((c) => c.mode === 'recognition');
  const jaIds = new Set(active.filter((e) => e.lang === 'ja').map((e) => e.id));
  const prod = activeCards.filter((c) => c.mode === 'production' && !jaIds.has(c.expressionId));

  const days = new Map<string, { ms: number; reviews: number }>();
  for (const l of logs) {
    const k = dayKey(new Date(l.reviewedAt), settings.dayStartHour);
    const d = days.get(k) ?? { ms: 0, reviews: 0 };
    d.ms += l.durationMs;
    d.reviews++;
    days.set(k, d);
  }
  let streak = 0;
  for (let i = 0; ; i++) {
    const k = dayKey(new Date(now.getTime() - i * 86400_000), settings.dayStartHour);
    if (days.has(k)) streak++;
    else if (i === 0) continue; // today not yet studied doesn't break the streak
    else break;
  }

  const since = now.getTime() - 30 * 86400_000;
  const mature = logs.filter((l) => new Date(l.reviewedAt).getTime() >= since && l.before.state === State.Review);
  const accuracy30 = mature.length ? mature.filter((l) => l.rating > 1).length / mature.length : null;

  const rs = activeCards.map((c) => retrievability(settings, c.fsrs, now)).filter((r): r is number => r !== null);
  const estimatedRetention = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  const established = (c?: ReviewCard) => !!c && c.state === State.Review && c.fsrs.stability >= ESTABLISHED_DAYS;
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  let canRead = 0, canRecall = 0, used = 0;
  for (const e of active) {
    if (established(cardMap.get(`${e.id}:recognition`))) canRead++;
    if (established(cardMap.get(`${e.id}:production`))) canRecall++;
    if (e.usedInRealLife.length > 0) used++;
  }

  const exprMap = new Map(exprs.map((e) => [e.id, e]));
  const weak = activeCards
    .filter((c) => c.fsrs.lapses >= 2)
    .sort((a, b) => b.fsrs.lapses - a.fsrs.lapses || a.fsrs.stability - b.fsrs.stability)
    .slice(0, 10)
    .map((c) => ({ expression: exprMap.get(c.expressionId)!, lapses: c.fsrs.lapses, mode: c.mode }));

  const catMap = new Map<string, { total: number; established: number }>();
  for (const e of active) {
    const k = e.category ?? e.ai?.category ?? 'uncategorized';
    const v = catMap.get(k) ?? { total: 0, established: 0 };
    v.total++;
    if (established(cardMap.get(`${e.id}:recognition`))) v.established++;
    catMap.set(k, v);
  }
  const categories = [...catMap.entries()]
    .map(([key, v]) => ({ key: key as Category | 'uncategorized', label: key === 'uncategorized' ? '未分類' : CATEGORY_LABELS[key as Category], ...v }))
    .sort((a, b) => b.total - a.total);

  const last14 = Array.from({ length: 14 }, (_, i) => {
    const k = dayKey(new Date(now.getTime() - (13 - i) * 86400_000), settings.dayStartHour);
    return { day: k, ...(days.get(k) ?? { ms: 0, reviews: 0 }) };
  });

  let dueNow = 0, overdue7 = 0;
  for (const c of activeCards) {
    if (c.introducedAt === null || c.mode === 'listening') continue;
    const due = new Date(c.due).getTime();
    if (due <= now.getTime()) dueNow++;
    if (now.getTime() - due > 7 * 86400_000) overdue7++;
  }

  return {
    totalExpressions: exprs.length,
    activeExpressions: active.length,
    studyDays: days.size,
    streak,
    totalMs: logs.reduce((s, l) => s + l.durationMs, 0),
    totalReviews: logs.length,
    accuracy30,
    estimatedRetention,
    reading: modeProgress(rec),
    speaking: modeProgress(prod),
    usedInRealLife: used,
    ladder: { canRead, canRecall, used },
    weak,
    categories,
    last14,
    dueBacklog: { dueNow, overdue7 },
  };
}

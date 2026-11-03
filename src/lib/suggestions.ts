/**
 * Daily AI suggestions: five expressions a day that the learner picks from.
 *
 * - Nothing is added automatically: each suggestion is "追加" / "もう知ってる" /
 *   "いらない". Added ones become ordinary new cards, so they go through the
 *   normal daily new-card limit.
 * - Suggestions pause on days when reviews are backlogged (new cards are being
 *   held back then anyway).
 * - Past decisions are sent with the next request so suggestions adapt.
 * - Duplicates of the library or of earlier suggestions are removed on the
 *   device; the AI only sees a sample of the library (texts only).
 */
import { db, getSettings, saveSettings } from '../db/db';
import type { Category, Example, Expression, Suggestion, SuggestionStatus } from '../db/types';
import { classifyKind, cleanEnglish, normalizeKey } from '../import/clean';
import { makeCards } from '../import/importer';
import { effectiveImportance } from '../srs/queue';
import { dayKey, nowIso, uid } from './util';
import type { GenerateUsage, SuggestContext, SuggestedItem } from './aiGenerate';

export const DAILY_SUGGESTIONS = 5;
/** Ask for a few more than needed so on-device duplicate removal still leaves five. */
export const ASK_COUNT = 8;
/** At most this many library expressions are sent as "already have" context. */
export const LIBRARY_SAMPLE = 300;
/** At most this many past decisions per kind are sent. */
export const HISTORY_SAMPLE = 80;

/** Requests allowed per day (the first set plus "もう5語" after deciding all). */
export const MAX_BATCHES_PER_DAY = 3;
/** Share of a set already known that raises the level by one. */
export const RAISE_LEVEL_KNOWN_SHARE = 0.8;

export const SUGGESTION_LEVELS = [
  { level: 1, label: '中上級', guide: 'Upper-intermediate: common, useful business phrasal verbs and collocations.' },
  {
    level: 2,
    label: '上級',
    guide:
      'Advanced: natural expressions an advanced non-native speaker would understand when reading but rarely produce on their own — nuanced verbs, precise collocations, hedging and diplomatic phrasing.',
  },
  {
    level: 3,
    label: 'ネイティブ寄り',
    guide:
      'Near-native: idiomatic expressions and phrasing native speakers use naturally in meetings that even advanced non-native speakers usually do not know. Still common in current use; not slang-heavy, not obscure.',
  },
  {
    level: 4,
    label: 'ネイティブ水準',
    guide:
      'Native-level: subtle idioms, colloquial and figurative expressions, and register-specific phrasing used by native professionals. Must be in current everyday use — never archaic, literary or regional.',
  },
] as const;
export const MAX_LEVEL = SUGGESTION_LEVELS.length;

export function levelInfo(level: number) {
  return SUGGESTION_LEVELS[Math.min(MAX_LEVEL, Math.max(1, Math.round(level))) - 1];
}

const batchOf = (s: Pick<Suggestion, 'batch'>) => s.batch ?? 1;
const batchKey = (s: Pick<Suggestion, 'day' | 'batch'>) => `${s.day}#${batchOf(s)}`;

/** The most recent set in which every suggestion has been decided. */
export function lastDecidedSet(past: Suggestion[]): { key: string; size: number; known: number } | null {
  const sets = new Map<string, Suggestion[]>();
  for (const s of past) {
    const k = batchKey(s);
    sets.set(k, [...(sets.get(k) ?? []), s]);
  }
  let best: { key: string; at: string; size: number; known: number } | null = null;
  for (const [key, xs] of sets) {
    if (xs.some((x) => x.status === 'pending')) continue;
    const at = xs.reduce((m, x) => (x.createdAt > m ? x.createdAt : m), '');
    if (!best || at > best.at) best = { key, at, size: xs.length, known: xs.filter((x) => x.status === 'known').length };
  }
  return best && { key: best.key, size: best.size, known: best.known };
}

/**
 * Level to use for the next request: one step up when the learner already knew
 * most of the last fully decided set. Each set is used only once (`basis`).
 */
export function nextLevel(level: number, basis: string | undefined, past: Suggestion[]): { level: number; basis: string | undefined; raised: boolean } {
  const last = lastDecidedSet(past);
  const cur = levelInfo(level).level;
  if (!last || last.key === basis || last.size === 0) return { level: cur, basis, raised: false };
  const raise = last.known / last.size >= RAISE_LEVEL_KNOWN_SHARE && cur < MAX_LEVEL;
  return { level: raise ? cur + 1 : cur, basis: last.key, raised: raise };
}

/** True when today's sets are all decided and another set may be requested. */
export function canAskMore(today: Suggestion[]): boolean {
  if (today.length === 0 || today.some((s) => s.status === 'pending')) return false;
  return Math.max(...today.map(batchOf)) < MAX_BATCHES_PER_DAY;
}

const CATEGORIES: Category[] = ['business', 'daily', 'phrasal_verb', 'idiom', 'academic', 'technical', 'low_priority'];

export async function todayKey(now = new Date()): Promise<string> {
  return dayKey(now, (await getSettings()).dayStartHour);
}

export async function suggestionsForDay(day: string): Promise<Suggestion[]> {
  const xs = await db.suggestions.where('day').equals(day).toArray();
  return xs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Context for the AI request (texts only). */
export function buildContext(expressions: Expression[], past: Suggestion[], level = 2): SuggestContext {
  const library = expressions
    .filter((e) => !e.suspended && e.lang !== 'ja' && e.text)
    .sort((a, b) => effectiveImportance(b) - effectiveImportance(a) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIBRARY_SAMPLE)
    .map((e) => e.text);
  const recent = [...past].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const by = (st: SuggestionStatus) => recent.filter((s) => s.status === st).slice(0, HISTORY_SAMPLE).map((s) => s.text);
  const last = lastDecidedSet(past);
  const info = levelInfo(level);
  return {
    count: ASK_COUNT,
    library,
    added: by('added'),
    known: by('known'),
    rejected: by('rejected'),
    pending: by('pending'),
    levelGuide: info.guide,
    avoidCliches: info.level >= 2,
    feedback: last ? `In the most recent set, the learner already knew ${last.known} of ${last.size} expressions${last.known / last.size >= RAISE_LEVEL_KNOWN_SHARE ? ' — go clearly beyond that level' : ''}.` : '',
  };
}

/**
 * Keep the first `n` usable items that are not already in the library or in
 * any earlier suggestion (compared by normalised key), and tidy them up.
 */
export function pickNew(items: SuggestedItem[], taken: Set<string>, n: number): SuggestedItem[] {
  const seen = new Set(taken);
  const out: SuggestedItem[] = [];
  for (const it of items) {
    const text = cleanEnglish(it.text);
    const key = normalizeKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...it,
      text,
      category: CATEGORIES.includes(it.category as Category) ? it.category : 'business',
      importance: Math.max(0, Math.min(100, Math.round(it.importance))),
      examples: it.examples.filter((x) => x.en.trim()).slice(0, 3),
    });
    if (out.length >= n) break;
  }
  return out;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  usage: GenerateUsage | null;
  /** Level the set was requested at, and whether it was raised automatically. */
  level: number;
  levelRaised: boolean;
}

/**
 * Ask the AI for today's suggestions. Without `more`, only when there are none
 * yet today; with `more`, another set after every earlier one is decided (up to
 * MAX_BATCHES_PER_DAY). The level goes up automatically when most of the last
 * set was already known.
 */
export async function requestTodaysSuggestions(now = new Date(), opts: { more?: boolean } = {}): Promise<SuggestResult> {
  const settings = await getSettings();
  const day = dayKey(now, settings.dayStartHour);
  const existing = await suggestionsForDay(day);
  if (existing.length > 0 && !opts.more) return { suggestions: existing, usage: null, level: levelInfo(settings.suggestionLevel).level, levelRaised: false };
  if (opts.more && !canAskMore(existing)) throw new Error('今日の提案をすべて選んでから、もう一度お試しください');
  const batch = existing.length ? Math.max(...existing.map(batchOf)) + 1 : 1;

  const [expressions, past] = await Promise.all([db.expressions.toArray(), db.suggestions.toArray()]);
  const lv = nextLevel(settings.suggestionLevel, settings.suggestionLevelBasis, past);
  if (lv.level !== settings.suggestionLevel || lv.basis !== settings.suggestionLevelBasis) {
    await saveSettings({ suggestionLevel: lv.level, suggestionLevelBasis: lv.basis });
  }
  const { suggestExpressions } = await import('./aiGenerate');
  const { items, usage, model } = await suggestExpressions(buildContext(expressions, past, lv.level));

  const taken = new Set([...expressions.map((e) => e.normalized), ...past.map((s) => s.normalized)]);
  const picked = pickNew(items, taken, DAILY_SUGGESTIONS);
  // createdAt is offset by a millisecond per item so the list keeps the AI's ranking.
  const rows: Suggestion[] = picked.map((it, i) => ({
    id: uid(),
    day,
    text: it.text,
    normalized: normalizeKey(it.text),
    meaning: it.meaning_ja.trim(),
    reason: it.why_ja.trim(),
    category: it.category as Category,
    importance: it.importance,
    examples: it.examples.map((x) => ({ kind: x.kind, en: x.en.trim(), ja: x.ja.trim() })),
    status: 'pending',
    batch,
    level: lv.level,
    model,
    createdAt: new Date(now.getTime() + i).toISOString(),
  }));
  await db.transaction('rw', db.suggestions, async () => {
    // Another tab/press may have saved this set meanwhile.
    const already = await db.suggestions.where('day').equals(day).filter((s) => batchOf(s) >= batch).count();
    if (already === 0) await db.suggestions.bulkPut(rows);
  });
  return { suggestions: await suggestionsForDay(day), usage, level: lv.level, levelRaised: lv.raised };
}

/**
 * Add a suggestion to the library as an ordinary new expression (Reading and
 * Speaking cards). Everything the AI wrote is kept as AI / unverified.
 * Returns the expression id and the id of its first example (for a pronunciation guide).
 */
export async function addSuggestion(id: string, now = new Date()): Promise<{ expressionId: string; firstExampleId: string | null }> {
  return db.transaction('rw', db.suggestions, db.expressions, db.cards, async () => {
    const s = await db.suggestions.get(id);
    if (!s) throw new Error('提案が見つかりません');
    if (s.status === 'added' && s.expressionId) return { expressionId: s.expressionId, firstExampleId: null };

    // Already in the library (e.g. added by hand meanwhile): just link it.
    const dup = await db.expressions.where('normalized').equals(s.normalized).first();
    if (dup) {
      await db.suggestions.put({ ...s, status: 'added', expressionId: dup.id, decidedAt: now.toISOString() });
      return { expressionId: dup.id, firstExampleId: null };
    }

    const ts = now.toISOString();
    const examples: Example[] = s.examples.map((x) => ({ id: uid(), kind: x.kind, en: x.en, ja: x.ja, origin: 'ai', status: 'unverified' }));
    const expr: Expression = {
      id: uid(),
      text: s.text,
      normalized: s.normalized,
      meaning: '',
      notes: '',
      kind: classifyKind(s.text),
      lang: 'en',
      ai: { category: s.category, importance: s.importance, meaning: s.meaning || undefined, rationale: s.reason || undefined, model: s.model, generatedAt: s.createdAt },
      examples,
      tags: ['AI提案'],
      suspended: false,
      usedInRealLife: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await db.expressions.add(expr);
    await db.cards.bulkPut(makeCards(expr.id, now));
    await db.suggestions.put({ ...s, status: 'added', expressionId: expr.id, decidedAt: ts });
    return { expressionId: expr.id, firstExampleId: examples[0]?.id ?? null };
  });
}

export async function decideSuggestion(id: string, status: 'known' | 'rejected' | 'pending'): Promise<void> {
  const s = await db.suggestions.get(id);
  if (!s || s.status === 'added') return;
  await db.suggestions.put({ ...s, status, decidedAt: status === 'pending' ? undefined : nowIso() });
}

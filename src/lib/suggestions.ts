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
import { db, getSettings } from '../db/db';
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

const CATEGORIES: Category[] = ['business', 'daily', 'phrasal_verb', 'idiom', 'academic', 'technical', 'low_priority'];

export async function todayKey(now = new Date()): Promise<string> {
  return dayKey(now, (await getSettings()).dayStartHour);
}

export async function suggestionsForDay(day: string): Promise<Suggestion[]> {
  const xs = await db.suggestions.where('day').equals(day).toArray();
  return xs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Context for the AI request (texts only). */
export function buildContext(expressions: Expression[], past: Suggestion[]): SuggestContext {
  const library = expressions
    .filter((e) => !e.suspended && e.lang !== 'ja' && e.text)
    .sort((a, b) => effectiveImportance(b) - effectiveImportance(a) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIBRARY_SAMPLE)
    .map((e) => e.text);
  const recent = [...past].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const by = (st: SuggestionStatus) => recent.filter((s) => s.status === st).slice(0, HISTORY_SAMPLE).map((s) => s.text);
  return { count: ASK_COUNT, library, added: by('added'), known: by('known'), rejected: by('rejected'), pending: by('pending') };
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

/**
 * Ask the AI for today's suggestions (only when there are none yet today).
 * Returns the saved suggestions and the API usage.
 */
export async function requestTodaysSuggestions(now = new Date()): Promise<{ suggestions: Suggestion[]; usage: GenerateUsage | null }> {
  const day = await todayKey(now);
  const existing = await suggestionsForDay(day);
  if (existing.length > 0) return { suggestions: existing, usage: null };

  const [expressions, past] = await Promise.all([db.expressions.toArray(), db.suggestions.toArray()]);
  const { suggestExpressions } = await import('./aiGenerate');
  const { items, usage, model } = await suggestExpressions(buildContext(expressions, past));

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
    model,
    createdAt: new Date(now.getTime() + i).toISOString(),
  }));
  await db.transaction('rw', db.suggestions, async () => {
    // Another tab/press may have saved today's set meanwhile.
    if ((await db.suggestions.where('day').equals(day).count()) === 0) await db.suggestions.bulkPut(rows);
  });
  return { suggestions: await suggestionsForDay(day), usage };
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

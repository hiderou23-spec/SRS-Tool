/**
 * "コピーした文から追加": add an expression found in a real text (Safari, mail,
 * Slack...), with the sentence it was found in as its first example.
 *
 * - Only the sentence around the selection is kept (and, when AI is used,
 *   sent to Anthropic) — never the whole pasted text.
 * - Expressions the learner picked themselves get a high importance so they
 *   are introduced before the rest of the unstarted pile.
 */
import { db } from '../db/db';
import { CAPTURE_TAG, type Category, type Example, type ExampleKind, type Expression, type PronunciationGuide } from '../db/types';
import { classifyKind, cleanEnglish, normalizeKey } from '../import/clean';
import { makeCards } from '../import/importer';
import { State } from '../srs/scheduler';
import { nowIso, uid } from './util';

/** Longest pasted text handled (characters). */
export const MAX_CAPTURE_CHARS = 10000;
/** Importance given to expressions the learner captured themselves. */
export const CAPTURED_IMPORTANCE = 85;
export { CAPTURE_TAG };

export interface Selection {
  a: number;
  b: number;
}

/** Split pasted text into whitespace-separated tokens (punctuation stays attached). */
export function tokenize(text: string): string[] {
  return text.slice(0, MAX_CAPTURE_CHARS).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Tap toggles a word in or out of the selection (several expressions at once). */
export function toggleToken(selected: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(selected);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  return next;
}

/**
 * Selected words that sit next to each other form one expression
 * ("table" + "the" + "discussion" → "table the discussion"). A run never
 * crosses the end of a sentence.
 */
export function runsOf(tokens: string[], selected: ReadonlySet<number>): Selection[] {
  const idx = [...selected].filter((i) => i >= 0 && i < tokens.length).sort((x, y) => x - y);
  const runs: Selection[] = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last.b + 1 && !endsSentence(tokens[last.b])) last.b = i;
    else runs.push({ a: i, b: i });
  }
  return runs.filter((r) => selectionText(tokens, r) !== '');
}

/** The selected words without surrounding punctuation or quotes. */
export function selectionText(tokens: string[], sel: Selection | null): string {
  if (!sel) return '';
  return tokens
    .slice(sel.a, sel.b + 1)
    .join(' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

const ENDS_SENTENCE = /[.?!。！？]["'”’)\]]*$/;
/** Tokens that end with a period but don't end a sentence. */
const ABBREV = /^(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|inc|ltd|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|u\.s|no)\.$/i;
const endsSentence = (t: string | undefined) => !!t && ENDS_SENTENCE.test(t) && !ABBREV.test(t);

/** The sentence(s) containing the selection, as plain text. */
export function sentenceAround(tokens: string[], sel: Selection): string {
  const ends = endsSentence;
  let start = sel.a;
  while (start > 0 && !ends(tokens[start - 1])) start--;
  let end = sel.b;
  while (end < tokens.length - 1 && !ends(tokens[end])) end++;
  return tokens.slice(start, end + 1).join(' ');
}

export async function findExisting(text: string): Promise<Expression | undefined> {
  const key = normalizeKey(cleanEnglish(text));
  if (!key) return undefined;
  return db.expressions.where('normalized').equals(key).first();
}

/** Active expressions not started yet (shown so the pile doesn't grow unnoticed). */
export async function unstartedCount(): Promise<number> {
  const [exprs, rec] = await Promise.all([db.expressions.toArray(), db.cards.where('mode').equals('recognition').toArray()]);
  const active = new Set(exprs.filter((e) => !e.suspended).map((e) => e.id));
  return rec.filter((c) => active.has(c.expressionId) && (c.introducedAt === null || c.state === State.New)).length;
}

/** What the AI adds (see analyzeCaptured in aiGenerate.ts). */
export interface CaptureAi {
  baseForm: string;
  meaning: string;
  category: Category;
  importance: number;
  sentenceJa: string;
  examples: { kind: ExampleKind; en: string; ja: string }[];
  pronunciation?: PronunciationGuide;
  model?: string;
}

export interface CaptureInput {
  text: string;
  sentence: string;
  /** The learner's own meaning (manual mode). */
  meaning?: string;
  keepSentence: boolean;
  ai?: CaptureAi;
}

/** Create the expression (Reading + Speaking cards). Returns its id. */
export async function addCaptured(input: CaptureInput, now = new Date()): Promise<string> {
  const text = cleanEnglish(input.text);
  const normalized = normalizeKey(text);
  if (!text || !normalized) throw new Error('表現を入力してください');
  const ts = now.toISOString();
  const examples: Example[] = [];
  if (input.keepSentence && input.sentence.trim()) {
    examples.push({
      id: uid(),
      kind: 'business',
      en: input.sentence.trim(),
      ja: input.ai?.sentenceJa?.trim() ?? '',
      // The sentence itself is real; its translation (if any) is AI-made, so it stays unverified.
      origin: 'user',
      status: input.ai ? 'unverified' : 'verified',
    });
  }
  for (const x of input.ai?.examples ?? []) {
    if (examples.length >= 3 || !x.en.trim()) continue;
    examples.push({ id: uid(), kind: x.kind, en: x.en.trim(), ja: x.ja.trim(), origin: 'ai', status: 'unverified' });
  }
  // The guide was written for one specific sentence: attach it only to that example.
  const pron = input.ai?.pronunciation;
  const target = pron && examples.find((x) => x.en === pron.level1.text);
  if (pron && target) target.pronunciation = pron;
  const expr: Expression = {
    id: uid(),
    text,
    normalized,
    meaning: input.meaning?.trim() ?? '',
    notes: '',
    kind: classifyKind(text),
    lang: 'en',
    importance: CAPTURED_IMPORTANCE,
    ...(input.ai
      ? {
          ai: {
            category: input.ai.category,
            importance: Math.max(0, Math.min(100, Math.round(input.ai.importance))),
            meaning: input.ai.meaning || undefined,
            model: input.ai.model,
            generatedAt: ts,
          },
        }
      : {}),
    examples,
    tags: [CAPTURE_TAG],
    suspended: false,
    usedInRealLife: [],
    createdAt: ts,
    updatedAt: nowIso(),
  };
  await db.transaction('rw', db.expressions, db.cards, async () => {
    if (await db.expressions.where('normalized').equals(normalized).first()) throw new Error('すでにライブラリにあります');
    await db.expressions.add(expr);
    await db.cards.bulkPut(makeCards(expr.id, now));
  });
  return expr.id;
}

// ---------------------------------------------------------------------------
// Batch: several expressions picked at once, registered immediately; the AI
// fills them in afterwards (see captureQueue.ts).

export interface BatchItem {
  /** The words as selected (punctuation stripped). */
  text: string;
  sentence: string;
  /** 'new' is registered; 'exists' (in the library) and 'dup' (twice in this batch) are skipped. */
  status: 'new' | 'exists' | 'dup';
}

export function planBatch(tokens: string[], runs: Selection[], libraryKeys: ReadonlySet<string>): BatchItem[] {
  const seen = new Set<string>();
  return runs.map((r) => {
    const text = selectionText(tokens, r);
    const key = normalizeKey(cleanEnglish(text));
    const status: BatchItem['status'] = libraryKeys.has(key) ? 'exists' : seen.has(key) ? 'dup' : 'new';
    seen.add(key);
    return { text, sentence: sentenceAround(tokens, r), status };
  });
}

export async function libraryKeys(): Promise<Set<string>> {
  return new Set((await db.expressions.toArray()).map((e) => e.normalized));
}

/** Register the new items right away (sentence as example, no meaning yet). Returns their ids. */
export async function addBatch(items: BatchItem[], now = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (const it of items) {
    if (it.status !== 'new') continue;
    try {
      // One millisecond apart, so the order they were picked in is kept (pendingAiIds sorts by it).
      ids.push(await addCaptured({ text: it.text, sentence: it.sentence, keepSentence: true }, new Date(now.getTime() + ids.length)));
    } catch {
      // Added meanwhile (e.g. another tab): skip.
    }
  }
  return ids;
}

/**
 * Captured expressions still waiting for the AI: registered from a text, no
 * meaning (own or AI) yet, the found sentence as their first example.
 */
export async function pendingAiIds(): Promise<string[]> {
  const all = await db.expressions.toArray();
  return all
    .filter((e) => e.tags.includes(CAPTURE_TAG) && !e.ai && !e.meaning && e.examples[0]?.origin === 'user' && !e.suspended)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e) => e.id);
}

/**
 * Merge the AI's result into an expression registered by addBatch. The text
 * becomes the AI's base form unless another expression already has it.
 * Returns the rename, if any.
 */
export async function applyCaptureAi(expressionId: string, ai: CaptureAi): Promise<{ from: string; to: string } | null> {
  return db.transaction('rw', db.expressions, async () => {
    const e = await db.expressions.get(expressionId);
    if (!e) return null;
    let rename: { from: string; to: string } | null = null;
    let text = e.text;
    let normalized = e.normalized;
    const base = cleanEnglish(ai.baseForm);
    const baseKey = normalizeKey(base);
    if (base && baseKey && baseKey !== e.normalized) {
      const clash = await db.expressions.where('normalized').equals(baseKey).first();
      if (!clash) {
        rename = { from: e.text, to: base };
        text = base;
        normalized = baseKey;
      }
    }
    const examples = e.examples.map((x, i) => {
      if (i !== 0 || x.origin !== 'user') return x;
      const withJa = x.ja ? x : { ...x, ja: ai.sentenceJa, status: 'unverified' as const };
      return ai.pronunciation && !x.pronunciation && ai.pronunciation.level1.text === x.en ? { ...withJa, pronunciation: ai.pronunciation } : withJa;
    });
    for (const x of ai.examples) {
      if (examples.length >= 3 || !x.en.trim()) continue;
      examples.push({ id: uid(), kind: x.kind, en: x.en.trim(), ja: x.ja.trim(), origin: 'ai', status: 'unverified' });
    }
    await db.expressions.put({
      ...e,
      text,
      normalized,
      kind: classifyKind(text),
      examples,
      ai: {
        category: ai.category,
        importance: Math.max(0, Math.min(100, Math.round(ai.importance))),
        meaning: ai.meaning || undefined,
        model: ai.model,
        generatedAt: nowIso(),
      },
      updatedAt: nowIso(),
    });
    return rename;
  });
}

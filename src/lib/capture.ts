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
export const MAX_CAPTURE_CHARS = 2000;
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

/**
 * Tap logic: first tap selects a word; tapping another word while one word is
 * selected extends to the range between them; tapping inside a range (or the
 * single selected word) starts over / clears.
 */
export function nextSelection(sel: Selection | null, i: number): Selection | null {
  if (!sel) return { a: i, b: i };
  if (sel.a === sel.b) {
    if (i === sel.a) return null;
    return { a: Math.min(sel.a, i), b: Math.max(sel.a, i) };
  }
  return { a: i, b: i };
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

/** The sentence(s) containing the selection, as plain text. */
export function sentenceAround(tokens: string[], sel: Selection): string {
  const ends = (t: string) => ENDS_SENTENCE.test(t) && !ABBREV.test(t);
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
      ...(input.ai?.pronunciation ? { pronunciation: input.ai.pronunciation } : {}),
    });
  }
  for (const x of input.ai?.examples ?? []) {
    if (examples.length >= 3 || !x.en.trim()) continue;
    examples.push({ id: uid(), kind: x.kind, en: x.en.trim(), ja: x.ja.trim(), origin: 'ai', status: 'unverified' });
  }
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

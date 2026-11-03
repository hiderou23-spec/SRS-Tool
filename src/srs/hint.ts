/**
 * Graduated hints for a card the learner can't recall.
 *
 * The goal is to leave as much of the recall to the learner as possible: each
 * step shows a little more, never the whole answer.
 *
 * Speaking (Japanese → English)
 *   1. word shapes with first letters:   h_____ o__
 *   2. about half of each word:          ham___ out
 *   3. (sentence mode) the English sentence with the expression still half
 *      masked: "We need to ham___ out the details."
 * Reading (English → meaning)
 *   1. the English example sentence (context, no translation)
 *
 * A recall that needed a hint should be rated Hard at most (the UI recommends
 * it and disables Easy) so FSRS doesn't overestimate the memory.
 */
import type { Example } from '../db/types';

/** Find the expression (allowing simple inflections) inside a sentence. */
export function findExpression(sentence: string, expr: string): { index: number; length: number } | null {
  const words = expr.replace(/[~〜(（].*$/, '').trim().split(/\s+/).filter((w) => /^[a-z'-]+$/i.test(w));
  if (words.length === 0) return null;
  const pattern = words
    .map((w, i) => (i === 0 && w.length > 2 ? w.replace(/e$/i, '') + "[a-z']*" : w.replace(/[-']/g, '\\$&') + "[a-z']{0,3}"))
    .join('\\s+');
  const m = new RegExp(`\\b(${pattern})\\b`, 'i').exec(sentence);
  return m ? { index: m.index, length: m[0].length } : null;
}

/**
 * Mask the letters of each word, keeping spaces and punctuation.
 * level 1: first letter only; level 2: about half (rounded up).
 * One-letter words ("a", "I") stay visible.
 */
export function maskWords(text: string, level: 1 | 2): string {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const keep = w.length <= 1 ? w.length : level === 1 ? 1 : Math.ceil(w.length / 2);
    return w.slice(0, keep) + '_'.repeat(w.length - keep);
  });
}

export type HintStep =
  | { kind: 'mask'; text: string }
  | { kind: 'sentence-mask'; before: string; masked: string; after: string }
  | { kind: 'context'; sentence: string };

/** The hint steps available for this card, in order. */
export function hintSteps(opts: { isProd: boolean; exprText: string; example?: Example; sentenceMode: boolean }): HintStep[] {
  const { isProd, exprText, example } = opts;
  if (!isProd) {
    return example?.en.trim() ? [{ kind: 'context', sentence: example.en }] : [];
  }
  const target = exprText.trim();
  if (!target || !/[A-Za-z]/.test(target)) return [];
  const steps: HintStep[] = [
    { kind: 'mask', text: maskWords(target, 1) },
    { kind: 'mask', text: maskWords(target, 2) },
  ];
  if (opts.sentenceMode && example) {
    const hit = findExpression(example.en, target);
    if (hit) {
      steps.push({
        kind: 'sentence-mask',
        before: example.en.slice(0, hit.index),
        masked: maskWords(example.en.slice(hit.index, hit.index + hit.length), 2),
        after: example.en.slice(hit.index + hit.length),
      });
    }
  }
  return steps;
}

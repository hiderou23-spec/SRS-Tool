import { findExpression } from '../srs/hint';

/** Highlight the expression (allowing simple inflections) inside an example sentence. */
export function highlight(sentence: string, expr: string) {
  const m = findExpression(sentence, expr);
  if (!m) return sentence;
  return (
    <>
      {sentence.slice(0, m.index)}
      <span className="mark">{sentence.slice(m.index, m.index + m.length)}</span>
      {sentence.slice(m.index + m.length)}
    </>
  );
}

const KANJI = /[\u4e00-\u9fff]/;
const KANA_OR_KANJI_START = /^[\u30a0-\u30ff\u4e00-\u9fff]/;

/**
 * Fallback when an example has no stored focus: the longest piece of the
 * meaning that also appears in the sentence. Deliberately strict (3+ chars,
 * starts with kanji/katakana, contains kanji — or a whole 2+ char sense such
 * as 襟章) so a wrong highlight is rare; when unsure, nothing is highlighted.
 */
export function guessJaFocus(ja: string, meanings: (string | undefined)[]): string | undefined {
  let best = '';
  for (const m of meanings) {
    if (!m) continue;
    const chunks = m.replace(/[（(〔【《〈][^）)〕】》〉]*[）)〕】》〉]/g, '、').split(/[、，,／/・;；\n「」『』。！？!?◆~〜…\s]+/);
    for (const c of chunks) {
      // A whole sense of the meaning found as is (e.g. 襟章) is safe even when short.
      if (c.length >= 2 && c.length > best.length && KANA_OR_KANJI_START.test(c) && /[゠-ヿ一-鿿]{2}/.test(c) && ja.includes(c)) best = c;
      for (let len = Math.min(c.length, 12); len >= 3 && len > best.length; len--) {
        for (let i = 0; i + len <= c.length; i++) {
          const piece = c.slice(i, i + len);
          if (KANA_OR_KANJI_START.test(piece) && KANJI.test(piece) && ja.includes(piece)) {
            best = piece;
            break;
          }
        }
      }
      // An inflected verb (降りる → 降りた): match its stem, then the okurigana is added below.
      if (/[うくすつぬむるぐぶ]$/.test(c)) {
        const stem = c.slice(0, -1);
        for (let i = 0; stem.length - i >= 2 && stem.length - i > best.length; i++) {
          const piece = stem.slice(i);
          if (KANJI.test(piece[0]) && ja.includes(piece)) {
            best = piece;
            break;
          }
        }
      }
    }
  }
  if (!best) return undefined;
  // Include trailing okurigana (e.g. 具体化 → 具体化して is too much; 固め → 固めたい is fine up to 2 chars).
  const at = ja.indexOf(best);
  let end = at + best.length;
  while (end < ja.length && end - (at + best.length) < 2 && /[\u3041-\u3093]/.test(ja[end]) && !'をはがにでとのもへやか'.includes(ja[end])) end++;
  return ja.slice(at, end);
}

/** Highlight the span of a Japanese sentence that the learner should say in English. */
export function highlightJa(ja: string, focus: string | undefined) {
  if (!focus) return ja;
  const at = ja.indexOf(focus);
  if (at < 0) return ja;
  return (
    <>
      {ja.slice(0, at)}
      <span className="mark">{focus}</span>
      {ja.slice(at + focus.length)}
    </>
  );
}

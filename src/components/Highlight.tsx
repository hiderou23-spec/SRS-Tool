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

/** Highlight the expression (allowing simple inflections) inside an example sentence. */
export function highlight(sentence: string, expr: string) {
  const words = expr.replace(/[~〜(（].*$/, '').trim().split(/\s+/).filter((w) => /^[a-z'-]+$/i.test(w));
  if (words.length === 0) return sentence;
  const pattern = words.map((w, i) => (i === 0 && w.length > 2 ? w.replace(/e$/i, '') + "[a-z']*" : w.replace(/[-']/g, '\\$&') + "[a-z']{0,3}")).join('\\s+');
  const m = new RegExp(`\\b(${pattern})\\b`, 'i').exec(sentence);
  if (!m) return sentence;
  return (
    <>
      {sentence.slice(0, m.index)}
      <span className="mark">{m[0]}</span>
      {sentence.slice(m.index + m[0].length)}
    </>
  );
}


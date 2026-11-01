/** Text cleaning for imported data. The raw value is always kept separately. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

/** Strip HTML tags; <br>, </p>, </div>, </li> become line breaks. */
export function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h\d)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

/** Full-width ASCII → half-width (Ａ→A, （→( , ！→!) and ideographic space → space. */
export function toHalfWidthAscii(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

export function cleanText(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = String(raw).replace(/\r\n?/g, '\n');
  s = stripHtml(s);
  s = decodeEntities(s);
  s = s.replace(/[​-‍﻿]/g, '');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
  return s;
}

/** Cleaning specific to the English side: half-width, unified apostrophes, single line. */
export function cleanEnglish(raw: string | undefined | null): string {
  let s = cleanText(raw);
  s = toHalfWidthAscii(s);
  s = s.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s;
}

/**
 * Normalised key for duplicate detection. Deliberately conservative:
 * case, punctuation at the ends, "~/…/sth/someone" placeholders and
 * whitespace are ignored, but word content is not changed.
 */
export function normalizeKey(english: string): string {
  let s = english.toLowerCase();
  s = s.replace(/[‘’`´]/g, "'");
  s = s.replace(/\(.*?\)|\[.*?\]/g, ' '); // parenthetical notes
  s = s.replace(/[~〜～…]/g, ' ');
  s = s.replace(/\b(sth|sb|something|someone|somebody|one's|oneself|o\.s\.|s\.o\.|s\.t\.)\b/g, ' ');
  s = s.replace(/^[\s"'.,!?;:-]+|[\s"'.,!?;:-]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Some apps export "Definition of: 'word' is: 'http://…'" — keep just the word. */
export function extractEnglishTerm(s: string): string {
  const m = /^Definition of:\s*'([^']+)'\s*is:/i.exec(s);
  return m ? m[1] : s;
}

export function classifyKind(english: string): 'word' | 'phrase' | 'sentence' {
  const words = english.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return 'word';
  if (words.length >= 6 || /[.?!]$/.test(english)) return 'sentence';
  return 'phrase';
}

const JA_RE = /[぀-ヿ㐀-鿿]/;
const LATIN_RE = /[A-Za-z]/;

export function looksJapanese(s: string): boolean {
  return JA_RE.test(s);
}

export function latinRatio(s: string): number {
  const letters = [...s].filter((c) => LATIN_RE.test(c) || JA_RE.test(c));
  if (letters.length === 0) return 0;
  return letters.filter((c) => LATIN_RE.test(c)).length / letters.length;
}

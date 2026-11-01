import Papa from 'papaparse';
import { cleanEnglish, latinRatio, looksJapanese } from './clean';

export interface DecodedFile {
  text: string;
  encoding: string;
}

/** Decode bytes: UTF-8 (with/without BOM), UTF-16 (BOM), otherwise Shift_JIS. */
export function decodeBytes(bytes: Uint8Array): DecodedFile {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8 (lossy)' };
    }
  }
}

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 50).join('\n');
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const res = Papa.parse<string[]>(sample, { delimiter: d, skipEmptyLines: true });
    const rows = res.data.filter((r) => r.length > 1);
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const mode = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const consistency = rows.filter((r) => r.length === mode).length / res.data.length;
    const score = consistency * Math.min(mode, 6) * (rows.length / Math.max(1, res.data.length));
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseRows(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: 'greedy' });
  return res.data.map((r) => r.map((c) => (c ?? '').toString()));
}

export interface ColumnGuess {
  englishCol: number;
  japaneseCol: number;
  hasHeader: boolean;
  columnCount: number;
}

const HEADER_WORDS = /^(question|answer|front|back|english|japanese|word|meaning|英語|日本語|問題|答え|解答|表|裏|単語|意味|メモ|備考|note|notes|ヒント)$/i;

/** Guess which column is English and which is Japanese. */
export function guessColumns(rows: string[][]): ColumnGuess {
  const columnCount = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  const sample = rows.slice(1, 300);
  const latinScores: number[] = [];
  const jaScores: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    const vals = sample.map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    const n = Math.max(1, vals.length);
    latinScores.push(vals.reduce((s, v) => s + (latinRatio(cleanEnglish(v)) > 0.8 ? 1 : 0), 0) / n * (vals.length / Math.max(1, sample.length)));
    jaScores.push(vals.reduce((s, v) => s + (looksJapanese(v) ? 1 : 0), 0) / n * (vals.length / Math.max(1, sample.length)));
  }
  let englishCol = latinScores.indexOf(Math.max(...latinScores));
  if (englishCol < 0) englishCol = 0;
  let japaneseCol = -1;
  let best = -1;
  jaScores.forEach((s, i) => {
    if (i !== englishCol && s > best) {
      best = s;
      japaneseCol = i;
    }
  });
  if (japaneseCol < 0) japaneseCol = columnCount > 1 ? (englishCol === 0 ? 1 : 0) : -1;
  const first = rows[0] ?? [];
  const hasHeader = first.length > 0 && first.some((c) => HEADER_WORDS.test(c.trim()));
  return { englishCol, japaneseCol, hasHeader, columnCount };
}

import { db } from '../db/db';
import type {
  DuplicateGroup,
  Expression,
  ImportBatch,
  ImportMapping,
  ImportStats,
  RawImportRow,
  ReviewCard,
} from '../db/types';
import { hash64, nowIso, uid } from '../lib/util';
import { newCardData } from '../srs/scheduler';
import { classifyKind, cleanEnglish, cleanText, extractEnglishTerm, latinRatio, normalizeKey } from './clean';

export interface AnalyzedRow {
  rowIndex: number;
  cells: string[];
  english: string;
  meaning: string;
  notes: string;
  normalized: string;
  sourceKey: string;
  status: 'new' | 'already_imported' | 'exact_duplicate' | 'failed';
  lang: 'en' | 'ja';
  reason?: string;
  /** Same normalized English exists (in DB or earlier in file) with a different meaning. */
  duplicateCandidate: boolean;
}

export interface ImportAnalysis {
  rows: AnalyzedRow[];
  stats: ImportStats;
  fileAlreadyImported: boolean;
}

export function sourceKeyFor(english: string, meaning: string): string {
  return hash64(normalizeKey(english) + '\u0000' + meaning.replace(/\s+/g, ''));
}

export async function analyzeImport(rows: string[][], mapping: ImportMapping, fileHash: string): Promise<ImportAnalysis> {
  const existing = await db.expressions.toArray();
  const existingKeys = new Set(existing.map((e) => e.source?.sourceKey).filter(Boolean) as string[]);
  // Also treat manually-created expressions with the same text+meaning as already present.
  for (const e of existing) existingKeys.add(sourceKeyFor(e.text, e.meaning));
  const existingNorm = new Map<string, string[]>();
  for (const e of existing) existingNorm.set(e.normalized, [...(existingNorm.get(e.normalized) ?? []), e.meaning]);

  const fileAlreadyImported = (await db.imports.where('fileHash').equals(fileHash).count()) > 0;

  const seenKeys = new Set<string>();
  const seenNorm = new Map<string, number>();
  const out: AnalyzedRow[] = [];
  const start = mapping.hasHeader ? 1 : 0;

  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    const english = extractEnglishTerm(cleanEnglish(cells[mapping.englishCol]));
    const meaningRaw = mapping.japaneseCol < 0 ? '' : mapping.joinRestIntoMeaning ? cells.slice(mapping.japaneseCol).join(',') : cells[mapping.japaneseCol];
    const meaning = cleanText(meaningRaw).replace(/,+$/, '').trim();
    const notes = mapping.notesCols
      .filter((c) => c !== mapping.englishCol && c !== mapping.japaneseCol && !(mapping.joinRestIntoMeaning && c > mapping.japaneseCol))
      .map((c) => cleanText(cells[c]))
      .filter(Boolean)
      .join('\n');
    const normalized = normalizeKey(english);
    const sourceKey = sourceKeyFor(english, meaning);
    const row: AnalyzedRow = { rowIndex: i, cells, english, meaning, notes, normalized, sourceKey, status: 'new', duplicateCandidate: false, lang: latinRatio(english) < 0.5 ? 'ja' : 'en' };

    if (!english || !normalized) {
      row.status = 'failed';
      row.reason = cells.every((c) => !c.trim()) ? '空行' : '英語表現が空欄';
    } else if (/^reminDOは勉強したこと/.test(english)) {
      row.status = 'failed';
      row.reason = 'reminDOアプリの説明文（学習データではありません）';
    } else if (english.length > (row.lang === 'ja' ? 1000 : 400)) {
      row.status = 'failed';
      row.reason = '英語表現が長すぎます（400文字超）';
    } else if (existingKeys.has(sourceKey)) {
      row.status = 'already_imported';
    } else if (seenKeys.has(sourceKey)) {
      row.status = 'exact_duplicate';
    } else {
      const inDb = existingNorm.has(normalized);
      const inFile = seenNorm.has(normalized);
      row.duplicateCandidate = inDb || inFile;
    }
    if (row.status === 'new') {
      seenKeys.add(sourceKey);
      seenNorm.set(normalized, (seenNorm.get(normalized) ?? 0) + 1);
    }
    out.push(row);
  }

  // Mark the first occurrence in the file as a candidate too when later rows collide.
  for (const r of out) {
    if (r.status === 'new' && !r.duplicateCandidate && (seenNorm.get(r.normalized) ?? 0) > 1) r.duplicateCandidate = true;
  }

  const newRows = out.filter((r) => r.status === 'new');
  const stats: ImportStats = {
    totalRows: out.length,
    imported: newRows.length,
    failed: out.filter((r) => r.status === 'failed').length,
    skippedAlreadyImported: out.filter((r) => r.status === 'already_imported').length,
    exactDuplicateRows: out.filter((r) => r.status === 'exact_duplicate').length,
    missingMeaning: newRows.filter((r) => !r.meaning).length,
    duplicateCandidates: newRows.filter((r) => r.duplicateCandidate).length,
    japaneseTerms: newRows.filter((r) => r.lang === 'ja').length,
    failures: out.filter((r) => r.status === 'failed').map((r) => ({ rowIndex: r.rowIndex, reason: r.reason! })),
  };
  return { rows: out, stats, fileAlreadyImported };
}

export function makeCards(expressionId: string, now = new Date()): ReviewCard[] {
  return (['recognition', 'production'] as const).map((mode) => {
    const fsrs = newCardData(now);
    return { id: `${expressionId}:${mode}`, expressionId, mode, fsrs, introducedAt: null, due: fsrs.due, state: fsrs.state };
  });
}

export async function commitImport(
  analysis: ImportAnalysis,
  mapping: ImportMapping,
  fileName: string,
  fileHash: string,
): Promise<ImportBatch> {
  const importId = uid();
  const now = new Date();
  const ts = now.toISOString();
  const expressions: Expression[] = [];
  const cards: ReviewCard[] = [];
  const rawRows: RawImportRow[] = [];
  const keyToId = new Map<string, string>();
  for (const e of await db.expressions.toArray()) if (e.source) keyToId.set(e.source.sourceKey, e.id);

  for (const r of analysis.rows) {
    let expressionId: string | null = null;
    if (r.status === 'new') {
      const id = uid();
      expressionId = id;
      keyToId.set(r.sourceKey, id);
      expressions.push({
        id,
        text: r.english,
        normalized: r.normalized,
        meaning: r.meaning,
        notes: r.notes,
        kind: classifyKind(r.english),
        lang: r.lang,
        examples: [],
        tags: [],
        suspended: false,
        usedInRealLife: [],
        source: { importId, rowIndex: r.rowIndex, sourceKey: r.sourceKey },
        createdAt: ts,
        updatedAt: ts,
      });
      cards.push(...makeCards(id, now));
    } else if (r.status === 'already_imported' || r.status === 'exact_duplicate') {
      expressionId = keyToId.get(r.sourceKey) ?? null;
    }
    rawRows.push({ id: `${importId}:${r.rowIndex}`, importId, rowIndex: r.rowIndex, cells: r.cells, expressionId });
  }

  const batch: ImportBatch = { id: importId, fileName, fileHash, importedAt: ts, mapping, stats: analysis.stats };

  await db.transaction('rw', [db.expressions, db.cards, db.rawRows, db.imports, db.duplicates], async () => {
    await db.expressions.bulkAdd(expressions);
    await db.cards.bulkAdd(cards);
    await db.rawRows.bulkPut(rawRows);
    await db.imports.add(batch);
    await refreshDuplicateGroups();
  });
  return batch;
}

/** Recompute duplicate candidate groups (same normalized English, ≥2 expressions). */
export async function refreshDuplicateGroups(): Promise<void> {
  const all = await db.expressions.toArray();
  const byNorm = new Map<string, string[]>();
  for (const e of all) byNorm.set(e.normalized, [...(byNorm.get(e.normalized) ?? []), e.id]);
  const existing = new Map((await db.duplicates.toArray()).map((g) => [g.id, g]));
  const groups: DuplicateGroup[] = [];
  const toDelete: string[] = [];
  for (const [norm, ids] of byNorm) {
    const prev = existing.get(norm);
    if (ids.length < 2) {
      if (prev) toDelete.push(norm);
      continue;
    }
    const sameMembers = prev && prev.expressionIds.length === ids.length && ids.every((id) => prev.expressionIds.includes(id));
    groups.push({
      id: norm,
      expressionIds: ids,
      resolution: sameMembers ? prev!.resolution : 'pending',
      updatedAt: sameMembers ? prev!.updatedAt : nowIso(),
    });
  }
  for (const id of existing.keys()) if (!byNorm.has(id)) toDelete.push(id);
  await db.duplicates.bulkDelete(toDelete);
  await db.duplicates.bulkPut(groups);
}

export async function fileHashOf(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle is unavailable on insecure origins; fall back to a fast hash.
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return 'fnv-' + hash64(s);
  }
}

import Papa from 'papaparse';
import { db, saveSettings } from '../db/db';
import { SCHEMA_VERSION, type Settings } from '../db/types';
import { nowIso } from './util';
import { effectiveImportance } from '../srs/queue';

export const BACKUP_FORMAT = 'english-mastery-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  app: string;
  counts: Record<string, number>;
  data: {
    expressions: unknown[];
    cards: unknown[];
    logs: unknown[];
    sessions: unknown[];
    imports: unknown[];
    rawRows: unknown[];
    duplicates: unknown[];
    settings: unknown[];
  };
}

const TABLES = ['expressions', 'cards', 'logs', 'sessions', 'imports', 'rawRows', 'duplicates', 'settings'] as const;

export async function createBackup(): Promise<BackupFile> {
  const data = {} as BackupFile['data'];
  await db.transaction('r', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) data[t] = await db.table(t).toArray();
  });
  const counts = Object.fromEntries(TABLES.map((t) => [t, data[t].length]));
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), app: 'English Mastery', counts, data };
}

export function validateBackup(obj: unknown): { ok: true; backup: BackupFile } | { ok: false; error: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'JSONの形式が正しくありません' };
  const b = obj as Partial<BackupFile>;
  if (b.format !== BACKUP_FORMAT) return { ok: false, error: 'English Masteryのバックアップファイルではありません' };
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION)
    return { ok: false, error: `未対応のバージョンです (schema ${b.schemaVersion})。アプリを更新してください` };
  if (!b.data) return { ok: false, error: 'data がありません' };
  for (const t of TABLES) {
    if (!Array.isArray((b.data as Record<string, unknown>)[t])) return { ok: false, error: `${t} がありません` };
  }
  const exprIds = new Set((b.data.expressions as { id: string }[]).map((e) => e.id));
  const orphan = (b.data.cards as { expressionId: string }[]).filter((c) => !exprIds.has(c.expressionId)).length;
  if (orphan > 0) return { ok: false, error: `カード${orphan}件が対応する表現を持っていません（ファイル破損の可能性）` };
  return { ok: true, backup: b as BackupFile };
}

/** Replace all local data with the backup (atomic: on failure nothing changes). */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      await db.table(t).bulkPut(backup.data[t] as never[]);
    }
  });
}

export function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Share sheet on iOS (lets the user save to Files/iCloud Drive); falls back to download. */
export async function shareOrDownload(name: string, content: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  try {
    const file = new File([content], name, { type: mime });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
  }
  downloadFile(name, content, mime);
  return 'downloaded';
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function exportBackupJson(): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const backup = await createBackup();
  const result = await shareOrDownload(`english-mastery-backup-${stamp()}.json`, JSON.stringify(backup), 'application/json');
  if (result !== 'cancelled') await saveSettings({ lastBackupAt: nowIso() } as Partial<Settings>);
  return result;
}

export async function buildCsv(): Promise<string> {
  const [exprs, cards] = await Promise.all([db.expressions.toArray(), db.cards.toArray()]);
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const rows = exprs.map((e) => {
    const rec = cardMap.get(`${e.id}:recognition`);
    const prod = cardMap.get(`${e.id}:production`);
    const ex = (i: number) => e.examples[i];
    return {
      english: e.text,
      japanese: e.meaning,
      notes: e.notes,
      category: e.category ?? e.ai?.category ?? '',
      importance: effectiveImportance(e),
      importance_source: e.importance != null ? 'user' : e.ai ? 'ai' : 'default',
      tags: e.tags.join(' '),
      suspended: e.suspended ? 1 : 0,
      example1_en: ex(0)?.en ?? '', example1_ja: ex(0)?.ja ?? '',
      example2_en: ex(1)?.en ?? '', example2_ja: ex(1)?.ja ?? '',
      example3_en: ex(2)?.en ?? '', example3_ja: ex(2)?.ja ?? '',
      reading_state: rec?.state ?? '', reading_due: rec?.due ?? '', reading_stability: rec?.fsrs.stability ?? '', reading_reps: rec?.fsrs.reps ?? '',
      speaking_state: prod?.state ?? '', speaking_due: prod?.due ?? '', speaking_stability: prod?.fsrs.stability ?? '', speaking_reps: prod?.fsrs.reps ?? '',
      id: e.id,
    };
  });
  return '﻿' + Papa.unparse(rows);
}

export async function exportCsv() {
  return shareOrDownload(`english-mastery-${stamp()}.csv`, await buildCsv(), 'text/csv');
}

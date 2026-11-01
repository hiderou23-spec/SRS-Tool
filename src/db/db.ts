import Dexie, { type EntityTable } from 'dexie';
import type {
  DuplicateGroup,
  Expression,
  ImportBatch,
  RawImportRow,
  ReviewCard,
  ReviewLogEntry,
  Settings,
  StudySession,
} from './types';
import { DEFAULT_SETTINGS } from './types';

export class EnglishMasteryDB extends Dexie {
  expressions!: EntityTable<Expression, 'id'>;
  cards!: EntityTable<ReviewCard, 'id'>;
  logs!: EntityTable<ReviewLogEntry, 'id'>;
  sessions!: EntityTable<StudySession, 'id'>;
  imports!: EntityTable<ImportBatch, 'id'>;
  rawRows!: EntityTable<RawImportRow, 'id'>;
  duplicates!: EntityTable<DuplicateGroup, 'id'>;
  settings!: EntityTable<Settings, 'id'>;

  constructor(name = 'english-mastery') {
    super(name);
    this.version(1).stores({
      expressions: 'id, normalized, source.sourceKey, category, updatedAt',
      cards: 'id, expressionId, mode, due, state, [mode+state]',
      logs: 'id, cardId, expressionId, reviewedAt, sessionId, mode',
      sessions: 'id, day, startedAt',
      imports: 'id, fileHash, importedAt',
      rawRows: 'id, importId',
      duplicates: 'id, resolution',
      settings: 'id',
    });
  }
}

export let db = new EnglishMasteryDB();

/** For tests: swap to a fresh database. */
export function useDatabase(name: string) {
  db = new EnglishMasteryDB(name);
  return db;
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch, id: 'settings' as const };
  await db.settings.put(next);
  return next;
}

/** Ask the browser not to evict our data (best-effort; Safari may decline). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return null;
}

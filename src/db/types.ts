/**
 * English Mastery — data model.
 *
 * Design principles
 * - Plain serialisable objects only (no class instances) so that the same
 *   shapes can be written to IndexedDB, to a JSON backup, and later to a
 *   cloud store without conversion.
 * - Original imported data is kept verbatim (`RawImportRow`) and never
 *   overwritten. Cleaned values live on `Expression`.
 * - Anything produced by AI is stored separately from user/imported values
 *   and carries provenance (`origin`, `verified`).
 * - Reading (recognition) and Speaking (production) have independent review
 *   states and logs. Listening is modelled but not used yet (Phase 3).
 */

export const SCHEMA_VERSION = 1;

/** Learning modes. `listening` is reserved for Phase 3. */
export type StudyMode = 'recognition' | 'production' | 'listening';
export const ACTIVE_MODES: StudyMode[] = ['recognition', 'production'];

export type Category =
  | 'business'
  | 'daily'
  | 'phrasal_verb'
  | 'idiom'
  | 'academic'
  | 'technical'
  | 'low_priority';

export const CATEGORY_LABELS: Record<Category, string> = {
  business: 'Business English',
  daily: 'Daily Conversation',
  phrasal_verb: 'Phrasal Verbs',
  idiom: 'Idioms',
  academic: 'Academic English',
  technical: 'Technical / Specialized',
  low_priority: 'Low Priority',
};

/** Where a piece of content came from. */
export type Origin = 'imported' | 'user' | 'ai' | 'sample';

/** Review status for content whose correctness matters (examples, pronunciation). */
export type QualityStatus = 'unverified' | 'needs_review' | 'verified';

export interface PronunciationLevel {
  /** English-letter respelling, e.g. "We need tuh hammer-rout the details". */
  text?: string;
  katakana?: string;
  ipa?: string;
}

export interface PronunciationGuide {
  /** Level 1: careful/citation pronunciation (the sentence itself + optional IPA/katakana). */
  level1: PronunciationLevel;
  /** Level 2: natural conversational connected speech. */
  level2?: PronunciationLevel;
  /** Level 3: fast/casual. Omitted when it would be an unnatural forced change. */
  level3?: PronunciationLevel;
  /** Notes explaining which processes occur (linking, reduction, elision, assimilation). */
  notes?: string;
  /** True when there is little or no connected-speech change worth showing. */
  minimalChange?: boolean;
  origin: Origin;
  status: QualityStatus;
}

export type ExampleKind = 'business' | 'daily' | 'alternative';

export interface Example {
  id: string;
  kind: ExampleKind;
  en: string;
  ja: string;
  origin: Origin;
  status: QualityStatus;
  pronunciation?: PronunciationGuide;
}

/** AI classification is kept apart from the user's own values. */
export interface AiAssessment {
  category: Category;
  importance: number; // 0-100
  rationale?: string;
  model?: string;
  generatedAt: string;
}

export interface Expression {
  id: string;
  /** Cleaned English expression shown on the card. */
  text: string;
  /** Normalised key used for duplicate detection (lowercase, quotes unified, etc.). */
  normalized: string;
  /** Cleaned Japanese meaning (may be empty). */
  meaning: string;
  /** Situation description used as a Production prompt (optional, falls back to meaning). */
  productionPrompt?: string;
  notes: string;
  kind: 'word' | 'phrase' | 'sentence';
  /** User-set category; overrides AI category when present. */
  category?: Category;
  /** User-set importance 0-100; overrides AI importance when present. */
  importance?: number;
  ai?: AiAssessment;
  examples: Example[];
  tags: string[];
  /** Excluded from study (still kept). */
  suspended: boolean;
  /** Self-reported: dates the user said they actually used it in real conversation. */
  usedInRealLife: string[];
  /** Import provenance. */
  source?: {
    importId: string;
    rowIndex: number;
    /** Stable hash of the cleaned (text, meaning) pair; makes re-import idempotent. */
    sourceKey: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** FSRS card state, serialised (Dates as ISO strings). Mirrors ts-fsrs `Card`. */
export interface FsrsCardData {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  /** 0 New, 1 Learning, 2 Review, 3 Relearning */
  state: number;
  last_review?: string;
}

/** One review card = one expression × one mode. id = `${expressionId}:${mode}` */
export interface ReviewCard {
  id: string;
  expressionId: string;
  mode: StudyMode;
  fsrs: FsrsCardData;
  /** When this card was first shown to the user (null = still new / not introduced). */
  introducedAt: string | null;
  /** Denormalised for indexing: fsrs.due */
  due: string;
  /** Denormalised for indexing: fsrs.state */
  state: number;
}

export type RatingValue = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface ReviewLogEntry {
  id: string;
  cardId: string;
  expressionId: string;
  mode: StudyMode;
  rating: RatingValue;
  reviewedAt: string;
  /** Time spent on this card (ms, active only, capped). */
  durationMs: number;
  sessionId: string | null;
  /** State before the review (for analytics and undo). */
  before: FsrsCardData;
  /** State after the review. */
  after: FsrsCardData;
  /** Retrievability at review time (null for new cards). */
  retrievability: number | null;
  wasIntroduction: boolean;
}

export interface StudySession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  targetMinutes: number;
  activeMs: number;
  /** Remaining queue (card ids) so the session can resume after the app is closed. */
  queue: string[];
  /** Cards answered in this session. */
  done: string[];
  /** Learning-step cards that came back within the session. */
  reviewedCount: number;
  newCount: number;
  /** Local date key YYYY-MM-DD */
  day: string;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  fileHash: string;
  importedAt: string;
  mapping: ImportMapping;
  stats: ImportStats;
}

export interface ImportMapping {
  hasHeader: boolean;
  delimiter: string;
  encoding: string;
  englishCol: number;
  japaneseCol: number;
  notesCols: number[];
}

export interface ImportStats {
  totalRows: number;
  imported: number;
  failed: number;
  skippedAlreadyImported: number;
  /** Rows identical (same English + same meaning) to an earlier row in the same file. */
  exactDuplicateRows: number;
  missingMeaning: number;
  duplicateCandidates: number;
  failures: { rowIndex: number; reason: string }[];
}

/** Verbatim copy of each source row. Never modified. */
export interface RawImportRow {
  id: string; // `${importId}:${rowIndex}`
  importId: string;
  rowIndex: number;
  cells: string[];
  expressionId: string | null;
}

/** Duplicate candidate group awaiting the user's decision. */
export interface DuplicateGroup {
  id: string; // normalized key
  expressionIds: string[];
  resolution: 'pending' | 'keep_all' | 'merged';
  updatedAt: string;
}

export interface Settings {
  id: 'settings';
  desiredRetention: number;
  maximumIntervalDays: number;
  enableFuzz: boolean;
  sessionMinutes: 5 | 10 | 15;
  newPerDay: number;
  /** Production cards are introduced only after the recognition card is this stable (days). */
  productionUnlockStabilityDays: number;
  showKatakana: boolean;
  showIpa: boolean;
  showSlurred: boolean;
  theme: 'system' | 'light' | 'dark';
  lastBackupAt: string | null;
  dayStartHour: number;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  desiredRetention: 0.9,
  maximumIntervalDays: 365 * 3,
  enableFuzz: true,
  sessionMinutes: 10,
  newPerDay: 10,
  productionUnlockStabilityDays: 7,
  showKatakana: true,
  showIpa: false,
  showSlurred: true,
  theme: 'system',
  lastBackupAt: null,
  dayStartHour: 4,
};

/**
 * Apply an AI classification file to the library.
 * The result goes into `expression.ai` only — the user's own category /
 * importance and the imported data are never touched.
 */
import { db } from '../db/db';
import type { Category, Example, ExampleKind, PronunciationGuide } from '../db/types';
import { CATEGORY_LABELS } from '../db/types';
import { normalizeKey } from '../import/clean';
import { nowIso, uid } from './util';

export const AI_FORMAT = 'english-mastery-ai-assessment';

export interface AiAssessmentFile {
  format: typeof AI_FORMAT;
  version: number;
  model?: string;
  generatedAt?: string;
  /**
   * category / importance may be left out by a file that only fills in
   * examples and pronunciation guides; existing AI values are then kept.
   */
  items: { key?: string; text: string; category?: Category; importance?: number; rationale?: string; meaning?: string; examples?: { kind: ExampleKind; en: string; ja: string; pronunciation?: Omit<PronunciationGuide, 'origin' | 'status'> }[] }[];
}

export function validateAiFile(obj: unknown): { ok: true; file: AiAssessmentFile } | { ok: false; error: string } {
  const f = obj as Partial<AiAssessmentFile>;
  if (!f || f.format !== AI_FORMAT || !Array.isArray(f.items)) return { ok: false, error: 'AI分類ファイルではありません' };
  const bad = f.items.filter(
    (i) => (i.category != null && !(i.category in CATEGORY_LABELS)) || (i.importance != null && typeof i.importance !== 'number'),
  ).length;
  if (bad > 0) return { ok: false, error: `不正な行が${bad}件あります` };
  return { ok: true, file: f as AiAssessmentFile };
}

export interface ApplyResult {
  items: number;
  matchedExpressions: number;
  unmatchedItems: number;
  userOverridesKept: number;
  examplesAdded: number;
  pronunciationsAdded: number;
}

export async function applyAiAssessment(file: AiAssessmentFile): Promise<ApplyResult> {
  const byKey = new Map<string, AiAssessmentFile['items'][number]>();
  for (const it of file.items) byKey.set(it.key ?? normalizeKey(it.text), it);
  const ts = nowIso();
  let matched = 0;
  let overrides = 0;
  let examplesAdded = 0;
  let pronunciationsAdded = 0;
  const guide = (g: Omit<PronunciationGuide, 'origin' | 'status'>): PronunciationGuide => ({ ...g, origin: 'ai', status: 'needs_review' });
  const usedKeys = new Set<string>();
  await db.transaction('rw', db.expressions, async () => {
    const all = await db.expressions.toArray();
    const updates = [];
    for (const e of all) {
      const it = byKey.get(e.normalized);
      if (!it) continue;
      usedKeys.add(e.normalized);
      matched++;
      if (e.category != null || e.importance != null) overrides++;
      // Existing examples are never changed or removed. A guide is attached to an
      // existing example with the same sentence where it has none yet...
      let examples: Example[] = e.examples.map((ex) => {
        const src = it.examples?.find((x) => x.pronunciation && x.en.trim() === ex.en.trim());
        if (!src || ex.pronunciation) return ex;
        pronunciationsAdded++;
        return { ...ex, pronunciation: guide(src.pronunciation!) };
      });
      // ...and new sentences fill the expression up to 3 examples.
      if (it.examples?.length && examples.length < 3) {
        const have = new Set(examples.map((x) => x.en.trim()));
        const extra: Example[] = it.examples
          .filter((x) => x.en.trim() && !have.has(x.en.trim()))
          .slice(0, 3 - examples.length)
          .map((x) => ({
            id: uid(), kind: x.kind, en: x.en.trim(), ja: x.ja, origin: 'ai' as const, status: 'unverified' as const,
            ...(x.pronunciation ? { pronunciation: guide(x.pronunciation) } : {}),
          }));
        if (extra.length) {
          examples = [...examples, ...extra];
          examplesAdded++;
          pronunciationsAdded += extra.filter((x) => x.pronunciation).length;
        }
      }
      // AI values: what the file gives; anything it leaves out keeps its current value.
      const category = it.category ?? e.ai?.category;
      const importance = it.importance ?? e.ai?.importance;
      const ai =
        category != null && importance != null
          ? {
              ...e.ai,
              category,
              importance: Math.max(0, Math.min(100, Math.round(importance))),
              rationale: it.rationale ?? e.ai?.rationale,
              meaning: it.meaning ?? e.ai?.meaning,
              model: file.model ?? e.ai?.model,
              generatedAt: file.generatedAt ?? ts,
            }
          : e.ai;
      updates.push({ ...e, examples, ...(ai ? { ai } : {}) });
    }
    await db.expressions.bulkPut(updates);
  });
  return { items: file.items.length, matchedExpressions: matched, unmatchedItems: file.items.length - usedKeys.size, userOverridesKept: overrides, examplesAdded, pronunciationsAdded };
}

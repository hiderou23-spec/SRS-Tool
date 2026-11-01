/**
 * Apply an AI classification file to the library.
 * The result goes into `expression.ai` only — the user's own category /
 * importance and the imported data are never touched.
 */
import { db } from '../db/db';
import type { Category } from '../db/types';
import { CATEGORY_LABELS } from '../db/types';
import { normalizeKey } from '../import/clean';
import { nowIso } from './util';

export const AI_FORMAT = 'english-mastery-ai-assessment';

export interface AiAssessmentFile {
  format: typeof AI_FORMAT;
  version: number;
  model?: string;
  generatedAt?: string;
  items: { key?: string; text: string; category: Category; importance: number; rationale?: string }[];
}

export function validateAiFile(obj: unknown): { ok: true; file: AiAssessmentFile } | { ok: false; error: string } {
  const f = obj as Partial<AiAssessmentFile>;
  if (!f || f.format !== AI_FORMAT || !Array.isArray(f.items)) return { ok: false, error: 'AI分類ファイルではありません' };
  const bad = f.items.filter((i) => !(i.category in CATEGORY_LABELS) || typeof i.importance !== 'number').length;
  if (bad > 0) return { ok: false, error: `不正な行が${bad}件あります` };
  return { ok: true, file: f as AiAssessmentFile };
}

export interface ApplyResult {
  items: number;
  matchedExpressions: number;
  unmatchedItems: number;
  userOverridesKept: number;
}

export async function applyAiAssessment(file: AiAssessmentFile): Promise<ApplyResult> {
  const byKey = new Map<string, AiAssessmentFile['items'][number]>();
  for (const it of file.items) byKey.set(it.key ?? normalizeKey(it.text), it);
  const ts = nowIso();
  let matched = 0;
  let overrides = 0;
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
      updates.push({
        ...e,
        ai: {
          category: it.category,
          importance: Math.max(0, Math.min(100, Math.round(it.importance))),
          rationale: it.rationale,
          model: file.model,
          generatedAt: file.generatedAt ?? ts,
        },
      });
    }
    await db.expressions.bulkPut(updates);
  });
  return { items: file.items.length, matchedExpressions: matched, unmatchedItems: file.items.length - usedKeys.size, userOverridesKept: overrides };
}

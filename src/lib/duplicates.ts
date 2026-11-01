/**
 * Non-destructive merging of duplicate candidates: the primary expression gets
 * the combined meanings/notes/examples; the others are suspended (excluded from
 * study) and tagged "merged" — nothing is deleted, history is kept.
 */
import { db } from '../db/db';
import type { DuplicateGroup, Expression } from '../db/types';
import { nowIso } from './util';

type Patch = Partial<Expression> & { id: string };

/** Compute the merge for one group in memory (no I/O). */
function planMerge(members: Expression[], primaryId: string, ts: string): Patch[] {
  const primary = members.find((m) => m.id === primaryId);
  if (!primary) return [];
  const others = members.filter((m) => m.id !== primaryId);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  return [
    {
      id: primaryId,
      meaning: uniq([primary.meaning, ...others.map((o) => o.meaning)]).join('\n'),
      notes: uniq([primary.notes, ...others.map((o) => o.notes)]).join('\n'),
      examples: [...primary.examples, ...others.flatMap((o) => o.examples)].slice(0, 3),
      suspended: false,
      updatedAt: ts,
    },
    ...others.map((o) => ({
      id: o.id,
      suspended: true,
      tags: uniq([...o.tags, 'merged']),
      notes: uniq([o.notes, `（${primary.text} に統合済み）`]).join('\n'),
      updatedAt: ts,
    })),
  ];
}

/**
 * Primary for automatic merging: an entry already studied, then one with a
 * meaning, then the most recently registered row.
 */
function pickPrimary(members: Expression[], studied: Set<string>): string {
  const score = (e: Expression) => (studied.has(e.id) ? 1e9 : 0) + (e.meaning ? 1e6 : 0) + (e.source?.rowIndex ?? 0);
  return [...members].sort((a, b) => score(b) - score(a))[0].id;
}

async function applyPatches(patches: Patch[]) {
  const current = new Map((await db.expressions.bulkGet(patches.map((p) => p.id))).filter(Boolean).map((e) => [e!.id, e!]));
  await db.expressions.bulkPut(patches.filter((p) => current.has(p.id)).map((p) => ({ ...current.get(p.id)!, ...p })));
}

export async function mergeGroup(group: DuplicateGroup, primaryId: string): Promise<void> {
  const ts = nowIso();
  await db.transaction('rw', db.expressions, db.duplicates, async () => {
    const members = (await db.expressions.bulkGet(group.expressionIds)).filter(Boolean) as Expression[];
    await applyPatches(planMerge(members, primaryId, ts));
    await db.duplicates.update(group.id, { resolution: 'merged', updatedAt: ts });
  });
}

export async function mergeAllPending(): Promise<number> {
  const ts = nowIso();
  return db.transaction('rw', db.expressions, db.cards, db.duplicates, async () => {
    const pending = await db.duplicates.where('resolution').equals('pending').toArray();
    if (pending.length === 0) return 0;
    const exprs = new Map((await db.expressions.toArray()).map((e) => [e.id, e]));
    const studied = new Set((await db.cards.toArray()).filter((c) => c.introducedAt).map((c) => c.expressionId));
    const patches: Patch[] = [];
    for (const g of pending) {
      const members = g.expressionIds.map((id) => exprs.get(id)).filter(Boolean) as Expression[];
      if (members.length > 1) patches.push(...planMerge(members, pickPrimary(members, studied), ts));
    }
    await applyPatches(patches);
    await db.duplicates.bulkPut(pending.map((g) => ({ ...g, resolution: 'merged' as const, updatedAt: ts })));
    return pending.length;
  });
}

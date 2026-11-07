import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useDatabase } from '../src/db/db';

let fail = new Set<string>();
vi.mock('../src/lib/aiGenerate', () => ({
  analyzeCaptured: vi.fn(async (selection: string, sentence: string) => {
    await new Promise((r) => setTimeout(r, 5));
    if (fail.has(selection)) throw Object.assign(new Error('boom'), { status: 500 });
    return {
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
      result: {
        baseForm: selection.replace(/ed$/, 'e'), meaning: selection + 'の意味', category: 'business', importance: 60, sentenceJa: '訳',
        examples: [{ kind: 'daily', en: 'D ' + selection, ja: 'd' }, { kind: 'alternative', en: 'A ' + selection, ja: 'a' }],
        pronunciation: { level1: { text: sentence }, origin: 'ai', status: 'needs_review' }, model: 't',
      },
    };
  }),
}));

const { addBatch, pendingAiIds } = await import('../src/lib/capture');
const { enqueueCaptureAi, useCaptureQueue } = await import('../src/lib/captureQueue');
void useCaptureQueue;

async function waitIdle() {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if ((await pendingAiIds()).length === 0 || i > 150) return;
  }
}

let n = 0;
beforeEach(async () => {
  await db.close();
  useDatabase('queue-' + n++);
  await db.open();
  fail = new Set();
});

describe('background AI for a batch', () => {
  it('fills every item in, renaming to the base form', async () => {
    const ids = await addBatch([
      { text: 'circulated', sentence: 'We circulated it.', status: 'new' },
      { text: 'tabled', sentence: 'They tabled it.', status: 'new' },
      { text: 'leverage', sentence: 'Leverage the data.', status: 'new' },
    ]);
    enqueueCaptureAi(ids);
    await waitIdle();
    const all = await db.expressions.bulkGet(ids);
    expect(all.map((e) => e!.text)).toEqual(['circulate', 'table', 'leverage']);
    expect(all.every((e) => e!.examples.length === 3 && !!e!.ai?.meaning)).toBe(true);
  });

  it('failures stay pending so they can be resumed', async () => {
    fail = new Set(['tabled']);
    const ids = await addBatch([
      { text: 'circulated', sentence: 'We circulated it.', status: 'new' },
      { text: 'tabled', sentence: 'They tabled it.', status: 'new' },
    ]);
    enqueueCaptureAi(ids);
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await pendingAiIds()).toEqual([ids[1]]);
    fail = new Set();
    enqueueCaptureAi(await pendingAiIds());
    await waitIdle();
    expect(await pendingAiIds()).toEqual([]);
    expect((await db.expressions.get(ids[1]))!.text).toBe('table');
  });
});

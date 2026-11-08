import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useDatabase } from '../src/db/db';

let calls = 0;
let fail = false;
vi.mock('../src/lib/aiGenerate', () => ({
  generatePronunciation: vi.fn(async (expressionId: string, exampleId: string) => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    if (fail) throw Object.assign(new Error('overloaded'), { status: 529 });
    const { db: d } = await import('../src/db/db');
    const e = (await d.expressions.get(expressionId))!;
    await d.expressions.put({ ...e, examples: e.examples.map((x) => (x.id === exampleId ? { ...x, pronunciation: { level1: { text: x.en }, origin: 'ai', status: 'needs_review' } } : x)) });
    return { inputTokens: 1, outputTokens: 1, costUsd: 0.03 };
  }),
}));
const { ensurePronunciation } = await import('../src/lib/pronOnOpen');

let n = 0;
beforeEach(async () => {
  await db.close();
  useDatabase('pron-open-' + n++);
  await db.open();
  calls = 0;
  fail = false;
  localStorage.setItem('em.anthropicApiKey', 'sk-ant-test');
  await db.expressions.put({
    id: 'e1', text: 'circulate', normalized: 'circulate', meaning: '', notes: '', kind: 'word', tags: [], suspended: false, usedInRealLife: [], createdAt: '', updatedAt: '',
    examples: [
      { id: 'a', kind: 'business', en: 'We circulated it.', ja: 'j', origin: 'ai', status: 'unverified', pronunciation: { level1: { text: 'We circulated it.' }, origin: 'ai', status: 'needs_review' } },
      { id: 'b', kind: 'daily', en: 'Rumors circulate.', ja: 'j', origin: 'ai', status: 'unverified' },
    ],
  });
});

describe('pronunciation guide on open', () => {
  it('writes a missing guide once, even if opened several times at once', async () => {
    const [x, y] = await Promise.all([ensurePronunciation('e1', 'b'), ensurePronunciation('e1', 'b')]);
    expect([x, y]).toEqual([true, true]);
    expect(calls).toBe(1);
    expect((await db.expressions.get('e1'))!.examples[1].pronunciation).toBeTruthy();
    expect(await ensurePronunciation('e1', 'b')).toBe(false); // now has one
    expect(calls).toBe(1);
  });
  it('does nothing for an example that already has a guide, or without an API key', async () => {
    expect(await ensurePronunciation('e1', 'a')).toBe(false);
    localStorage.removeItem('em.anthropicApiKey');
    expect(await ensurePronunciation('e1', 'b')).toBe(false);
    expect(calls).toBe(0);
  });
  it('a failure can be retried', async () => {
    fail = true;
    await expect(ensurePronunciation('e1', 'b')).rejects.toThrow('overloaded');
    fail = false;
    expect(await ensurePronunciation('e1', 'b')).toBe(true);
    expect(calls).toBe(2);
  });
});

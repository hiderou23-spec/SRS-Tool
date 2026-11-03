import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import type { Expression, Suggestion } from '../src/db/types';
import type { SuggestedItem } from '../src/lib/aiGenerate';

const aiCalls: unknown[] = [];
let aiItems: SuggestedItem[] = [];
vi.mock('../src/lib/aiGenerate', () => ({
  suggestExpressions: vi.fn(async (ctx: unknown) => {
    aiCalls.push(ctx);
    return { items: aiItems, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, model: 'test-model' };
  }),
}));

const { addSuggestion, buildContext, decideSuggestion, pickNew, requestTodaysSuggestions, DAILY_SUGGESTIONS } = await import('../src/lib/suggestions');
const { createBackup, restoreBackup, validateBackup } = await import('../src/lib/backup');

const item = (text: string, importance = 70): SuggestedItem => ({
  text, meaning_ja: `${text}の意味`, why_ja: '会議で使う', category: 'business', importance,
  examples: [
    { kind: 'business', en: `Let's ${text} today.`, ja: '今日やろう' },
    { kind: 'daily', en: `I ${text} a lot.`, ja: 'よくやる' },
    { kind: 'alternative', en: `They ${text}.`, ja: '彼らは' },
  ],
});
const expr = (text: string, extra: Partial<Expression> = {}): Expression => ({
  id: 'x-' + text, text, normalized: text.toLowerCase(), meaning: '', notes: '', kind: 'phrase', examples: [], tags: [],
  suspended: false, usedInRealLife: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
});

let n = 0;
beforeEach(async () => {
  await db.close();
  useDatabase('sg-test-' + n++);
  await db.open();
  aiCalls.length = 0;
  aiItems = [];
});

describe('picking suggestions', () => {
  it('drops library / past duplicates and repeats, keeps at most n', () => {
    const out = pickNew(
      [item('Circle back'), item('get buy-in'), item('GET  BUY-IN'), item('push back'), item(''), item('touch base'), item('loop in'), item('sync up'), item('ramp up')],
      new Set(['circle back', 'push back']),
      5,
    );
    expect(out.map((x) => x.text)).toEqual(['get buy-in', 'touch base', 'loop in', 'sync up', 'ramp up']);
  });
  it('clamps importance and keeps up to 3 examples', () => {
    const [x] = pickNew([{ ...item('a b'), importance: 140, examples: [...item('a b').examples, ...item('a b').examples] }], new Set(), 5);
    expect(x.importance).toBe(100);
    expect(x.examples).toHaveLength(3);
  });
  it('sends texts only: active English library and past decisions', () => {
    const past = (text: string, status: Suggestion['status']) => ({ text, status, createdAt: '2026-01-0' + text.length } as Suggestion);
    const ctx = buildContext(
      [expr('hammer out'), expr('off'.repeat(1), { suspended: true }), expr('会議', { lang: 'ja' })],
      [past('aa', 'added'), past('bbb', 'known'), past('cccc', 'rejected'), past('ddddd', 'pending')],
    );
    expect(ctx.library).toEqual(['hammer out']);
    expect(ctx).toMatchObject({ added: ['aa'], known: ['bbb'], rejected: ['cccc'], pending: ['ddddd'] });
  });
});

describe('daily suggestions', () => {
  it('asks the AI once per day and saves five new ones', async () => {
    await db.expressions.put(expr('circle back'));
    aiItems = ['circle back', 'get buy-in', 'touch base', 'loop in', 'sync up', 'ramp up', 'drill down', 'zoom out'].map((t) => item(t));
    const first = await requestTodaysSuggestions();
    expect(first.suggestions).toHaveLength(DAILY_SUGGESTIONS);
    expect(first.suggestions.map((s) => s.text)).toEqual(['get buy-in', 'touch base', 'loop in', 'sync up', 'ramp up']); // AI order, minus the duplicate
    expect(first.suggestions.every((s) => s.status === 'pending')).toBe(true);
    const again = await requestTodaysSuggestions();
    expect(again.usage).toBeNull();
    expect(aiCalls).toHaveLength(1);
    expect((aiCalls[0] as { library: string[] }).library).toEqual(['circle back']);
  });

  it('adds a suggestion as a new expression with Reading and Speaking cards', async () => {
    aiItems = [item('get buy-in', 85)];
    const [s] = (await requestTodaysSuggestions()).suggestions;
    const { expressionId, firstExampleId } = await addSuggestion(s.id);
    const e = (await db.expressions.get(expressionId))!;
    expect(e).toMatchObject({ text: 'get buy-in', meaning: '', tags: ['AI提案'], suspended: false });
    expect(e.ai).toMatchObject({ category: 'business', importance: 85, meaning: 'get buy-inの意味', model: 'test-model' });
    expect(e.examples.map((x) => [x.origin, x.status])).toEqual(Array(3).fill(['ai', 'unverified']));
    expect(firstExampleId).toBe(e.examples[0].id);
    expect((await db.cards.where('expressionId').equals(expressionId).toArray()).map((c) => c.mode).sort()).toEqual(['production', 'recognition']);
    expect((await db.suggestions.get(s.id))!.status).toBe('added');
    // Pressing again does nothing new.
    expect((await addSuggestion(s.id)).expressionId).toBe(expressionId);
    expect(await db.expressions.count()).toBe(1);
  });

  it('links instead of duplicating when the expression was added meanwhile', async () => {
    aiItems = [item('get buy-in')];
    const [s] = (await requestTodaysSuggestions()).suggestions;
    await db.expressions.put(expr('get buy-in'));
    expect((await addSuggestion(s.id)).expressionId).toBe('x-get buy-in');
    expect(await db.expressions.count()).toBe(1);
  });

  it('records known / not wanted, can be undone, and the next request sends them', async () => {
    aiItems = [item('touch base'), item('loop in')];
    const [a, b] = (await requestTodaysSuggestions()).suggestions;
    await decideSuggestion(a.id, 'known');
    await decideSuggestion(b.id, 'rejected');
    await decideSuggestion(b.id, 'pending');
    expect((await db.suggestions.get(b.id))!.status).toBe('pending');
    await decideSuggestion(b.id, 'rejected');
    const ctx = buildContext([], await db.suggestions.toArray());
    expect(ctx.known).toEqual(['touch base']);
    expect(ctx.rejected).toEqual(['loop in']);
  });
});

describe('backup', () => {
  it('includes suggestions and still restores older backups without them', async () => {
    aiItems = [item('touch base')];
    await requestTodaysSuggestions();
    const b = await createBackup();
    expect(b.counts.suggestions).toBe(1);
    await db.suggestions.clear();
    await restoreBackup(b);
    expect(await db.suggestions.count()).toBe(1);

    const old = JSON.parse(JSON.stringify(b));
    delete old.data.suggestions;
    const v = validateBackup(old);
    expect(v.ok).toBe(true);
    if (v.ok) await restoreBackup(v.backup);
    expect(await db.suggestions.count()).toBe(0);
  });
});

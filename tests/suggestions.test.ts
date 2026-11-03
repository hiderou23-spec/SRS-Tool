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

const { addSuggestion, buildContext, canAskMore, decideSuggestion, nextLevel, pickNew, requestTodaysSuggestions, DAILY_SUGGESTIONS, MAX_BATCHES_PER_DAY } = await import('../src/lib/suggestions');
const { getSettings, saveSettings } = await import('../src/db/db');
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

describe('suggestion level', () => {
  const sg = (day: string, batch: number, status: Suggestion['status'], i = 0) =>
    ({ id: `${day}-${batch}-${i}`, day, batch, status, createdAt: `${day}T00:00:0${batch}.00${i}Z`, text: 't' + i } as Suggestion);
  const set = (day: string, batch: number, known: number, other: Suggestion['status'] = 'added') =>
    Array.from({ length: 5 }, (_, i) => sg(day, batch, i < known ? 'known' : other, i));

  it('goes up one step when most of the last decided set was already known, once per set', () => {
    const past = [...set('2026-11-01', 1, 1), ...set('2026-11-02', 1, 5)];
    const up = nextLevel(2, undefined, past);
    expect(up).toEqual({ level: 3, basis: '2026-11-02#1', raised: true });
    expect(nextLevel(3, up.basis, past)).toEqual({ level: 3, basis: '2026-11-02#1', raised: false });
    expect(nextLevel(4, undefined, past).level).toBe(4); // already at the top
  });
  it('stays when the learner did not know most of them, and ignores undecided sets', () => {
    expect(nextLevel(2, undefined, set('2026-11-02', 1, 3)).raised).toBe(false);
    const undecided = [...set('2026-11-02', 1, 4), sg('2026-11-02', 1, 'pending', 9)];
    expect(nextLevel(2, undefined, undecided).raised).toBe(false);
  });
  it('treats rows from before batches existed as set 1', () => {
    const old = set('2026-11-02', 1, 5).map(({ batch: _b, ...x }) => x as Suggestion);
    expect(nextLevel(2, undefined, old)).toMatchObject({ level: 3, raised: true });
  });
  it('tells the AI the level and the last result', () => {
    const ctx = buildContext([], set('2026-11-02', 1, 5), 3);
    expect(ctx.levelGuide).toMatch(/^Near-native/);
    expect(ctx.avoidCliches).toBe(true);
    expect(ctx.feedback).toMatch(/knew 5 of 5 .*go clearly beyond/);
    expect(buildContext([], [], 1).avoidCliches).toBe(false);
  });
  it('allows another set only after deciding every suggestion, up to the daily limit', () => {
    expect(canAskMore([])).toBe(false);
    expect(canAskMore([...set('d', 1, 4), sg('d', 1, 'pending', 8)])).toBe(false);
    expect(canAskMore(set('d', 1, 5))).toBe(true);
    expect(canAskMore(set('d', MAX_BATCHES_PER_DAY, 5))).toBe(false);
  });
  it('uses the per-day limit from settings', async () => {
    expect(canAskMore(set('d', 3, 5), 5)).toBe(true);
    expect(canAskMore(set('d', 1, 5), 1)).toBe(false);
    expect(canAskMore(set('d', 3, 5), Number.NaN)).toBe(false); // broken value → default 3

    await saveSettings({ suggestionBatchesPerDay: 1 });
    aiItems = [item('e1 f')];
    const [s] = (await requestTodaysSuggestions()).suggestions;
    await decideSuggestion(s.id, 'rejected');
    await expect(requestTodaysSuggestions(new Date(), { more: true })).rejects.toThrow();
    await saveSettings({ suggestionBatchesPerDay: 2 });
    aiItems = [item('g1 h')];
    expect((await requestTodaysSuggestions(new Date(), { more: true })).suggestions).toHaveLength(2);
  });

  it('end to end: all known → ask again → the level is raised and saved', async () => {
    await saveSettings({ suggestionLevel: 2 });
    aiItems = ['a1 b', 'a2 b', 'a3 b', 'a4 b', 'a5 b'].map((t) => item(t));
    const first = await requestTodaysSuggestions();
    expect(first.level).toBe(2);
    for (const s of first.suggestions) await decideSuggestion(s.id, 'known');
    await expect(requestTodaysSuggestions(new Date(), {})).resolves.toMatchObject({ usage: null }); // same day without "more": no new call
    aiItems = ['c1 d', 'c2 d', 'c3 d', 'c4 d', 'c5 d', 'a1 b'].map((t) => item(t));
    const second = await requestTodaysSuggestions(new Date(), { more: true });
    expect(second).toMatchObject({ level: 3, levelRaised: true });
    expect(second.suggestions).toHaveLength(10);
    expect(second.suggestions.slice(5).every((s) => s.batch === 2 && s.level === 3)).toBe(true);
    expect((await getSettings()).suggestionLevel).toBe(3);
    expect((aiCalls[1] as { levelGuide: string }).levelGuide).toMatch(/^Near-native/);
    // Can't ask again while the new set is undecided.
    await expect(requestTodaysSuggestions(new Date(), { more: true })).rejects.toThrow();
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

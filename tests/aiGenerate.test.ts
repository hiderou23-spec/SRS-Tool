import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useDatabase } from '../src/db/db';
import { makeCards } from '../src/import/importer';
import { nowIso, uid } from '../src/lib/util';

const calls: Record<string, unknown>[] = [];
let nextOutput: unknown;
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    opts: unknown;
    constructor(opts: unknown) { this.opts = opts; }
    beta = {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { stop_reason: 'end_turn', parsed_output: nextOutput, usage: { input_tokens: 1000, output_tokens: 2000 } };
        },
        // Streaming: replays the JSON in chunks to 'text' listeners, then resolves.
        stream: (params: Record<string, unknown>) => {
          calls.push({ ...params, __stream: true });
          const listeners: ((d: string, s: string) => void)[] = [];
          const json = JSON.stringify(nextOutput);
          return {
            on(ev: string, cb: (d: string, s: string) => void) {
              if (ev === 'text') listeners.push(cb);
              return this;
            },
            async finalMessage() {
              for (let i = 40; i < json.length + 40; i += 40) for (const l of listeners) l(json.slice(i - 40, i), json.slice(0, i));
              return { stop_reason: 'end_turn', parsed_output: null, content: [{ type: 'text', text: json }], usage: { input_tokens: 500, output_tokens: 300 } };
            },
          };
        },
      },
    };
  },
}));

const pron = {
  level1_katakana: 'ウィ ニード', level1_ipa: '/wi nid/',
  level2: { text: 'We nee-tuh', katakana: 'ウィ ニートゥ' }, level3: null,
  notes_ja: 'need to の d が脱落', minimal_change: false, uncertain: true,
};

let n = 0;
beforeEach(async () => {
  calls.length = 0;
  await db.close();
  useDatabase('ai-' + n++);
  await db.open();
  localStorage.setItem('em.anthropicApiKey', 'sk-ant-test');
  localStorage.removeItem('em.aiModel');
});

async function addExpr(patch: Record<string, unknown> = {}) {
  const id = uid(); const ts = nowIso();
  await db.expressions.add({ id, text: 'hammer out', normalized: 'hammer out', meaning: '', notes: '', kind: 'phrase', examples: [], tags: [], suspended: false, usedInRealLife: [], createdAt: ts, updatedAt: ts, ...patch });
  await db.cards.bulkAdd(makeCards(id));
  return id;
}

describe('in-app AI generation', () => {
  it('stores generated examples, AI meaning and guide as unverified AI content', async () => {
    const { generateExamples } = await import('../src/lib/aiGenerate');
    const id = await addExpr();
    nextOutput = {
      category: 'phrasal_verb', importance: 95, meaning_ja: '詳細を詰める',
      examples: [
        { kind: 'business', en: 'We need to hammer out the details.', ja: '詳細を詰める必要がある。' },
        { kind: 'daily', en: 'We hammered out our plans.', ja: '計画を決めた。' },
        { kind: 'alternative', en: 'They hammered out a deal.', ja: '合意をまとめた。' },
      ],
      pronunciation: pron,
    };
    const usage = await generateExamples(id);
    expect(usage.costUsd).toBeCloseTo((1000 * 4 + 2000 * 20) / 1e6);
    const p = calls[0];
    expect(p).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect((p.output_config as { effort: string }).effort).toBe('medium');
    const e = (await db.expressions.get(id))!;
    expect(e.meaning).toBe(''); // learner's field untouched
    expect(e.ai).toMatchObject({ category: 'phrasal_verb', importance: 95, meaning: '詳細を詰める' });
    expect(e.examples).toHaveLength(3);
    expect(e.examples.every((x) => x.origin === 'ai' && x.status === 'unverified')).toBe(true);
    expect(e.examples[0].pronunciation).toMatchObject({ origin: 'ai', status: 'needs_review', level2: { text: 'We nee-tuh' } });
    expect(e.examples[0].pronunciation!.notes).toContain('【要確認】');
    expect(e.examples[1].pronunciation).toBeUndefined();
  });

  it('never overwrites the learner’s own examples or meaning', async () => {
    const { generateExamples, generatePronunciation } = await import('../src/lib/aiGenerate');
    const exId = uid();
    const id = await addExpr({ meaning: '自分の訳', examples: [{ id: exId, kind: 'business', en: 'My own sentence.', ja: '自作', origin: 'user', status: 'verified' }] });
    nextOutput = { category: 'business', importance: 80, meaning_ja: 'AI訳', examples: [{ kind: 'business', en: 'x', ja: 'y' }], pronunciation: pron };
    await generateExamples(id);
    let e = (await db.expressions.get(id))!;
    expect(e.examples.map((x) => x.en)).toEqual(['My own sentence.']);
    expect(e.meaning).toBe('自分の訳');
    expect(e.ai?.meaning).toBeUndefined();

    nextOutput = { pronunciation: pron };
    await generatePronunciation(id, exId);
    e = (await db.expressions.get(id))!;
    expect(e.examples[0].pronunciation?.level1.text).toBe('My own sentence.');
    expect(e.examples[0].en).toBe('My own sentence.');
  });

  it('requires an API key and picks candidates by importance', async () => {
    const mod = await import('../src/lib/aiGenerate');
    const a = await addExpr({ importance: 30 });
    const b = await addExpr({ importance: 90 });
    expect(await mod.bulkCandidates(5)).toEqual([b, a]);
    localStorage.removeItem('em.anthropicApiKey');
    await expect(mod.generateExamples(a)).rejects.toThrow('API キー');
  });
});

describe('faster suggestions and filling in later', () => {
  const item = (text: string) => ({ text, meaning_ja: 'm', why_ja: 'w', category: 'business', importance: 80, examples: [{ kind: 'business', en: `We ${text}.`, ja: '例' }] });

  it('streams the suggestion request at low effort and reports progress', async () => {
    const { suggestExpressions } = await import('../src/lib/aiGenerate');
    nextOutput = { suggestions: ['a b', 'c d', 'e f'].map(item) };
    const seen: number[] = [];
    const ctx = { count: 3, library: [], added: [], known: [], rejected: [], pending: [], levelGuide: 'x', avoidCliches: true, feedback: '' };
    const res = await suggestExpressions(ctx, (n) => seen.push(n));
    expect(res.items.map((i) => i.text)).toEqual(['a b', 'c d', 'e f']);
    const call = calls[0] as { __stream?: boolean; betas: string[]; output_config: { effort: string } };
    expect(call.__stream).toBe(true);
    expect(call.output_config.effort).toBe('low');
    expect(call.betas).toEqual(['server-side-fallback-2026-07-01', 'structured-outputs-2025-12-15']);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(3);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen); // never goes backwards
  });

  it('Haiku streams without the fallback beta', async () => {
    const { suggestExpressions } = await import('../src/lib/aiGenerate');
    localStorage.setItem('em.aiModel', 'claude-haiku-5-5');
    nextOutput = { suggestions: [item('a b')] };
    await suggestExpressions({ count: 1, library: [], added: [], known: [], rejected: [], pending: [], levelGuide: 'x', avoidCliches: true, feedback: '' }, () => {});
    const call = calls[0] as { betas: string[]; fallbacks?: string };
    expect(call.betas).toEqual(['structured-outputs-2025-12-15']);
    expect(call.fallbacks).toBeUndefined();
  });

  it('completeExamples keeps the existing example, adds the missing kinds and a guide for the first', async () => {
    const { completeExamples } = await import('../src/lib/aiGenerate');
    const id = await addExpr({ examples: [{ id: 'x1', kind: 'business', en: 'We need to hammer out the details.', ja: '詳細を詰める必要がある。', origin: 'ai', status: 'unverified' }] });
    nextOutput = {
      examples: [
        { kind: 'daily', en: 'We hammered out our plans.', ja: '計画を決めた。' },
        { kind: 'alternative', en: 'They hammered out a deal.', ja: '合意をまとめた。' },
        { kind: 'daily', en: 'Extra.', ja: '余分' },
      ],
      pronunciation: pron,
    };
    await completeExamples(id);
    const e = (await db.expressions.get(id))!;
    expect(e.examples.map((x) => [x.id === 'x1' ? 'kept' : x.origin, x.kind])).toEqual([['kept', 'business'], ['ai', 'daily'], ['ai', 'alternative']]);
    expect(e.examples[0].pronunciation?.level1.text).toBe('We need to hammer out the details.');
    expect(String((calls[0] as { messages: { content: string }[] }).messages[0].content)).toContain('kinds: daily, alternative');
    // Nothing left to do: no further call.
    expect(await completeExamples(id)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a typed expression without a sentence gets 3 examples and a guide for the first', async () => {
    const { analyzeCaptured } = await import('../src/lib/aiGenerate');
    nextOutput = {
      category: 'business', importance: 70, meaning_ja: '回覧する',
      examples: [
        { kind: 'business', en: 'Please circulate the memo.', ja: 'メモを回覧して。' },
        { kind: 'daily', en: 'Rumors circulate fast.', ja: '噂はすぐ広まる。' },
        { kind: 'alternative', en: 'Blood circulates.', ja: '血液が循環する。' },
      ],
      pronunciation: pron,
    };
    const { result } = await analyzeCaptured('circulate', '');
    expect(result).toMatchObject({ baseForm: 'circulate', meaning: '回覧する', sentenceJa: '' });
    expect(result.examples).toHaveLength(3);
    expect(result.pronunciation?.level1.text).toBe('Please circulate the memo.');
  });
});

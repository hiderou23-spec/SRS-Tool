/**
 * In-app AI generation with the user's own Anthropic API key.
 *
 * - Runs only when the user presses a button (nothing is sent automatically).
 * - Sends only the expression text, its meaning/notes, and existing example
 *   sentences — never review history or other personal data.
 * - The API key lives in this browser's localStorage only; it is NOT part of
 *   the JSON backup.
 * - Everything generated is stored as origin 'ai' and unverified / 要確認.
 *
 * The SDK is loaded lazily so the normal app bundle stays small.
 */
import { z } from 'zod';
import { db } from '../db/db';
import type { Category, Example, Expression, PronunciationGuide } from '../db/types';
import { nowIso, uid } from './util';
import { effectiveImportance } from '../srs/queue';
import { estimateCostUsd, getAiModel, getApiKey, type GenerateUsage } from './aiConfig';
export type { GenerateUsage } from './aiConfig';

const CATEGORIES = ['business', 'daily', 'phrasal_verb', 'idiom', 'academic', 'technical', 'low_priority'] as const;

const LevelSchema = z.object({ text: z.string(), katakana: z.string() });
const PronSchema = z.object({
  level1_katakana: z.string().describe('Careful pronunciation in katakana, word by word'),
  level1_ipa: z.string().describe('Broad American IPA of the careful pronunciation, between slashes'),
  level2: LevelSchema.describe('Natural conversational connected speech. Change pronunciation only, never the words.'),
  level3: LevelSchema.nullable().describe('Fast casual speech. null unless it is a reduction native speakers really use (wanna, gonna, needa, shoulda...)'),
  notes_ja: z.string().describe('Japanese explanation of the linking / reduction / elision / assimilation that occurs'),
  minimal_change: z.boolean(),
  uncertain: z.boolean().describe('true if any part is uncertain'),
});

const ExamplesSchema = z.object({
  category: z.enum(CATEGORIES),
  importance: z.number().int().describe('0-100 for this learner'),
  meaning_ja: z.string().describe('Concise Japanese meaning. Empty string if the learner already has one.'),
  examples: z
    .array(z.object({ kind: z.enum(['business', 'daily', 'alternative']), en: z.string(), ja: z.string() }))
    .describe('Exactly 3: business, daily, alternative (different sense or usage)'),
  pronunciation: PronSchema.describe('Pronunciation guide for the FIRST example sentence'),
});

const PronOnlySchema = z.object({ pronunciation: PronSchema });

const SYSTEM = `You write study material for a Japanese learner of English.
The learner: Head of payment products at a large tech company in Japan, long finance background, upper-intermediate to advanced English, wants to speak and listen better in English business meetings. Business usage is slightly prioritised over daily usage.

Example sentences:
- Natural sentences a native speaker would actually say; grammatically correct; short (usually under 20 words).
- The business example should fit meetings, payments, merchants, finance, product or leadership work.
- The alternative example shows a different natural sense or usage. Japanese translations are natural, not literal.
- The target expression must appear in each sentence (inflection allowed).

Pronunciation (General American):
- Level 1: careful pronunciation. Level 2: natural conversational connected speech — linking, reduction, elision, flapping, assimilation — spelled with the same words (e.g. "We nee-tuh hamme-rout the details b'fore Friday."). Never change the words.
- Level 3 only when a genuinely common casual reduction exists; otherwise null. Do not invent unnatural distortions.
- Katakana reflects the actual connected sounds as far as katakana can. It is only an approximation.
- If you are not confident, set uncertain=true rather than guessing.

Importance: how useful the expression is for this learner (90+ essential meeting language, 60-80 useful, 30-50 occasional, below 30 rare/literary/proper nouns).`;

async function client() {
  const key = getApiKey();
  if (!key) throw new Error('API キーが設定されていません（Settings → AI 生成）');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The user's own key, used only from their own device (no shared backend).
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

function toGuide(p: z.infer<typeof PronSchema>, sentence: string): PronunciationGuide {
  return {
    level1: { text: sentence, katakana: p.level1_katakana, ipa: p.level1_ipa },
    level2: { text: p.level2.text, katakana: p.level2.katakana },
    ...(p.level3 ? { level3: { text: p.level3.text, katakana: p.level3.katakana } } : {}),
    notes: p.uncertain ? `【要確認】${p.notes_ja}` : p.notes_ja,
    minimalChange: p.minimal_change,
    origin: 'ai',
    status: 'needs_review',
  };
}

async function call<T>(schema: z.ZodType<T>, user: string): Promise<{ data: T; usage: GenerateUsage }> {
  const c = await client();
  const model = getAiModel();
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const res = await c.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('AI がこの表現の生成を辞退しました');
  if (res.stop_reason === 'max_tokens') throw new Error('出力が途中で切れました。もう一度お試しください');
  if (!res.parsed_output) throw new Error('AI の出力を読み取れませんでした');
  const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
  const outputTokens = res.usage.output_tokens;
  return { data: res.parsed_output as T, usage: { inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) } };
}

function describe(e: Expression): string {
  return [
    `Expression: ${e.text}`,
    e.meaning ? `Learner's meaning: ${e.meaning}` : e.ai?.meaning ? `Existing AI meaning: ${e.ai.meaning}` : 'Learner has no meaning yet.',
    e.notes ? `Learner's notes: ${e.notes.slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 3 examples (+ meaning / category if missing) and a guide for the first example. */
export async function generateExamples(expressionId: string): Promise<GenerateUsage> {
  const e = await db.expressions.get(expressionId);
  if (!e) throw new Error('表現が見つかりません');
  const { data, usage } = await call(ExamplesSchema, `${describe(e)}\n\nWrite the category, importance, Japanese meaning (empty if the learner already has one), 3 examples and a pronunciation guide for the first example.`);
  const kinds = ['business', 'daily', 'alternative'] as const;
  const examples: Example[] = data.examples.slice(0, 3).map((x, i) => ({
    id: uid(),
    kind: x.kind ?? kinds[i],
    en: x.en.trim(),
    ja: x.ja.trim(),
    origin: 'ai',
    status: 'unverified',
    ...(i === 0 ? { pronunciation: toGuide(data.pronunciation, x.en.trim()) } : {}),
  }));
  await db.transaction('rw', db.expressions, async () => {
    const cur = await db.expressions.get(expressionId);
    if (!cur) return;
    const ai = cur.ai ?? { category: data.category as Category, importance: Math.max(0, Math.min(100, data.importance)), generatedAt: nowIso(), model: getAiModel() };
    await db.expressions.put({
      ...cur,
      // Never overwrite the learner's own examples.
      examples: cur.examples.length ? cur.examples : examples,
      ai: { ...ai, meaning: ai.meaning ?? (!cur.meaning && data.meaning_ja ? data.meaning_ja : undefined) },
      updatedAt: nowIso(),
    });
  });
  return usage;
}

/** Pronunciation guide for one existing example sentence. */
export async function generatePronunciation(expressionId: string, exampleId: string): Promise<GenerateUsage> {
  const e = await db.expressions.get(expressionId);
  const ex = e?.examples.find((x) => x.id === exampleId);
  if (!e || !ex) throw new Error('例文が見つかりません');
  const { data, usage } = await call(PronOnlySchema, `${describe(e)}\nSentence: ${ex.en}\n\nWrite the pronunciation guide for this exact sentence.`);
  await db.transaction('rw', db.expressions, async () => {
    const cur = await db.expressions.get(expressionId);
    if (!cur) return;
    await db.expressions.put({
      ...cur,
      examples: cur.examples.map((x) => (x.id === exampleId && !x.pronunciation ? { ...x, pronunciation: toGuide(data.pronunciation, x.en) } : x)),
      updatedAt: nowIso(),
    });
  });
  return usage;
}

/** Candidates for bulk generation: active, no examples, highest importance first. */
export async function bulkCandidates(limit: number): Promise<string[]> {
  const all = await db.expressions.toArray();
  return all
    .filter((e) => !e.suspended && e.examples.length === 0 && e.text)
    .sort((a, b) => effectiveImportance(b) - effectiveImportance(a))
    .slice(0, limit)
    .map((e) => e.id);
}

export async function bulkPronunciationCandidates(limit: number): Promise<{ expressionId: string; exampleId: string }[]> {
  const all = await db.expressions.toArray();
  return all
    .filter((e) => !e.suspended && e.examples[0] && !e.examples[0].pronunciation)
    .sort((a, b) => effectiveImportance(b) - effectiveImportance(a))
    .slice(0, limit)
    .map((e) => ({ expressionId: e.id, exampleId: e.examples[0].id }));
}


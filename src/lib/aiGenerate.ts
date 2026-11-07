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
import type { CaptureAi } from './capture';

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

interface CallOptions {
  /** Thinking effort: 'low' for quick selection tasks, 'medium' (default) for writing material. */
  effort?: 'low' | 'medium';
  /** Stream the reply and report the JSON text received so far (for progress). */
  onText?: (snapshot: string) => void;
}

async function call<T>(schema: z.ZodType<T>, user: string, opts: CallOptions = {}): Promise<{ data: T; usage: GenerateUsage }> {
  const c = await client();
  const model = getAiModel();
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  // Claude Haiku has no server-side refusal fallback; send the parameter only to models that have it.
  const fallbackBetas = model.startsWith('claude-haiku') ? [] : ['server-side-fallback-2026-07-01'];
  const fallback = model.startsWith('claude-haiku') ? {} : { fallbacks: 'default' as const };
  const format = betaZodOutputFormat(schema);
  const params = {
    model,
    max_tokens: 16000,
    ...fallback,
    system: SYSTEM,
    output_config: { effort: opts.effort ?? 'medium', format },
    messages: [{ role: 'user' as const, content: user }],
  };
  let res;
  if (opts.onText) {
    // Streaming: the structured-outputs beta is added by parse() but not by stream().
    const stream = c.beta.messages.stream({ ...params, betas: [...fallbackBetas, 'structured-outputs-2025-12-15'] });
    stream.on('text', (_delta, snapshot) => opts.onText!(snapshot));
    res = await stream.finalMessage();
  } else {
    res = await c.beta.messages.parse({ ...params, betas: fallbackBetas });
  }
  if (res.stop_reason === 'refusal') throw new Error('AI がこの表現の生成を辞退しました');
  if (res.stop_reason === 'max_tokens') throw new Error('出力が途中で切れました。もう一度お試しください');
  let parsed: T | null = (res as { parsed_output?: T | null }).parsed_output ?? null;
  if (parsed == null) {
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      parsed = format.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  if (parsed == null) throw new Error('AI の出力を読み取れませんでした');
  const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
  const outputTokens = res.usage.output_tokens;
  return { data: parsed, usage: { inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) } };
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


const SuggestSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string().describe('The English expression in its base form (e.g. "get buy-in", "circle back")'),
        meaning_ja: z.string().describe('Concise natural Japanese meaning'),
        why_ja: z.string().describe('One short Japanese sentence: why it is useful for this learner'),
        category: z.enum(CATEGORIES),
        importance: z.number().int().describe('0-100 for this learner'),
        examples: z
          .array(z.object({ kind: z.enum(['business', 'daily', 'alternative']), en: z.string(), ja: z.string() }))
          .describe('Exactly 1 short business example. (More examples are written later, only for the ones the learner adds.)'),
      }),
    )
    .describe('Candidates, best first'),
});
export type SuggestedItem = z.infer<typeof SuggestSchema>['suggestions'][number];

export interface SuggestContext {
  /** How many candidates to ask for (more than needed, duplicates are removed on the device). */
  count: number;
  /** Expressions already in the library (a sample: most important / most recent). */
  library: string[];
  /** Previously suggested, by the learner's decision. */
  added: string[];
  known: string[];
  rejected: string[];
  /** Earlier suggestions not yet decided (do not repeat). */
  pending: string[];
  /** Target difficulty, described in English. */
  levelGuide: string;
  /** Avoid common business clichés (from level 2 up). */
  avoidCliches: boolean;
  /** e.g. "In the last set, the learner already knew 5 of 5." */
  feedback: string;
}

/**
 * Today's suggestions. Sends only expression texts (library sample and past
 * decisions) — no meanings, notes, or review history.
 */
/** Count of candidates the streamed JSON has started so far. */
export function countStartedItems(snapshot: string): number {
  return (snapshot.match(/"text"\s*:/g) ?? []).length;
}

export async function suggestExpressions(
  ctx: SuggestContext,
  onProgress?: (started: number) => void,
): Promise<{ items: SuggestedItem[]; usage: GenerateUsage; model: string }> {
  const list = (xs: string[]) => (xs.length ? xs.join(' | ') : '(none)');
  const prompt = [
    `Suggest ${ctx.count} English expressions this learner should add to their study list today.`,
    'Choose expressions a native speaker really uses in meetings, emails and conversations about payments, products, finance and leadership, plus some everyday conversation.',
    'Prefer multi-word expressions (phrasal verbs, collocations, idioms, set phrases). No basic words, no rare, archaic or literary phrases, no proper nouns.',
    `Target level: ${ctx.levelGuide}`,
    ...(ctx.avoidCliches
      ? ['Skip business-English staples that any working professional already knows (for example: touch base, circle back, follow up, ballpark figure, win-win, think outside the box, on the same page, low-hanging fruit, get buy-in, push back, loop in).']
      : []),
    ...(ctx.feedback ? [ctx.feedback] : []),
    'Vary the categories within the list. Do not suggest anything in the lists below, or a trivial variant of it.',
    '',
    `Already in the learner's library: ${list(ctx.library)}`,
    `Suggested before and still undecided: ${list(ctx.pending)}`,
    `Suggested before and added (the learner liked these — similar level and style is good): ${list(ctx.added)}`,
    `Suggested before but the learner already knew them (suggest slightly more advanced ones): ${list(ctx.known)}`,
    `Suggested before but not wanted (avoid this kind): ${list(ctx.rejected)}`,
    '',
    'For each: the expression, a concise Japanese meaning, one Japanese sentence on why it is useful for this learner, category, importance, and ONE short business example (with Japanese) following the example-sentence rules.',
  ].join('\n');
  // Choosing expressions needs little deliberation: low effort and a streamed reply keep it quick.
  const { data, usage } = await call(SuggestSchema, prompt, {
    effort: 'low',
    onText: onProgress ? (snap) => onProgress(countStartedItems(snap)) : undefined,
  });
  return { items: data.suggestions, usage, model: getAiModel() };
}

const CaptureSchema = z.object({
  base_form: z
    .string()
    .describe('The expression as a learner would study it: dictionary form (verbs in base form, nouns singular), keeping a multi-word phrase whole; unchanged if already so'),
  meaning_ja: z.string().describe('Concise natural Japanese meaning as used in the sentence'),
  category: z.enum(CATEGORIES),
  importance: z.number().int().describe('0-100 for this learner'),
  sentence_ja: z.string().describe('Natural Japanese translation of the found sentence'),
  examples: z
    .array(z.object({ kind: z.enum(['business', 'daily', 'alternative']), en: z.string(), ja: z.string() }))
    .describe('Exactly 2 NEW examples: one daily, one alternative (different sense or usage). The found sentence already serves as the business example.'),
  pronunciation: PronSchema.describe('Pronunciation guide for the FOUND sentence, exactly as written'),
});

/**
 * For an expression the learner found in a real text. Sends only the selected
 * words and the one sentence they were found in.
 */
export async function analyzeCaptured(selection: string, sentence: string): Promise<{ result: CaptureAi; usage: GenerateUsage }> {
  if (!sentence.trim()) return analyzeTyped(selection);
  const prompt = [
    `The learner found this expression in a real text and wants to study it: "${selection}"`,
    `Sentence it appeared in: ${sentence}`,
    '',
    'Give its base form, Japanese meaning as used here, category, importance, a Japanese translation of the sentence, 2 new examples (daily, alternative) following the example-sentence rules, and a pronunciation guide for the found sentence exactly as written.',
  ].join('\n');
  const { data, usage } = await call(CaptureSchema, prompt);
  const s = sentence.trim();
  return {
    usage,
    result: {
      baseForm: data.base_form.trim() || selection,
      meaning: data.meaning_ja.trim(),
      category: data.category as Category,
      importance: data.importance,
      sentenceJa: data.sentence_ja.trim(),
      examples: data.examples.slice(0, 2).map((x) => ({ kind: x.kind, en: x.en.trim(), ja: x.ja.trim() })),
      pronunciation: toGuide(data.pronunciation, s),
      model: getAiModel(),
    },
  };
}

/** Typed in directly, without a sentence: meaning, 3 examples, pronunciation for the first. */
async function analyzeTyped(text: string): Promise<{ result: CaptureAi; usage: GenerateUsage }> {
  const { data, usage } = await call(
    ExamplesSchema,
    `Expression: ${text}\nLearner has no meaning yet.\n\nWrite the category, importance, Japanese meaning, 3 examples and a pronunciation guide for the first example.`,
  );
  const examples = data.examples.slice(0, 3).map((x) => ({ kind: x.kind, en: x.en.trim(), ja: x.ja.trim() }));
  return {
    usage,
    result: {
      baseForm: text,
      meaning: data.meaning_ja.trim(),
      category: data.category as Category,
      importance: data.importance,
      sentenceJa: '',
      examples,
      pronunciation: examples[0] ? toGuide(data.pronunciation, examples[0].en) : undefined,
      model: getAiModel(),
    },
  };
}

const MoreSchema = z.object({
  examples: z
    .array(z.object({ kind: z.enum(['business', 'daily', 'alternative']), en: z.string(), ja: z.string() }))
    .describe('The requested number of NEW examples, of the requested kinds'),
  pronunciation: PronSchema.describe('Pronunciation guide for the FIRST existing example sentence, exactly as written'),
});

/**
 * Fill an expression up to 3 examples (keeping the ones it has) and add a
 * pronunciation guide to its first example if missing. Used after adding a
 * suggestion, which comes with a single example to keep suggestions fast.
 */
export async function completeExamples(expressionId: string): Promise<GenerateUsage | null> {
  const e = await db.expressions.get(expressionId);
  if (!e || e.examples.length === 0) return e ? generateExamples(expressionId) : null;
  const have = new Set(e.examples.map((x) => x.kind));
  const missing = (['business', 'daily', 'alternative'] as const).filter((k) => !have.has(k)).slice(0, Math.max(0, 3 - e.examples.length));
  const first = e.examples[0];
  if (missing.length === 0 && first.pronunciation) return null;
  const prompt = [
    describe(e),
    `Existing examples:\n${e.examples.map((x) => `- (${x.kind}) ${x.en}`).join('\n')}`,
    missing.length ? `Write ${missing.length} new example(s), kinds: ${missing.join(', ')}.` : 'Write no new examples (empty list).',
    `Write the pronunciation guide for this exact sentence: ${first.en}`,
  ].join('\n\n');
  const { data, usage } = await call(MoreSchema, prompt);
  await db.transaction('rw', db.expressions, async () => {
    const cur = await db.expressions.get(expressionId);
    if (!cur) return;
    const added: Example[] = data.examples
      .filter((x) => x.en.trim())
      .slice(0, Math.max(0, 3 - cur.examples.length))
      .map((x) => ({ id: uid(), kind: x.kind, en: x.en.trim(), ja: x.ja.trim(), origin: 'ai' as const, status: 'unverified' as const }));
    const examples = cur.examples.map((x, i) => (i === 0 && !x.pronunciation ? { ...x, pronunciation: toGuide(data.pronunciation, x.en) } : x));
    await db.expressions.put({ ...cur, examples: [...examples, ...added], updatedAt: nowIso() });
  });
  return usage;
}

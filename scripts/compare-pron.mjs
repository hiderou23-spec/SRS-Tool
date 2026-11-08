#!/usr/bin/env node
/**
 * Compare pronunciation-guide quality across models (Opus / Sonnet / Haiku).
 *
 * Sends exactly what the app sends for "発音ガイドを生成": the app's own system
 * prompt (read from src/lib/aiGenerate.ts so it never drifts), the same
 * structured-output schema, effort "medium", and the same user message.
 *
 * Usage (needs ANTHROPIC_API_KEY in the environment; costs roughly $1–2 for 24
 * sentences × 3 models):
 *   node scripts/compare-pron.mjs [--models opus,sonnet,haiku] [--limit N] [--out DIR]
 *   node scripts/compare-pron.mjs --dry      # print the request for the first sentence, no API call
 *
 * Writes <out>/results.json (every output with usage, latency, errors) and
 * <out>/blind.json (outputs relabelled A/B/C per sentence, in random order, plus
 * the key) so the outputs can be judged without knowing which model wrote them.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DRY = args.includes('--dry');

const MODELS = {
  opus: { id: 'claude-opus-5-5', inPerM: 4, outPerM: 20 },
  sonnet: { id: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10 },
  haiku: { id: 'claude-haiku-5-5', inPerM: 0.1, outPerM: 0.5 },
};
const models = arg('models', 'opus,sonnet,haiku').split(',').map((m) => m.trim());
for (const m of models) if (!MODELS[m]) throw new Error(`unknown model ${m}`);
const out = arg('out', join(root, 'compare-pron-out'));
const sentences = JSON.parse(readFileSync(join(here, 'compare-pron.sentences.json'), 'utf8')).slice(0, Number(arg('limit', 1e9)));

// The app's system prompt, verbatim.
const src = readFileSync(join(root, 'src/lib/aiGenerate.ts'), 'utf8');
const m = src.match(/const SYSTEM = `([\s\S]*?)`;/);
if (!m) throw new Error('SYSTEM prompt not found in src/lib/aiGenerate.ts');
const SYSTEM = m[1];

// Same schema as src/lib/aiGenerate.ts (PronOnlySchema).
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
const PronOnlySchema = z.object({ pronunciation: PronSchema });

// Same user message as generatePronunciation() in the app.
const userMessage = (s) =>
  [`Expression: ${s.expression}`, s.meaning ? `Learner's meaning: ${s.meaning}` : 'Learner has no meaning yet.'].join('\n') +
  `\nSentence: ${s.sentence}\n\nWrite the pronunciation guide for this exact sentence.`;

function params(modelKey, s) {
  const model = MODELS[modelKey].id;
  const haiku = modelKey === 'haiku';
  return {
    model,
    max_tokens: 16000,
    betas: haiku ? [] : ['server-side-fallback-2026-07-01'],
    ...(haiku ? {} : { fallbacks: 'default' }),
    system: SYSTEM,
    output_config: { effort: 'medium', format: betaZodOutputFormat(PronOnlySchema) },
    messages: [{ role: 'user', content: userMessage(s) }],
  };
}

if (DRY) {
  const p = params(models[0], sentences[0]);
  console.log(JSON.stringify({ ...p, output_config: { effort: 'medium', format: '(PronOnlySchema)' } }, null, 2));
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to the environment and run again.');
  process.exit(2);
}

const client = new Anthropic({ maxRetries: 3 });
const results = [];
// Two requests at a time per model: quick enough, gentle on rate limits.
async function runModel(modelKey) {
  const queue = [...sentences];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      const t0 = Date.now();
      try {
        const res = await client.beta.messages.parse(params(modelKey, s));
        const u = res.usage;
        const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const cost = (input * MODELS[modelKey].inPerM + u.output_tokens * MODELS[modelKey].outPerM) / 1e6;
        results.push({ id: s.id, model: modelKey, ms: Date.now() - t0, stop: res.stop_reason, servedBy: res.model, inputTokens: input, outputTokens: u.output_tokens, costUsd: cost, output: res.parsed_output?.pronunciation ?? null });
        process.stdout.write('.');
      } catch (err) {
        results.push({ id: s.id, model: modelKey, ms: Date.now() - t0, error: String(err?.message ?? err) });
        process.stdout.write('x');
      }
    }
  };
  await Promise.all([worker(), worker()]);
}
for (const mk of models) {
  process.stdout.write(`${mk}: `);
  await runModel(mk);
  process.stdout.write('\n');
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'results.json'), JSON.stringify({ sentences, results }, null, 2));

// Blind set: per sentence, shuffle the models and label them A, B, C.
const key = {};
const blind = sentences.map((s) => {
  const outs = results.filter((r) => r.id === s.id);
  for (let i = outs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [outs[i], outs[j]] = [outs[j], outs[i]];
  }
  const labelled = outs.map((r, i) => {
    const label = String.fromCharCode(65 + i);
    key[`${s.id}:${label}`] = r.model;
    return { label, output: r.output, error: r.error ?? null };
  });
  return { id: s.id, expression: s.expression, sentence: s.sentence, candidates: labelled };
});
writeFileSync(join(out, 'blind.json'), JSON.stringify(blind, null, 2));
writeFileSync(join(out, 'blind-key.json'), JSON.stringify(key, null, 2));

// Summary per model.
console.log('\nmodel   ok/total  avg s   total $   uncertain');
for (const mk of models) {
  const rs = results.filter((r) => r.model === mk);
  const ok = rs.filter((r) => r.output);
  const avg = ok.length ? ok.reduce((a, r) => a + r.ms, 0) / ok.length / 1000 : 0;
  const cost = ok.reduce((a, r) => a + r.costUsd, 0);
  const unc = ok.filter((r) => r.output.uncertain).length;
  console.log(`${mk.padEnd(7)} ${String(ok.length).padStart(2)}/${rs.length}     ${avg.toFixed(1).padStart(5)}  ${cost.toFixed(3).padStart(7)}   ${unc}`);
}
console.log(`\nwritten to ${out}`);

/**
 * "見たときに作る": write a pronunciation guide the moment the learner opens
 * the guide of an example that has none. One request per sentence even if the
 * panel is opened and closed repeatedly; only sentences actually looked at
 * cost anything.
 */
import { db } from '../db/db';
import { recordUsage } from '../components/AiPanel';
import { getApiKey } from './aiConfig';

const inflight = new Map<string, Promise<boolean>>();

/**
 * Generate the guide for this example if it still has none.
 * Resolves true when a guide was written, false when there was nothing to do
 * (already has one, example gone, or no API key). Rejects on an API error.
 */
export function ensurePronunciation(expressionId: string, exampleId: string): Promise<boolean> {
  const running = inflight.get(exampleId);
  if (running) return running;
  const job = (async () => {
    if (!getApiKey()) return false;
    const e = await db.expressions.get(expressionId);
    const ex = e?.examples.find((x) => x.id === exampleId);
    if (!ex || ex.pronunciation) return false;
    const { generatePronunciation } = await import('./aiGenerate');
    recordUsage(await generatePronunciation(expressionId, exampleId));
    return true;
  })();
  inflight.set(exampleId, job);
  // Forget it once settled, so a failed attempt can be retried.
  void job.finally(() => inflight.delete(exampleId)).catch(() => {});
  return job;
}

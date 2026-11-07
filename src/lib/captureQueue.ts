/**
 * Background AI work for expressions registered in a batch. Runs while the app
 * is open (also while the learner moves to other screens). If the app is
 * closed midway, the unfinished ones are found again by pendingAiIds() and can
 * be resumed.
 */
import { useSyncExternalStore } from 'react';
import { db } from '../db/db';
import { recordUsage } from '../components/AiPanel';
import { friendlyError } from './aiConfig';
import { applyCaptureAi } from './capture';

export interface QueueState {
  total: number;
  done: number;
  failed: number;
  running: boolean;
  /** Base-form changes made by the AI, for the summary. */
  renamed: { from: string; to: string }[];
  lastError: string;
  costUsd: number;
}

const EMPTY: QueueState = { total: 0, done: 0, failed: 0, running: false, renamed: [], lastError: '', costUsd: 0 };
let state: QueueState = EMPTY;
const listeners = new Set<() => void>();
const waiting: string[] = [];
let stopped = false;

function set(patch: Partial<QueueState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useCaptureQueue(): QueueState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Forget the finished batch's summary. */
export function clearQueueSummary() {
  if (!state.running) set({ ...EMPTY });
}

const CONCURRENCY = 2;

/** Add expressions to the queue and start working if idle. */
export function enqueueCaptureAi(ids: string[]) {
  const fresh = ids.filter((id) => !waiting.includes(id));
  if (fresh.length === 0) return;
  waiting.push(...fresh);
  if (!state.running) {
    stopped = false;
    set({ ...EMPTY, total: fresh.length, running: true });
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => set({ running: false }));
  } else {
    set({ total: state.total + fresh.length });
  }
}

async function worker() {
  let consecutive = 0;
  while (waiting.length && !stopped) {
    const id = waiting.shift()!;
    try {
      const e = await db.expressions.get(id);
      const sentence = e?.examples[0]?.origin === 'user' ? e.examples[0].en : '';
      if (!e || e.ai || !sentence) {
        set({ done: state.done + 1 });
        continue;
      }
      const { analyzeCaptured } = await import('./aiGenerate');
      const { result, usage } = await analyzeCaptured(e.text, sentence);
      recordUsage(usage);
      const rename = await applyCaptureAi(id, result);
      consecutive = 0;
      set({ done: state.done + 1, costUsd: state.costUsd + usage.costUsd, renamed: rename ? [...state.renamed, rename] : state.renamed });
    } catch (err) {
      consecutive++;
      set({ done: state.done + 1, failed: state.failed + 1, lastError: friendlyError(err) });
      const status = (err as { status?: number }).status;
      // A bad key or repeated failures: stop; the rest can be resumed later.
      if (status === 401 || consecutive >= 4) {
        stopped = true;
        waiting.length = 0;
      }
    }
  }
}

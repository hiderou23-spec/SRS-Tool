/** Lightweight AI settings shared by the UI (no SDK / zod imports here). */
const KEY_STORAGE = 'em.anthropicApiKey';
const MODEL_STORAGE = 'em.aiModel';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（最高品質・推奨）', inPerM: 4, outPerM: 20 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（バランス）', inPerM: 2, outPerM: 10 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（低コスト）', inPerM: 0.1, outPerM: 0.5 },
] as const;
export type AiModelId = (typeof AI_MODELS)[number]['id'];

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

export const getApiKey = () => safeGet(KEY_STORAGE);
export const setApiKey = (k: string | null) => safeSet(KEY_STORAGE, k?.trim() || null);
export const getAiModel = (): AiModelId => (AI_MODELS.find((m) => m.id === safeGet(MODEL_STORAGE))?.id ?? 'claude-opus-5-5');
export const setAiModel = (m: AiModelId) => safeSet(MODEL_STORAGE, m);

export function estimateCostUsd(model: AiModelId, inputTokens: number, outputTokens: number): number {
  const m = AI_MODELS.find((x) => x.id === model)!;
  return (inputTokens * m.inPerM + outputTokens * m.outPerM) / 1_000_000;
}

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function friendlyError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e?.status === 401) return 'API キーが正しくありません';
  if (e?.status === 429) return '利用上限に達しました。少し待ってから再開してください';
  if (e?.status === 529 || (e?.status ?? 0) >= 500) return 'Anthropic 側が混み合っています。少し待ってから再開してください';
  if (e?.message?.includes('Failed to fetch')) return 'ネットワークに接続できません';
  return e?.message ?? String(err);
}

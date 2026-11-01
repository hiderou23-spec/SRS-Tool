import { useRef, useState } from 'react';
import { AI_MODELS, friendlyError, getAiModel, getApiKey, setAiModel, setApiKey, type AiModelId, type GenerateUsage } from '../lib/aiConfig';
import { toast } from '../lib/hooks';

const SPEND_KEY = 'em.aiSpendUsd';
function readSpend(): number {
  try {
    return Number(localStorage.getItem(SPEND_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function addSpend(usd: number) {
  try {
    localStorage.setItem(SPEND_KEY, String(readSpend() + usd));
  } catch {
    /* ignore */
  }
}
export function recordUsage(u: GenerateUsage) {
  addSpend(u.costUsd);
}

type Job = 'examples' | 'pronunciation';

export default function AiPanel() {
  const [key, setKey] = useState(getApiKey() ?? '');
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [model, setModel] = useState<AiModelId>(getAiModel());
  const [count, setCount] = useState(20);
  const [running, setRunning] = useState<Job | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0, cost: 0, last: '' });
  const [spend, setSpend] = useState(readSpend());
  const stopRef = useRef(false);

  const saveKey = () => {
    setApiKey(key);
    setHasKey(!!key.trim());
    toast(key.trim() ? 'API キーを保存しました（この端末のみ）' : 'API キーを削除しました');
  };

  const run = async (job: Job) => {
    if (!getApiKey()) {
      toast('先に API キーを保存してください');
      return;
    }
    const { bulkCandidates, bulkPronunciationCandidates, generateExamples, generatePronunciation } = await import('../lib/aiGenerate');
    const targets =
      job === 'examples'
        ? (await bulkCandidates(count)).map((expressionId) => ({ expressionId, exampleId: '' }))
        : await bulkPronunciationCandidates(count);
    if (targets.length === 0) {
      toast(job === 'examples' ? '例文のない表現はありません' : '発音ガイドのない例文はありません');
      return;
    }
    const m = AI_MODELS.find((x) => x.id === model)!;
    const perItem = job === 'examples' ? (2500 * m.inPerM + 2500 * m.outPerM) / 1e6 : (1800 * m.inPerM + 1200 * m.outPerM) / 1e6;
    if (!confirm(`${targets.length}件を生成します。\n\n目安の費用：約 $${(perItem * targets.length).toFixed(2)}（${m.label}）\n送信する内容：英語表現・意味・メモ・例文のみ\n\n途中で止めることもできます。続けますか？`)) return;

    stopRef.current = false;
    setRunning(job);
    setProgress({ done: 0, total: targets.length, failed: 0, cost: 0, last: '' });
    let done = 0;
    let failed = 0;
    let cost = 0;
    let consecutiveErrors = 0;
    // Small concurrency keeps it fast without hammering rate limits.
    const queue = [...targets];
    const worker = async () => {
      while (queue.length && !stopRef.current) {
        const t = queue.shift()!;
        try {
          const u = job === 'examples' ? await generateExamples(t.expressionId) : await generatePronunciation(t.expressionId, t.exampleId);
          cost += u.costUsd;
          recordUsage(u);
          consecutiveErrors = 0;
        } catch (err) {
          failed++;
          consecutiveErrors++;
          const msg = friendlyError(err);
          setProgress((p) => ({ ...p, last: msg }));
          const status = (err as { status?: number }).status;
          if (status === 401 || consecutiveErrors >= 5) stopRef.current = true;
        }
        done++;
        setProgress((p) => ({ ...p, done, failed, cost }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setRunning(null);
    setSpend(readSpend());
    toast(stopRef.current && done < targets.length ? `停止しました（${done - failed}件 生成）` : `${done - failed}件を生成しました`);
  };

  return (
    <div className="card stack">
      <p className="small" style={{ margin: 0 }}>
        ご自身の Anthropic API キーで、例文・日本語訳・発音ガイドをこの場で生成します。ボタンを押したときだけ、英語表現・意味・メモ・例文が Anthropic に送信されます（学習履歴は送りません）。生成物はすべて「AI生成・要確認」として保存されます。
      </p>
      <label className="field" style={{ marginBottom: 0 }}>
        <span>API キー（この端末のブラウザにのみ保存・バックアップには含まれません）</span>
        <div className="row">
          <input className="input grow" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn sm" onClick={saveKey}>保存</button>
        </div>
      </label>
      <p className="tiny muted" style={{ margin: 0 }}>
        キーは console.anthropic.com で発行できます。使った分だけ課金されます。{hasKey ? '（保存済み）' : ''}
      </p>
      <label className="field" style={{ marginBottom: 0 }}>
        <span>モデル</span>
        <select className="select" value={model} onChange={(e) => { const v = e.target.value as AiModelId; setModel(v); setAiModel(v); }}>
          {AI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>

      <div className="hr" />
      <div className="row between">
        <span className="small">まとめて生成（重要度の高い順）</span>
        <select className="select" style={{ maxWidth: 110, minHeight: 38 }} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={!!running}>
          {[5, 20, 50, 100, 300].map((n) => <option key={n} value={n}>{n}件</option>)}
        </select>
      </div>
      <button className="btn primary block" disabled={!!running || !hasKey} onClick={() => run('examples')}>
        {running === 'examples' ? '例文を生成中…' : '例文のない表現に例文＋発音ガイドを生成'}
      </button>
      <button className="btn block" disabled={!!running || !hasKey} onClick={() => run('pronunciation')}>
        {running === 'pronunciation' ? '発音ガイドを生成中…' : '例文に発音ガイドだけを追加'}
      </button>
      {running && (
        <div className="stack">
          <div className="meter"><div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
          <div className="row between small">
            <span>{progress.done} / {progress.total}{progress.failed ? `（失敗 ${progress.failed}）` : ''}</span>
            <span className="muted">約 ${progress.cost.toFixed(3)}</span>
          </div>
          {progress.last && <div className="tiny" style={{ color: 'var(--again)' }}>{progress.last}</div>}
          <button className="btn ghost block danger" onClick={() => { stopRef.current = true; }}>停止する</button>
        </div>
      )}
      <p className="tiny muted" style={{ margin: 0 }}>これまでの生成費用の目安：約 ${spend.toFixed(2)}（この端末での合計・概算）</p>
    </div>
  );
}

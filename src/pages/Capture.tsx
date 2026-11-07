import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Expression } from '../db/types';
import { AI_MODELS, getAiModel, getApiKey, friendlyError } from '../lib/aiConfig';
import { toast } from '../lib/hooks';
import { recordUsage } from '../components/AiPanel';
import {
  addBatch,
  addCaptured,
  findExisting,
  libraryKeys,
  MAX_CAPTURE_CHARS,
  pendingAiIds,
  planBatch,
  runsOf,
  selectionText,
  sentenceAround,
  toggleToken,
  tokenize,
  unstartedCount,
  type CaptureAi,
} from '../lib/capture';
import { clearQueueSummary, enqueueCaptureAi, useCaptureQueue } from '../lib/captureQueue';

interface Draft {
  selection: string;
  sentence: string;
  text: string;
  keepSentence: boolean;
  how: 'ai' | 'manual';
  meaning: string;
  ai: CaptureAi | null;
  aiLoading: boolean;
  aiError: string;
  existing: Expression | null;
}

type SetDraft = Dispatch<SetStateAction<Draft | null>>;

/** Ask the AI for the base form, meaning, examples and pronunciation; merge into the draft. */
function startAi(setDraft: SetDraft, selection: string, sentence: string) {
  const mine = (d: Draft | null) => !!d && d.selection === selection && d.sentence === sentence;
  setDraft((d) => (mine(d) ? { ...d!, how: 'ai', aiLoading: true, aiError: '' } : d));
  void import('../lib/aiGenerate')
    .then(({ analyzeCaptured }) => analyzeCaptured(selection, sentence))
    .then(({ result, usage }) => {
      recordUsage(usage);
      // Use the AI's base form unless the learner already edited the text.
      setDraft((d) => (mine(d) ? { ...d!, ai: result, aiLoading: false, text: d!.text === selection ? result.baseForm : d!.text } : d));
    })
    .catch((err) => setDraft((d) => (mine(d) ? { ...d!, aiLoading: false, aiError: friendlyError(err) } : d)));
}

function AddSheet({ draft, setDraft, onClose, onAdded }: { draft: Draft; setDraft: SetDraft; onClose: () => void; onAdded: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const hasKey = !!getApiKey();
  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const runAi = () => startAi(setDraft, draft.selection, draft.sentence);

  // Check for a duplicate whenever the expression text changes.
  useEffect(() => {
    let cancelled = false;
    const text = draft.text;
    void findExisting(text).then((e) => {
      if (!cancelled) setDraft((d) => (d && d.text === text ? { ...d, existing: e ?? null } : d));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.text, setDraft]);

  const add = async () => {
    setBusy(true);
    try {
      await addCaptured({
        text: draft.text,
        sentence: draft.sentence,
        keepSentence: draft.keepSentence,
        meaning: draft.how === 'manual' ? draft.meaning : '',
        ai: draft.how === 'ai' && draft.ai ? draft.ai : undefined,
      });
      onAdded(draft.text);
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const canAdd = !!draft.text.trim() && !draft.existing && !(draft.how === 'ai' && draft.aiLoading);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet stack" role="dialog" aria-label="ライブラリに追加" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2 style={{ margin: 0, fontSize: 19 }}>ライブラリに追加</h2>
          <button className="btn ghost sm" onClick={onClose}>閉じる</button>
        </div>

        <label className="field" style={{ marginBottom: 0 }}>
          <span>表現</span>
          <input className="input capture-expr" value={draft.text} onChange={(e) => update({ text: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {draft.ai && draft.ai.baseForm.toLowerCase() !== draft.selection.toLowerCase() && (
            <span className="tiny muted">AIの提案：{draft.selection} → {draft.ai.baseForm}（自由に直せます）</span>
          )}
        </label>
        {draft.existing && (
          <div className="notice info" style={{ margin: 0 }}>
            「{draft.existing.text}」はすでにライブラリにあります。<a href={`#/library/${draft.existing.id}`}>開く</a>
          </div>
        )}

        <div>
          <div className="small" style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>見つけた文</div>
          <div className="capture-sentence">{draft.sentence}</div>
          {draft.ai?.sentenceJa && <div className="small muted" style={{ marginTop: 4 }}>{draft.ai.sentenceJa} <span className="ai-tag">AI</span></div>}
          <label className="row small" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={draft.keepSentence} onChange={(e) => update({ keepSentence: e.target.checked })} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
            この文を例文として保存する
          </label>
        </div>

        <div className="stack">
          <div className="small" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>意味と残りの例文</div>
          <label className={draft.how === 'ai' ? 'capture-option on' : 'capture-option'}>
            <input type="radio" name="how" checked={draft.how === 'ai'} disabled={!hasKey} onChange={() => (draft.ai ? update({ how: 'ai' }) : runAi())} />
            <span className="grow">
              <b>AIに作ってもらう</b>
              <span className="tiny muted" style={{ display: 'block' }}>
                {hasKey ? '原形・意味・例文2つ・発音ガイド（AI・要確認）。選んだ語と、それを含む1文だけを送ります' : 'Settings → AI 生成 で API キーを保存すると使えます'}
              </span>
              {draft.how === 'ai' && draft.aiLoading && <span className="small" style={{ display: 'block', marginTop: 6 }}>AIが確認しています…</span>}
              {draft.how === 'ai' && draft.aiError && (
                <span className="small" style={{ display: 'block', marginTop: 6, color: 'var(--again)' }}>
                  {draft.aiError} <button className="btn ghost sm" onClick={runAi}>再試行</button>
                </span>
              )}
              {draft.how === 'ai' && draft.ai && <span className="small" style={{ display: 'block', marginTop: 6 }}>{draft.ai.meaning}</span>}
            </span>
          </label>
          <label className={draft.how === 'manual' ? 'capture-option on' : 'capture-option'}>
            <input type="radio" name="how" checked={draft.how === 'manual'} onChange={() => update({ how: 'manual' })} />
            <span className="grow">
              <b>意味を自分で入力する</b>
              {draft.how === 'manual' && (
                <input className="input" style={{ marginTop: 8 }} placeholder="日本語の意味" value={draft.meaning} onChange={(e) => update({ meaning: e.target.value })} />
              )}
            </span>
          </label>
        </div>

        <button className="btn primary block lg" disabled={!canAdd || busy} onClick={add}>追加する</button>
        <p className="tiny muted" style={{ margin: 0 }}>自分で追加した表現は、未学習の表現より先に出題されます（1日の新規上限の範囲で）。</p>
      </div>
    </div>
  );
}

/** Rough per-item cost of the background AI work (base form, meaning, 2 examples, guide). */
function estimatePerItemUsd(): number {
  const m = AI_MODELS.find((x) => x.id === getAiModel())!;
  return (1500 * m.inPerM + 1500 * m.outPerM) / 1e6;
}

function QueueStatus() {
  const q = useCaptureQueue();
  const pending = useLiveQuery(() => pendingAiIds(), []);
  const hasKey = !!getApiKey();
  const leftover = q.running ? 0 : (pending?.length ?? 0);
  if (!q.running && q.total === 0 && leftover === 0) return null;
  const pct = q.total ? Math.round((q.done / q.total) * 100) : 0;
  return (
    <div className="card stack capture-queue" role="status" aria-live="polite">
      {q.total > 0 && (
        <>
          <div className="row between small">
            <span>{q.running ? 'AIで作成中…' : 'AIの作成が終わりました'}</span>
            <b>{q.done} / {q.total}</b>
          </div>
          <div className="meter"><div style={{ width: `${pct}%` }} /></div>
          {q.running && <p className="tiny muted" style={{ margin: 0 }}>他の画面に移っても続きます（アプリを閉じると止まり、次回ここから再開できます）。</p>}
          {q.renamed.length > 0 && (
            <p className="small" style={{ margin: 0 }}>原形に直しました：{q.renamed.map((r) => `${r.from} → ${r.to}`).join('、')}</p>
          )}
          {q.failed > 0 && <p className="small" style={{ margin: 0, color: 'var(--again)' }}>{q.failed}件は作成できませんでした（{q.lastError}）。</p>}
        </>
      )}
      {leftover > 0 && (
        hasKey ? (
          <button className="btn block" onClick={() => { clearQueueSummary(); void pendingAiIds().then(enqueueCaptureAi); }}>
            AIの作成を再開（残り {leftover}件・約${(estimatePerItemUsd() * leftover).toFixed(2)}）
          </button>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>意味が空の表現が {leftover}件あります。Settings → AI 生成 で API キーを保存すると、ここから作成できます。</p>
        )
      )}
    </div>
  );
}

export default function Capture() {
  const [raw, setRaw] = useState('');
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const unstarted = useLiveQuery(() => unstartedCount(), []);
  const keys = useLiveQuery(() => libraryKeys(), []);
  const tokens = useMemo(() => tokenize(raw), [raw]);
  const runs = useMemo(() => runsOf(tokens, chosen), [tokens, chosen]);
  const plan = useMemo(() => (keys ? planBatch(tokens, runs, keys) : []), [tokens, runs, keys]);
  const newCount = plan.filter((p) => p.status === 'new').length;
  const hasKey = !!getApiKey();

  const reset = () => setChosen(new Set());

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) {
        toast('クリップボードが空です');
        return;
      }
      setRaw(t.slice(0, MAX_CAPTURE_CHARS));
      reset();
      setPicking(true);
    } catch {
      toast('貼り付けできませんでした。下の欄を長押しして「ペースト」してください');
    }
  };

  /** One expression: the confirmation sheet (base form, meaning, examples). */
  const openSheet = async () => {
    const run = runs[0];
    const selected = run ? selectionText(tokens, run) : '';
    if (!run || !selected) return;
    const sentence = sentenceAround(tokens, run);
    // Already in the library: say so and don't spend an AI call on it.
    const existing = (await findExisting(selected)) ?? null;
    const useAi = hasKey && !existing;
    const base: Draft = {
      selection: selected, sentence, text: selected, keepSentence: true,
      how: hasKey ? 'ai' : 'manual', meaning: '', ai: null, aiLoading: useAi, aiError: '', existing,
    };
    setDraft(base);
    if (useAi) startAi(setDraft, selected, sentence);
  };

  /** Several expressions: register now, let the AI finish them in the background. */
  const registerAll = async () => {
    setBusy(true);
    try {
      const ids = await addBatch(plan);
      const names = plan.filter((p) => p.status === 'new').map((p) => p.text);
      toast(`${ids.length}件を登録しました`);
      setAdded((xs) => [...xs, ...names]);
      reset();
      if (ids.length && hasKey) {
        clearQueueSummary();
        enqueueCaptureAi(ids);
      }
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <a className="btn ghost sm" href="#/library" style={{ paddingLeft: 0 }}>‹ Library</a>
      <h1 className="page-title" style={{ marginTop: 4 }}>コピーした文から追加</h1>

      <QueueStatus />

      {!picking ? (
        <div className="card stack">
          <p className="small" style={{ margin: 0 }}>Safari・メール・Slack などで、知らない単語を含む文をコピーしてから押してください。長い文章でも大丈夫です。</p>
          <button className="btn primary block lg" onClick={pasteFromClipboard}>クリップボードから貼り付け</button>
          <textarea
            className="textarea"
            rows={4}
            placeholder="うまく貼り付けられないときは、ここを長押しして「ペースト」"
            value={raw}
            onChange={(e) => setRaw(e.target.value.slice(0, MAX_CAPTURE_CHARS))}
          />
          <button className="btn block" disabled={tokens.length === 0} onClick={() => { reset(); setPicking(true); }}>この文から選ぶ</button>
          <p className="tiny muted" style={{ margin: 0 }}>貼り付けた文はこの画面でだけ使います。保存されるのは、選んだ語を含む1文だけです。</p>
        </div>
      ) : (
        <>
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            登録したい語をタップしてください。いくつでも選べます。隣り合う語を続けて選ぶと、1つの表現になります（例：table・the・discussion）。もう一度タップすると外れます。
          </p>
          <div className="card">
            <div className="row between" style={{ marginBottom: 6 }}>
              <span className="tiny muted" style={{ fontWeight: 600 }}>貼り付けた文</span>
              <button className="btn ghost sm" onClick={() => { setPicking(false); reset(); }}>貼り付け直す</button>
            </div>
            <div className="capture-text">
              {tokens.map((t, i) => (
                <button key={i} className={chosen.has(i) ? 'capture-word on' : 'capture-word'} aria-pressed={chosen.has(i)} onClick={() => setChosen(toggleToken(chosen, i))}>{t}</button>
              ))}
            </div>
          </div>

          {plan.length === 0 ? (
            <p className="small muted" style={{ margin: '4px 4px 0' }}>まだ何も選ばれていません。</p>
          ) : (
            <div className="capture-bar">
              <div className="row between small" style={{ marginBottom: 6 }}>
                <span className="muted">選択中 {plan.length}件</span>
                <button className="btn ghost sm" onClick={reset}>選択を解除</button>
              </div>
              <div className="capture-chips">
                {plan.map((p, i) => (
                  <span key={i} className={'capture-chip ' + p.status}>
                    {p.text}
                    {p.status === 'exists' && <small>登録済み</small>}
                    {p.status === 'dup' && <small>重複</small>}
                  </span>
                ))}
              </div>
              {plan.length === 1 ? (
                <button className="btn primary block lg" disabled={plan[0].status !== 'new'} onClick={openSheet}>
                  {plan[0].status === 'new' ? `「${plan[0].text}」を追加` : 'すでにライブラリにあります'}
                </button>
              ) : (
                <>
                  <button className="btn primary block lg" disabled={newCount === 0 || busy} onClick={registerAll}>
                    {newCount === 0 ? '新しく登録できる語がありません' : `${newCount}件をまとめて登録`}
                  </button>
                  <p className="tiny muted" style={{ margin: '6px 2px 0' }}>
                    {hasKey
                      ? `登録したあと、AIが裏で原形・意味・例文・発音ガイドを作ります（約$${(estimatePerItemUsd() * newCount).toFixed(2)}）。送るのは選んだ語と、それを含む1文だけです。`
                      : '見つけた文を例文にして登録します。意味は空のままです（APIキーを保存すると、あとでAIで作れます）。'}
                    {plan.some((p) => p.status !== 'new') && ' 登録済み・重複の語は飛ばします。'}
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}

      {added.length > 0 && <p className="small" style={{ margin: '14px 4px 0' }}>追加しました：{added.join('、')}</p>}

      {unstarted !== undefined && unstarted > 0 && (
        <p className="tiny muted" style={{ margin: '14px 4px 0' }}>今、まだ学習していない表現が {unstarted.toLocaleString()}語 あります。</p>
      )}

      {draft && (
        <AddSheet
          draft={draft}
          setDraft={setDraft}
          onClose={() => setDraft(null)}
          onAdded={(text) => {
            toast(`「${text}」を追加しました`);
            setAdded((xs) => [...xs, text]);
            setDraft(null);
            reset();
          }}
        />
      )}
    </main>
  );
}

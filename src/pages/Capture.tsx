import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Expression } from '../db/types';
import { getApiKey, friendlyError } from '../lib/aiConfig';
import { toast } from '../lib/hooks';
import { recordUsage } from '../components/AiPanel';
import {
  addCaptured,
  findExisting,
  isWholeSentence,
  MAX_CAPTURE_CHARS,
  nextSelection,
  selectionText,
  sentenceAround,
  sentenceRange,
  tokenize,
  unstartedCount,
  type CaptureAi,
  type Selection,
} from '../lib/capture';

interface Draft {
  /** 'paste': picked from pasted text; 'typed': entered directly. */
  source: 'paste' | 'typed';
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

        {draft.sentence && <div>
          <div className="small" style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>{draft.source === 'typed' ? '入力した例文' : '見つけた文'}</div>
          <div className="capture-sentence">{draft.sentence}</div>
          {draft.ai?.sentenceJa && <div className="small muted" style={{ marginTop: 4 }}>{draft.ai.sentenceJa} <span className="ai-tag">AI</span></div>}
          <label className="row small" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={draft.keepSentence} onChange={(e) => update({ keepSentence: e.target.checked })} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
            この文を例文として保存する
          </label>
        </div>}

        <div className="stack">
          <div className="small" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{draft.sentence ? '意味と残りの例文' : '意味と例文'}</div>
          <label className={draft.how === 'ai' ? 'capture-option on' : 'capture-option'}>
            <input type="radio" name="how" checked={draft.how === 'ai'} disabled={!hasKey} onChange={() => (draft.ai ? update({ how: 'ai' }) : runAi())} />
            <span className="grow">
              <b>AIに作ってもらう</b>
              <span className="tiny muted" style={{ display: 'block' }}>
                {!hasKey
                  ? 'Settings → AI 生成 で API キーを保存すると使えます'
                  : draft.sentence
                    ? `原形・意味・例文2つ・発音ガイド（AI・要確認）。${draft.source === 'typed' ? '入力した表現と例文' : '選んだ語と、それを含む1文'}だけを送ります`
                    : '意味・例文3つ・発音ガイド（AI・要確認）。入力した表現だけを送ります'}
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

export default function Capture() {
  const [raw, setRaw] = useState('');
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [typedExample, setTypedExample] = useState('');
  const unstarted = useLiveQuery(() => unstartedCount(), []);
  const tokens = useMemo(() => tokenize(raw), [raw]);
  const selected = selectionText(tokens, sel);

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) {
        toast('クリップボードが空です');
        return;
      }
      setRaw(t.slice(0, MAX_CAPTURE_CHARS));
      setSel(null);
      setPicking(true);
    } catch {
      toast('貼り付けできませんでした。下の欄を長押しして「ペースト」してください');
    }
  };

  const open = async (source: Draft['source'], selection: string, sentence: string) => {
    if (!selection) return;
    // Already in the library: say so and don't spend an AI call on it.
    const existing = (await findExisting(selection)) ?? null;
    const useAi = !!getApiKey() && !existing;
    const base: Draft = {
      source, selection, sentence, text: selection,
      // A whole sentence added as the expression doesn't need itself as an example.
      keepSentence: !!sentence && !isWholeSentence(selection, sentence),
      how: getApiKey() ? 'ai' : 'manual', meaning: '', ai: null, aiLoading: useAi, aiError: '', existing,
    };
    setDraft(base);
    if (useAi) startAi(setDraft, selection, sentence);
  };
  const openSheet = () => sel && open('paste', selected, sentenceAround(tokens, sel));
  const openTyped = () => open('typed', typed.trim(), typedExample.trim());
  const selectWholeSentence = () => {
    if (tokens.length === 0) return;
    setSel(sentenceRange(tokens, sel ?? { a: 0, b: 0 }));
  };

  return (
    <main className="page">
      <a className="btn ghost sm" href="#/library" style={{ paddingLeft: 0 }}>‹ Library</a>
      <h1 className="page-title" style={{ marginTop: 4 }}>表現を追加</h1>

      {!picking ? (
        <div className="card stack">
          <p className="small" style={{ margin: 0 }}>Safari・メール・Slack などで、知らない単語を含む文をコピーしてから押してください。</p>
          <button className="btn primary block lg" onClick={pasteFromClipboard}>クリップボードから貼り付け</button>
          <textarea
            className="textarea"
            rows={4}
            placeholder="うまく貼り付けられないときは、ここを長押しして「ペースト」"
            value={raw}
            onChange={(e) => setRaw(e.target.value.slice(0, MAX_CAPTURE_CHARS))}
          />
          <button className="btn block" disabled={tokens.length === 0} onClick={() => { setSel(null); setPicking(true); }}>この文から選ぶ</button>
          <p className="tiny muted" style={{ margin: 0 }}>貼り付けた文はこの画面でだけ使います。保存されるのは、選んだ語を含む1文だけです。</p>
        </div>
      ) : null}

      {!picking && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>単語・表現を直接入力</h2>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>単語・フレーズ・文</span>
            <input className="input capture-expr" placeholder="例：circulate / table the discussion" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>例文（任意）</span>
            <textarea className="textarea" rows={2} placeholder="実際に見聞きした文があれば。なければAIが例文を作ります" value={typedExample} onChange={(e) => setTypedExample(e.target.value)} />
          </label>
          <button className="btn primary block" disabled={!typed.trim()} onClick={openTyped}>追加へ進む</button>
        </div>
      )}

      {!picking ? null : (
        <>
          <p className="small muted" style={{ margin: '0 0 10px' }}>登録したい単語をタップしてください。続けて別の単語をタップすると、その間の語もまとめて選べます。</p>
          <div className="card">
            <div className="row between" style={{ marginBottom: 6 }}>
              <span className="tiny muted" style={{ fontWeight: 600 }}>貼り付けた文</span>
              <div className="row" style={{ gap: 0 }}>
                <button className="btn ghost sm" onClick={selectWholeSentence}>文全体を選ぶ</button>
                <button className="btn ghost sm" onClick={() => { setPicking(false); setSel(null); }}>貼り付け直す</button>
              </div>
            </div>
            <div className="capture-text">
              {tokens.map((t, i) => {
                const on = !!sel && i >= sel.a && i <= sel.b;
                return (
                  <button key={i} className={on ? 'capture-word on' : 'capture-word'} onClick={() => setSel(nextSelection(sel, i))}>{t}</button>
                );
              })}
            </div>
          </div>
          {selected ? (
            <div className="stack" style={{ margin: '4px 4px 0' }}>
              <div className="small muted">選択中</div>
              <div className="capture-selected">{selected}</div>
              <button className="btn primary block lg" onClick={openSheet}>「{selected}」を追加</button>
            </div>
          ) : (
            <p className="small muted" style={{ margin: '4px 4px 0' }}>まだ何も選ばれていません。</p>
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
            setSel(null);
            setTyped('');
            setTypedExample('');
          }}
        />
      )}
    </main>
  );
}

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../db/db';
import { CATEGORY_LABELS, type Category, type Example, type ExampleKind, type Expression, type PronunciationGuide, type QualityStatus } from '../db/types';
import { classifyKind, cleanEnglish, normalizeKey } from '../import/clean';
import { refreshDuplicateGroups } from '../import/importer';
import { formatInterval, nowIso, uid } from '../lib/util';
import { effectiveImportance, DEFAULT_IMPORTANCE } from '../srs/queue';
import { retrievability, State } from '../srs/scheduler';
import { useSettings, toast } from '../lib/hooks';
import { hashParams, navigate } from '../lib/router';
import { IconBack } from '../components/Icons';
import { QualityChip } from '../components/Pronunciation';
import { friendlyError, getApiKey, type GenerateUsage } from '../lib/aiConfig';
import { recordUsage } from '../components/AiPanel';

const STATE_LABEL = ['未学習', '学習中', '復習', '再学習'];
const KINDS: { k: ExampleKind; label: string }[] = [
  { k: 'business', label: 'Business' },
  { k: 'daily', label: 'Daily' },
  { k: 'alternative', label: 'Alternative' },
];
const RATING_LABEL = ['', 'Again', 'Hard', 'Good', 'Easy'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function PronEditor({ value, onChange }: { value?: PronunciationGuide; onChange: (v?: PronunciationGuide) => void }) {
  if (!value) {
    return (
      <button className="btn sm" onClick={() => onChange({ level1: {}, origin: 'user', status: 'unverified' })}>発音ガイドを追加</button>
    );
  }
  const set = (patch: Partial<PronunciationGuide>) => onChange({ ...value, ...patch, origin: value.origin === 'imported' ? 'imported' : value.origin });
  const lv = (k: 'level1' | 'level2' | 'level3', f: 'text' | 'katakana' | 'ipa', v: string) => set({ [k]: { ...(value[k] ?? {}), [f]: v || undefined } });
  return (
    <div className="pron stack">
      <div className="row between">
        <QualityChip status={value.status} origin={value.origin} />
        <button className="btn ghost sm danger" onClick={() => onChange(undefined)}>削除</button>
      </div>
      <div className="small muted">Level 1 · 通常</div>
      <input className="input" placeholder="カタカナ" value={value.level1.katakana ?? ''} onChange={(e) => lv('level1', 'katakana', e.target.value)} />
      <input className="input" placeholder="IPA" value={value.level1.ipa ?? ''} onChange={(e) => lv('level1', 'ipa', e.target.value)} />
      {(['level2', 'level3'] as const).map((k) => (
        <div key={k} className="stack">
          <div className="small muted">{k === 'level2' ? 'Level 2 · 自然な会話' : 'Level 3 · 速い/カジュアル（無理に作らない）'}</div>
          <input className="input" placeholder="英語表記 (例: We nee-tuh hamme-rout…)" value={value[k]?.text ?? ''} onChange={(e) => lv(k, 'text', e.target.value)} autoCapitalize="off" />
          <input className="input" placeholder="カタカナ" value={value[k]?.katakana ?? ''} onChange={(e) => lv(k, 'katakana', e.target.value)} />
          <input className="input" placeholder="IPA" value={value[k]?.ipa ?? ''} onChange={(e) => lv(k, 'ipa', e.target.value)} />
        </div>
      ))}
      <textarea className="textarea" placeholder="解説（連結・弱化・脱落など）" value={value.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      <label className="row between"><span className="small">音の変化がほとんどない</span>
        <span className="toggle"><input type="checkbox" checked={!!value.minimalChange} onChange={(e) => set({ minimalChange: e.target.checked })} /><span /></span>
      </label>
      <StatusSelect value={value.status} onChange={(status) => set({ status })} />
    </div>
  );
}

function StatusSelect({ value, onChange }: { value: QualityStatus; onChange: (v: QualityStatus) => void }) {
  return (
    <div className="seg" role="group">
      {(['unverified', 'needs_review', 'verified'] as const).map((s) => (
        <button key={s} aria-pressed={value === s} onClick={() => onChange(s)} style={{ fontSize: 12.5 }}>
          {s === 'unverified' ? '未検証' : s === 'needs_review' ? '要確認' : '確認済み'}
        </button>
      ))}
    </div>
  );
}

export default function ExpressionDetail({ id }: { id: string }) {
  const settings = useSettings();
  const stored = useLiveQuery(() => db.expressions.get(id).then((e) => e ?? null), [id]);
  const cards = useLiveQuery(() => db.cards.where('expressionId').equals(id).toArray(), [id]);
  const logs = useLiveQuery(() => db.logs.where('expressionId').equals(id).toArray(), [id]);
  const raw = useLiveQuery(async () => {
    const e = await db.expressions.get(id);
    if (!e?.source) return undefined;
    return db.rawRows.get(`${e.source.importId}:${e.source.rowIndex}`);
  }, [id]);
  const [draft, setDraft] = useState<Expression | null>(null);
  const [dirty, setDirty] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const isNewParam = hashParams().get('new') === '1';

  useEffect(() => {
    if (stored && !dirty) setDraft(stored);
  }, [stored, dirty]);

  if (stored === undefined && draft === null) return <main className="page"><p className="muted">読み込み中…</p></main>;
  if (!stored || !draft) return <main className="page"><p>見つかりません。</p><a href="#/library">Libraryへ戻る</a></main>;

  const set = (patch: Partial<Expression>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const setEx = (i: number, patch: Partial<Example>) => {
    const examples = draft.examples.map((x, k) => (k === i ? { ...x, ...patch } : x));
    set({ examples });
  };

  const save = async () => {
    const text = cleanEnglish(draft.text);
    if (!text) {
      toast('英語表現を入力してください');
      return;
    }
    const next: Expression = { ...draft, text, normalized: normalizeKey(text), kind: classifyKind(text), updatedAt: nowIso() };
    await db.transaction('rw', db.expressions, db.duplicates, async () => {
      await db.expressions.put(next);
      if (next.normalized !== stored.normalized) await refreshDuplicateGroups();
    });
    setDirty(false);
    toast('保存しました');
  };

  const remove = async () => {
    if (!confirm(`「${stored.text || '（未入力）'}」を削除しますか？学習履歴も削除されます。元のインポートデータは保持されます。\n\n学習から外すだけなら「学習から除外」を使ってください。`)) return;
    await db.transaction('rw', [db.expressions, db.cards, db.logs, db.duplicates], async () => {
      await db.cards.where('expressionId').equals(id).delete();
      await db.logs.where('expressionId').equals(id).delete();
      await db.expressions.delete(id);
      await refreshDuplicateGroups();
    });
    navigate('library');
  };

  const back = () => {
    if (dirty && !confirm('保存していない変更があります。破棄しますか？')) return;
    if (isNewParam && !stored.text) {
      void db.transaction('rw', db.expressions, db.cards, async () => {
        await db.cards.where('expressionId').equals(id).delete();
        await db.expressions.delete(id);
      });
    }
    history.length > 1 ? history.back() : navigate('library');
  };

  const markUsed = async () => {
    const usedInRealLife = [...stored.usedInRealLife, nowIso()];
    await db.expressions.update(id, { usedInRealLife });
    if (draft) setDraft({ ...draft, usedInRealLife });
    toast('記録しました。素晴らしい！');
  };

  const runAi = async (label: string, fn: () => Promise<GenerateUsage>) => {
    if (!getApiKey()) {
      toast('Settings → AI 生成 で API キーを設定してください');
      return;
    }
    if (dirty) {
      toast('先に変更を保存してください');
      return;
    }
    setAiBusy(label);
    try {
      const u = await fn();
      recordUsage(u);
      toast(`生成しました（約 $${u.costUsd.toFixed(3)}）`);
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setAiBusy(null);
    }
  };

  const aiImp = draft.ai?.importance;
  const sortedLogs = [...(logs ?? [])].sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));

  return (
    <main className="page">
      <div className="row between" style={{ marginBottom: 6 }}>
        <button className="icon-btn" onClick={back} aria-label="戻る" style={{ marginLeft: -10 }}><IconBack /></button>
        <button className="btn primary sm" onClick={save} disabled={!dirty}>保存</button>
      </div>

      <div className="card">
        <Field label="英語表現">
          <input className="input" style={{ fontFamily: 'var(--serif)', fontSize: 20 }} value={draft.text} onChange={(e) => set({ text: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus={isNewParam} />
        </Field>
        <Field label={draft.lang === 'ja' ? '意味・読み・英語での言い方' : '日本語の意味'}>
          <textarea className="textarea" value={draft.meaning} onChange={(e) => set({ meaning: e.target.value })} />
        </Field>
        {draft.ai?.meaning && (
          <div className="notice info" style={{ marginTop: -6 }}>
            <div className="row between" style={{ marginBottom: 4 }}><b className="small">AI訳</b><span className="chip warn">未検証</span></div>
            <div className="small" style={{ whiteSpace: 'pre-line' }}>{draft.ai.meaning}</div>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="btn sm" onClick={() => set({ meaning: draft.meaning ? `${draft.meaning}\n${draft.ai!.meaning}` : draft.ai!.meaning! })}>{draft.meaning ? '意味に追記' : 'この訳を採用'}</button>
            </div>
          </div>
        )}
        <Field label="Speaking用の状況説明（任意・空なら意味を表示）">
          <input className="input" placeholder="例: 会議で、詳細を詰めようと提案する" value={draft.productionPrompt ?? ''} onChange={(e) => set({ productionPrompt: e.target.value || undefined })} />
        </Field>
        <Field label="メモ">
          <textarea className="textarea" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>

      <div className="card">
        <h2>分類と重要度</h2>
        <Field label="カテゴリー">
          <select className="select" value={draft.category ?? ''} onChange={(e) => set({ category: (e.target.value || undefined) as Category | undefined })}>
            <option value="">{draft.ai ? `AI判定に従う（${CATEGORY_LABELS[draft.ai.category]}）` : '未分類'}</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label={`重要度: ${effectiveImportance(draft)}${draft.importance == null ? (aiImp != null ? '（AI判定）' : '（初期値）') : '（手動）'}`}>
          <input type="range" min={0} max={100} step={5} style={{ width: '100%' }} value={effectiveImportance(draft)} onChange={(e) => set({ importance: Number(e.target.value) })} />
        </Field>
        {draft.importance != null && (
          <button className="btn ghost sm" onClick={() => set({ importance: undefined })}>手動設定を解除（{aiImp != null ? `AI: ${aiImp}` : `初期値: ${DEFAULT_IMPORTANCE}`}）</button>
        )}
        {draft.ai && <p className="tiny muted">AI判定: {CATEGORY_LABELS[draft.ai.category]} / {draft.ai.importance}{draft.ai.rationale ? ` — ${draft.ai.rationale}` : ''}</p>}
        <label className="row between" style={{ marginTop: 10 }}>
          <span>学習から除外</span>
          <span className="toggle"><input type="checkbox" checked={draft.suspended} onChange={(e) => set({ suspended: e.target.checked })} /><span /></span>
        </label>
      </div>

      <div className="section-title">例文（{draft.examples.length}/3）</div>
      {draft.examples.map((ex, i) => (
        <div className="card stack" key={ex.id}>
          <div className="row between">
            <div className="seg grow" role="group">
              {KINDS.map((k) => <button key={k.k} aria-pressed={ex.kind === k.k} onClick={() => setEx(i, { kind: k.k })} style={{ fontSize: 12.5 }}>{k.label}</button>)}
            </div>
          </div>
          <textarea className="textarea" style={{ fontFamily: 'var(--serif)', fontSize: 17, minHeight: 64 }} placeholder="English example" value={ex.en} onChange={(e) => setEx(i, { en: e.target.value, origin: ex.origin === 'ai' ? 'user' : ex.origin })} autoCapitalize="sentences" />
          <textarea className="textarea" style={{ minHeight: 56 }} placeholder="日本語訳" value={ex.ja} onChange={(e) => setEx(i, { ja: e.target.value, origin: ex.origin === 'ai' ? 'user' : ex.origin })} />
          <div className="row between small muted">
            <span>出典: {ex.origin === 'ai' ? 'AI生成' : ex.origin === 'user' ? '自分で入力/編集' : ex.origin === 'imported' ? 'インポート' : 'サンプル'}</span>
            <div className="row" style={{ gap: 4 }}>
              {i > 0 && <button className="btn ghost sm" onClick={() => { const a = [...draft.examples]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set({ examples: a }); }}>↑ 上へ</button>}
              <button className="btn ghost sm danger" onClick={() => set({ examples: draft.examples.filter((_, k) => k !== i) })}>削除</button>
            </div>
          </div>
          <StatusSelect value={ex.status} onChange={(status) => setEx(i, { status })} />
          <div className="small muted">発音ガイド</div>
          <PronEditor value={ex.pronunciation} onChange={(pronunciation) => setEx(i, { pronunciation })} />
          {!ex.pronunciation && ex.en.trim() && stored.examples.some((s) => s.id === ex.id) && (
            <button className="btn sm" disabled={!!aiBusy} onClick={() => runAi(ex.id, async () => (await import('../lib/aiGenerate')).generatePronunciation(id, ex.id))}>{aiBusy === ex.id ? '生成中…' : 'AIで発音ガイドを生成'}</button>
          )}
        </div>
      ))}
      {draft.examples.length < 3 && (
        <button className="btn block" onClick={() => set({ examples: [...draft.examples, { id: uid(), kind: (['business', 'daily', 'alternative'] as const)[draft.examples.length], en: '', ja: '', origin: 'user', status: 'verified' }] })}>＋ 例文を追加</button>
      )}
      {draft.examples.length === 0 && draft.text && (
        <button className="btn primary block" style={{ marginTop: 8 }} disabled={!!aiBusy} onClick={() => runAi('examples', async () => (await import('../lib/aiGenerate')).generateExamples(id))}>
          {aiBusy === 'examples' ? 'AIで生成中…' : 'AIで3例文＋発音ガイドを生成'}
        </button>
      )}
      <p className="tiny muted">先頭の例文が学習時に最初に表示されます。AI生成には Settings で API キーの設定が必要です。</p>

      <div className="section-title">実際に使えた？</div>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>会議や会話で実際に使えたら記録しましょう（自己申告。アプリ内の習得推定とは別に集計します）。</p>
        <button className="btn block" onClick={markUsed}>今日使えた！（{stored.usedInRealLife.length}回）</button>
      </div>

      <div className="section-title">学習状態（FSRS）</div>
      <div className="card">
        {(cards ?? []).filter((c) => c.mode !== 'listening').sort((a, b) => a.mode.localeCompare(b.mode)).map((c) => {
          const r = retrievability(settings, c.fsrs);
          return (
            <div key={c.id} style={{ marginBottom: 12 }}>
              <div className="row between"><b>{c.mode === 'recognition' ? 'Reading' : 'Speaking'}</b><span className="chip">{STATE_LABEL[c.state]}</span></div>
              {c.state === State.New ? (
                <div className="small muted">{c.mode === 'production' && draft.lang === 'ja' ? '日本語の用語のためSpeakingは出題しません' : c.mode === 'production' ? `Readingが安定（${settings.productionUnlockStabilityDays}日以上）すると出題されます` : 'まだ学習していません'}</div>
              ) : (
                <div className="small muted">
                  次回: {new Date(c.due).toLocaleDateString('ja-JP')}（間隔 {formatInterval(c.fsrs.scheduled_days)}）・安定度 {formatInterval(c.fsrs.stability)}・難易度 {c.fsrs.difficulty.toFixed(1)}/10・復習 {c.fsrs.reps}回・失念 {c.fsrs.lapses}回{r != null ? `・現在の想起確率 ${(r * 100).toFixed(0)}%` : ''}
                </div>
              )}
            </div>
          );
        })}
        {sortedLogs.length > 0 && (
          <details>
            <summary className="small" style={{ cursor: 'pointer' }}>復習履歴（{sortedLogs.length}）</summary>
            <div className="small muted" style={{ marginTop: 8 }}>
              {sortedLogs.slice(0, 50).map((l) => (
                <div key={l.id} className="row between" style={{ padding: '4px 0' }}>
                  <span>{new Date(l.reviewedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {l.mode === 'recognition' ? 'R' : 'S'}</span>
                  <span>{RATING_LABEL[l.rating]} → {new Date(l.after.due).toLocaleDateString('ja-JP')}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {raw && (
        <>
          <div className="section-title">元データ（インポート時のまま・変更されません）</div>
          <div className="card small" style={{ wordBreak: 'break-word' }}>
            {raw.cells.map((c, i) => <div key={i}><span className="muted">列{i + 1}:</span> {c || <span className="muted">（空）</span>}</div>)}
          </div>
        </>
      )}

      <button className="btn ghost block danger" style={{ marginTop: 20 }} onClick={remove}>この表現を削除</button>
    </main>
  );
}

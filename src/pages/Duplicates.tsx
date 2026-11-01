import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/db';
import type { DuplicateGroup } from '../db/types';
import { nowIso } from '../lib/util';
import { mergeAllPending, mergeGroup } from '../lib/duplicates';
import { toast } from '../lib/hooks';
import { navigate } from '../lib/router';
import { IconBack } from '../components/Icons';

export default function Duplicates() {
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = useLiveQuery(async () => {
    const groups = await db.duplicates.toArray();
    const ids = groups.flatMap((g) => g.expressionIds);
    const exprs = await db.expressions.bulkGet(ids);
    return { groups, exprs: new Map(exprs.filter(Boolean).map((e) => [e!.id, e!])) };
  }, []);

  if (!data) return <main className="page" />;
  const pending = data.groups.filter((g) => g.resolution === 'pending');
  const list = showResolved ? data.groups : pending;

  const keepAll = async (g: DuplicateGroup) => {
    await db.duplicates.update(g.id, { resolution: 'keep_all', updatedAt: nowIso() });
  };

  const merge = async (g: DuplicateGroup, primaryId: string) => {
    await mergeGroup(g, primaryId);
    toast('統合しました（他の表現は除外状態で保持しています）');
  };

  const mergeAll = async () => {
    if (!confirm(`未対応の重複候補 ${pending.length}グループを一括で統合します。\n\n・意味・メモ・例文は1つにまとめます\n・残りは削除せず「除外中」として保持します（元データ・学習履歴もそのまま）\n・後から個別に「未対応に戻す」ことはできますが、まとめた意味は手で直す必要があります\n\n先にJSONバックアップを取ることをおすすめします。続けますか？`)) return;
    setBusy(true);
    try {
      const n = await mergeAllPending();
      toast(`${n}グループを統合しました`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="icon-btn" style={{ marginLeft: -10 }} onClick={() => navigate('settings')} aria-label="戻る"><IconBack /></button>
      </div>
      <h1 className="page-title">重複候補</h1>
      <p className="page-sub">同じ英語表現で意味が異なるもの。自動では削除しません。</p>
      <label className="row between card" style={{ padding: '10px 16px' }}>
        <span className="small">対応済みも表示</span>
        <span className="toggle"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /><span /></span>
      </label>
      {pending.length > 0 && (
        <div className="card stack">
          <p className="small" style={{ margin: 0 }}>未対応 {pending.length}グループ。1つずつ選ぶか、まとめて統合できます（学習済み → 訳あり → 新しく登録した方を残します）。</p>
          <button className="btn primary block" disabled={busy} onClick={mergeAll}>{busy ? '統合中…' : 'すべて一括で統合（削除はしません）'}</button>
        </div>
      )}
      {list.length === 0 && <p className="muted center">確認が必要な重複候補はありません。</p>}
      {list.map((g) => (
        <div key={g.id} className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{g.id}</b>
            <span className={'chip ' + (g.resolution === 'pending' ? 'warn' : 'accent')}>{g.resolution === 'pending' ? '未対応' : g.resolution === 'merged' ? '統合済み' : '両方残す'}</span>
          </div>
          {g.expressionIds.map((id) => {
            const e = data.exprs.get(id);
            if (!e) return null;
            return (
              <div key={id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--line)' }}>
                <a href={`#/library/${id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div style={{ fontFamily: 'var(--serif)' }}>{e.text} {e.suspended && <span className="chip">除外中</span>}</div>
                  <div className="small muted" style={{ whiteSpace: 'pre-line' }}>{e.meaning || '（訳なし）'}</div>
                </a>
                {g.resolution === 'pending' && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => merge(g, id)}>これに統合</button>}
              </div>
            );
          })}
          {g.resolution === 'pending' ? (
            <button className="btn block" style={{ marginTop: 8 }} onClick={() => keepAll(g)}>別の表現として両方残す</button>
          ) : (
            <button className="btn ghost sm" onClick={() => db.duplicates.update(g.id, { resolution: 'pending' })}>未対応に戻す</button>
          )}
        </div>
      ))}
    </main>
  );
}

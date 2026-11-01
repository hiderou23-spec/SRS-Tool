import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/db';
import type { DuplicateGroup, Expression } from '../db/types';
import { nowIso } from '../lib/util';
import { toast } from '../lib/hooks';
import { navigate } from '../lib/router';
import { IconBack } from '../components/Icons';

export default function Duplicates() {
  const [showResolved, setShowResolved] = useState(false);
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

  /** Non-destructive merge: primary gets combined meaning/notes; others are suspended (kept with history). */
  const merge = async (g: DuplicateGroup, primaryId: string) => {
    const members = g.expressionIds.map((id) => data.exprs.get(id)).filter(Boolean) as Expression[];
    const primary = members.find((m) => m.id === primaryId)!;
    const others = members.filter((m) => m.id !== primaryId);
    const meanings = [primary.meaning, ...others.map((o) => o.meaning)].filter(Boolean);
    const uniqueMeanings = [...new Set(meanings)];
    const notes = [primary.notes, ...others.map((o) => o.notes)].filter(Boolean);
    const ts = nowIso();
    await db.transaction('rw', db.expressions, db.duplicates, async () => {
      await db.expressions.update(primaryId, {
        meaning: uniqueMeanings.join('\n'),
        notes: [...new Set(notes)].join('\n'),
        examples: [...primary.examples, ...others.flatMap((o) => o.examples)].slice(0, 3),
        updatedAt: ts,
      });
      for (const o of others) {
        await db.expressions.update(o.id, { suspended: true, tags: [...new Set([...o.tags, 'merged'])], notes: [o.notes, `（${primary.text} に統合済み）`].filter(Boolean).join('\n'), updatedAt: ts });
      }
      await db.duplicates.update(g.id, { resolution: 'merged', updatedAt: ts });
    });
    toast('統合しました（他の表現は除外状態で保持しています）');
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

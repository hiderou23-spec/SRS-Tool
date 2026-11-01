import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useMemo, useState } from 'react';
import { db } from '../db/db';
import { CATEGORY_LABELS, type Category, type Expression, type ReviewCard } from '../db/types';
import { effectiveImportance } from '../srs/queue';
import { ESTABLISHED_DAYS } from '../srs/stats';
import { State } from '../srs/scheduler';
import { navigate } from '../lib/router';
import { makeCards } from '../import/importer';
import { nowIso, uid } from '../lib/util';

type Filter = 'all' | 'new' | 'learning' | 'established' | 'nomeaning' | 'suspended' | 'aiunverified';
const FILTERS: { k: Filter; label: string }[] = [
  { k: 'all', label: 'すべて' },
  { k: 'new', label: '未学習' },
  { k: 'learning', label: '学習中' },
  { k: 'established', label: '定着' },
  { k: 'nomeaning', label: '訳なし' },
  { k: 'aiunverified', label: 'AI未検証' },
  { k: 'suspended', label: '除外中' },
];

function stage(c?: ReviewCard): 'new' | 'learning' | 'established' {
  if (!c || c.introducedAt === null || c.state === State.New) return 'new';
  if (c.state === State.Review && c.fsrs.stability >= ESTABLISHED_DAYS) return 'established';
  return 'learning';
}

const PAGE = 80;

export default function Library() {
  const data = useLiveQuery(async () => {
    const [exprs, cards] = await Promise.all([db.expressions.toArray(), db.cards.toArray()]);
    return { exprs, cards: new Map(cards.map((c) => [c.id, c])) };
  }, []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [cat, setCat] = useState<Category | 'any' | 'none'>('any');
  const [sort, setSort] = useState<'importance' | 'alpha' | 'recent'>('importance');
  const [limit, setLimit] = useState(PAGE);
  const dq = useDeferredValue(q);

  const results = useMemo(() => {
    if (!data) return [];
    const needle = dq.trim().toLowerCase();
    let list = data.exprs.filter((e) => {
      if (needle && !(e.text.toLowerCase().includes(needle) || e.meaning.toLowerCase().includes(needle) || e.notes.toLowerCase().includes(needle))) return false;
      const c = e.category ?? e.ai?.category;
      if (cat === 'none' && c) return false;
      if (cat !== 'any' && cat !== 'none' && c !== cat) return false;
      const rec = data.cards.get(`${e.id}:recognition`);
      switch (filter) {
        case 'new': return !e.suspended && stage(rec) === 'new';
        case 'learning': return !e.suspended && stage(rec) === 'learning';
        case 'established': return stage(rec) === 'established';
        case 'nomeaning': return !e.meaning;
        case 'suspended': return e.suspended;
        case 'aiunverified': return e.examples.some((x) => x.origin === 'ai' && x.status !== 'verified') || e.examples.some((x) => x.pronunciation && x.pronunciation.status !== 'verified');
        default: return !e.suspended;
      }
    });
    const cmp: Record<typeof sort, (a: Expression, b: Expression) => number> = {
      importance: (a, b) => effectiveImportance(b) - effectiveImportance(a) || a.text.localeCompare(b.text),
      alpha: (a, b) => a.text.localeCompare(b.text, 'en', { sensitivity: 'base' }),
      recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    };
    list = [...list].sort(cmp[sort]);
    return list;
  }, [data, dq, filter, cat, sort]);

  const createNew = async () => {
    const id = uid();
    const ts = nowIso();
    await db.transaction('rw', db.expressions, db.cards, async () => {
      await db.expressions.add({ id, text: '', normalized: '', meaning: '', notes: '', kind: 'phrase', examples: [], tags: [], suspended: false, usedInRealLife: [], createdAt: ts, updatedAt: ts });
      await db.cards.bulkAdd(makeCards(id));
    });
    navigate(`library/${id}?new=1`);
  };

  return (
    <main className="page">
      <div className="search">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h1 className="page-title" style={{ margin: 0 }}>Library</h1>
          <button className="btn sm" onClick={createNew}>＋ 追加</button>
        </div>
        <input className="input" type="search" placeholder="英語・日本語・メモで検索" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <div className="row" style={{ marginTop: 8, overflowX: 'auto', gap: 6, paddingBottom: 2 }}>
          {FILTERS.map((f) => (
            <button key={f.k} className={'chip' + (filter === f.k ? ' accent' : '')} style={{ border: 0, padding: '6px 11px', fontSize: 13 }} onClick={() => { setFilter(f.k); setLimit(PAGE); }}>{f.label}</button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <select className="select" style={{ minHeight: 38, fontSize: 14 }} value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>
            <option value="any">全カテゴリー</option>
            <option value="none">未分類</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="select" style={{ minHeight: 38, fontSize: 14, maxWidth: 130 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="importance">重要度順</option>
            <option value="alpha">ABC順</option>
            <option value="recent">更新順</option>
          </select>
        </div>
      </div>

      <p className="small muted" style={{ margin: '4px 4px 8px' }}>{data ? `${results.length.toLocaleString()} 件` : '読み込み中…'}</p>

      {results.length > 0 && (
        <div className="list">
          {results.slice(0, limit).map((e) => {
            const rec = data!.cards.get(`${e.id}:recognition`);
            const prod = data!.cards.get(`${e.id}:production`);
            const sr = stage(rec), sp = stage(prod);
            return (
              <a key={e.id} className="list-item lib-item" href={`#/library/${e.id}`}>
                <div className="grow">
                  <div className="t" style={{ opacity: e.suspended ? 0.45 : 1 }}>{e.text || <span className="muted">（未入力）</span>}</div>
                  <div className="m">{e.meaning || '— 訳なし —'}</div>
                </div>
                <div className="row" style={{ gap: 4 }} title="Reading / Speaking">
                  <span className={'dot ' + (sr === 'established' ? 'on' : sr === 'learning' ? 'half' : '')} />
                  <span className={'dot ' + (sp === 'established' ? 'on' : sp === 'learning' ? 'half' : '')} />
                </div>
              </a>
            );
          })}
        </div>
      )}
      {results.length > limit && (
        <button className="btn block" onClick={() => setLimit(limit + PAGE * 2)}>さらに表示（残り {results.length - limit}件）</button>
      )}
      <p className="tiny muted center" style={{ marginTop: 12 }}>● 左: Reading　● 右: Speaking（薄い=学習中・濃い=定着）</p>
    </main>
  );
}

import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/db';
import type { Expression } from '../db/types';
import { effectiveImportance } from '../srs/queue';
import { nowIso } from '../lib/util';
import { navigate } from '../lib/router';
import { useSettings } from '../lib/hooks';
import { IconBack } from '../components/Icons';
import { PronunciationView } from '../components/Pronunciation';

type Tab = 'examples' | 'pronunciation' | 'meaning';
const PAGE = 15;

const needsExample = (e: Expression) => e.examples.some((x) => x.origin === 'ai' && x.status !== 'verified');
const needsPron = (e: Expression) => e.examples.some((x) => x.pronunciation && x.pronunciation.status !== 'verified');
const needsMeaning = (e: Expression) => !e.meaning && !!e.ai?.meaning;

/** Quick review of AI-generated content: approve in one tap, or open the editor to fix. */
export default function Review() {
  const settings = useSettings();
  const [tab, setTab] = useState<Tab>('examples');
  const [limit, setLimit] = useState(PAGE);
  const data = useLiveQuery(async () => {
    const all = (await db.expressions.toArray()).filter((e) => !e.suspended);
    all.sort((a, b) => effectiveImportance(b) - effectiveImportance(a));
    return {
      examples: all.filter(needsExample),
      pronunciation: all.filter(needsPron),
      meaning: all.filter(needsMeaning),
    };
  }, []);
  if (!data) return <main className="page" />;
  const list = data[tab];

  const update = async (id: string, fn: (e: Expression) => Expression) => {
    const e = await db.expressions.get(id);
    if (e) await db.expressions.put({ ...fn(e), updatedAt: nowIso() });
  };
  const approveExample = (id: string, exId: string) =>
    update(id, (e) => ({ ...e, examples: e.examples.map((x) => (x.id === exId ? { ...x, status: 'verified' } : x)) }));
  const approvePron = (id: string, exId: string) =>
    update(id, (e) => ({ ...e, examples: e.examples.map((x) => (x.id === exId && x.pronunciation ? { ...x, pronunciation: { ...x.pronunciation, status: 'verified' } } : x)) }));
  const adoptMeaning = (id: string) => update(id, (e) => ({ ...e, meaning: e.ai?.meaning ?? e.meaning }));

  const TABS: { k: Tab; label: string }[] = [
    { k: 'examples', label: `例文 ${data.examples.length}` },
    { k: 'pronunciation', label: `発音 ${data.pronunciation.length}` },
    { k: 'meaning', label: `AI訳 ${data.meaning.length}` },
  ];

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="icon-btn" style={{ marginLeft: -10 }} onClick={() => navigate('settings')} aria-label="戻る"><IconBack /></button>
      </div>
      <h1 className="page-title">AIコンテンツの確認</h1>
      <p className="page-sub">重要度の高い順。問題なければ「OK」、直したい時は「編集」。</p>
      <div className="seg" style={{ marginBottom: 14 }}>
        {TABS.map((t) => <button key={t.k} aria-pressed={tab === t.k} onClick={() => { setTab(t.k); setLimit(PAGE); }}>{t.label}</button>)}
      </div>
      {list.length === 0 && <p className="muted center">確認待ちはありません。</p>}
      {list.slice(0, limit).map((e) => (
        <div key={e.id} className="card">
          <div className="row between" style={{ marginBottom: 6 }}>
            <b style={{ fontFamily: 'var(--serif)', fontSize: 19 }}>{e.text}</b>
            <a className="btn ghost sm" href={`#/library/${e.id}`}>編集</a>
          </div>
          <div className="small muted" style={{ whiteSpace: 'pre-line' }}>{e.meaning || e.ai?.meaning || '（訳なし）'}</div>

          {tab === 'meaning' && (
            <button className="btn sm primary" style={{ marginTop: 10 }} onClick={() => adoptMeaning(e.id)}>この訳でOK（自分の訳として保存）</button>
          )}

          {tab === 'examples' && e.examples.filter((x) => x.origin === 'ai' && x.status !== 'verified').map((x) => (
            <div key={x.id} style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--line)' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{x.en}</div>
              <div className="small" style={{ color: 'var(--ink-2)' }}>{x.ja}</div>
              <div className="row between" style={{ marginTop: 6 }}>
                <span className="chip">{x.kind}</span>
                <button className="btn sm primary" onClick={() => approveExample(e.id, x.id)}>OK</button>
              </div>
            </div>
          ))}

          {tab === 'pronunciation' && e.examples.filter((x) => x.pronunciation && x.pronunciation.status !== 'verified').map((x) => (
            <div key={x.id} style={{ marginTop: 10 }}>
              <PronunciationView guide={x.pronunciation} sentence={x.en} settings={{ ...settings, showKatakana: true, showIpa: true, showSlurred: true }} />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                <button className="btn sm primary" onClick={() => approvePron(e.id, x.id)}>OK</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {list.length > limit && <button className="btn block" onClick={() => setLimit(limit + PAGE)}>さらに表示（残り {list.length - limit}件）</button>}
    </main>
  );
}

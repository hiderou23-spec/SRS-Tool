import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { previewToday } from '../srs/session';
import { State } from '../srs/scheduler';
import { navigate } from '../lib/router';
import { IconBack } from '../components/Icons';

/** Honest view of the review backlog — nothing hidden, but no guilt. */
export default function Backlog() {
  const data = useLiveQuery(async () => {
    const plan = await previewToday();
    const cards = await db.cards.toArray();
    const now = Date.now();
    const buckets = { d1: 0, d7: 0, d30: 0, more: 0 };
    const upcoming = Array.from({ length: 7 }, () => 0);
    for (const c of cards) {
      if (c.introducedAt === null || c.state === State.New || c.mode === 'listening') continue;
      const diff = (now - new Date(c.due).getTime()) / 86400_000;
      if (diff >= 0) {
        if (diff < 1) buckets.d1++;
        else if (diff < 7) buckets.d7++;
        else if (diff < 30) buckets.d30++;
        else buckets.more++;
      } else if (-diff < 7) upcoming[Math.floor(-diff)]++;
    }
    const newRemaining = cards.filter((c) => c.mode === 'recognition' && c.introducedAt === null).length;
    return { plan, buckets, upcoming, newRemaining };
  }, []);
  if (!data) return <main className="page" />;
  const { plan, buckets, upcoming, newRemaining } = data;
  const daysToClear = plan.capacity > 0 ? Math.ceil(plan.dueTotal / plan.capacity) : 0;

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="icon-btn" style={{ marginLeft: -10 }} onClick={() => history.length > 1 ? history.back() : navigate('home')} aria-label="戻る"><IconBack /></button>
      </div>
      <h1 className="page-title">復習の状況</h1>
      <p className="page-sub">隠さずに表示します。焦る必要はありません。</p>

      <div className="card">
        <h2>今日</h2>
        <div className="stat-grid">
          <div className="stat"><b>{plan.dueTotal}</b><span>期限の来た復習</span></div>
          <div className="stat"><b>{plan.dueInQueue}</b><span>今日の学習に含む</span></div>
          <div className="stat"><b>{plan.backlog}</b><span>明日以降に回す</span></div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          1回の学習（約{plan.capacity}件分）で優先度の高い順に進めます。今のペースで約{daysToClear}日分です。
        </p>
      </div>

      <div className="card">
        <h2>期限からの経過</h2>
        {[['1日未満', buckets.d1], ['1〜7日', buckets.d7], ['7〜30日', buckets.d30], ['30日以上', buckets.more]].map(([k, v]) => (
          <div key={k as string} className="row between" style={{ padding: '6px 0', borderBottom: '0.5px solid var(--line)' }}><span className="small">{k}</span><b>{v as number}</b></div>
        ))}
        <p className="small muted" style={{ marginBottom: 0 }}>FSRSは遅れて復習したカードも、実際の経過日数を使って正しく次回日を計算します。遅れたこと自体で記録が壊れることはありません。</p>
      </div>

      <div className="card">
        <h2>今後7日の復習予定</h2>
        <div className="bars">
          {upcoming.map((v, i) => <div key={i} className={v === 0 ? 'zero' : ''} style={{ height: `${Math.max(3, (v / Math.max(1, ...upcoming)) * 100)}%` }} title={`${v}`} />)}
        </div>
        <div className="row between tiny muted" style={{ marginTop: 4 }}><span>明日</span><span>7日後</span></div>
      </div>

      <div className="card">
        <h2>優先順位の決め方</h2>
        <p className="small" style={{ margin: 0 }}>
          ① 学習ステップ中のカード → ② 重要度（AI判定または手動）→ ③ 忘れている可能性（FSRSの想起確率）→ ④ 遅れの大きさ、の順に評価します。
          復習が1回分の時間に収まらない日は、新しい表現の追加を自動で止めます。未学習の表現は残り {newRemaining.toLocaleString()} 件です。
        </p>
      </div>
    </main>
  );
}

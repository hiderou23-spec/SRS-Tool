import { useLiveQuery } from 'dexie-react-hooks';
import { computeProgress, ESTABLISHED_DAYS, type ModeProgress } from '../srs/stats';
import { formatDuration } from '../lib/util';

function ModeBar({ label, p }: { label: string; p: ModeProgress }) {
  const total = Math.max(1, p.notStarted + p.learning + p.established);
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row between small" style={{ marginBottom: 6 }}>
        <b>{label}</b>
        <span className="muted">定着 {p.established.toLocaleString()} · 学習中 {p.learning.toLocaleString()} · 未学習 {p.notStarted.toLocaleString()}</span>
      </div>
      <div className="stack-bar">
        <div style={{ width: `${(p.established / total) * 100}%`, background: 'var(--accent)' }} />
        <div style={{ width: `${(p.learning / total) * 100}%`, background: 'color-mix(in srgb, var(--accent) 40%, transparent)' }} />
      </div>
    </div>
  );
}

export default function Progress() {
  const s = useLiveQuery(() => computeProgress(), []);
  if (!s) return <main className="page"><h1 className="page-title">Progress</h1></main>;
  const maxMs = Math.max(1, ...s.last14.map((d) => d.ms));

  return (
    <main className="page">
      <h1 className="page-title">Progress</h1>

      <div className="card">
        <h2>成長の階段</h2>
        <div className="ladder">
          <div className="step"><b>{s.ladder.canRead.toLocaleString()}</b><span>読める</span></div>
          <div className="arrow">→</div>
          <div className="step"><b>{s.ladder.canRecall.toLocaleString()}</b><span>思い出せる</span></div>
          <div className="arrow">→</div>
          <div className="step"><b>{s.ladder.used.toLocaleString()}</b><span>使えた</span></div>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          「読める」「思い出せる」はアプリ内の自己評価とFSRSによる推定（安定度{ESTABLISHED_DAYS}日以上）です。
          「使えた」は実際の会話で使ったと自分で記録した数で、実際の会話力そのものを測定するものではありません。
        </p>
      </div>

      <div className="card">
        <h2>直近14日</h2>
        <div className="bars">
          {s.last14.map((d) => <div key={d.day} className={d.ms === 0 ? 'zero' : ''} style={{ height: `${Math.max(3, (d.ms / maxMs) * 100)}%` }} title={`${d.day}: ${Math.round(d.ms / 60000)}分`} />)}
        </div>
        <div className="row between tiny muted" style={{ marginTop: 4 }}><span>2週間前</span><span>今日</span></div>
        <div className="stat-grid" style={{ marginTop: 14 }}>
          <div className="stat"><b>{s.streak}</b><span>連続日数</span></div>
          <div className="stat"><b>{s.studyDays}</b><span>学習日数</span></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{formatDuration(s.totalMs)}</b><span>総学習時間</span></div>
        </div>
      </div>

      <div className="card">
        <h2>習得状況</h2>
        <ModeBar label="Reading（意味が分かる）" p={s.reading} />
        <ModeBar label="Speaking（英語で言える）" p={s.speaking} />
        <p className="tiny muted" style={{ margin: 0 }}>Listening は高品質な音声の確保後（Phase 3）に追加予定です。</p>
      </div>

      <div className="card">
        <h2>記憶の質</h2>
        <div className="stat-grid">
          <div className="stat"><b>{s.estimatedRetention != null ? `${Math.round(s.estimatedRetention * 100)}%` : '—'}</b><span>推定記憶率（今）</span></div>
          <div className="stat"><b>{s.accuracy30 != null ? `${Math.round(s.accuracy30 * 100)}%` : '—'}</b><span>正答率（30日）</span></div>
          <div className="stat"><b>{s.totalReviews.toLocaleString()}</b><span>総回答数</span></div>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>推定記憶率はFSRSが予測する現在の想起確率の平均。正答率は復習段階のカードで Again 以外を選んだ割合です。</p>
      </div>

      <div className="card">
        <h2>Reading と Speaking</h2>
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="stat"><b>{s.accuracyByMode.reading != null ? `${Math.round(s.accuracyByMode.reading * 100)}%` : '—'}</b><span>Reading 正答率</span></div>
          <div className="stat"><b>{s.accuracyByMode.speaking != null ? `${Math.round(s.accuracyByMode.speaking * 100)}%` : '—'}</b><span>Speaking 正答率</span></div>
          <div className="stat"><b>{s.avgMinutesPerStudyDay != null ? `${s.avgMinutesPerStudyDay.toFixed(1)}分` : '—'}</b><span>1日平均（学習日）</span></div>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>直近30日、復習段階のカードのみ。Speaking が Reading より低いのは自然です。差が縮まるほど「使える」に近づいています。</p>
      </div>

      <div className="card">
        <h2>今後2週間の復習予定</h2>
        <div className="bars">
          {s.forecast14.map((v, i) => <div key={i} className={v === 0 ? 'zero' : ''} style={{ height: `${Math.max(3, (v / Math.max(1, ...s.forecast14)) * 100)}%` }} title={`${v}件`} />)}
        </div>
        <div className="row between tiny muted" style={{ marginTop: 4 }}><span>明日</span><span>2週間後</span></div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>合計 {s.forecast14.reduce((a, b) => a + b, 0).toLocaleString()}件。山が高い日も、1日の学習時間の範囲で優先度順に出題されます。</p>
      </div>

      <div className="card">
        <h2>学習素材の充実度</h2>
        {[
          ['例文あり', s.content.withExamples],
          ['発音ガイドあり', s.content.withPron],
        ].map(([label, n]) => (
          <div key={label as string} style={{ marginBottom: 10 }}>
            <div className="row between small"><span>{label}</span><span className="muted">{(n as number).toLocaleString()} / {s.content.total.toLocaleString()}</span></div>
            <div className="meter" style={{ marginTop: 4 }}><div style={{ width: `${((n as number) / Math.max(1, s.content.total)) * 100}%` }} /></div>
          </div>
        ))}
        {s.content.aiPending > 0 && <a className="small" href="#/review">AI生成の確認待ち：{s.content.aiPending.toLocaleString()}件 →</a>}
      </div>

      {s.weak.length > 0 && (
        <div className="card">
          <h2>苦手な表現</h2>
          {s.weak.map((w) => (
            <a key={w.expression.id + w.mode} href={`#/library/${w.expression.id}`} className="row between" style={{ padding: '7px 0', borderBottom: '0.5px solid var(--line)', color: 'inherit', textDecoration: 'none' }}>
              <span style={{ fontFamily: 'var(--serif)' }}>{w.expression.text}</span>
              <span className="small muted">{w.mode === 'recognition' ? 'Reading' : 'Speaking'} · {w.lapses}回忘れ</span>
            </a>
          ))}
        </div>
      )}

      <div className="card">
        <h2>カテゴリー別</h2>
        {s.categories.map((c) => (
          <div key={c.key} style={{ marginBottom: 10 }}>
            <div className="row between small"><span>{c.label}</span><span className="muted">{c.established}/{c.total}</span></div>
            <div className="meter" style={{ marginTop: 4 }}><div style={{ width: `${(c.established / Math.max(1, c.total)) * 100}%` }} /></div>
          </div>
        ))}
        {s.categories.length === 1 && s.categories[0].key === 'uncategorized' && (
          <p className="tiny muted" style={{ margin: 0 }}>AIによるカテゴリー分類はPhase 2で実装予定です。各表現の編集画面から手動で設定できます。</p>
        )}
      </div>
    </main>
  );
}

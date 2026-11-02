import { useLiveQuery } from 'dexie-react-hooks';
import { loadSessionDelta, loadVocab, monthLabel, type VocabForecast } from '../srs/vocab';
import { ESTABLISHED_DAYS } from '../srs/stats';

function paceText(v: VocabForecast): string {
  if (v.paceSource === 'setting') return `1日${v.pacePerDay}語ずつ増やすと`;
  const p = v.pacePerDay;
  return `最近のペース（1日 約${p >= 10 ? Math.round(p) : p.toFixed(1)}語）なら`;
}

function horizonLabel(days: number) {
  return days >= 365 ? `${Math.round(days / 365)}年後` : `${days}日後`;
}

/** One-line projection, or null when there is nothing to project. */
function forecastLine(v: VocabForecast, days = 90): string | null {
  if (v.total === 0) return null;
  if (v.notStarted === 0) return v.learning > 0 ? `あと${v.learning}語が学習中。全${v.total.toLocaleString()}語まであと少しです` : `ライブラリの全${v.total.toLocaleString()}語を覚えました`;
  if (v.pacePerDay <= 0) return '新しい表現を始めると、ここから増えていきます';
  if (v.daysToAll !== null && v.daysToAll <= days) return `${paceText(v)} ${monthLabel(v.daysToAll)}ごろに全${v.total.toLocaleString()}語へ`;
  const p = v.projections.find((x) => x.days === days) ?? v.projections[0];
  return `${paceText(v)} ${horizonLabel(p.days)}に 約${p.learned.toLocaleString()}語`;
}

/** Home: the counter with a one-line forecast. */
export function VocabCounter() {
  const v = useLiveQuery(() => loadVocab(), []);
  if (!v || v.total === 0) return null;
  const line = forecastLine(v);
  return (
    <a className="card vocab" href="#/progress" aria-label="覚えた表現の詳細">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div className="small muted">覚えた表現</div>
        <div className="tiny muted">全{v.total.toLocaleString()}語</div>
      </div>
      <div className="vocab-num">{v.learned.toLocaleString()}<span>語</span></div>
      <div className="meter vocab-meter">
        <div style={{ width: `${(v.learned / v.total) * 100}%` }} />
      </div>
      {line && <p className="small" style={{ margin: '10px 0 0' }}>{line}</p>}
    </a>
  );
}

/** Progress: counter, breakdown and every horizon. */
export function VocabForecastCard() {
  const v = useLiveQuery(() => loadVocab(), []);
  if (!v) return null;
  return (
    <div className="card">
      <h2>覚えた表現と今後の予測</h2>
      <div className="stat-grid">
        <div className="stat"><b>{v.learned.toLocaleString()}</b><span>覚えた</span></div>
        <div className="stat"><b>{v.established.toLocaleString()}</b><span>うち定着</span></div>
        <div className="stat"><b>{v.learning.toLocaleString()}</b><span>学習中</span></div>
      </div>
      {v.notStarted > 0 && v.pacePerDay > 0 ? (
        <>
          <p className="small" style={{ margin: '14px 0 8px' }}>{paceText(v)}：</p>
          <div className="forecast-rows">
            {v.projections.filter((p) => v.daysToAll === null || p.days < v.daysToAll).map((p) => (
              <div key={p.days} className="row between">
                <span>{horizonLabel(p.days)}<span className="tiny muted">（{monthLabel(p.days)}）</span></span>
                <b>約{p.learned.toLocaleString()}語</b>
              </div>
            ))}
            {v.daysToAll !== null && v.daysToAll > 0 && (
              <div className="row between">
                <span>全{v.total.toLocaleString()}語</span>
                <b>{monthLabel(v.daysToAll)}ごろ</b>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="small" style={{ margin: '14px 0 0' }}>{forecastLine(v)}</p>
      )}
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        「覚えた」は Reading の学習ステップを終えた表現（忘れて学び直し中のものは除く）、「定着」は安定度{ESTABLISHED_DAYS}日以上です。
        予測は{v.paceSource === 'recent' ? '直近4週間に始めた新しい表現の数' : '設定の「1日の新規上限」'}から出した目安で、学習中の表現もいずれ覚える前提です。
      </p>
    </div>
  );
}

/** Study end screens: count, change in this session, forecast. */
export function VocabSessionSummary({ sessionId }: { sessionId: string }) {
  const data = useLiveQuery(async () => ({ v: await loadVocab(), delta: await loadSessionDelta(sessionId) }), [sessionId]);
  if (!data || data.v.total === 0) return null;
  const { v, delta } = data;
  const line = forecastLine(v);
  return (
    <div className="vocab-summary">
      <div className="small muted">覚えた表現</div>
      <div className="vocab-num">
        {v.learned.toLocaleString()}<span>語</span>
        {delta !== 0 && <em className={delta > 0 ? 'up' : 'down'}>{delta > 0 ? `+${delta}` : delta}</em>}
      </div>
      {line && <p className="small muted" style={{ margin: '4px 0 0' }}>{line}</p>}
    </div>
  );
}

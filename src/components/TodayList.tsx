import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { IconChevron } from './Icons';
import { loadTodaySummary, setSuspended, type DayItem, type DayTier } from '../srs/daySummary';

const TIER_CHIP: Record<DayTier, { label: string; cls: string } | null> = {
  again: { label: 'Again', cls: 'again' },
  hint: { label: 'ヒント', cls: 'hint' },
  hard: { label: 'Hard', cls: 'hard' },
  ok: null,
};

function Row({ item }: { item: DayItem }) {
  const [showMeaning, setShowMeaning] = useState(false);
  const [busy, setBusy] = useState(false);
  const e = item.expression;
  const meaning = (e.meaning || e.ai?.meaning || '').split('\n')[0];
  const chip = TIER_CHIP[item.tier];
  const toggleSuspend = async () => {
    setBusy(true);
    try {
      await setSuspended(e.id, !e.suspended);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={e.suspended ? 'today-row suspended' : 'today-row'}>
      <div className="row" style={{ alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span className="today-text">{e.text || e.meaning}</span>
        {chip && <span className={`today-chip ${chip.cls}`}>{chip.label}</span>}
        {item.isNew && <span className="today-chip new">NEW</span>}
        <span className="tiny muted">{item.modes.map((m) => (m === 'recognition' ? 'R' : m === 'production' ? 'S' : 'L')).join('・')}</span>
      </div>
      {showMeaning && meaning && <div className="today-meaning">{meaning}</div>}
      <div className="today-actions">
        {meaning && (
          <button className="btn ghost sm" onClick={() => setShowMeaning(!showMeaning)}>{showMeaning ? '意味を隠す' : '意味を見る'}</button>
        )}
        <a className="btn ghost sm" href={`#/library/${e.id}`}>編集</a>
        <button className={e.suspended ? 'btn ghost sm' : 'btn ghost sm muted-btn'} disabled={busy} onClick={toggleSuspend}>
          {e.suspended ? '学習に戻す' : '学習から外す'}
        </button>
      </div>
    </div>
  );
}

/**
 * Folded list of today's expressions (hardest first). Opens on tap; meanings
 * stay hidden until tapped so a glance doesn't replace recall.
 */
export function TodayList({ card = false }: { card?: boolean }) {
  const [open, setOpen] = useState(false);
  const s = useLiveQuery(() => loadTodaySummary(), []);
  if (!s || s.items.length === 0) return null;
  const body = (
    <>
      <button className="disclosure today-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          今日の表現 {s.items.length}語
          {s.needsReview > 0 && <span className="muted">（要復習 {s.needsReview}）</span>}
        </span>
        <IconChevron />
      </button>
      {open && (
        <div className="today-list">
          {s.items.map((i) => <Row key={i.expression.id} item={i} />)}
          <p className="tiny muted" style={{ margin: '10px 0 0' }}>
            忘れた表現は、FSRSが近いうちに自動で出し直します。ここで覚え直す必要はありません。R＝Reading、S＝Speaking。
          </p>
        </div>
      )}
    </>
  );
  return card ? <div className="card today-card">{body}</div> : <div className="today-inline">{body}</div>;
}

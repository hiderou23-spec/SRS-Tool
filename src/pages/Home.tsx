import { useLiveQuery } from 'dexie-react-hooks';
import { db, saveSettings } from '../db/db';
import { previewToday } from '../srs/session';
import { useSettings, toast } from '../lib/hooks';
import { navigate } from '../lib/router';
import { addSampleDeck } from '../lib/sample';
import { streakFrom } from '../srs/stats';
import { VocabCounter } from '../components/Vocab';

export default function Home() {
  const settings = useSettings();
  const count = useLiveQuery(() => db.expressions.count(), []);
  const plan = useLiveQuery(() => previewToday(), [settings.sessionMinutes, settings.newPerDay, settings.desiredRetention]);
  const streak = useLiveQuery(async () => {
    const sessions = await db.sessions.toArray();
    const days = new Set(sessions.filter((x) => x.reviewedCount + x.newCount > 0).map((x) => x.day));
    return streakFrom(days, new Date(), settings.dayStartHour);
  }, [settings.dayStartHour]);
  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });

  if (count === undefined || plan === undefined) return <main className="page" />;

  if (count === 0) {
    return (
      <main className="page">
        <h1 className="page-title">English Mastery</h1>
        <p className="page-sub">Remember it. Understand it. Use it.</p>
        <div className="card stack">
          <p style={{ margin: 0 }}>まずは学習データを用意しましょう。</p>
          <a className="btn primary block lg" href="#/import">reminDOのデータを取り込む</a>
          <button className="btn block" onClick={async () => { const n = await addSampleDeck(); toast(`サンプル${n}件を追加しました`); }}>
            サンプル表現（4件）を試す
          </button>
          <p className="small muted" style={{ margin: 0 }}>データはこのiPhone内（ブラウザのIndexedDB）にのみ保存され、外部へ送信されません。</p>
        </div>
      </main>
    );
  }

  const target = settings.sessionMinutes;
  const todayMin = plan.todayMs / 60000;
  const pct = Math.min(100, (todayMin / target) * 100);
  const active = plan.activeSession;
  const remainingInActive = active?.queue.length ?? 0;
  const nothingLeft = plan.queue.length === 0 && remainingInActive === 0;
  const backupStale = !settings.lastBackupAt || Date.now() - new Date(settings.lastBackupAt).getTime() > 7 * 86400_000;

  return (
    <main className="page">
      <h1 className="page-title">Today’s English</h1>
      <p className="page-sub">{today}</p>

      <section className="card hero">
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <div>
            <div className="big">{Math.floor(todayMin)}<span style={{ fontSize: 18, fontWeight: 600 }}> / {target}分</span></div>
            <div className="small muted">今日の学習時間</div>
          </div>
          <div className="small muted" style={{ textAlign: 'right' }}>{todayMin >= target ? '今日の目標を達成' : `目標まであと${Math.ceil(target - todayMin)}分`}</div>
        </div>
        <div className="meter" style={{ marginTop: 14 }}><div style={{ width: `${pct}%` }} /></div>

        <div className="stat-grid" style={{ marginTop: 18 }}>
          <div className="stat"><b>{active ? remainingInActive : plan.queue.length}</b><span>残り（件）</span></div>
          <div className="stat"><b>{plan.todayReviews}</b><span>今日の回答</span></div>
          <div className="stat"><b>{streak ?? 0}</b><span>連続（日）</span></div>
        </div>

        <div style={{ marginTop: 18 }}>
          {nothingLeft ? (
            <div className="center stack">
              <p style={{ margin: 0, fontWeight: 600 }}>今日の分はすべて完了しました</p>
              <button className="btn block" onClick={() => navigate('study?extra=1')}>もう少し続ける</button>
            </div>
          ) : (
            <>
              <a className="btn primary block lg" href="#/study">{active && active.reviewedCount + active.newCount > 0 ? '続きから再開' : '学習を開始'}</a>
              <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => navigate('study?quick=1')}>時間がない日は 1分だけ</button>
            </>
          )}
        </div>

        <div className="seg" style={{ marginTop: 12 }} role="group" aria-label="学習時間">
          {([5, 10, 15] as const).map((m) => (
            <button key={m} aria-pressed={settings.sessionMinutes === m} onClick={() => saveSettings({ sessionMinutes: m })}>{m}分</button>
          ))}
        </div>
      </section>

      <VocabCounter />

      {plan.backlog > 0 && (
        <div className="notice info">
          今日は大切な表現から <b>{plan.dueInQueue}件</b> に絞りました。残りの {plan.backlog}件 は無理せず明日以降に回ります。
          {' '}<a href="#/backlog">詳細</a>
        </div>
      )}
      {plan.newSuppressed && (
        <div className="notice info">復習を優先するため、今日は新しい表現をお休みしています。</div>
      )}
      {backupStale && (
        <div className="notice">
          {settings.lastBackupAt ? '最後のバックアップから7日以上経っています。' : 'まだバックアップがありません。'}
          iPhoneのデータ削除に備えて、<a href="#/settings">バックアップ</a>をおすすめします。
        </div>
      )}
    </main>
  );
}

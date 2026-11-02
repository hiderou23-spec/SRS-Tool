import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import type { Example, Expression, RatingValue, ReviewCard, StudySession } from '../db/types';
import { answerCard, excludeExpression, extendSession, finishSession, restoreExpression, startOrResumeSession, undoLast, getActiveSession } from '../srs/session';
import { previewIntervals } from '../srs/scheduler';
import { useSettings } from '../lib/hooks';
import { hashParams, navigate } from '../lib/router';
import { formatInterval } from '../lib/util';
import { IconChevron, IconClose, IconUndo } from '../components/Icons';
import { PronunciationView, QualityChip } from '../components/Pronunciation';

const RATINGS: { v: RatingValue; label: string; cls: string }[] = [
  { v: 1, label: 'Again', cls: 'again' },
  { v: 2, label: 'Hard', cls: 'hard' },
  { v: 3, label: 'Good', cls: 'good' },
  { v: 4, label: 'Easy', cls: 'easy' },
];

const KIND_LABEL: Record<string, string> = { business: 'Business', daily: 'Daily', alternative: 'Alternative' };

/** Highlight the expression (allowing simple inflections) inside an example sentence. */
export function highlight(sentence: string, expr: string) {
  const words = expr.replace(/[~〜(（].*$/, '').trim().split(/\s+/).filter((w) => /^[a-z'-]+$/i.test(w));
  if (words.length === 0) return sentence;
  const pattern = words.map((w, i) => (i === 0 && w.length > 2 ? w.replace(/e$/i, '') + "[a-z']*" : w.replace(/[-']/g, '\\$&') + "[a-z']{0,3}")).join('\\s+');
  const m = new RegExp(`\\b(${pattern})\\b`, 'i').exec(sentence);
  if (!m) return sentence;
  return (
    <>
      {sentence.slice(0, m.index)}
      <span className="mark">{m[0]}</span>
      {sentence.slice(m.index + m[0].length)}
    </>
  );
}

function ExampleBlock({ ex, expr, open, onToggle }: { ex: Example; expr: string; open: boolean; onToggle: () => void }) {
  const settings = useSettings();
  return (
    <div className="example">
      <div className="en">{highlight(ex.en, expr)}</div>
      {ex.ja && <div className="ja">{ex.ja}</div>}
      <div className="meta">
        <span className="chip">{KIND_LABEL[ex.kind]}</span>
        {ex.origin === 'ai' && <QualityChip status={ex.status} origin="ai" />}
      </div>
      <button className="disclosure" aria-expanded={open} onClick={onToggle}>
        <span>発音ガイド{ex.pronunciation ? '' : '（未登録）'}</span>
        <IconChevron />
      </button>
      {open && <PronunciationView guide={ex.pronunciation} sentence={ex.en} settings={settings} />}
    </div>
  );
}

export default function Study() {
  const settings = useSettings();
  const [session, setSession] = useState<StudySession | null>(null);
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [expr, setExpr] = useState<Expression | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pronOpen, setPronOpen] = useState<string | null>(null);
  const [showComplete, setShowComplete] = useState(false);
  const [completeDismissed, setCompleteDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<{ id: string; text: string; prevQueue: string[] } | null>(null);
  const [, tick] = useState(0);

  // Active-time tracking for the current card (paused while the app is hidden).
  const cardStart = useRef<number>(Date.now());
  const cardAccum = useRef<number>(0);
  const cardElapsed = () => cardAccum.current + (document.hidden ? 0 : Date.now() - cardStart.current);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) cardAccum.current += Date.now() - cardStart.current;
      else cardStart.current = Date.now();
    };
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, []);

  // Start or resume.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const extra = hashParams().get('extra');
      let s: StudySession;
      if (extra) {
        const active = await getActiveSession();
        s = active ? await extendSession(active.id, 5) : await startOrResumeSession(5);
        if (s.queue.length === 0) s = await extendSession(s.id, 5);
        history.replaceState(null, '', '#/study');
      } else {
        s = await startOrResumeSession(settings.sessionMinutes);
      }
      if (!cancelled) setSession(s);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentId = session?.queue[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentId) {
        setCard(null);
        setExpr(null);
        return;
      }
      const c = await db.cards.get(currentId);
      const e = c ? await db.expressions.get(c.expressionId) : undefined;
      if (cancelled) return;
      if (!c || !e) {
        // Card was deleted meanwhile: drop it from the queue.
        setSession((prev) => {
          if (!prev) return prev;
          const s = { ...prev, queue: prev.queue.filter((id) => id !== currentId) };
          void db.sessions.put(s);
          return s;
        });
        return;
      }
      setCard(c);
      setExpr(e);
      setRevealed(false);
      setMoreOpen(false);
      setPronOpen(null);
      cardStart.current = Date.now();
      cardAccum.current = 0;
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  const intervals = useMemo(() => (card ? previewIntervals(settings, card.fsrs) : null), [card, settings]);

  const elapsedMs = (session?.activeMs ?? 0) + (card && session?.queue.length ? Math.min(60_000, cardElapsed()) : 0);
  const targetMs = (session?.targetMinutes ?? settings.sessionMinutes) * 60_000;

  const answer = useCallback(
    async (r: RatingValue) => {
      if (!session || !card || busy) return;
      setBusy(true);
      try {
        const res = await answerCard(session.id, card.id, r, cardElapsed());
        setExcluded(null);
        setSession({ ...res.session });
        if (!completeDismissed && res.session.activeMs >= targetMs && res.session.queue.length > 0) setShowComplete(true);
      } finally {
        setBusy(false);
      }
    },
    [session, card, busy, completeDismissed, targetMs],
  );

  const exclude = async () => {
    if (!session || !expr || busy) return;
    setBusy(true);
    try {
      const res = await excludeExpression(session.id, expr.id);
      if (!res) return;
      setExcluded({ id: expr.id, text: expr.text || expr.meaning, prevQueue: res.prevQueue });
      setSession({ ...res.session });
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!session || !excluded) return;
    const s = await restoreExpression(session.id, excluded.id, excluded.prevQueue);
    setExcluded(null);
    if (s) setSession({ ...s });
  };

  const excludedBar = excluded && (
    <div className="excluded-bar" role="status">
      <span className="grow">「{excluded.text}」を学習から外しました</span>
      <button className="btn sm" onClick={restore}>元に戻す</button>
    </div>
  );

  const undo = async () => {
    if (!session) return;
    const s = await undoLast(session.id);
    if (s) setSession({ ...s });
  };

  const end = async () => {
    if (session) await finishSession(session.id);
    navigate('home');
  };

  const extend = async (min: number) => {
    if (!session) return;
    const s = await extendSession(session.id, min);
    setShowComplete(false);
    setCompleteDismissed(true);
    setSession({ ...s });
  };

  // Keyboard shortcuts (useful on iPad / desktop).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (showComplete) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        void answer(Number(e.key) as RatingValue);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [revealed, answer, showComplete]);

  if (!session) return <div className="study" />;

  const answered = session.done.length;
  const progressPct = Math.min(100, (elapsedMs / targetMs) * 100);
  const minutes = Math.floor(elapsedMs / 60000);
  const seconds = Math.floor((elapsedMs % 60000) / 1000);

  const top = (
    <div className="study-top">
      <button className="icon-btn" aria-label="終了" onClick={end}><IconClose /></button>
      <div className="study-progress">
        <div className="meter"><div style={{ width: `${progressPct}%` }} /></div>
        <div className="tiny row between">
          <span>{minutes}:{String(seconds).padStart(2, '0')} / {session.targetMinutes}:00</span>
          <span>残り {session.queue.length}</span>
        </div>
      </div>
      <button className="icon-btn" aria-label="ひとつ戻す" onClick={undo} disabled={answered === 0 && session.reviewedCount + session.newCount === 0}><IconUndo /></button>
    </div>
  );

  if (session.queue.length === 0) {
    return (
      <div className="study">
        {top}
        <div className="study-body done-screen">
          <div className="big">✓</div>
          <h2 style={{ margin: '0 0 6px' }}>お疲れさまでした</h2>
          <p className="muted" style={{ margin: 0 }}>
            {session.reviewedCount}件の復習・{session.newCount}件の新しい表現 / {Math.round(session.activeMs / 60000)}分
          </p>
          <p className="small muted">次回の復習日はFSRSが自動で決めています。</p>
        </div>
        <div className="study-bottom stack">
          {excludedBar}
          <button className="btn primary block lg" onClick={end}>終了する</button>
          <button className="btn block" onClick={() => extend(5)}>あと5分続ける</button>
        </div>
      </div>
    );
  }

  if (!card || !expr) return <div className="study">{top}</div>;

  const isProd = card.mode === 'production';
  const examples = expr.examples;
  const mainEx = examples[0];
  const prompt = expr.productionPrompt || expr.meaning || expr.ai?.meaning || mainEx?.ja || '（日本語訳が未登録です）';
  const isNew = card.introducedAt === null;

  return (
    <div className="study">
      {top}
      <div className="study-body" onClick={() => !revealed && setRevealed(true)}>
        <div className="mode-label">
          {isProd ? 'Speaking · 英語で言ってみる' : 'Reading · 意味を思い出す'}
          {isNew && <span className="chip accent" style={{ marginLeft: 8 }}>NEW</span>}
        </div>

        {isProd ? (
          <>
            <div className="expr prompt">{prompt}</div>
            {expr.productionPrompt && expr.meaning && <p className="small muted" style={{ margin: 0 }}>{expr.meaning}</p>}
          </>
        ) : (
          <div className="expr">{expr.text}</div>
        )}

        {revealed && (
          <div className="reveal" onClick={(e) => e.stopPropagation()}>
            {isProd ? <div className="expr" style={{ marginTop: 0 }}>{expr.text}</div> : null}
            {!isProd && (expr.meaning ? <p className="meaning">{expr.meaning}</p> : !expr.ai?.meaning && <p className="meaning muted">日本語訳が未登録です</p>)}
            {!isProd && expr.ai?.meaning && (
              <div style={{ marginTop: expr.meaning ? 12 : 0 }}>
                <p className={expr.meaning ? 'small' : 'meaning'} style={{ whiteSpace: 'pre-line', margin: 0, color: expr.meaning ? 'var(--ink-2)' : undefined }}>{expr.ai.meaning}</p>
                <span className="chip warn" style={{ marginTop: 6 }}>AI訳・未検証</span>
              </div>
            )}

            {mainEx && <ExampleBlock ex={mainEx} expr={expr.text} open={pronOpen === mainEx.id} onToggle={() => setPronOpen(pronOpen === mainEx.id ? null : mainEx.id)} />}

            {examples.length > 1 && (
              <>
                <button className="disclosure" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
                  <span>他の例文（{examples.length - 1}）</span>
                  <IconChevron />
                </button>
                {moreOpen && examples.slice(1).map((ex) => (
                  <ExampleBlock key={ex.id} ex={ex} expr={expr.text} open={pronOpen === ex.id} onToggle={() => setPronOpen(pronOpen === ex.id ? null : ex.id)} />
                ))}
              </>
            )}

            {expr.notes && <p className="small muted" style={{ whiteSpace: 'pre-line', marginTop: 18 }}>{expr.notes}</p>}
          </div>
        )}

        <div className="row study-actions" onClick={(e) => e.stopPropagation()}>
          {revealed && <a className="btn ghost sm" href={`#/library/${expr.id}`}>編集</a>}
          <button className="btn ghost sm muted-btn" disabled={busy} onClick={exclude}>学習から外す</button>
        </div>
      </div>

      <div className="study-bottom">
        {excludedBar}
        {!revealed ? (
          <button className="btn primary block lg" onClick={() => setRevealed(true)}>
            {isProd ? '英文を見る' : '答えを見る'}
          </button>
        ) : (
          <div className="ratings">
            {RATINGS.map(({ v, label, cls }) => (
              <button key={v} className={`rate ${cls}`} disabled={busy} onClick={() => answer(v)}>
                <b>{label}</b>
                <small>{intervals ? formatInterval(intervals[v]) : ''}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {showComplete && (
        <div className="sheet-backdrop">
          <div className="sheet center">
            <div style={{ fontSize: 40 }}>🎉</div>
            <h2 style={{ margin: '4px 0 6px' }}>今日の{session.targetMinutes}分が完了しました</h2>
            <p className="muted small">ここで終えても大丈夫です。残りは明日以降に自動で回ります。</p>
            <div className="stack" style={{ marginTop: 18 }}>
              <button className="btn primary block lg" onClick={end}>今日はここまで</button>
              <button className="btn block" onClick={() => { setShowComplete(false); setCompleteDismissed(true); }}>キューの残りを続ける（{session.queue.length}件）</button>
              <button className="btn ghost block" onClick={() => extend(5)}>さらに5分追加</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

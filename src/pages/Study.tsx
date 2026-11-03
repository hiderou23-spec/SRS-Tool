import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import type { Example, Expression, RatingValue, ReviewCard, StudySession } from '../db/types';
import { answerCard, excludeExpression, extendSession, finishSession, restoreExpression, startOrResumeSession, startQuickSession, undoLast, getActiveSession } from '../srs/session';
import { previewIntervals } from '../srs/scheduler';
import { useSettings } from '../lib/hooks';
import { hashParams, navigate } from '../lib/router';
import { formatInterval } from '../lib/util';
import { IconChevron, IconClose, IconUndo } from '../components/Icons';
import { PronunciationView } from '../components/Pronunciation';
import { pickExample } from '../srs/rotation';
import { highlight } from '../components/Highlight';
import { useLiveQuery } from 'dexie-react-hooks';
import { encouragementFor } from '../lib/encouragement';
import { hintSteps, type HintStep } from '../srs/hint';
import { VocabSessionSummary } from '../components/Vocab';

const RATINGS: { v: RatingValue; label: string; cls: string }[] = [
  { v: 1, label: 'Again', cls: 'again' },
  { v: 2, label: 'Hard', cls: 'hard' },
  { v: 3, label: 'Good', cls: 'good' },
  { v: 4, label: 'Easy', cls: 'easy' },
];

const KIND_LABEL: Record<string, string> = { business: 'Business', daily: 'Daily', alternative: 'Alternative' };

function ExampleBlock({ ex, expr, open, onToggle, hideJa }: { ex: Example; expr: string; open: boolean; onToggle: () => void; hideJa?: boolean }) {
  const settings = useSettings();
  return (
    <div className="example">
      <div className="en">{highlight(ex.en, expr)}</div>
      {ex.ja && !hideJa && <div className="ja">{ex.ja}</div>}
      <div className="meta">
        <span className="chip">{KIND_LABEL[ex.kind]}</span>
        {ex.origin === 'ai' && ex.status !== 'verified' && <span className="ai-tag" title="AIが作成（未確認）">AI</span>}
      </div>
      <button className="disclosure" aria-expanded={open} onClick={onToggle}>
        <span>発音ガイド{ex.pronunciation ? '' : '（未登録）'}</span>
        <IconChevron />
      </button>
      {open && <PronunciationView guide={ex.pronunciation} sentence={ex.en} settings={settings} compact />}
    </div>
  );
}

function HintView({ step }: { step: HintStep }) {
  if (step.kind === 'mask') return <div className="hint-mask">{step.text}</div>;
  if (step.kind === 'sentence-mask') {
    return (
      <div className="hint-sentence">
        {step.before}<span className="hint-mask inline">{step.masked}</span>{step.after}
      </div>
    );
  }
  return (
    <div className="hint-sentence">
      <span className="tiny muted" style={{ display: 'block', marginBottom: 2 }}>例文</span>
      {step.sentence}
    </div>
  );
}

function Encouragement({ session }: { session: StudySession }) {
  const answered = session.reviewedCount + session.newCount;
  // A new pair per end screen: the goal sheet and a later finished screen of
  // the same session (or after "あと5分") show different text.
  const { message, tip } = useMemo(
    () => encouragementFor({ sessionId: session.id, answered, quick: session.quick }),
    [session.id, answered, session.quick],
  );
  return (
    <div className="encourage">
      <p className="msg">{message}</p>
      <div className="tip"><span className="tip-label">Tips</span>{tip}</div>
    </div>
  );
}

export default function Study() {
  const settings = useSettings();
  const [session, setSession] = useState<StudySession | null>(null);
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [expr, setExpr] = useState<Expression | null>(null);
  const [revealed, setRevealed] = useState(false);
  /** Hint steps shown for the current card (0 = none). */
  const [hintLevel, setHintLevel] = useState(0);
  /** Hint steps actually shown (hintLevel clamped to the card's steps), for answer(). */
  const hintsShown = useRef(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pronOpen, setPronOpen] = useState<string | null>(null);
  const [showComplete, setShowComplete] = useState(false);
  const [completeDismissed, setCompleteDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped on every answer / undo / exclude so the same card id coming back is reloaded. */
  const [turn, setTurn] = useState(0);
  /** True from an answer until the next card is on screen (blocks double answers). */
  const [loadingNext, setLoadingNext] = useState(false);
  /** Next card prefetched while the current one is shown, so advancing needs no DB wait. */
  const prefetched = useRef(new Map<string, Promise<{ c?: ReviewCard; e?: Expression }>>());
  const [menuOpen, setMenuOpen] = useState(false);
  const totalAnswers = useLiveQuery(() => db.logs.count(), []);
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
      const params = hashParams();
      const extra = params.get('extra');
      let s: StudySession;
      if (params.get('quick')) {
        s = await startQuickSession();
        history.replaceState(null, '', '#/study');
      } else if (extra) {
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
  const nextId = session?.queue[1] ?? null;

  const fetchCard = (id: string) =>
    db.transaction('r', db.cards, db.expressions, async () => {
      const c = await db.cards.get(id);
      const e = c ? await db.expressions.get(c.expressionId) : undefined;
      return { c, e };
    });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentId) {
        setCard(null);
        setExpr(null);
        setLoadingNext(false);
        return;
      }
      const cached = prefetched.current.get(currentId);
      prefetched.current.delete(currentId);
      const { c, e } = await (cached ?? fetchCard(currentId));
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
      setLoadingNext(false);
      setRevealed(false);
      setHintLevel(0);
      setMoreOpen(false);
      setPronOpen(null);
      setMenuOpen(false);
      cardStart.current = Date.now();
      cardAccum.current = 0;
    })();
    return () => {
      cancelled = true;
    };
    // `turn`: a learning card can come straight back with the same id (e.g. the
    // last card in the queue answered Again); it must still be reloaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, turn]);

  // Prefetch the following card. Cached entries are only ever for cards that
  // haven't been answered since (the answered card's entry is dropped).
  useEffect(() => {
    if (nextId && nextId !== currentId && !prefetched.current.has(nextId)) {
      const pr = fetchCard(nextId);
      pr.catch(() => prefetched.current.delete(nextId));
      prefetched.current.set(nextId, pr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextId, currentId, turn]);

  /** Apply a session returned by an action and force the current card to reload. */
  const applySession = (s: StudySession, changedCardId?: string) => {
    if (changedCardId) prefetched.current.delete(changedCardId);
    setSession({ ...s });
    setTurn((n) => n + 1);
  };

  const intervals = useMemo(() => (card ? previewIntervals(settings, card.fsrs) : null), [card, settings]);

  const elapsedMs = (session?.activeMs ?? 0) + (card && session?.queue.length ? Math.min(60_000, cardElapsed()) : 0);
  const targetMs = (session?.targetMinutes ?? settings.sessionMinutes) * 60_000;

  const answer = useCallback(
    async (r: RatingValue) => {
      if (!session || !card || busy || loadingNext) return;
      setBusy(true);
      try {
        // A recall that needed a hint is never "Easy" (FSRS would overestimate it).
        const used = hintsShown.current;
        if (used > 0 && r === 4) return;
        const res = await answerCard(session.id, card.id, r, cardElapsed(), new Date(), { hintsUsed: used });
        setExcluded(null);
        setLoadingNext(true);
        applySession(res.session, card.id);
        if (!completeDismissed && res.session.activeMs >= targetMs && res.session.queue.length > 0) setShowComplete(true);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, card, busy, loadingNext, completeDismissed, targetMs],
  );

  const exclude = async () => {
    if (!session || !expr || busy) return;
    setBusy(true);
    try {
      const res = await excludeExpression(session.id, expr.id);
      if (!res) return;
      setExcluded({ id: expr.id, text: expr.text || expr.meaning, prevQueue: res.prevQueue });
      applySession(res.session);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!session || !excluded) return;
    const s = await restoreExpression(session.id, excluded.id, excluded.prevQueue);
    setExcluded(null);
    if (s) applySession(s);
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
    // The undone card's state changed back: never reuse a prefetched copy of it.
    if (s) {
      prefetched.current.clear();
      applySession(s);
    }
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
    applySession(s);
  };

  // Keyboard shortcuts (useful on iPad / desktop).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (showComplete) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (!revealed && (e.key === 'h' || e.key === 'H')) {
        setHintLevel((n) => n + 1); // clamped to the available steps when rendering
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
          <span>{session.quick && session.targetMinutes === 1 && <b className="quick-tag">1分モード</b>}{minutes}:{String(seconds).padStart(2, '0')} / {session.targetMinutes}:00</span>
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
          <VocabSessionSummary sessionId={session.id} />
          <Encouragement session={session} />
          <p className="tiny muted">次回の復習日はFSRSが自動で決めています。</p>
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
  // Reading: rotate through all examples. Speaking: rotate through examples that
  // have a Japanese translation, and ask for the whole sentence.
  const { main: mainEx, others } = pickExample(expr.examples, card, isProd ? (e) => !!e.ja.trim() : undefined);
  const sentenceMode = isProd && !!mainEx;
  const meaningHint = expr.meaning || expr.ai?.meaning;
  const prompt = sentenceMode ? mainEx!.ja : expr.productionPrompt || meaningHint || '（日本語訳が未登録です）';
  const isNew = card.introducedAt === null;
  const steps = hintSteps({ isProd, exprText: expr.text, example: mainEx, sentenceMode });
  const shownHints = Math.min(hintLevel, steps.length);
  const hintUsed = shownHints > 0;
  hintsShown.current = shownHints;
  const nextHint = () => setHintLevel(Math.min(steps.length, shownHints + 1));
  const hasAi =
    (!isProd && !!expr.ai?.meaning) ||
    [mainEx, ...(moreOpen ? others : [])].some((e) => e && e.origin === 'ai' && e.status !== 'verified');

  return (
    <div className="study">
      {top}
      <div className={revealed ? 'study-body' : 'study-body asking'} onClick={() => !revealed && setRevealed(true)}>
        <div className="mode-label">
          {sentenceMode ? 'Speaking · この文を英語で言う' : isProd ? 'Speaking · 英語で言ってみる' : 'Reading · 意味を思い出す'}
          {isNew && <span className="chip accent" style={{ marginLeft: 8 }}>NEW</span>}
        </div>

        {isProd ? (
          <>
            <div className={sentenceMode ? 'expr prompt sentence' : 'expr prompt'}>{prompt}</div>
            {sentenceMode
              ? meaningHint && <p className="small muted" style={{ margin: 0, whiteSpace: 'pre-line' }}>使う表現：{meaningHint.split('\n')[0]}</p>
              : expr.productionPrompt && expr.meaning && <p className="small muted" style={{ margin: 0 }}>{expr.meaning}</p>}
          </>
        ) : (
          <div className="expr">{expr.text}</div>
        )}

        {!revealed && hintUsed && (
          <div className="hints" onClick={(e) => e.stopPropagation()} aria-live="polite">
            <HintView step={steps[shownHints - 1]} />
            <p className="tiny muted" style={{ margin: '6px 0 0' }}>
              ヒント {shownHints}/{steps.length}　まずは数秒、自分で思い出してみてください
            </p>
          </div>
        )}

        {revealed && (
          <div className="reveal" onClick={(e) => e.stopPropagation()}>
            {isProd ? <div className="expr" style={{ marginTop: 0 }}>{expr.text}</div> : null}
            {!isProd && (expr.meaning ? <p className="meaning">{expr.meaning}</p> : !expr.ai?.meaning && <p className="meaning muted">日本語訳が未登録です</p>)}
            {!isProd && expr.ai?.meaning && (
              <div style={{ marginTop: expr.meaning ? 12 : 0 }}>
                <p className={expr.meaning ? 'small' : 'meaning'} style={{ whiteSpace: 'pre-line', margin: 0, color: expr.meaning ? 'var(--ink-2)' : undefined }}>{expr.ai.meaning} <span className="ai-tag" title="AIが作成した訳（未確認）">AI</span></p>
              </div>
            )}

            {mainEx && <ExampleBlock ex={mainEx} expr={expr.text} hideJa={sentenceMode} open={pronOpen === mainEx.id} onToggle={() => setPronOpen(pronOpen === mainEx.id ? null : mainEx.id)} />}

            {others.length > 0 && (
              <>
                <button className="disclosure" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
                  <span>他の例文（{others.length}）</span>
                  <IconChevron />
                </button>
                {moreOpen && others.map((ex) => (
                  <ExampleBlock key={ex.id} ex={ex} expr={expr.text} open={pronOpen === ex.id} onToggle={() => setPronOpen(pronOpen === ex.id ? null : ex.id)} />
                ))}
              </>
            )}

            {expr.notes && <p className="small muted" style={{ whiteSpace: 'pre-line', marginTop: 18 }}>{expr.notes}</p>}
            {hasAi && <p className="tiny muted" style={{ marginTop: 16 }}><span className="ai-tag">AI</span> はAIが作った内容です（未確認）。気になったら編集で直せます。</p>}
          </div>
        )}

        <div className="row study-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn ghost sm muted-btn" aria-expanded={menuOpen} aria-label="その他の操作" onClick={() => setMenuOpen(!menuOpen)}>⋯ その他</button>
          {menuOpen && (
            <>
              <a className="btn ghost sm" href={`#/library/${expr.id}`}>編集</a>
              <button className="btn ghost sm danger" disabled={busy} onClick={exclude}>学習から外す</button>
            </>
          )}
        </div>
      </div>

      <div className="study-bottom">
        {excludedBar}
        {!revealed ? (
          <div className="ask-row">
            {steps.length > 0 && (
              <button className="btn lg hint-btn" disabled={shownHints >= steps.length} onClick={nextHint}>
                {shownHints === 0 ? 'ヒント' : shownHints < steps.length ? 'もう少し' : 'ヒント終了'}
              </button>
            )}
            <button className="btn primary block lg" onClick={() => setRevealed(true)}>
              {isProd ? '英文を見る' : '答えを見る'}
            </button>
          </div>
        ) : (
          <>
          {hintUsed ? (
            <p className="rating-hint">ヒントを使ったので <b>Hard</b> がおすすめです（Easy は選べません）。思い出せなかったら Again。</p>
          ) : totalAnswers !== undefined && totalAnswers < 30 && (
            <p className="rating-hint">下の数字は「次にこのカードが出るまで」の間隔です。迷ったら Good。</p>
          )}
          <div className="ratings">
            {RATINGS.map(({ v, label, cls }) => (
              <button
                key={v}
                className={`rate ${cls}${hintUsed && v === 2 ? ' suggested' : ''}`}
                disabled={busy || loadingNext || (hintUsed && v === 4)}
                onClick={() => answer(v)}
              >
                <b>{label}</b>
                <small>{intervals ? formatInterval(intervals[v]) : ''}</small>
              </button>
            ))}
          </div>
          </>
        )}
      </div>

      {showComplete && (
        <div className="sheet-backdrop">
          <div className="sheet center">
            <div style={{ fontSize: 40 }}>🎉</div>
            <h2 style={{ margin: '4px 0 6px' }}>{session.quick && session.targetMinutes === 1 ? '1分完了。今日もつながりました' : `今日の${session.targetMinutes}分が完了しました`}</h2>
            <VocabSessionSummary sessionId={session.id} />
            <Encouragement session={session} />
            <p className="muted tiny" style={{ margin: '10px 0 0' }}>ここで終えても大丈夫です。残りは明日以降に自動で回ります。</p>
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

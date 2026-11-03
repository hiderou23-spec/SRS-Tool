import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AI_MODELS, friendlyError, getAiModel, getApiKey } from '../lib/aiConfig';
import { toast, useSettings } from '../lib/hooks';
import { saveSettings } from '../db/db';
import { recordUsage } from './AiPanel';
import { IconChevron } from './Icons';
import {
  addSuggestion,
  canAskMore,
  decideSuggestion,
  DAILY_SUGGESTIONS,
  levelInfo,
  nextLevel,
  requestTodaysSuggestions,
  SUGGESTION_LEVELS,
  suggestionsForDay,
  todayKey,
} from '../lib/suggestions';
import type { Suggestion } from '../db/types';

/** Rough cost of one request (library sample + 8 candidates with examples). */
function estimateUsd(): number {
  const m = AI_MODELS.find((x) => x.id === getAiModel())!;
  return (5000 * m.inPerM + 4000 * m.outPerM) / 1e6;
}

function Item({ s }: { s: Suggestion }) {
  const [busy, setBusy] = useState(false);
  const ex = s.examples[0];

  const add = async () => {
    setBusy(true);
    try {
      const { firstExampleId, expressionId } = await addSuggestion(s.id);
      toast(`「${s.text}」を追加しました`);
      // Pronunciation guide for the first example, in the background.
      if (firstExampleId && getApiKey()) {
        void import('../lib/aiGenerate')
          .then(({ generatePronunciation }) => generatePronunciation(expressionId, firstExampleId))
          .then(recordUsage)
          .catch((err) => toast(`発音ガイドは作れませんでした：${friendlyError(err)}`));
      }
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (st: 'known' | 'rejected' | 'pending') => {
    setBusy(true);
    try {
      await decideSuggestion(s.id, st);
    } finally {
      setBusy(false);
    }
  };

  const decided = s.status !== 'pending';
  return (
    <div className={decided ? 'suggestion decided' : 'suggestion'}>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div className="sg-text">{s.text}</div>
        {s.status === 'added' && <a className="chip accent" href={`#/library/${s.expressionId}`}>追加済み</a>}
        {s.status === 'known' && <span className="chip">知ってる</span>}
        {s.status === 'rejected' && <span className="chip">見送り</span>}
      </div>
      {s.meaning && <div className="sg-meaning">{s.meaning} <span className="ai-tag" title="AIが作成（未確認）">AI</span></div>}
      {!decided && (
        <>
          {s.reason && <p className="tiny muted" style={{ margin: '4px 0 0' }}>{s.reason}</p>}
          {ex && <p className="sg-example">{ex.en}<br /><span className="muted">{ex.ja}</span></p>}
          <div className="sg-actions">
            <button className="btn sm primary" disabled={busy} onClick={add}>追加</button>
            <button className="btn sm" disabled={busy} onClick={() => decide('known')}>もう知ってる</button>
            <button className="btn sm ghost muted-btn" disabled={busy} onClick={() => decide('rejected')}>いらない</button>
          </div>
        </>
      )}
      {(s.status === 'known' || s.status === 'rejected') && (
        <button className="btn ghost sm" style={{ padding: 0, minHeight: 28 }} disabled={busy} onClick={() => decide('pending')}>取り消す</button>
      )}
    </div>
  );
}

/**
 * Home card. `paused`: reviews are backlogged today, so no new expressions are
 * suggested (they would only add to the pile).
 */
export function DailySuggestions({ paused }: { paused: boolean }) {
  const [loading, setLoading] = useState(false);
  const [showDecided, setShowDecided] = useState(false);
  const settings = useSettings();
  const hasKey = !!getApiKey();
  const today = useLiveQuery(async () => suggestionsForDay(await todayKey()), []);
  if (today === undefined) return null;

  if (!hasKey) {
    return (
      <div className="card">
        <h2>今日のAI提案</h2>
        <p className="small" style={{ margin: 0 }}>
          毎日{DAILY_SUGGESTIONS}語、あなたの仕事に合った表現をAIが提案します。使うには <a href="#/settings">Settings → AI 生成</a> で API キーを保存してください。
        </p>
      </div>
    );
  }

  const fetchNow = async (more = false) => {
    setLoading(true);
    try {
      const before = today.length;
      const { usage, suggestions, level, levelRaised } = await requestTodaysSuggestions(new Date(), { more });
      if (usage) recordUsage(usage);
      if (levelRaised) toast(`知っている表現が多かったので、レベルを「${levelInfo(level).label}」に上げました`);
      else if (suggestions.length === before) toast('新しい候補が見つかりませんでした。また明日お試しください');
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const pendingItems = today.filter((s) => s.status === 'pending');
  const decidedItems = today.filter((s) => s.status !== 'pending');
  const pending = pendingItems.length;
  const count = (st: string) => decidedItems.filter((s) => s.status === st).length;
  const breakdown = [
    ['追加', count('added')],
    ['知ってる', count('known')],
    ['見送り', count('rejected')],
  ]
    .filter(([, n]) => n)
    .map(([l, n]) => `${l}${n}`)
    .join('・');
  const more = canAskMore(today);
  const upcoming = nextLevel(settings.suggestionLevel, settings.suggestionLevelBasis, today);
  const levelSelect = (
    <label className="row tiny muted" style={{ gap: 6, marginTop: 12 }}>
      <span>レベル</span>
      <select
        className="select sg-level"
        value={levelInfo(settings.suggestionLevel).level}
        onChange={(e) => saveSettings({ suggestionLevel: Number(e.target.value) })}
      >
        {SUGGESTION_LEVELS.map((l) => <option key={l.level} value={l.level}>{l.label}</option>)}
      </select>
      <span className="grow">「知ってる」が多いと自動で上がります</span>
    </label>
  );
  const canStart = today.length === 0 && !paused;
  return (
    <div className="card">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>今日のAI提案</h2>
        {today.length > 0 && <span className="tiny muted">{pending > 0 ? `あと${pending}語` : '選び終わりました'}</span>}
      </div>
      {today.length > 0 ? (
        <>
          {/* Only undecided suggestions are shown in full; decided ones fold into one line. */}
          {pending > 0 && <div className="sg-list">{pendingItems.map((s) => <Item key={s.id} s={s} />)}</div>}
          {decidedItems.length > 0 && (
            <>
              <button className="disclosure sg-decided" aria-expanded={showDecided} onClick={() => setShowDecided(!showDecided)}>
                <span>選んだ表現 {decidedItems.length}語<span className="muted">（{breakdown}）</span></span>
                <IconChevron />
              </button>
              {showDecided && <div className="sg-list">{decidedItems.map((s) => <Item key={s.id} s={s} />)}</div>}
            </>
          )}
          {pending === 0 && !more && <p className="small muted" style={{ margin: '10px 0 0' }}>今日の提案は以上です。また明日。</p>}
        </>
      ) : paused ? (
        <p className="small" style={{ margin: '10px 0 0' }}>今日は復習を優先する日なので、新しい表現の提案はお休みです。</p>
      ) : (
        <>
          <p className="small" style={{ margin: '10px 0 12px' }}>
            あなたの仕事に合った表現を{DAILY_SUGGESTIONS}語提案します。気に入ったものだけ追加してください。
          </p>
          <button className="btn block" disabled={loading} onClick={() => fetchNow()}>
            {loading ? '考えています…' : `今日の${DAILY_SUGGESTIONS}語を提案してもらう`}
          </button>
          <p className="tiny muted" style={{ margin: '8px 0 0' }}>
            目安 約${estimateUsd().toFixed(2)}／回。送信するのはライブラリの英語表現（一部）とこれまでの提案への選択だけです。
          </p>
        </>
      )}
      {more && (
        <div style={{ marginTop: 12 }}>
          {upcoming.raised && (
            <p className="small" style={{ margin: '0 0 8px' }}>知っている表現が多かったので、次はレベルを「{levelInfo(upcoming.level).label}」に上げて提案します。</p>
          )}
          <button className="btn block" disabled={loading} onClick={() => fetchNow(true)}>
            {loading ? '考えています…' : `もう${DAILY_SUGGESTIONS}語提案してもらう（約$${estimateUsd().toFixed(2)}）`}
          </button>
        </div>
      )}
      {(canStart || more) && levelSelect}
      {pending > 0 && (
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>
          追加した表現は新しいカードとして、1日の新規上限の範囲で出題されます。例文と訳はAIが作成したもの（要確認）です。
        </p>
      )}
    </div>
  );
}

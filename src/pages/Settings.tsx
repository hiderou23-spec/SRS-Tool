import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db, saveSettings } from '../db/db';
import type { Settings } from '../db/types';
import { exportBackupJson, exportCsv, restoreBackup, validateBackup, type BackupFile } from '../lib/backup';
import { useSettings, toast } from '../lib/hooks';
import { addSampleDeck } from '../lib/sample';
import { applyAiAssessment, validateAiFile } from '../lib/aiAssessment';
import AiPanel from '../components/AiPanel';
import { IconRight } from '../components/Icons';

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="list-item">
      <div className="grow">
        <div>{label}</div>
        {desc && <div className="tiny muted">{desc}</div>}
      </div>
      <span className="toggle"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}

function Link({ href, label, badge }: { href: string; label: string; badge?: string | number }) {
  return (
    <a className="list-item" href={href}>
      <span className="grow">{label}</span>
      {badge !== undefined && badge !== 0 && <span className="chip warn">{badge}</span>}
      <span className="muted"><IconRight /></span>
    </a>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const set = (patch: Partial<Settings>) => saveSettings(patch);
  const pendingDup = useLiveQuery(() => db.duplicates.where('resolution').equals('pending').count(), []);
  const counts = useLiveQuery(async () => ({ expressions: await db.expressions.count(), logs: await db.logs.count() }), []);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<string>('');
  const [restoreCandidate, setRestoreCandidate] = useState<BackupFile | null>(null);

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    navigator.storage?.estimate?.().then((e) => setUsage(e.usage != null ? `${(e.usage / 1024 / 1024).toFixed(1)} MB 使用中` : '')).catch(() => {});
  }, []);

  const onRestoreFile = async (f: File) => {
    try {
      const obj = JSON.parse(await f.text());
      if (obj?.format === 'english-mastery-ai-assessment') {
        toast('これはAI分類ファイルです。「AI分類ファイルを読み込む」から選んでください');
        return;
      }
      const v = validateBackup(obj);
      if (!v.ok) {
        toast(v.error);
        return;
      }
      setRestoreCandidate(v.backup);
    } catch {
      toast('JSONを読み込めませんでした');
    }
  };

  const doRestore = async () => {
    if (!restoreCandidate) return;
    try {
      await restoreBackup(restoreCandidate);
      setRestoreCandidate(null);
      toast('復元しました');
    } catch (e) {
      toast(`復元に失敗しました（データは変更されていません）: ${(e as Error).message}`);
    }
  };

  const onAiFile = async (f: File) => {
    try {
      const obj = JSON.parse(await f.text());
      if (obj?.format === 'english-mastery-backup') {
        toast('これはバックアップファイルです。「JSONバックアップから復元」から選んでください');
        return;
      }
      const v = validateAiFile(obj);
      if (!v.ok) {
        toast(v.error);
        return;
      }
      const r = await applyAiAssessment(v.file);
      toast(`AI分類を${r.matchedExpressions.toLocaleString()}件に反映しました`);
      alert(`AI分類の反映結果\n\n分類データ: ${r.items.toLocaleString()}件\n反映した表現: ${r.matchedExpressions.toLocaleString()}件\n一致する表現がなかった分類: ${r.unmatchedItems.toLocaleString()}件\n手動設定を優先した表現: ${r.userOverridesKept.toLocaleString()}件\n例文を追加した表現: ${r.examplesAdded.toLocaleString()}件\n発音ガイドを追加した例文: ${r.pronunciationsAdded.toLocaleString()}件\n\nAI判定は元データ・手動設定とは別に保存されています。各表現の編集画面で修正できます。`);
    } catch {
      toast('ファイルを読み込めませんでした');
    }
  };

  const wipe = async () => {
    if (!confirm('すべての学習データを削除します。先にJSONバックアップを取りましたか？')) return;
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    await db.transaction('rw', db.tables, async () => {
      for (const t of db.tables) await t.clear();
    });
    toast('削除しました');
  };

  return (
    <main className="page">
      <h1 className="page-title">Settings</h1>

      <div className="section-title">学習</div>
      <div className="card">
        <label className="field"><span>1回の学習時間</span>
          <div className="seg">
            {([5, 10, 15] as const).map((m) => <button key={m} aria-pressed={s.sessionMinutes === m} onClick={() => set({ sessionMinutes: m })}>{m}分</button>)}
          </div>
        </label>
        <label className="field"><span>1日の新しい表現の上限: {s.newPerDay}件</span>
          <input type="range" min={0} max={40} step={1} value={s.newPerDay} onChange={(e) => set({ newPerDay: Number(e.target.value) })} style={{ width: '100%' }} />
          <span className="tiny muted" style={{ display: 'block', marginTop: 0 }}>復習が時間内に収まらない日は、自動で0件になります。</span>
        </label>
        <label className="field"><span>目標記憶率（FSRS）: {Math.round(s.desiredRetention * 100)}%</span>
          <input type="range" min={0.8} max={0.97} step={0.01} value={s.desiredRetention} onChange={(e) => set({ desiredRetention: Number(e.target.value) })} style={{ width: '100%' }} />
          <span className="tiny muted" style={{ display: 'block' }}>高くすると忘れにくくなりますが、復習回数が増えます。初期値90%。</span>
        </label>
        <label className="field"><span>Speaking を出題し始める条件: Readingの安定度 {s.productionUnlockStabilityDays}日以上</span>
          <input type="range" min={0} max={30} step={1} value={s.productionUnlockStabilityDays} onChange={(e) => set({ productionUnlockStabilityDays: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
        <label className="field"><span>最大復習間隔</span>
          <select className="select" value={s.maximumIntervalDays} onChange={(e) => set({ maximumIntervalDays: Number(e.target.value) })}>
            {[180, 365, 730, 1095, 1825, 3650].map((d) => <option key={d} value={d}>{d >= 365 ? `${d / 365}年` : `${d}日`}</option>)}
          </select>
        </label>
      </div>
      <div className="list">
        <Toggle label="間隔のゆらぎ (fuzz)" desc="同じ日に復習が集中しないよう、間隔を少しずらします" checked={s.enableFuzz} onChange={(v) => set({ enableFuzz: v })} />
      </div>

      <div className="section-title">発音ガイドの表示</div>
      <div className="list">
        <Toggle label="Slurred Pronunciation" desc="Level 2 / 3 の崩れた発音" checked={s.showSlurred} onChange={(v) => set({ showSlurred: v })} />
        <Toggle label="カタカナ" checked={s.showKatakana} onChange={(v) => set({ showKatakana: v })} />
        <Toggle label="IPA（発音記号）" checked={s.showIpa} onChange={(v) => set({ showIpa: v })} />
      </div>

      <div className="section-title">外観</div>
      <div className="card">
        <div className="seg">
          {([['system', '自動'], ['light', 'ライト'], ['dark', 'ダーク']] as const).map(([k, l]) => <button key={k} aria-pressed={s.theme === k} onClick={() => set({ theme: k })}>{l}</button>)}
        </div>
      </div>

      <div className="section-title">AI 生成</div>
      <AiPanel />
      <div className="list">
        <Link href="#/review" label="AI生成コンテンツの確認" />
      </div>

      <div className="section-title">データ</div>
      <div className="list">
        <Link href="#/import" label="CSV / テキストを取り込む（reminDO）" />
        <Link href="#/duplicates" label="重複候補を確認" badge={pendingDup} />
        <label className="list-item">
          <span className="grow">AI分類ファイルを読み込む（カテゴリー・重要度）</span>
          <input type="file" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) void onAiFile(e.target.files[0]); e.target.value = ''; }} />
        </label>
        <Link href="#/backlog" label="復習の状況（遅延の確認）" />
      </div>

      <div className="section-title">バックアップ</div>
      <div className="card stack">
        <p className="small" style={{ margin: 0 }}>
          学習データはこの端末のブラウザ内にのみ保存されます。Safariの履歴・Webサイトデータの削除や、長期間未使用によって消える可能性があるため、定期的にJSONバックアップを「ファイル」アプリやiCloud Driveに保存してください。
        </p>
        <p className="tiny muted" style={{ margin: 0 }}>
          最終バックアップ: {s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString('ja-JP') : 'なし'}
          {' · '}永続ストレージ: {persisted === null ? '不明' : persisted ? '許可済み' : '未許可'}
          {usage && ` · ${usage}`}
          {counts && ` · 表現 ${counts.expressions.toLocaleString()}件 / 回答 ${counts.logs.toLocaleString()}件`}
        </p>
        <button className="btn primary block" onClick={async () => { const r = await exportBackupJson(); if (r !== 'cancelled') toast('バックアップを書き出しました'); }}>JSONバックアップを保存（完全）</button>
        <label className="btn block">
          JSONバックアップから復元
          <input type="file" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) void onRestoreFile(e.target.files[0]); e.target.value = ''; }} />
        </label>
        <button className="btn block" onClick={() => exportCsv()}>CSVで書き出す（表現・例文・学習状態）</button>
      </div>

      <div className="section-title">その他</div>
      <div className="list">
        <button className="list-item" onClick={async () => { const n = await addSampleDeck(); toast(n ? `サンプル${n}件を追加しました` : 'サンプルは追加済みです'); }}>
          <span className="grow">サンプル表現を追加（例文・発音ガイド付き4件）</span>
        </button>
      </div>

      <div className="section-title">機能の実装状況</div>
      <div className="card small">
        <p style={{ marginTop: 0 }}><b>実装済み（Phase 1）</b><br />CSV/テキスト取り込み（重複候補・再取り込み対策・元データ保持）／検索・編集／Reading・Speakingモード／FSRS（ts-fsrs）による復習管理／学習時間制限と優先順位付け／学習履歴・取り消し／JSONバックアップ・復元／CSV書き出し／オフライン対応PWA／例文・発音ガイドの手動編集と表示</p>
        <p><b>実装済み（Phase 2）</b><br />AIデータファイルの読み込み（分類・重要度・AI訳・例文・発音ガイド）／自分の API キーによるアプリ内生成（3例文・日本語訳・Slurred Pronunciation・カタカナ・IPA）／AI生成コンテンツの確認画面／学習分析の強化。AI生成物はすべて元データと別に「要確認」として保存</p>
        <p style={{ marginBottom: 0 }}><b>未実装（Phase 3）</b><br />音声／Listening SRS／シャドーイング／AI会議シミュレーション／クラウド同期</p>
      </div>

      <div className="list" style={{ marginTop: 20 }}>
        <button className="list-item" onClick={wipe}><span className="grow" style={{ color: 'var(--again)' }}>すべてのデータを削除</span></button>
      </div>
      <p className="tiny muted center">English Mastery v{__APP_VERSION__} · データは外部に送信されません</p>

      {restoreCandidate && (
        <div className="sheet-backdrop" onClick={() => setRestoreCandidate(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>バックアップから復元</h2>
            <p className="small">{new Date(restoreCandidate.exportedAt).toLocaleString('ja-JP')} に作成</p>
            <p className="small">表現 {restoreCandidate.counts.expressions?.toLocaleString()}件 · 回答履歴 {restoreCandidate.counts.logs?.toLocaleString()}件</p>
            <div className="notice">現在のデータ（表現 {counts?.expressions.toLocaleString()}件 · 回答 {counts?.logs.toLocaleString()}件）はすべて置き換えられます。</div>
            <div className="stack">
              <button className="btn block" onClick={() => exportBackupJson()}>先に現在のデータをバックアップ</button>
              <button className="btn primary block" onClick={doRestore}>復元する</button>
              <button className="btn ghost block" onClick={() => setRestoreCandidate(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

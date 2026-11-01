import type { PronunciationGuide, Settings } from '../db/types';

const STATUS: Record<string, string> = { unverified: '未検証', needs_review: '要確認', verified: '確認済み' };

export function QualityChip({ status, origin }: { status: string; origin?: string }) {
  const label = origin === 'ai' || origin === 'sample' ? `AI生成・${STATUS[status]}` : STATUS[status];
  return <span className={'chip ' + (status === 'verified' ? 'accent' : 'warn')}>{label}</span>;
}

export function PronunciationView({ guide, sentence, settings }: { guide?: PronunciationGuide; sentence: string; settings: Settings }) {
  if (!guide) {
    return <div className="pron small muted">この例文の発音ガイドはまだありません（Phase 2で生成予定・手動入力は編集画面から可能）。</div>;
  }
  const levels = [
    { lv: 'Level 1 · 通常の発音', d: { ...guide.level1, text: guide.level1.text ?? sentence } },
    ...(settings.showSlurred && guide.level2 ? [{ lv: 'Level 2 · 自然な会話', d: guide.level2 }] : []),
    ...(settings.showSlurred && guide.level3 ? [{ lv: 'Level 3 · 速い・カジュアル', d: guide.level3 }] : []),
  ];
  return (
    <div className="pron">
      <div className="row between" style={{ marginBottom: 8 }}>
        <QualityChip status={guide.status} origin={guide.origin} />
      </div>
      {levels.map(({ lv, d }) => (
        <div className="pron-level" key={lv}>
          <div className="lv">{lv}</div>
          {d.text && <div className="t">{d.text}</div>}
          {settings.showKatakana && d.katakana && <div className="k">{d.katakana}</div>}
          {settings.showIpa && d.ipa && <div className="i">{d.ipa}</div>}
        </div>
      ))}
      {settings.showSlurred && !guide.level3 && guide.level2 && (
        <p className="tiny muted" style={{ margin: '10px 0 0' }}>Level 3: これ以上の自然な崩れは少ないため省略しています。</p>
      )}
      {guide.minimalChange && <p className="tiny muted" style={{ margin: '10px 0 0' }}>この文は音の変化がほとんどありません。</p>}
      {guide.notes && <p className="small" style={{ margin: '10px 0 0', color: 'var(--ink-2)' }}>{guide.notes}</p>}
      <p className="tiny muted" style={{ margin: '10px 0 0' }}>発音は話者・アクセント・速度で変わります。カタカナは補助的な目安です。</p>
    </div>
  );
}

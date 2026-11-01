import { useState } from 'react';
import type { ImportMapping } from '../db/types';
import { decodeBytes, detectDelimiter, detectUnquoted, guessColumns, parseRows } from '../import/parse';
import { analyzeImport, commitImport, fileHashOf, type ImportAnalysis } from '../import/importer';
import { navigate } from '../lib/router';
import { IconBack } from '../components/Icons';

interface Loaded {
  name: string;
  bytes: Uint8Array;
  hash: string;
  text: string;
  rows: string[][];
  columnCount: number;
}

const DELIMS: { v: string; label: string }[] = [
  { v: ',', label: 'カンマ (,)' },
  { v: '\t', label: 'タブ' },
  { v: ';', label: 'セミコロン (;)' },
  { v: '|', label: '縦棒 (|)' },
];

export default function ImportPage() {
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportAnalysis['stats'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (f: File, encodingOverride?: string, delimiterOverride?: string) => {
    setError(null);
    setAnalysis(null);
    setDone(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const decoded = encodingOverride ? { text: new TextDecoder(encodingOverride).decode(bytes).replace(/^﻿/, ''), encoding: encodingOverride } : decodeBytes(bytes);
      const delimiter = delimiterOverride ?? detectDelimiter(decoded.text);
      const quotes = !detectUnquoted(decoded.text, delimiter);
      const rows = parseRows(decoded.text, delimiter, quotes);
      if (rows.length === 0) throw new Error('データ行が見つかりません');
      const g = guessColumns(rows);
      setFile({ name: f.name, bytes, hash: await fileHashOf(bytes), text: decoded.text, rows, columnCount: g.columnCount });
      setMapping({
        hasHeader: g.hasHeader,
        delimiter,
        encoding: decoded.encoding,
        englishCol: g.englishCol,
        japaneseCol: g.japaneseCol,
        notesCols: g.unquotedCommas ? [] : Array.from({ length: g.columnCount }, (_, i) => i).filter((i) => i !== g.englishCol && i !== g.japaneseCol),
        joinRestIntoMeaning: g.unquotedCommas || !quotes,
        quotes,
      });
    } catch (e) {
      setError(`ファイルを読み込めませんでした: ${(e as Error).message}`);
    }
  };

  const reparse = (patch: Partial<ImportMapping>) => {
    if (!file || !mapping) return;
    const next = { ...mapping, ...patch };
    let rows = file.rows;
    let columnCount = file.columnCount;
    if (patch.delimiter !== undefined || patch.encoding !== undefined || patch.quotes !== undefined) {
      const text = patch.encoding !== undefined ? new TextDecoder(next.encoding.replace(/ .*/, '')).decode(file.bytes).replace(/^﻿/, '') : file.text;
      rows = parseRows(text, next.delimiter, next.quotes !== false);
      columnCount = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
      setFile({ ...file, text, rows, columnCount });
    }
    setMapping(next);
    setAnalysis(null);
  };

  const analyze = async () => {
    if (!file || !mapping) return;
    setBusy(true);
    try {
      setAnalysis(await analyzeImport(file.rows, mapping, file.hash));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file || !mapping || !analysis) return;
    setBusy(true);
    try {
      const batch = await commitImport(analysis, mapping, file.name, file.hash);
      setDone(batch.stats);
    } catch (e) {
      setError(`取り込みに失敗しました（データは変更されていません）: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const colName = (i: number) => {
    const h = mapping?.hasHeader ? file?.rows[0]?.[i] : '';
    return `列${i + 1}${h ? `「${h.slice(0, 12)}」` : ''}`;
  };

  if (done) {
    return (
      <main className="page">
        <h1 className="page-title">取り込み完了</h1>
        <div className="card">
          <StatsTable stats={done} />
        </div>
        {done.duplicateCandidates > 0 && <a className="btn block" href="#/duplicates" style={{ marginBottom: 10 }}>重複候補を確認する（{done.duplicateCandidates}件）</a>}
        <a className="btn primary block lg" href="#/home">ホームへ</a>
      </main>
    );
  }

  const preview = file ? file.rows.slice(0, 6) : [];

  return (
    <main className="page">
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="icon-btn" style={{ marginLeft: -10 }} onClick={() => navigate('settings')} aria-label="戻る"><IconBack /></button>
      </div>
      <h1 className="page-title">データの取り込み</h1>
      <p className="page-sub">reminDOなどからエクスポートしたCSV / テキスト</p>

      <div className="card stack">
        <label className="btn primary block">
          ファイルを選択
          <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        </label>
        <p className="small muted" style={{ margin: 0 }}>元のデータはそのまま保存され、上書き・削除されません。同じファイルを再度取り込んでも、既に取り込んだ行は追加されません。</p>
        {file && <p className="small" style={{ margin: 0 }}>{file.name} · {file.rows.length.toLocaleString()} 行 · {mapping?.encoding}</p>}
      </div>
      {error && <div className="notice">{error}</div>}

      {file && mapping && (
        <>
          <div className="section-title">プレビュー</div>
          <div className="card scroll-x" style={{ padding: 10 }}>
            <table className="preview">
              <thead><tr>{Array.from({ length: file.columnCount }, (_, i) => <th key={i}>列{i + 1}</th>)}</tr></thead>
              <tbody>
                {preview.map((r, ri) => (
                  <tr key={ri} style={{ opacity: mapping.hasHeader && ri === 0 ? 0.5 : 1 }}>
                    {Array.from({ length: file.columnCount }, (_, i) => <td key={i}>{(r[i] ?? '').slice(0, 60)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title">列の割り当て</div>
          <div className="card">
            <label className="field"><span>英語表現の列</span>
              <select className="select" value={mapping.englishCol} onChange={(e) => reparse({ englishCol: Number(e.target.value) })}>
                {Array.from({ length: file.columnCount }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
              </select>
            </label>
            <label className="field"><span>日本語訳の列</span>
              <select className="select" value={mapping.japaneseCol} onChange={(e) => reparse({ japaneseCol: Number(e.target.value) })}>
                <option value={-1}>なし</option>
                {Array.from({ length: file.columnCount }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
              </select>
            </label>
            <div className="field"><span>メモとして取り込む列</span>
              <div className="row wrap" style={{ gap: 6 }}>
                {Array.from({ length: file.columnCount }, (_, i) => i).filter((i) => i !== mapping.englishCol && i !== mapping.japaneseCol && !(mapping.joinRestIntoMeaning && i > mapping.japaneseCol)).map((i) => {
                  const on = mapping.notesCols.includes(i);
                  return <button key={i} className={'chip' + (on ? ' accent' : '')} style={{ border: 0, padding: '6px 11px', fontSize: 13 }} onClick={() => reparse({ notesCols: on ? mapping.notesCols.filter((x) => x !== i) : [...mapping.notesCols, i] })}>{colName(i)}</button>;
                })}
                {file.columnCount <= 2 && <span className="small muted">（他の列はありません）</span>}
              </div>
            </div>
            <label className="row between" style={{ marginBottom: 14 }}>
              <span className="grow">日本語訳の列より右をすべて訳として結合<br /><span className="tiny muted">reminDOはカンマを含む訳を引用符で囲まずに書き出すため、訳が複数列に分かれます</span></span>
              <span className="toggle"><input type="checkbox" checked={!!mapping.joinRestIntoMeaning} onChange={(e) => reparse({ joinRestIntoMeaning: e.target.checked })} /><span /></span>
            </label>
            <label className="row between" style={{ marginBottom: 14 }}>
              <span className="grow">1行＝1件として読む（引用符を無視）<br /><span className="tiny muted">reminDO形式。自動判定済み</span></span>
              <span className="toggle"><input type="checkbox" checked={mapping.quotes === false} onChange={(e) => reparse({ quotes: !e.target.checked })} /><span /></span>
            </label>
            <label className="row between" style={{ marginBottom: 14 }}>
              <span>1行目は見出し</span>
              <span className="toggle"><input type="checkbox" checked={mapping.hasHeader} onChange={(e) => reparse({ hasHeader: e.target.checked })} /><span /></span>
            </label>
            <div className="row">
              <label className="field grow"><span>区切り文字</span>
                <select className="select" value={mapping.delimiter} onChange={(e) => reparse({ delimiter: e.target.value })}>
                  {DELIMS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                </select>
              </label>
              <label className="field grow"><span>文字コード</span>
                <select className="select" value={mapping.encoding.replace(/ .*/, '')} onChange={(e) => reparse({ encoding: e.target.value })}>
                  <option value="utf-8">UTF-8</option>
                  <option value="shift_jis">Shift_JIS</option>
                  <option value="utf-16le">UTF-16</option>
                </select>
              </label>
            </div>
            <button className="btn primary block" disabled={busy} onClick={analyze}>{busy ? '解析中…' : '内容をチェック'}</button>
          </div>
        </>
      )}

      {analysis && (
        <>
          <div className="section-title">チェック結果</div>
          {analysis.fileAlreadyImported && <div className="notice">このファイルは以前に取り込み済みです。既存の行は追加されません。</div>}
          <div className="card">
            <StatsTable stats={analysis.stats} preview />
            {analysis.stats.failures.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="small">取り込めない行（{analysis.stats.failures.length}）</summary>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {analysis.stats.failures.slice(0, 50).map((f) => <div key={f.rowIndex}>{f.rowIndex + 1}行目: {f.reason}</div>)}
                </div>
              </details>
            )}
            {analysis.rows.filter((r) => r.status === 'new').length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="small">取り込み内容の例</summary>
                <div className="small" style={{ marginTop: 6 }}>
                  {analysis.rows.filter((r) => r.status === 'new').slice(0, 8).map((r) => (
                    <div key={r.rowIndex} style={{ padding: '4px 0', borderBottom: '0.5px solid var(--line)' }}>
                      <b style={{ fontFamily: 'var(--serif)' }}>{r.english}</b> — <span className="muted">{r.meaning || '（訳なし）'}</span>
                      {r.duplicateCandidate && <span className="chip warn" style={{ marginLeft: 6 }}>重複候補</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
          <button className="btn primary block lg" disabled={busy || analysis.stats.imported === 0} onClick={commit}>
            {busy ? '取り込み中…' : `${analysis.stats.imported.toLocaleString()}件を取り込む`}
          </button>
        </>
      )}
    </main>
  );
}

function StatsTable({ stats, preview }: { stats: ImportAnalysis['stats']; preview?: boolean }) {
  const rows: [string, number, string?][] = [
    ['総行数', stats.totalRows],
    [preview ? '取り込み予定' : '取り込み成功', stats.imported, 'accent'],
    ['取り込み失敗（空欄など）', stats.failed],
    ['日本語訳が不足', stats.missingMeaning],
    ['日本語の用語（Readingのみで学習）', stats.japaneseTerms ?? 0],
    ['重複候補（要確認・自動削除しません）', stats.duplicateCandidates],
    ['取り込み済みのためスキップ', stats.skippedAlreadyImported],
    ['ファイル内の完全一致行（スキップ・元データは保持）', stats.exactDuplicateRows],
  ];
  return (
    <div>
      {rows.map(([k, v, cls]) => (
        <div key={k} className="row between" style={{ padding: '7px 0', borderBottom: '0.5px solid var(--line)' }}>
          <span className="small">{k}</span>
          <b className={cls === 'accent' ? '' : ''} style={{ color: cls === 'accent' ? 'var(--accent)' : undefined, fontVariantNumeric: 'tabular-nums' }}>{v.toLocaleString()}</b>
        </div>
      ))}
    </div>
  );
}

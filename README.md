# English Mastery

**Remember it. Understand it. Use it.**

An English-learning PWA for iPhone, built for about 10 minutes a day. It schedules reviews with FSRS, imports reminDO data, and tracks Reading (意味が分かる) and Speaking (日本語から英語を思い出す) separately.

## 実装状況

| 区分 | 内容 |
|---|---|
| ✅ 実装済み（Phase 1） | CSV/TSV/テキスト取り込み（文字コード自動判別：UTF-8 / Shift_JIS / UTF-16、列の割り当て、HTMLタグ除去、全角→半角、重複候補の検出、再取り込み時の重複防止、元データの保持）／ライブラリ（検索・絞り込み・編集・追加・除外・削除）／Recognition・Productionモード／FSRSによる復習管理（ts-fsrs）／学習時間の上限（5・10・15分）と優先順位付け／新規カードの自動抑制／復習の遅れの表示／回答の取り消し／学習履歴（端末内に自動保存）／JSONの完全バックアップ・復元／CSV書き出し／オフラインで使えるPWA／例文3件・発音ガイド（Level 1〜3、カタカナ、IPA）の表示と手動編集／学習分析 |
| ⚠️ サンプルのみ | 例文と発音ガイドが入ったサンプル4件（hammer out / flesh out / push back / align on）。AIが作成した内容で、未検証・**要確認**として表示します |
| ❌ Phase 2（未実装） | AIによる重要度分類、3例文の自動生成、Slurred Pronunciation・カタカナ・IPAの自動生成 |
| ❌ Phase 3（未実装） | 音声、Listening用のSRS、シャドーイング、AI会議シミュレーション、クラウド同期、複数ユーザー対応 |

データモデルにはPhase 2/3用のフィールド（`ai`、`examples[].pronunciation`、`listening`モード、`origin`/`status`）を用意してあります。

## 技術構成

- **React 19 + TypeScript + Vite 7**
- **FSRS:** [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) 5.x を使用。open-spaced-repetitionが公式に保守しているTypeScript実装です。スケジューリングの計算はすべてこのライブラリが行い、`src/srs/scheduler.ts` は保存形式の変換と設定の受け渡しだけを担当します。目標記憶率の初期値は90%（設定で変更可）。短期の学習ステップとfuzzは有効にしています。
- **保存:** IndexedDB（[Dexie](https://dexie.org) 4）。回答のたびに、カードの状態・復習ログ・セッションの進み具合を1つのトランザクションで書き込みます。途中でアプリを閉じても失われません。
- **PWA:** `vite-plugin-pwa`（Workbox）。アプリ本体をすべてプリキャッシュするため、2回目以降はオフラインで起動できます。ハッシュルーティングを使うので、GitHub Pagesのサブパスでもそのまま動きます。
- **外部への送信なし:** 学習データは端末から外に出ません。

### 1日の学習量の決め方（`src/srs/queue.ts`）

FSRSは各カードの**次の期限**を決めます。このモジュールは、期限が来たカードのうち**今日の時間に収まる分**を選びます。

1. 1回に解ける件数 = 学習時間 ÷ 1枚あたりの秒数（過去の回答時間の中央値。初期値15秒）
2. 期限が来たカードは次の優先度で並べます：学習ステップ中のカード → 重要度（55%）＋忘れている可能性 `1−R`（25%）＋遅れの大きさ（15%）＋Speakingを少し優先
3. 新しいカードは「1日の上限」と「残り時間」の小さい方まで。**期限が来た復習だけで時間がいっぱいの日は、新規を0件にします**
4. 入りきらなかった分は期限切れのまま残し、ホーム画面と「復習の状況」で件数を隠さず表示します。FSRSは実際に経過した日数で計算するので、遅れて復習しても正しく扱えます
5. Speakingカードは、Readingカードの安定度が設定値（初期値7日）を超えてから出題します

## データモデル（`src/db/types.ts`）

```
Expression   英語表現（整形済み）、意味、Speaking用の状況説明、メモ、カテゴリー/重要度（手動）、
             ai{category, importance}（AIの判定。手動の値とは別に保存）、examples[≤3]、
             source{importId, rowIndex, sourceKey}、suspended、usedInRealLife[]
Example      kind(business|daily|alternative)、en、ja、origin(imported|user|ai|sample)、
             status(unverified|needs_review|verified)、pronunciation?
Pronunciation level1/level2/level3 {text, katakana, ipa}、notes、minimalChange、origin、status
ReviewCard   id = `${expressionId}:${mode}`、mode(recognition|production|listening)、
             fsrs{due, stability, difficulty, reps, lapses, state, …}、introducedAt
ReviewLog    rating、reviewedAt、durationMs、mode、変更前/変更後のFSRS状態、想起確率、sessionId
StudySession 残りのキュー、回答済み、作業時間（セッションを再開できるようにするため）
RawImportRow 元のセルをそのまま保存（変更しない）
ImportBatch  ファイルのハッシュ、列の割り当て、統計
DuplicateGroup 正規化した表現が同じもの → 未対応 / 両方残す / 統合（統合しても削除はしない）
```

再取り込みしても増えない仕組み：各行に `sourceKey = hash(正規化した英語 + 意味)` を付けます。すでにあるキーの行は取り込みません。同じファイルを2回目に取り込むと、追加は0件になります。

## 開発

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # 単体テスト（取り込み、FSRS、セッション、取り消し、バックアップ）
npm run build     # dist/ に出力
npm run preview   # ビルドしたものを確認
```

## iPhoneでの使い方

### 1. 公開（GitHub Pages）
1. GitHubのリポジトリで **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main` にpushすると `.github/workflows/deploy.yml` がテスト・ビルド・デプロイを実行します
3. 公開URL：`https://<ユーザー名>.github.io/<リポジトリ名>/`

### 2. ホーム画面に追加
1. iPhoneの**Safari**で上のURLを開く
2. 共有ボタン → **「ホーム画面に追加」**
3. ホーム画面のアイコンから起動すると、アドレスバーのない全画面で開きます。一度開いておけばオフラインでも使えます

### 3. reminDOのデータを取り込む
1. reminDOからCSVまたはテキストを書き出し、「ファイル」アプリに保存する
2. Settings → 「CSV / テキストを取り込む」→ ファイルを選択
3. 英語の列・日本語訳の列・メモの列が正しいか確認する（自動で推定しますが、変更できます）
4. 「内容をチェック」で件数を確認 → 取り込む
5. 重複候補は Settings → 「重複候補を確認」で処理します

### 4. バックアップ（大事です）
SafariのWebサイトデータを削除したり、iOSがストレージを整理したりすると、データが消えることがあります。Settings → 「JSONバックアップを保存」を押すと共有シートが開くので、「ファイルに保存」でiCloud Driveに保存してください。最後のバックアップから7日以上経つと、ホーム画面にお知らせが出ます。

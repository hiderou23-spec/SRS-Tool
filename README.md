# English Mastery

**Remember it. Understand it. Use it.**

An English-learning PWA for iPhone, built for about 10 minutes a day. It schedules reviews with FSRS, imports reminDO data, and tracks Reading (意味が分かる) and Speaking (日本語から英語を思い出す) separately.

## 実装状況

| 区分 | 内容 |
|---|---|
| ✅ 実装済み（Phase 1） | CSV/TSV/テキスト取り込み（文字コード自動判別：UTF-8 / Shift_JIS / UTF-16、列の割り当て、HTMLタグ除去、全角→半角、重複候補の検出、再取り込み時の重複防止、元データの保持）／ライブラリ（検索・絞り込み・編集・追加・除外・削除）／Recognition・Productionモード／FSRSによる復習管理（ts-fsrs）／学習時間の上限（5・10・15分）と優先順位付け／新規カードの自動抑制／復習の遅れの表示／回答の取り消し／学習履歴（端末内に自動保存）／JSONの完全バックアップ・復元／CSV書き出し／オフラインで使えるPWA／例文3件・発音ガイド（Level 1〜3、カタカナ、IPA）の表示と手動編集／学習分析 |
| ⚠️ サンプルのみ | 例文と発音ガイドが入ったサンプル4件（hammer out / flesh out / push back / align on）。AIが作成した内容で、未検証・**要確認**として表示します |
| ✅ Phase 2 | AIデータファイルの読み込み／アプリ内AI生成（3例文・訳・発音ガイド・カタカナ・IPA）／AI生成コンテンツの確認画面／学習分析の強化 |
| ✅ 追加機能 | 語彙数カウンター（覚えた表現・定着・学習中）と将来予測（直近4週間のペースから30日／90日／1年後と全語到達の目安）／1分モード（ホームの「時間がない日は 1分だけ」。1分ぶんの短いキューで開始し、終了画面に覚えた表現の増減と予測を表示） |
| ✅ 毎日のAI提案 | ホームに「今日のAI提案」（1日5語）。ボタンを押した時だけAIに依頼し、1語ずつ「追加／もう知ってる／いらない」を選ぶ。追加した表現は通常の新規カード（AI・要確認、例文3つ＋発音ガイド）。復習が溜まっている日はお休み。選択結果は次回の提案に反映。ライブラリや過去の提案との重複は端末内で除外。送信するのは英語表現（ライブラリの一部と過去の提案）のみ。Settings でオフにできます |
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
6. 学習ステップ中のカード（新規や Again）は、FSRSが決めた時刻（例：10分後）に合わせて、その頃に回ってくる位置へ戻します。今のセッション中に時刻が来ない場合は、次のセッションに回します
7. 同じ表現は1日に1モードだけ出題します。Reading と Speaking の両方が期限の日は優先度の高い方を出し、もう片方は翌日に回します（学習ステップ中のカードは除く）

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

### reminDOの書き出し形式について
reminDOの書き出しは「問題,答え」を1行に1件書いた形式で、引用符を使いません（答えの中のカンマや `"` もそのまま書かれます）。取り込み時にこれを自動判定し、「1行＝1件」として読み込みます。2列目より右の部分は、まとめて訳として扱います。日本語だけの行（覚えたい日本語の語句・人名・植物名など）は「日本語の用語」として取り込み、Readingでのみ出題します（Speakingは出題しません）。reminDOアプリ自身の説明文の行だけは取り込みません（元の行は保存します）。

### AI分類ファイル（カテゴリー・重要度）
Settings → 「AI分類ファイルを読み込む」で、`english-mastery-ai-assessment` 形式のJSONを読み込めます。正規化した英語表現が一致するものに、`expression.ai` として反映します。ファイルに `examples`（最大3件）が含まれていれば、例文がまだない表現にだけ「AI生成・未検証」として追加します（再読み込みしても重複しません）。例文に `pronunciation` があれば発音ガイドとして付けます（「AI生成・要確認」）。既存の例文と英文が完全に一致する場合は、発音ガイドがまだない例文にだけ追加します。`meaning`（AI訳）が含まれていれば、意味が空欄の表現に「AI訳・未検証」として表示します。編集画面の「この訳を採用」を押すと、あなた自身の訳として保存されます。手動で設定した値や元データは変更しません。重要度が高い表現から順に、新しい表現として出題されます。

### アプリ内でのAI生成（Phase 2）
Settings →「AI 生成」で、自分の Anthropic API キーを登録すると、アプリの中で例文・日本語訳・発音ガイドを生成できます。

- **生成の単位:** 表現ごと（編集画面の「AIで3例文＋発音ガイドを生成」「AIで発音ガイドを生成」）と、まとめて（重要度の高い順に5〜300件）の2通りです。まとめて生成するときは、開始前に概算の費用を表示し、途中で止めることもできます。
- **送信する内容:** ボタンを押したときだけ、英語表現・意味・メモ・例文を Anthropic API に送ります。学習履歴は送りません。
- **API キーの保存場所:** この端末のブラウザ（localStorage）にだけ保存します。JSON バックアップには含めません。
- **モデル:** Claude Opus 5.5（初期値）、Sonnet 5.5、Haiku 5.5 から選べます。Opus 5.5 が安全上の理由で応答を断った場合に別のモデルで再試行する server-side fallback（`fallbacks: "default"`）を有効にしています。
- **生成物の扱い:** すべて「AI生成・未検証／要確認」として保存し、自分で入力した例文や訳を上書きすることはありません。
- **確認画面:** Settings →「AI生成コンテンツの確認」で、例文・発音ガイド・AI訳を重要度の高い順に確認し、問題なければ「OK」を押して確認済みにできます。

### 重複候補の一括統合
Settings → 重複候補 →「すべて一括で統合」で、重複候補をまとめて1つにできます。残す1件は「学習済み → 訳あり → 新しく登録した方」の順に選びます。意味・メモ・例文は残す1件にまとめ、それ以外は削除せずに「除外中」として保持します（学習履歴と元データもそのまま残ります）。

### 4. バックアップ（大事です）
SafariのWebサイトデータを削除したり、iOSがストレージを整理したりすると、データが消えることがあります。Settings → 「JSONバックアップを保存」を押すと共有シートが開くので、「ファイルに保存」でiCloud Driveに保存してください。最後のバックアップから7日以上経つと、ホーム画面にお知らせが出ます。

# LeakScan — リークスキャン

2026年に日本で公表された**個人情報漏洩事案のオープンデータセット**と、それを
**Gmailの差出人だけ**と照合して「自分が使っているどのサービスが漏れたか」を特定する
Chrome拡張機能です。

- **サイト**: https://leakscan.matsunai.com
- **データ**: [`data/breaches.json`](data/breaches.json)（CC BY 4.0・そのまま使えます）
- **拡張機能**: Gmail API も OAuth も AI API も使いません。すべてブラウザ内で完結します。

> [!IMPORTANT]
> **このプロジェクトのコードは 100% AI が書いています。**
>
> 拡張機能・サイト・データ整形スクリプト・このREADMEを含め、すべてAIが生成したものです。
> 人間による詳細なコードレビューは経ていません。
> **動作・内容・安全性について、いかなる保証もしません。** 利用はご自身の判断でお願いします。
>
> その代わり隠しているものは何もありません。コードは **MITライセンス**（無保証条項を含みます）、
> データは **CC BY 4.0** で全文公開しています。読んで、疑って、検証して、好きに改変して使ってください。
> セキュリティに関わるツールである以上、**信じる前に `extension/` の中身を読むことを勧めます**。
> JavaScriptは全部で約1,200行、依存パッケージはゼロです。

```
data/                      ← 正本。ここだけ編集する
  breaches.json              事案データ
  meta.json                  ラベル定義・免責
  sources.json               日次監視する情報源
  domain-denylist.json       人が確認して除外した照合ドメインと、その理由
  breaches.csv               ⚙ 生成物
  domains.tsv                ⚙ 生成物（ドメイン→事案の対応表）
  stats.json                 ⚙ 生成物
schema/breaches.schema.json
scripts/
  lib/source-feed.mjs        情報源の構造化データ → 本データベースへの変換
  lib/shared-domains.mjs     「その組織だけのものでないドメイン」の判定
  lib/sector.mjs             業種の推定
  collect.mjs                未収録の事案を報告（書き込みなし）
  autoadd.mjs                未収録の事案を追記
  refresh-auto.mjs           追記済みの事案を情報源と同期（件数・状態の続報を反映）
  resolve-domains.mjs        公式発表のURLから照合ドメインを補完
  validate.mjs               構造と安全性の検証
  build.mjs                  生成物の作成と site/・extension/ への同期
  watch-sources.mjs          情報源の更新検出
  check-sources.mjs          出典リンクの生存確認
site/                      ← 静的サイト（Cloudflare Workers Static Assets）
extension/                 ← Chrome拡張機能（Manifest V3）
test/
  match.test.js              照合ロジックと誤検知
  domains.test.mjs           照合ドメインの安全弁
  feed.test.mjs              情報源データの変換
```

## データをそのまま使う

認証なしで取得できます（CORS許可済み）。

```bash
curl https://leakscan.matsunai.com/data/breaches.json   # 全事案
curl https://leakscan.matsunai.com/data/breaches.csv    # 表計算ソフト向け
curl https://leakscan.matsunai.com/data/domains.tsv     # ドメイン→事案
curl https://leakscan.matsunai.com/data/stats.json      # 集計
```

```python
import urllib.request, json
d = json.load(urllib.request.urlopen("https://leakscan.matsunai.com/data/breaches.json"))
mine = {"muji.com", "lawson.co.jp"}
for e in d:
    if mine & set(e["match"]["domains"]):
        print(e["disclosed"], e["service"], e["records"], e["categories"])
```

### データ形式

```json
{
  "id": "company-service-2026-10",
  "company": "会社名",
  "service": "サービス名",
  "sector": "小売",
  "match": { "domains": ["example.co.jp"], "names": ["サービス名"] },
  "disclosed": "2026-10-08",
  "records": "最大約100万件",
  "records_num": 1000000,
  "categories": ["name", "email", "card"],
  "status": "possible",
  "scope": "補足（任意）",
  "cause": "unauthorized_access",
  "ai_link": "unconfirmed",
  "sources": [{ "title": "出典名", "url": "https://..." }]
}
```

`categories` / `status` / `cause` / `ai_link` に使える値は [`data/meta.json`](data/meta.json)、
各項目の制約は [`schema/breaches.schema.json`](schema/breaches.schema.json) にあります。

| フィールド | 意味 |
|---|---|
| `status` | `confirmed` 漏洩を確認 / `possible` 漏洩の可能性 / `investigating` 調査中 |
| `ai_link` | `confirmed` AI使用が公式確認 / `suspected` 指摘あり（未確認）/ `unconfirmed` 未確認 / `supply_chain` AI関連ソフトのサプライチェーン侵害 |
| `match` | 拡張機能がGmailの差出人と照合するパターン。誤検知を避ける制約あり（[CONTRIBUTING](CONTRIBUTING.md)） |

## 日次更新

GitHub Actions が毎朝8時（JST）に実行されます。

1. **情報源の更新検出** — [`data/sources.json`](data/sources.json) の各情報源を取得し、
   内容のフィンガープリントが前日と変わっていれば検出する
2. **出典リンクの生存確認** — 全出典URLを叩く（リンク切れは信頼性の毀損なので潰す）
3. **未収録の事案を収集** — 情報源が公開している構造化データ（`incidents.json`）を読み、
   個人情報を含む事案のうち未収録のものを洗い出す
4. **追記** — 1回あたり最大60件、45日以内に公表されたものを追記する
5. **既存の自動追記分を同期** — 件数の確定・状態の変化といった続報を反映する
6. **照合ドメインの補完** — 事案ページから**公式発表のURL**を辿り、そのホスト名から
   照合用ドメインを取る（1回あたり最大40件）
7. **検証・生成物の更新・テスト** → 通ればコミット → サイトへ反映
8. 検証に落ちた場合はその回の追記を**丸ごと破棄**し、`triage` ラベルの Issue を作る

### 自動追記で守っていること

企業名を漏洩元として公開する以上、誤報は実害になります。機械に判断させない範囲を決めています。

| 守っていること | やり方 |
|---|---|
| 漏洩項目・原因・状態を推測しない | 情報源が公開している**列挙値**だけを対応表で変換する。文章からの正規表現推測はしない |
| 確度を強く書かない | 「漏洩を確認」と書くのは**確定件数が公表されている場合だけ**。最大値しかなければ「可能性」、件数未公表なら「調査中」 |
| パスワードを平文と断定しない | 情報源は平文とハッシュを区別しないので「ログイン認証情報」に寄せる |
| 情報源の文章を転載しない | 説明文は構造化された項目から組み立てる |
| 照合ドメインを推測しない | **公式発表が置かれているURLのホスト名**しか使わない。取れなければ空のまま（＝拡張機能では検出されない） |
| 無関係な組織を巻き込まない | グループ会社・親会社・プレスリリース配信サイト・CDN・業界共用ドメイン（信用金庫の共用ドメイン等）・省庁ドメインを除外する。除外した判断と理由は [`data/domain-denylist.json`](data/domain-denylist.json) に残す |
| 同じ事案を二重に登録しない | 事案IDに加え、企業名・サービス名の表記ゆれ（連名・括弧内・「〜ホールディングス」）を正規化して照合する |
| AIの関与を断定しない | 自動追記分は一律 `unconfirmed` |

自動追記した事案は `"auto": true` が付きます。人が公式発表を読んで精査した事案と
区別できるようにしてあるので、精度を気にする用途では絞り込んでください。

## 全体のしくみ

```
  ┌─ 情報源（第三者が公開している事案データベース）
  │     incidents.json … 事案ごとの区分値（漏洩項目・原因・件数・公表日）
  │
  ▼  毎朝8時 / GitHub Actions（publicリポジトリなので無料）
  ┌──────────────────────────────────────────────┐
  │ collect → autoadd → refresh-auto → resolve-domains │
  │   未収録を洗い出し / 追記 / 続報を反映 / 公式発表URLから照合ドメイン │
  │                    ↓                          │
  │ validate → build → test                       │
  │   危険なドメインを弾く / CSV・TSV・統計を生成 / 誤検知テスト │
  │   ここで落ちたら、その回の追記は丸ごと破棄される     │
  └──────────────────────────────────────────────┘
  │
  ├─→ GitHub（data/breaches.json が正本。誰でも取得・検証できる）
  │
  └─→ Cloudflare Workers 静的アセット
        leakscan.matsunai.com に JSON・CSV・TSV と HTML を置くだけ
        （サーバ側で動くコードは無い）
  │
  ▼
  Chrome拡張機能（利用者のブラウザの中だけで動く）
    1. 上記の JSON を取得（12時間キャッシュ・取れなければ同梱コピー）
    2. Gmailの「検索」に from:(...) を入れて差出人を引く
    3. 一致した差出人の「ドメインと表示名」だけを読む
       本文・件名・添付は読まない。どこにも送信しない
```

**お金がかかる場所がどこにも無い**のがこの構成の要点です。

- サーバで動くコードが無い（静的ファイルだけ）→ 実行時間の課金が発生しない
- AIも有料APIも呼ばない → 従量課金が発生しない
- Gmail APIを使わない → Google Cloud の課金対象にならない
- 計算は全部、利用者のブラウザの中で終わる → こちらの負荷にならない

## 運用コスト

**月額 0円で動きます。** 有料APIもAI APIも使わず、課金対象の機能を一つも有効にしていません。

| 項目 | 料金 | 根拠 |
|---|---|---|
| サイト配信（Cloudflare Workers 静的アセット） | **0円** | [静的アセットへのリクエストは無料・無制限](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)（無料・有料プラン共通） |
| アセットの保存 | **0円** | 保存容量への課金なし |
| 独自ドメイン・SSL証明書 | **0円** | Cloudflareの標準機能 |
| GitHub Actions（CI・日次更新） | **0円** | publicリポジトリは実行時間無料 |
| Gmailの読み取り | **0円** | Gmail APIを使わず、利用者のブラウザ上の画面を読むだけ |
| 漏洩データの配信 | **0円** | 静的JSONを置いているだけ |

`wrangler.jsonc` に `main` を置いていないため **Workerスクリプトが存在せず**、
全リクエストが「静的アセットへのリクエスト」として処理されます（存在しないパスは
Workerではなく404が返ります）。利用者が何人増えても、リクエスト課金は発生しません。

### 課金を発生させる変更（入れないこと）

| 変更 | 何が起きるか |
|---|---|
| `main` でWorkerスクリプトを追加 | アセットに一致しないリクエストが[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)で課金対象に |
| `assets.run_worker_first` | **全**リクエストがWorker呼び出しになり課金対象に。無料枠超過時は429 |
| [Workers Cache](https://developers.cloudflare.com/workers/cache/) の有効化 | **本来無料の静的アセットへのリクエストまで**通常レートで課金される |
| `observability` | Workers Logs は別枠の従量課金 |
| リポジトリをprivateに変更 | GitHub Actions の実行時間が無料枠の消費対象に |

無料プランの上限にも余裕があります（静的アセット **15ファイル** / 上限20,000、
最大ファイル **704KB**（`breaches.json`）/ 上限25MiB）。
`breaches.json` は Cloudflare が Brotli で圧縮して配信するため、実際の転送量は **約65KB** です。

### 日次ジョブが使う通信

無料枠の中で収まる量しか動きません。

| 処理 | 1日あたりのリクエスト |
|---|---|
| 情報源の構造化データ取得（`incidents.json`） | 1回（約590KB） |
| 情報源の更新検出 | `data/sources.json` の件数ぶん |
| 出典リンクの生存確認 | 収録件数ぶん（HEAD） |
| 照合ドメインの補完 | 最大40回（0.7秒間隔） |
| Cloudflareへの配信 | 変更があった日に1回 |

## AIについて

この漏洩ラッシュは「AIによる攻撃」と紹介されることが多いですが、
**国内の事案でAIの使用が公式に確認されたものは現時点でありません。**
侵入経路は認証情報の悪用・委託先/SaaSの侵害・API悪用・既知脆弱性の未修正が中心です。
確認されているのは AI関連ライブラリ LiteLLM v1.107.0 のサプライチェーン侵害、
海外では Microsoft による攻撃グループの ARTEX 使用の分析などです。
データセットは事案ごとに `ai_link` でこの区別を保持します。

## 拡張機能の仕組み

Gmail API の `gmail.readonly` は制限付きスコープで、一般公開には Google の審査が必要です。
LeakScan はこれを避け、**ログイン済みのGmailの画面をそのまま**使います。

1. Gmailのタブを開き、`location.hash` を `#search/from:(...)` に書き換えて Gmail自身の検索を実行
2. 検索結果一覧の `<span email="..." name="...">` だけを読む
3. ブラウザ内でデータセットと照合し、漏洩項目からルールベースで対応リストを生成

**件名・本文・添付は一切参照しません。** 通信は `breaches.json` の取得のみで、
そのリクエストに利用者の情報は含まれません。

### 検索回数を抑える

574事案を1件ずつ検索すると574回の遷移が要ります。複数サービスを1つの
`from:(A OR B OR ...)` にまとめ、0件ならまとめて「なし」と確定します。
**件数ではなくクエリの文字数で詰める**ので、収録件数が増えても照会回数は
比例して増えません（574件 → **37回**、1クエリ最長894文字）。
ヒットがあって1ページに収まらない場合だけ、未ヒット分を二分割して再検索します。
多くの利用者は大半のサービスを使っていないため、再検索はほとんど起きません。

### 古い結果を読まない

Gmailはクエリを変えても前の結果が一瞬残ります。各クエリの前に必ずヒットしない
ダミー語で一度リストを空にし、さらに「検索ボックスの値が新しいクエリになっていること」を
確認してから結果を読みます。

### 誤検知を抑える

- ドメイン一致は3段階。`domain`（完全一致・サブドメイン）→ `related`（同一ブランドの別ドメイン／配信用ドメイン）→ `name`（表示名のみ）
- `related` は登録可能部分のラベルで判定する。`lawson.co.jp` に対し `lawson.jp` や `lawsonmail.jp` は拾うが、
  ラベルが5文字未満、一般語（life, point, mail 等）、数字のみの場合は使わない
- **自治体・政府系のドメインはブランド部分に広げない。** `pref.yamanashi.jp` と
  `city.yamanashi.yamanashi.jp` は別組織だが、ブランド部分はどちらも `yamanashi` に
  なってしまうため、完全一致とサブドメインだけで判定する
- `example.com.evil.com` のような接尾辞偽装は不一致
- 表示名一致は日本語2文字以上・英字のみ4文字以上（`au` が `Paul` に当たる事故を防ぐ）
- 表示名だけの一致は結果画面に「表示名一致」と明示（なりすましの可能性）
- 既定では迷惑メール・ゴミ箱を対象にしない（フィッシングを「利用中」と誤判定しないため）

## うまく動かないときは

拡張機能の設定画面に **セルフテスト** があります。Gmailのタブを一瞬だけ開き、
検索ボックスの検出・リセット・0件判定・一覧行の読み取り・差出人の読み取り・
ページ送りの検出を個別に判定します（差出人やメールの中身は記録しません）。
GmailのDOMが変わった場合、どこが壊れたかが分かります。

## Chrome ウェブストアへの申請

申請に必要な全項目（説明文・権限の正当化・データ使用申告・スクリーンショット4点）を
[`store/`](store/) に用意しています。デベロッパー登録料の支払いとGoogleアカウントでの
ログインのみ、人間の操作が必要です。

## サイトへの自動反映に必要な設定

日次ジョブは事案の追記・検証・コミットまでを毎朝実行しますが、
**Cloudflareへの配信は `CLOUDFLARE_API_TOKEN` が設定されているときだけ**走ります。
未設定の場合、データはGitHubに入りますがサイトには出ません（ジョブは警告を出して成功します）。

設定する場合は、Cloudflareダッシュボードで `Edit Cloudflare Workers` テンプレートの
APIトークンを作り、リポジトリの Settings → Secrets → Actions に
`CLOUDFLARE_API_TOKEN` として登録します（`CLOUDFLARE_ACCOUNT_ID` は設定済み）。
設定しない場合は `npx wrangler deploy` を手元で実行すれば反映されます。

## 開発

```bash
node scripts/validate.mjs        # データセットの検証
node scripts/build.mjs           # 生成物の作成と同期
node test/match.test.js          # 照合と誤検知
node test/domains.test.mjs       # 照合ドメインの安全弁
node test/feed.test.mjs          # 情報源データの変換
node scripts/audit-domains.mjs   # 共用プラットフォームが照合に混じっていないか監査
node scripts/package.mjs         # ストア提出用 zip を作って点検（dist/ に出力）
node scripts/make-preview.mjs    # サイトの単体プレビュー（store/preview.html）
sh   promo/build.sh              # プロモ動画を作り直す（数字は stats.json から）
npx wrangler@4 deploy            # サイトのデプロイ
python3 -m http.server 8731 -d site   # ローカルプレビュー
```

拡張機能のUIをChrome外で確認する場合は、リポジトリのルートを配信して
`/test/results-preview.html`、`/test/popup-preview.html`、`/test/options-preview.html` を開きます。

拡張機能の読み込み: `chrome://extensions` → デベロッパーモード →
「パッケージ化されていない拡張機能を読み込む」→ `extension/`

## 既知の制約

- Gmailの標準UI（`mail.google.com`）専用です。
- GmailのDOM構造が変わると読み取りに失敗します。失敗時は結果を偽らず、その旨を表示します。
- 別のメールアドレスで登録したサービスや、メールを受け取っていないサービスは検出できません。
  **「該当なし」は安全の証明ではありません。**
- 一致は「そのサービスを使っていた可能性が高い」ことを示すだけで、利用者個人のデータが
  流出対象に含まれていたかは示しません。確定情報は各社の公式発表で確認してください。

## ライセンス・免責

- コード: [MIT](LICENSE)
- データ（`data/`）: [CC BY 4.0](data/LICENSE)

MITライセンスの無保証条項がそのまま適用されます。

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

**コードは100%AIが生成したものであり、人間によるレビューを経ていません。**
動作保証はなく、利用により生じたいかなる損害についても責任を負いません。
データセットについても、正確性・完全性の保証はありません（各社の公式発表をご確認ください）。

訂正・追加は [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。掲載企業からの訂正依頼も歓迎します。

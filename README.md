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
data/                    ← 正本。ここだけ編集する
  breaches.json            事案データ
  meta.json                ラベル定義・免責
  sources.json             日次監視する情報源
  breaches.csv             ⚙ 生成物
  domains.tsv              ⚙ 生成物（ドメイン→事案の対応表）
  stats.json               ⚙ 生成物
schema/breaches.schema.json
scripts/
  validate.mjs             構造と安全性の検証
  build.mjs                生成物の作成と site/・extension/ への同期
  watch-sources.mjs        情報源の更新検出
  check-sources.mjs        出典リンクの生存確認
site/                    ← 静的サイト（Cloudflare Workers Static Assets）
extension/               ← Chrome拡張機能（Manifest V3）
test/match.test.js       ← 照合ロジックと誤検知のテスト
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

1. [`data/sources.json`](data/sources.json) の情報源（個人情報保護委員会ほか）を取得し、
   内容のフィンガープリントが前日と変わっていれば検出
2. データセット内の全出典URLの生存確認（リンク切れ＝信頼性の毀損）
3. 検証と生成物の更新をコミット
4. 人の確認が必要な変化があれば `triage` ラベルの Issue を作成・更新

**事案の自動追加はしません。** 公式発表を人が読まずに企業名を漏洩元として公開するのは、
誤報と名誉毀損の直接の原因になるためです。日次ジョブは「ここを見ろ」と言うまでが仕事です。

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

無料プランの上限にも余裕があります（静的アセット **14ファイル** / 上限20,000、
最大ファイル **71KB** / 上限25MiB）。

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

79事案を1件ずつ検索すると79回の遷移が要ります。8サービスを1クエリにまとめ、
0件ならまとめて「なし」と確定、ヒットがあり1ページに収まらない場合だけ未ヒット分を
二分割して再検索します。多くの利用者は大半のサービスを使っていないため、実際は
**10〜20回程度**で終わります。

### 古い結果を読まない

Gmailはクエリを変えても前の結果が一瞬残ります。各クエリの前に必ずヒットしない
ダミー語で一度リストを空にし、さらに「検索ボックスの値が新しいクエリになっていること」を
確認してから結果を読みます。

### 誤検知を抑える

- ドメイン一致は `example.com` と `*.example.com` のみ（`example.com.evil.com` は不一致）
- 表示名一致は日本語2文字以上・英字のみ4文字以上（`au` が `Paul` に当たる事故を防ぐ）
- 表示名だけの一致は結果画面に「表示名一致」と明示（なりすましの可能性）
- 既定では迷惑メール・ゴミ箱を対象にしない（フィッシングを「利用中」と誤判定しないため）

## うまく動かないときは

拡張機能の設定画面に **セルフテスト** があります。Gmailのタブを一瞬だけ開き、
検索ボックスの検出・リセット・0件判定・一覧行の読み取り・差出人の読み取り・
ページ送りの検出を個別に判定します（差出人やメールの中身は記録しません）。
GmailのDOMが変わった場合、どこが壊れたかが分かります。

## 開発

```bash
node scripts/validate.mjs        # データセットの検証
node scripts/build.mjs           # 生成物の作成と同期
node test/match.test.js          # 照合と誤検知のテスト（38項目）
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

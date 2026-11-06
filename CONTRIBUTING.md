# コントリビュート

このデータセットは**実在する企業を名指し**します。誤りは企業の名誉を損ない、
利用者には誤った安心・不安を与えます。精度を最優先でお願いします。

## 原則

1. **出典のない事案は載せない。** 公式発表を最優先し、最低1件のURLを付ける。
2. **確証のないことを断定しない。** 「漏洩の可能性」は `status: possible`、
   調査中は `investigating`。AI関与は、公式に確認されていなければ `ai_link: unconfirmed`。
3. **訂正は最優先で取り込む。** 掲載企業からの指摘を含め、公式発表と食い違う記載は速やかに直す。
4. **機械に判断させる範囲を決めておく。** 日次ジョブは事案を自動追記しますが、
   情報源が公開している**列挙値**だけを対応表で変換し、文章からの推測はしません。
   照合用ドメインは**公式発表が置かれているURLのホスト名**しか使わず、取れなければ空のままにします。
   自動追記分には `"auto": true` が付きます。詳細は [README](README.md#自動追記で守っていること)。

## 事案を追加する

```bash
$EDITOR data/breaches.json     # 1件追記
node scripts/validate.mjs      # 構造と安全性の検証
node scripts/build.mjs         # CSV/TSV/統計の再生成と同期
node test/match.test.js        # 照合ロジックと誤検知
node test/domains.test.mjs     # 照合ドメインの安全弁
node test/feed.test.mjs        # 情報源データの変換
```

1件の形式は [README](README.md#データ形式) と [schema/breaches.schema.json](schema/breaches.schema.json) を参照。

## 照合パターン（`match`）の付け方

拡張機能はここだけを使って「利用者がそのサービスを使っているか」を判定します。
**誤検知は実害**（使ってもいないサービスの漏洩を警告する）なので慎重に。

- `domains`: そのサービスが**実際にメールを送信するドメイン**のみ。
  `example.com` は `example.com` と `*.example.com` に一致します。
  フリーメール（`gmail.com` 等）や巨大プラットフォームの共用ドメインは
  `validate.mjs` が拒否します。確信が持てないドメインは**書かない**でください
  （書かなければ検出漏れで済みますが、誤れば誤検知になります）。
- `names`: 差出人の表示名に含まれる文字列。日本語を含むものは2文字以上、
  英字のみのものは4文字以上。`au` のような短い英字は `Paul` に一致してしまうため拒否されます。
- 1つのドメインを複数の事案に重複して登録することはできません。
- **その組織だけのものではないドメインは使えません。** 業界共用ドメイン（信用金庫の
  `shinkin.co.jp` など）、都道府県の地域型ドメイン（`kanagawa.jp` は県内の全市町村を含む）、
  配信基盤・CDN、プレスリリース配信サイトは `validate.mjs` が拒否します。
  自治体は `pref.kanagawa.jp` / `city.kawasaki.jp` のように**ホスト名まるごと**で書いてください。
- グループ会社・親会社のドメインを子会社の事案に使わないでください。公式発表が親会社の
  サイトに置かれていることはよくありますが、親会社からのメールを受け取っている人まで
  「あなたのサービスが漏洩した」と表示してしまいます。人が確認して除外したものは
  [`data/domain-denylist.json`](data/domain-denylist.json) に理由付きで残してあります。

## 検証されること

`node scripts/validate.mjs` は次を機械的に拒否します。

- id の重複・書式違反、未来の公表日
- 未知の `status` / `cause` / `ai_link` / `categories`
- 出典ゼロ、不正なURL
- フリーメール・共用ドメインの登録、ドメインの重複
- 業界共用・地域型・配信基盤のドメイン、除外リストに載っているドメイン
- 短すぎる表示名パターン
- 根拠の書かれていない `ai_link: confirmed`

テストは3つあります。

```bash
node test/match.test.js      # 照合ロジック。無関係な差出人（Gmail・GitHub 等）が一致しないこと
node test/domains.test.mjs   # 照合ドメインの安全弁。本番データに危険なドメインが残っていないこと
node test/feed.test.mjs      # 情報源データの変換。確度を強く書きすぎないこと、二重登録しないこと
```

## 掲載企業の方へ

訂正・削除のご依頼は [Issue](../../issues/new/choose) か Pull Request でお願いします。
公式発表と食い違う記載、すでに訂正済みの内容、対象範囲の誤りは、確認でき次第直します。
本データセットは注意喚起を目的としたもので、掲載企業を非難する意図はありません。

## sources.lock.json について

`data/sources.lock.json` は日次ジョブが所有する状態ファイルです。ローカルで
`watch-sources.mjs` を実行すると衝突することがあります。その場合は origin 側
（botのコミット）を採用してください。

```bash
git checkout --ours data/sources.lock.json && git add data/sources.lock.json
```

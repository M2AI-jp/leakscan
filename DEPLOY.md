# デプロイ手順

## 現在の状態（2026-11-06）

| 項目 | 状態 |
|---|---|
| 本番URL | **https://leakscan.matsunai.com** （稼働中・証明書発行済み） |
| 配信方式 | Cloudflare **Workers Static Assets**（Worker名 `leakscan`） |
| 独自ドメイン | `wrangler deploy` が custom domain とDNSレコードを自動作成 |
| `/data/*` のCORS | `access-control-allow-origin: *` 確認済み（`_headers` が有効） |

## 1. サイト

`site/` は完全な静的サイトです。ビルド不要、依存ゼロ。

```bash
npx wrangler@4 deploy
```

これだけです。[wrangler.jsonc](wrangler.jsonc) に設定が入っています:

```jsonc
{
  "name": "leakscan",
  "compatibility_date": "2026-11-04",
  "assets": { "directory": "./site" },
  "routes": [{ "pattern": "leakscan.matsunai.com", "custom_domain": true }]
}
```

### なぜ Pages ではなく Workers なのか

`routes` に `custom_domain: true` を書くと、**wrangler が Workers API 経由で独自ドメインとDNSレコードを
自動作成します**。必要な権限は `workers_routes:write` で、これは wrangler の OAuth トークンに含まれています。

一方 Cloudflare Pages の場合、プロジェクトへのドメイン登録はできてもCNAMEは自分で作る必要があり、
それには `zone:edit` 権限のAPIトークンが別途必要になります（wranglerのトークンには含まれません）。
**同じことをするのに追加の認証情報が要らない**ので、Workersを採用しています。

`_headers` / `_redirects` は Workers Static Assets でもそのまま有効です。

### 確認

```bash
sh check-domain.sh
```

> macOSのDNSキャッシュが古い否定応答を保持していると、`dig` では引けるのに `curl` が
> `Could not resolve host` を返すことがあります。その場合は `dig +short leakscan.matsunai.com` で
> 出たIPを使って `curl --resolve leakscan.matsunai.com:443:<IP> https://leakscan.matsunai.com/` で確認してください。

### 旧 Pages プロジェクトについて

移行前に作った Pages プロジェクト `leakscan`（`leakscan.matsunai.com`）が残っています。
現在は使っていないので、削除して構いません:

```bash
npx wrangler@4 pages project delete leakscan
```

### Netlify / Vercel / S3+CloudFront の場合

- 公開ディレクトリ: `site`
- ビルドコマンド: なし
- **`/data/*` に `Access-Control-Allow-Origin: *` を必ず付けること**（拡張機能が取得できなくなります）。
  Netlify は `_headers` をそのまま解釈します。Vercel は `vercel.json` の `headers`、
  CloudFront はレスポンスヘッダーポリシーで同等の設定が必要です。

### 確認

```bash
curl -I https://leakscan.matsunai.com/data/breaches.json | grep -i access-control-allow-origin
```

`access-control-allow-origin: *` が返れば拡張機能から取得できます。

## 2. 拡張機能

### 開発者モードで読み込む（今すぐ使う）

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択
4. Gmailにログインした状態で、ツールバーのLeakScanアイコン → 「スキャン開始」

### 配布用zipを作る

```bash
cd extension && zip -r ../leakscan-extension.zip . -x '.*' -x '__MACOSX/*' && cd ..
```

### Chrome ウェブストアに出す場合

ストア申請時に必要になる説明は以下の通りです。審査では権限の正当化を必ず聞かれます。

| 項目 | 内容 |
|---|---|
| `storage` | 漏洩データベースのキャッシュ、設定、スキャン結果の保存。すべてローカル。 |
| `mail.google.com` のホスト権限 | Gmailの検索結果一覧から差出人のアドレスと表示名のみを読み取るため。本文は読み取らない。 |
| `leakscan.matsunai.com` のホスト権限 | 漏洩データベース（静的JSON）の取得のため。利用者の情報は送信しない。 |
| リモートコード | 使用しない（JSONデータのみ取得、コードは取得・実行しない）。 |
| データの取り扱い | 収集・送信ゼロ。プライバシーポリシーのURLとして `https://leakscan.matsunai.com/#privacy` を指定。 |

> 注意: Gmailの画面を操作する拡張機能は審査が慎重になります。「Gmail APIを使わずに、
> 利用者自身のブラウザ内で表示済みの差出人だけを読む」点と、本文を読まない点を明記してください。

## 3. データの更新運用

```bash
# 1. 事案を追記
$EDITOR site/data/breaches.json

# 2. 検証（整合性 + 誤検知テスト）
node test/match.test.js

# 3. 拡張機能の同梱フォールバックも更新
cp site/data/breaches.json site/data/meta.json extension/data/

# 4. サイトだけ再デプロイ（拡張機能の再配布は不要）
npx wrangler@4 deploy
```

拡張機能は12時間ごとにサイトからデータベースを取得し直します。利用者は何もしなくて構いません。
取得に失敗した場合は同梱コピーで動作します。

## 4. 公開前のチェックリスト

- [ ] `node test/match.test.js` が全項目パスする
- [ ] `/data/breaches.json` にCORSヘッダーが付いている
- [ ] 掲載事案の出典リンクが生きている（リンク切れは信頼性に直結します）
- [ ] 件数や漏洩項目が各社の最新の続報と食い違っていないか
- [ ] 訂正の連絡先を用意する（誤りの指摘を受けられない状態で公開しない）

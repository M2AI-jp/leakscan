#!/usr/bin/env node
/* ストアの掲載画像（1280×800、4枚）を作る。
 *
 *   node scripts/shots.mjs
 *
 * 手で撮っていると、商品名を変えた日に古い名前の画像だけが残る。
 * 実際そうなった（画面は「LeakScan」のまま、掲載名は別）。
 * 画面そのものから撮るので、UIを直せば画像もついてくる。
 *
 * 見本のページは /extension/... のような絶対パスでCSSを読むため、
 * リポジトリの根をそのまま配る小さなサーバを一時的に立てる。
 * Chromium は おことづけの広告工場のものを借りる（あちらには書き込まない）。 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store/screenshots');
const PORT = 8742;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values'
};

const server = createServer((req, res) => {
  /* 根の外は出さない。手元で数十秒動くだけだが、決まりは決まり。 */
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const SHOTS = [
  { out: '1-results.png', url: '/test/results-preview.html', note: 'スキャン結果' },
  { out: '2-popup.png', url: '/store/shots/popup-frame.html', note: 'ポップアップと主な特徴' },
  { out: '3-selftest.png', url: '/test/options-preview.html', note: '設定・セルフテスト' },
  { out: '4-site.png', url: '/store/preview.html', note: '公式サイト' }
];

const require = createRequire('/Users/amano/dev/okotozuke-ads/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
/* 4枚とも暗い画面で揃える。ヘッドレスの既定は明るい画面なので、
   指定しないと1枚だけ白くなって並びが崩れる。 */
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'dark'
});
mkdirSync(OUT, { recursive: true });

for (const s of SHOTS) {
  await page.goto(`http://127.0.0.1:${PORT}${s.url}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  /* 件数のカウントアップが終わるまで待つ。途中で撮ると嘘の数字が残る。 */
  await page.waitForTimeout(1600);
  await page.screenshot({ path: join(OUT, s.out) });
  console.log(`生成: store/screenshots/${s.out}（${s.note}）`);
}

await browser.close();
server.close();
console.log('4枚とも 1280x800');

#!/usr/bin/env node
/* サイトの単体プレビュー（store/preview.html）を作る。
 *
 * 1枚のHTMLに CSS・JS・データを全部埋め込む。アーティファクトとして
 * 共有したときに、外部ファイルの取得なしでそのまま見られるようにするため。
 * 本番サイトの site/index.html から毎回作り直すので、内容がずれない。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, p), 'utf8');

const entries = JSON.parse(r('site/data/breaches.json'));
const meta = JSON.parse(r('site/data/meta.json'));

/* 一覧ページは別なので、トップに要るぶんだけ残して軽くする */
const slim = entries.map((e) => ({
  id: e.id, company: e.company, service: e.service, sector: e.sector,
  disclosed: e.disclosed, records: e.records, records_num: e.records_num,
  categories: e.categories, status: e.status, cause: e.cause, official: e.official
}));

let html = r('site/index.html');

html = html.replace('<link rel="stylesheet" href="assets/style.css">', `<style>\n${r('site/assets/style.css')}\n</style>`);
html = html.replace('<link rel="icon" href="assets/logo.svg" type="image/svg+xml">', '');
html = html.replace('<script src="assets/app.js"></script>',
  `<script>\n${r('site/assets/app.js')}\n</script>\n<script>\n` +
  `/* プレビュー用: データを埋め込み、取得せずに描画する */\n` +
  `window.LeakScan.load = async function () { return ${JSON.stringify({ meta, entries: slim })}; };\n` +
  `</script>`);

/* 相対リンクは本番サイトへ向ける */
html = html.replace(/href="(list|privacy)"/g, 'href="https://leakscan.matsunai.com/$1"');
html = html.replace(/href="(data\/[^"]+)"/g, 'href="https://leakscan.matsunai.com/$1"');

writeFileSync(join(ROOT, 'store/preview.html'), html);
console.log(`store/preview.html を生成: ${(html.length / 1024).toFixed(0)} KB / ${entries.length} 件`);

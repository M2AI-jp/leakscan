#!/usr/bin/env node
/* プロモ動画の各シーンに入っている数字を data/stats.json から入れ直す。
 * 収録件数は毎日変わるので、動画を作り直すたびにここを通す。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const stats = JSON.parse(readFileSync(join(ROOT, 'data/stats.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));
const P = join(ROOT, 'promo/scene.html');

/** 622074796 → "6.22" （単位の「億件」はHTML側に書いてある） */
function oku(n) {
  const v = n / 100000000;
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** 2026-11-06 → 2026年11月6日 */
function jaDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : String(iso || '');
}

/* スキャン中の画面は「途中経過」なので、収録件数の約7割を進捗として見せる
   （進捗バーの幅 71% と合わせる）。照会回数は実際の詰め込み方から出す。 */
const incidents = stats.incidents;
const scanned = Math.round(incidents * 0.71);
const queries = Number(process.env.PROMO_QUERIES || 37);

const VALUES = {
  incidents: incidents.toLocaleString('ja-JP'),
  records: oku(stats.records_total),
  updated: jaDate(meta.updated),
  scanned: scanned.toLocaleString('ja-JP'),
  queries: String(queries)
};

let html = readFileSync(P, 'utf8');
let changed = 0;
for (const [key, value] of Object.entries(VALUES)) {
  const re = new RegExp(`(<b data-stat="${key}">)([^<]*)(</b>)`, 'g');
  html = html.replace(re, (m, a, old, c) => {
    if (old !== value) changed++;
    return a + value + c;
  });
}
writeFileSync(P, html);

console.log(`promo/scene.html を更新: ${changed} か所`);
for (const [k, v] of Object.entries(VALUES)) console.log(`  ${k.padEnd(10)} ${v}`);

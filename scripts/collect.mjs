#!/usr/bin/env node
/* LeakScan — 未収録の事案候補を自動で洗い出す。
 *
 * 事案を breaches.json に自動追加することはしない。
 * 出典を人が読まずに企業名を掲載するのは、誤報と名誉毀損の直接の原因になる。
 * このスクリプトは「どの企業がまだ入っていないか」を名指しするところまでを担う。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'user-agent': 'LeakScan-collect/1.0 (+https://leakscan.matsunai.com)' };
const BASE = 'https://incidents.seory.co.jp/monthly/';

const entries = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));

/** 社名の表記ゆれを吸収して比較するためのキー */
function key(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|一般社団法人|公益財団法人|生活協同組合/g, '')
    .replace(/[\s　・,，.。'"“”’`()（）\-ー－]/g, '');
}

/** 既知の社名・サービス名（部分一致で突き合わせる） */
const known = [];
for (const e of entries) {
  for (const v of [e.company, e.service]) {
    const k = key(v);
    if (k.length >= 2) known.push(k);
  }
}
const isKnown = (org) => {
  const k = key(org);
  if (k.length < 2) return true;
  return known.some((n) => n.includes(k) || k.includes(n));
};

const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** 要約文から件数らしき表記を拾う */
function records(summary) {
  const m = summary.match(/(?:最大)?(?:約)?[\d,]{3,}(?:件|名|人|アカウント|社)/g);
  return m ? [...new Set(m)].slice(0, 3).join(' / ') : '';
}

function parse(html, monthUrl) {
  const out = [];
  const items = html.split('<li class="ii-item">').slice(1);
  for (const it of items) {
    const date = (it.match(/datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const st = (it.match(/状態:\s*([^<]+)</) || [])[1];
    const link = it.match(/<a href="(\/incidents\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!date || !link) continue;
    const tags = [...it.matchAll(/<ul class="ii-tags">([\s\S]*?)<\/ul>/g)]
      .flatMap((m) => [...m[1].matchAll(/<li>([^<]+)<\/li>/g)].map((x) => x[1]));
    const sum = (it.match(/<p class="ii-item__summary">([\s\S]*?)<\/p>/) || [])[1] || '';
    out.push({
      date,
      org: strip(link[2]),
      status: (st || '').trim(),
      cause: tags.join('・'),
      summary: strip(sum),
      records: records(strip(sum)),
      url: 'https://incidents.seory.co.jp' + link[1],
      month: monthUrl
    });
  }
  return out;
}

function months() {
  const now = new Date();
  const out = [];
  for (let i = 0; i < 2; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const all = [];
for (const m of months()) {
  const url = BASE + m + '/';
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.error(`取得失敗 ${url}: HTTP ${res.status}`); continue; }
    all.push(...parse(await res.text(), url));
  } catch (e) {
    console.error(`取得失敗 ${url}: ${e.message || e}`);
  }
}

const seen = new Set();
const candidates = all
  .filter((c) => !isKnown(c.org))
  .filter((c) => { const k = c.date + key(c.org); if (seen.has(k)) return false; seen.add(k); return true; })
  .sort((a, b) => b.date.localeCompare(a.date));

writeFileSync(join(ROOT, 'data/candidates.json'),
  JSON.stringify({ generated: new Date().toISOString(), scanned: all.length, candidates }, null, 2) + '\n');

console.log(`情報源から ${all.length} 件を取得`);
console.log(`収録済み ${entries.length} 件と突き合わせた結果、未収録の候補 ${candidates.length} 件`);
for (const c of candidates.slice(0, 40)) {
  console.log(`CAND\t${c.date}\t${c.org}\t${c.records || '件数未取得'}\t${c.cause}\t${c.url}`);
}

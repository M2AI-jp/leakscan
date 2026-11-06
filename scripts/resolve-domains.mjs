#!/usr/bin/env node
/* LeakScan — 自動追記した事案に、照合用ドメインと公式発表の出典を補う。
 *
 * 推測でドメインを埋めない。情報源の事案ページに載っている
 * 「公式発表へのリンク」からホスト名を取り、それだけを採用する。
 * 企業自身のドメインで公表されている事実が根拠になる。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'user-agent': 'LeakScan-resolve/1.0 (+https://leakscan.matsunai.com)' };
const LIMIT = Number(process.env.RESOLVE_LIMIT || 40);

const M = await import('../extension/lib/match.js').then((m) => m.default || m);
const { normCompany } = await import('./lib/source-feed.mjs');
const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));

/* 企業自身のドメインではないもの。プレスリリース配信サイト・報道・SNS など */
const NOT_OWN = [
  'prtimes.jp', 'kyodonewsprwire.jp', 'atpress.ne.jp', 'value-press.com', 'dreamnews.jp',
  'nikkei.com', 'yahoo.co.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp', 'sankei.com',
  'itmedia.co.jp', 'impress.co.jp', 'nhk.or.jp', 'jiji.com', 'news.yahoo.co.jp',
  'seory.co.jp', 'x.com', 'twitter.com', 'facebook.com', 'youtube.com', 'note.com',
  'google.com', 'docs.google.com', 'drive.google.com', 'amazonaws.com', 'cloudfront.net',
  'hatena.ne.jp', 'ameblo.jp', 'wixsite.com', 'jpcert.or.jp', 'ipa.go.jp', 'ppc.go.jp'
];
const FORBIDDEN = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'outlook.com', 'hotmail.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'icloud.com'
]);

const { rejectReason, needsWholeHost, rejectForOrg } = await import('./lib/shared-domains.mjs');
const DENY = JSON.parse(readFileSync(join(ROOT, 'data/domain-denylist.json'), 'utf8')).domains;

/** 既に他の「別企業」が持っているドメイン。同じ企業の別事案なら共有してよい
 *  （年内に2回漏洩した自治体を、両方とも検出できるようにするため） */
const owned = new Map();     // domain -> 正規化した社名
for (const e of db) for (const d of e.match.domains || []) owned.set(d, normCompany(e.company));

/** web.archive.org などに包まれたURLから、元のURLを取り出す */
function unwrap(url) {
  const m = /^https?:\/\/web\.archive\.org\/web\/[^/]+\/(https?:\/\/.+)$/.exec(String(url));
  return m ? m[1] : url;
}

/** ホスト名 → 照合に使うドメイン（www などを落とす）
 *  地域型・政府系は登録可能ドメインまで削ると別組織と混ざるので、ホスト全体を使う。 */
function registrable(host) {
  const h = String(host || '').toLowerCase().replace(/^www\d*\./, '');
  if (needsWholeHost(h)) return h;
  const label = M.brandLabel(h);
  if (!label) return '';
  const i = h.indexOf(label + '.');
  return i >= 0 ? h.slice(i) : h;
}

const targets = db.filter(
  (e) => e.auto && !(e.match.domains || []).length &&
         (e.sources || []).some((s) => s.url.includes('incidents.seory.co.jp'))
).slice(0, LIMIT);

console.log(`対象 ${targets.length} 件（自動追記でドメイン未設定）`);

let resolved = 0, official = 0, skipped = [];

for (const e of targets) {
  const src = e.sources.find((s) => s.url.includes('incidents.seory.co.jp'));
  await new Promise((r) => setTimeout(r, 700));   // 相手サーバへの配慮
  let html;
  try {
    const res = await fetch(src.url, { headers: UA, signal: AbortSignal.timeout(25000) });
    if (!res.ok) { skipped.push(`${e.company}: HTTP ${res.status}`); continue; }
    html = await res.text();
  } catch (err) { skipped.push(`${e.company}: ${err.message || err}`); continue; }

  const links = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => unwrap(m[1]));
  let picked = null, pickedUrl = null;
  for (const u of links) {
    let host;
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (NOT_OWN.some((n) => host === n || host.endsWith('.' + n))) continue;
    const reg = registrable(host);
    if (!reg || FORBIDDEN.has(reg)) continue;
    const bad = rejectReason(reg, DENY, { auto: true }) || rejectForOrg(e.company, reg);
    if (bad) { skipped.push(`${e.company}: ${reg} を棄却（${bad}）`); continue; }
    if (owned.has(reg) && owned.get(reg) !== normCompany(e.company)) continue;   // 他社と衝突
    picked = reg; pickedUrl = u; break;
  }

  if (!picked) { skipped.push(`${e.company}: 公式発表のリンクなし`); continue; }

  e.match.domains = [picked];
  owned.set(picked, normCompany(e.company));
  resolved++;

  if (!e.sources.some((s) => s.url === pickedUrl)) {
    e.sources.unshift({ title: `${e.company} 公式発表`, url: pickedUrl });
    official++;
  }
  console.log(`  ${e.company}  →  ${picked}`);
}

writeFileSync(join(ROOT, 'data/breaches.json'), JSON.stringify(db, null, 2) + '\n');
console.log(`\nドメインを補完: ${resolved} 件 / 公式発表を出典に追加: ${official} 件`);
if (skipped.length) {
  console.log(`補完できず: ${skipped.length} 件`);
  for (const s of skipped.slice(0, 10)) console.log(`  - ${s}`);
}

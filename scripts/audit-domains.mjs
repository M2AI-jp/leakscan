#!/usr/bin/env node
/* LeakScan — 照合ドメインの事後監査。
 *
 * 1社だけのものと思って採用したドメインが、実は共用プラットフォームだった
 * ことは自動では気づけない。ただし「同じホストが複数の会社の公式発表の
 * 置き場所になっている」なら、それは共用である強い証拠になる。
 * 情報源の全事案を横断して数え、2社以上で使われているホストを報告する。
 *
 *   node scripts/audit-domains.mjs            報告のみ
 *   node scripts/audit-domains.mjs --fix      該当ドメインを外し、除外リストに追記
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normCompany } from './lib/source-feed.mjs';
import { isOfficialSource } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');
const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const DENY_PATH = join(ROOT, 'data/domain-denylist.json');
const deny = JSON.parse(readFileSync(DENY_PATH, 'utf8'));

/* 照合ドメインごとに、それを使っている会社を集める */
const users = new Map();     // domain -> Set<正規化した社名>
for (const e of db) {
  for (const d of e.match.domains || []) {
    if (!users.has(d)) users.set(d, new Set());
    users.get(d).add(normCompany(e.company));
  }
}

/* 公式発表の出典ホストごとに、それを使っている会社を集める。
   同じホストが複数社の発表置き場になっていれば共用プラットフォーム。 */
const hosts = new Map();     // host -> Set<正規化した社名>
for (const e of db) {
  for (const s of e.sources || []) {
    if (s.url.includes('seory.co.jp')) continue;
    let h; try { h = new URL(s.url).hostname.toLowerCase().replace(/^www\d*\./, ''); } catch { continue; }
    if (!hosts.has(h)) hosts.set(h, new Set());
    hosts.get(h).add(normCompany(e.company));
  }
}

const shared = [];
const media = [];
for (const [h, cos] of hosts) {
  if (cos.size < 2) continue;
  /* 自治体・政府系は「同じホストに複数の組織」が正常なので除く
     （pref.X.jp は県と県の出先機関で共用される） */
  if (/\.(lg|go)\.jp$/.test(h) || /^(pref|city|town|village|metro)\./.test(h)) continue;
  /* 報道・集計サイトとして既知のものは「公式発表ではない」側で扱う。
     ただしその媒体自身が被害企業である場合、照合ドメインとしては正当なので
     自動では外さず、別枠で報告する（例: 日経ID の事案と nikkei.com）。 */
  if (!isOfficialSource('https://' + h + '/')) {
    if (users.has(h)) media.push({ host: h, companies: [...cos] });
    continue;
  }
  shared.push({ host: h, companies: [...cos] });
}
shared.sort((a, b) => b.companies.length - a.companies.length);

console.log(`照合ドメイン ${users.size} 件 / 出典のホスト ${hosts.size} 件`);

if (media.length) {
  console.log(`\n報道・集計サイトのドメインが照合に使われている: ${media.length} 件`);
  console.log('  （その媒体自身が被害企業なら正当。別の会社の事案なら誤り）');
  for (const m of media) {
    const owners = db.filter((e) => (e.match.domains || []).includes(m.host)).map((e) => e.company);
    console.log(`  ${m.host}  → 照合に使っている事案: ${owners.join(' / ')}`);
  }
}

if (!shared.length) {
  console.log('複数社で共用されているホストは見つかりませんでした。');
  process.exit(0);
}

console.log(`\n複数社の公式発表が同じホストに置かれている: ${shared.length} 件`);
for (const s of shared) {
  const inUse = users.has(s.host) ? ' ← 照合に使用中' : '';
  console.log(`  ${s.host}  (${s.companies.length}社)${inUse}`);
  console.log(`    ${s.companies.join(' / ')}`);
}

if (!fix) {
  console.log('\n--fix を付けると、照合に使用中のものを外して除外リストに追記します。');
  process.exit(0);
}

let removed = 0;
for (const s of shared) {
  if (!users.has(s.host)) continue;
  deny.domains[s.host] = deny.domains[s.host] ||
    `複数社（${s.companies.length}社）の公式発表が同じホストに置かれている共用プラットフォーム`;
  for (const e of db) {
    const before = (e.match.domains || []).length;
    e.match.domains = (e.match.domains || []).filter((d) => d !== s.host);
    if (e.match.domains.length !== before) removed++;
  }
}
writeFileSync(join(ROOT, 'data/breaches.json'), JSON.stringify(db, null, 2) + '\n');
writeFileSync(DENY_PATH, JSON.stringify(deny, null, 2) + '\n');
console.log(`\n照合ドメインを外した事案: ${removed} 件 / 除外リスト: ${Object.keys(deny.domains).length} 件`);

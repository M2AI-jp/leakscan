/* 照合ドメインの安全弁テスト — node test/domains.test.mjs
 *
 * 守りたいこと: 「その企業だけのものではないドメイン」を照合に使わない。
 * 使ってしまうと、無関係な人に「あなたのサービスが漏洩した」と表示し、
 * 無関係な企業を漏洩企業として名指ししてしまう。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rejectReason, needsWholeHost, looksLikeInfra } from '../scripts/lib/shared-domains.mjs';
import { orgKey } from '../scripts/lib/source-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DENY = JSON.parse(readFileSync(join(ROOT, 'data/domain-denylist.json'), 'utf8')).domains;
const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const section = (t) => console.log('\n' + t);

section('1. 共用ドメインは棄却される');
for (const [d, why] of [
  ['shinkin.co.jp', '全国の信用金庫が共用'],
  ['kanagawa.jp', '県内の全市町村を巻き込む'],
  ['tokyo.jp', '都内の全区市町村を巻き込む'],
  ['prtimes.jp', 'プレスリリース配信'],
  ['tdnet.info', '全上場企業の開示基盤'],
  ['co.jp', '属性型JPドメインそのもの'],
  ['jp', 'TLDそのもの']
]) ok(`${d} を棄却 (${why})`, !!rejectReason(d, DENY, { auto: true }), rejectReason(d, DENY, { auto: true }) || '通ってしまった');

section('2. 企業・自治体固有のドメインは通る');
for (const d of [
  'tepco.co.jp', 'e-design.net', 'kyushu-u.ac.jp',
  'pref.kanagawa.jp', 'city.kawasaki.jp', 'pref.okinawa.lg.jp',
  'digital.go.jp'   // 人が確認したデジタル庁。auto なしなら通る
]) ok(`${d} は通る`, !rejectReason(d, DENY, { auto: false }), rejectReason(d, DENY, { auto: false }));

section('3. 省庁ドメインは自動補完だけ厳しくする');
ok('digital.go.jp は自動補完では棄却', !!rejectReason('digital.go.jp', DENY, { auto: true }));
ok('digital.go.jp は人の確認なら通る', !rejectReason('digital.go.jp', DENY, { auto: false }));

section('4. 配信基盤・ストレージは企業の持ち物ではない');
for (const h of [
  'microcms-assets.io', 'assets.example.com', 'cdn.example.co.jp',
  'static.example.jp', 'files.example.com', 'example.s3.amazonaws.com',
  'example.cloudfront.net', 'example.pages.dev', 'example.vercel.app'
]) ok(`${h} を配信基盤と判定`, looksLikeInfra(h), '素通りした');
ok('tepco.co.jp は配信基盤ではない', !looksLikeInfra('tepco.co.jp'));
ok('mediba.jp は media. で始まらないので誤判定しない', !looksLikeInfra('mediba.jp'));

section('5. 自治体ホストは削らずそのまま使う');
for (const h of ['www.city.kawasaki.jp', 'pref.toyama.jp', 'city.edogawa.tokyo.jp', 'metro.tokyo.jp'])
  ok(`${h} はホスト全体を使う`, needsWholeHost(h));
ok('tepco.co.jp は登録可能ドメインまで削ってよい', !needsWholeHost('www.tepco.co.jp'));

section('6. 本番データに危険なドメインが残っていない');
const bad = [];
for (const e of db) {
  for (const d of e.match.domains || []) {
    const why = rejectReason(d, DENY, { auto: !!e.auto });
    if (why) bad.push(`${e.id}: ${d} (${why})`);
  }
}
ok(`${db.length} 件すべて安全`, bad.length === 0, bad.slice(0, 5).join(' / '));

section('7. 1つのドメインを2つの組織が持っていない');
/* 同じ組織が年内に複数回漏洩した場合は、同じドメインを両方の事案に持たせる
   （どちらの事案も利用者に見せたいので）。別組織との重複だけが誤り。 */
const owner = new Map();
const dup = [];
for (const e of db) for (const d of e.match.domains || []) {
  const co = orgKey(e.company);
  if (owner.has(d) && owner.get(d).co !== co) {
    dup.push(`${d}: ${owner.get(d).co}(${owner.get(d).id}) と ${co}(${e.id})`);
  } else if (!owner.has(d)) {
    owner.set(d, { id: e.id, co });
  }
}
ok('別組織との重複なし', dup.length === 0, dup.join(' / '));

section('8. 包括ドメインが他組織のドメインを飲み込んでいない');
const swallow = [];
const all = [];
for (const e of db) for (const d of e.match.domains || []) all.push({ d, co: orgKey(e.company), id: e.id });
for (const a of all) for (const b of all) {
  if (a.d === b.d || !b.d.endsWith('.' + a.d) || a.co === b.co) continue;
  swallow.push(`${a.d}(${a.co}) ⊃ ${b.d}(${b.co})`);
}
ok('飲み込みなし', swallow.length === 0, swallow.join(' / '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

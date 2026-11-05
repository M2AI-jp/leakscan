/* LeakScan matching tests — run with: node test/match.test.js */
const fs = require('fs');
const path = require('path');
const M = require('../extension/lib/match.js');
const A = require('../extension/lib/advice.js');

const entries = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/data/breaches.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/data/meta.json'), 'utf8'));
const services = entries.map((e) => ({ id: e.id, label: e.service, domains: e.match.domains, names: e.match.names }));
const byId = (id) => services.find((s) => s.id === id);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/** which services does this sender hit, across the whole DB? */
function hits(sender) {
  return services.filter((s) => M.matchSender(sender, s)).map((s) => s.id);
}

section('1. ドメイン一致');
ok('muji.net → MUJI', M.matchSender({ email: 'info@muji.net', name: '無印良品' }, byId('ryohin-keikaku-muji-2026-10')) === 'domain');
ok('サブドメインも一致', M.matchSender({ email: 'no-reply@mail.muji.com', name: '' }, byId('ryohin-keikaku-muji-2026-10')) === 'domain');
ok('大文字アドレスも一致', M.matchSender({ email: 'News@LAWSON.CO.JP', name: '' }, byId('lawson-id-2026-10')) === 'domain');
ok('部分文字列ドメインは不一致', M.matchSender({ email: 'a@notmuji.net', name: '' }, byId('ryohin-keikaku-muji-2026-10')) === null);
ok('接尾辞偽装ドメインは不一致', M.matchSender({ email: 'a@lawson.co.jp.evil.com', name: '' }, byId('lawson-id-2026-10')) === null);

section('2. 表示名一致（ドメイン未知のサービス）');
ok('表示名「ローソン」', M.matchSender({ email: 'x@unknown-mail.jp', name: 'ローソン' }, byId('lawson-id-2026-10')) === 'name');
ok('全角/半角ゆれを吸収', M.matchSender({ email: 'x@y.jp', name: 'ﾋﾞｯｸﾞｴｺｰ' }, byId('daiichikosho-2026-10')) === 'name');
ok('スペース入り表示名', M.matchSender({ email: 'x@y.jp', name: '花 キューピット' }, byId('hanacupid-2026-10')) === 'name');
ok('短い英字パターンは採用しない', M.minNameLen('au') === 4 && M.minNameLen('ローソン') === 2);

section('3. 誤検知（これが一番大事）');
const innocuous = [
  { email: 'friend@gmail.com', name: '山田太郎' },
  { email: 'noreply@github.com', name: 'GitHub' },
  { email: 'team@slack.com', name: 'Slack' },
  { email: 'paul@example.com', name: 'Paul Auster' },
  { email: 'info@example.co.jp', name: '株式会社サンプル' },
  { email: 'no-reply@accounts.google.com', name: 'Google' },
  { email: 'billing@stripe.com', name: 'Stripe' },
  { email: 'news@nikkei-shimbun-fake.example', name: 'authentication service' }
];
for (const s of innocuous) {
  const h = hits(s);
  ok('無関係な差出人が一致しない: ' + s.email, h.length === 0, h.join(','));
}

section('4. 1差出人が複数サービスに一致しないか');
let multi = [];
for (const e of entries) {
  for (const d of e.match.domains) {
    const h = hits({ email: 'noreply@' + d, name: '' });
    if (h.length > 1) multi.push(d + ' → ' + h.join(', '));
  }
}
ok('ドメインの衝突なし', multi.length === 0, multi.join(' | '));

section('5. クエリ生成');
const batch = services.slice(0, 8);
const q = M.buildQuery(batch, {});
ok('from:(...) 形式', /^from:\(.+\)$/.test(q));
ok('OR 区切り', q.includes(' OR '));
ok('日本語は引用符で囲む', q.includes('"無印良品"'));
ok('クエリ長が実用範囲 (<1000)', q.length < 1000, 'len=' + q.length);
ok('in:anywhere オプション', M.buildQuery(batch, { includeSpamTrash: true }).endsWith(' in:anywhere'));
const longest = (() => { let mx = 0; for (let i = 0; i < services.length; i += 8) mx = Math.max(mx, M.buildQuery(services.slice(i, i + 8), {}).length); return mx; })();
ok('全バッチで1000字未満', longest < 1000, 'max=' + longest);

section('6. データ整合性');
ok('全エントリにidとsourcesがある', entries.every((e) => e.id && e.sources && e.sources.length));
ok('statusは既知の値', entries.every((e) => meta.status_labels[e.status]));
ok('causeは既知の値', entries.every((e) => meta.cause_labels[e.cause]));
ok('ai_linkは既知の値', entries.every((e) => meta.ai_link_labels[e.ai_link]));
ok('categoriesは既知の値', entries.every((e) => e.categories.every((c) => meta.categories[c])));
ok('照合パターンを持つ事案が9割以上',
  entries.filter((e) => e.match.domains.length || e.match.names.length).length / entries.length > 0.9);
ok('AI断定なし（国内事案でai_link=confirmedがない）',
  !entries.some((e) => e.ai_link === 'confirmed' && e.id !== 'litellm-supplychain-2026-10'));

section('7. 対応アドバイス');
ok('カード漏洩は危険度3', A.severity(['card', 'name']) === 3);
ok('メールのみは危険度1', A.severity(['email']) === 1);
ok('パスワード漏洩で「今すぐ」が出る', A.adviceFor(['password']).some((a) => a.urgency === 3));
ok('全エントリでアドバイスが1件以上', entries.every((e) => A.adviceFor(e.categories).length >= 1));

section('8. 実在しそうな受信箱でのシミュレーション');
const inbox = [
  { email: 'info@muji.net', name: '無印良品' },
  { email: 'noreply@lawson.co.jp', name: 'ローソン' },
  { email: 'mail@capcom.com', name: 'CAPCOM ID' },
  { email: 'info@so-net.ne.jp', name: 'So-net' },
  { email: 'friend@gmail.com', name: '友人' },
  { email: 'noreply@github.com', name: 'GitHub' },
  { email: 'ticket@skyticket.jp', name: 'skyticket' }
];
const matched = new Set();
for (const s of inbox) for (const id of hits(s)) matched.add(id);
ok('6件中5サービスを検出', matched.size === 5, [...matched].join(', '));
ok('MUJIを検出', matched.has('ryohin-keikaku-muji-2026-10'));
ok('skyticketを検出', matched.has('skyticket-2026-10'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

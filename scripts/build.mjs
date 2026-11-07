#!/usr/bin/env node
/* LeakScan — derive publishable artifacts from data/ and sync them to the
 * site and the extension. Run after editing data/breaches.json. */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { updateHeaders } from './csp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const d = (p) => join(ROOT, p);

const entries = JSON.parse(readFileSync(d('data/breaches.json'), 'utf8'));
const meta = JSON.parse(readFileSync(d('data/meta.json'), 'utf8'));
const { hasOfficialSource } = await import('./lib/sources.mjs');

/* ---- derived: 公式発表を直接引いているか ----
 * サイトのバッジ（公式発表あり / 報道による）と統計の根拠。
 * 出典から機械的に決まるので、データを直す必要はない。 */
for (const e of entries) e.official = hasOfficialSource(e);
writeFileSync(d('data/breaches.json'), JSON.stringify(entries, null, 2) + '\n');

/* ---- derived: updated / version ----
 * ここは data/meta.json に手で書いていた。だから日次ジョブが事案を追記しても
 * サイトの「最終更新」は動かず、新しい事案が古い日付のまま出ていた。
 *
 * 中身の指紋を meta.json に持たせ、指紋が変わった時だけ日付を押す。
 * 同じデータで何度ビルドしても差分は出ないので、CIの「生成物が最新か確認」は通る。
 * 指紋の対象は事案そのもの（この日付が答えるのは「表示しているデータはいつのものか」で、
 * 区分値の訳語を直したときに動いてほしくはない）。
 * 日付は日本時間で取る。収集が走るのは日本の朝で、CIはUTCのため。 */
const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const stamped = meta.fingerprint !== fingerprint;
if (stamped) {
  meta.fingerprint = fingerprint;
  meta.updated = jstToday();
  meta.version = meta.updated.replace(/-/g, '.');
  writeFileSync(d('data/meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ---- breaches.csv : one row per incident ---- */
const COLS = ['id', 'company', 'service', 'sector', 'disclosed', 'records', 'records_num',
  'status', 'cause', 'ai_link', 'official', 'categories', 'domains', 'names', 'scope', 'source_urls'];
const csv = [COLS.join(',')];
for (const e of entries) {
  csv.push([
    e.id, e.company, e.service, e.sector, e.disclosed, e.records,
    e.records_num ?? '', e.status, e.cause, e.ai_link, e.official ? 'yes' : 'no',
    (e.categories || []).join('|'),
    (e.match.domains || []).join('|'),
    (e.match.names || []).join('|'),
    e.scope || '',
    (e.sources || []).map((s) => s.url).join('|')
  ].map(csvCell).join(','));
}
writeFileSync(d('data/breaches.csv'), csv.join('\n') + '\n');

/* ---- domains.tsv : domain -> incident, for anyone building their own matcher ---- */
const rows = [['domain', 'id', 'service', 'company', 'disclosed'].join('\t')];
for (const e of entries) {
  for (const dom of e.match.domains || []) {
    rows.push([dom, e.id, e.service, e.company, e.disclosed].join('\t'));
  }
}
rows.sort((a, b) => (a === rows[0] ? -1 : b === rows[0] ? 1 : a.localeCompare(b)));
writeFileSync(d('data/domains.tsv'), rows.join('\n') + '\n');

/* ---- stats.json ---- */
const sev3 = ['card', 'bank', 'password', 'id_document', 'login_credential', 'my_number'];
const stats = {
  /* ここに「作った日」を入れていたが、中身と関係なく毎日変わるので、
     ビルドし直しただけで差分が出てCIが止まっていた。しかも手元(JST)とCI(UTC)で
     9時間ずれるため、日本の深夜に触ると必ず落ちる。読んでいる所もなかった。
     データがいつのものかは下の version と meta.json の updated が言っている。 */
  version: meta.version,
  incidents: entries.length,
  companies: new Set(entries.map((e) => e.company)).size,
  records_total: entries.reduce((a, e) => a + (e.records_num || 0), 0),
  records_note: '重複を含む延べ件数。公表値の単純合計で、実人数ではない。',
  by_status: {},
  by_cause: {},
  by_sector: {},
  by_ai_link: {},
  high_severity: entries.filter((e) => (e.categories || []).some((c) => sev3.includes(c))).length,
  official_sources: entries.filter((e) => e.official).length,
  auto_added: entries.filter((e) => e.auto).length,
  matchable: entries.filter((e) => (e.match.domains || []).length || (e.match.names || []).length).length,
  domains: entries.reduce((a, e) => a + (e.match.domains || []).length, 0),
  earliest: entries.map((e) => e.disclosed).sort()[0],
  latest: entries.map((e) => e.disclosed).sort().slice(-1)[0]
};
for (const e of entries) {
  stats.by_status[e.status] = (stats.by_status[e.status] || 0) + 1;
  stats.by_cause[e.cause] = (stats.by_cause[e.cause] || 0) + 1;
  stats.by_sector[e.sector] = (stats.by_sector[e.sector] || 0) + 1;
  stats.by_ai_link[e.ai_link] = (stats.by_ai_link[e.ai_link] || 0) + 1;
}
writeFileSync(d('data/stats.json'), JSON.stringify(stats, null, 2) + '\n');

/* ---- sync to the site and the bundled extension copy ---- */
for (const dir of ['site/data', 'extension/data']) {
  mkdirSync(d(dir), { recursive: true });
  for (const f of ['breaches.json', 'meta.json']) copyFileSync(d('data/' + f), d(`${dir}/${f}`));
}
for (const f of ['breaches.csv', 'domains.tsv', 'stats.json']) {
  copyFileSync(d('data/' + f), d('site/data/' + f));
}

/* ---- CSPのハッシュもここで合わせる ----
   ページ内スクリプトを直すとハッシュが変わる。手で写すと必ず忘れるので、
   生成物の一つとして扱う。 */
const csp = updateHeaders();

/* ---- 共有画像が古くなっていないか ----
 * SNSに貼ったときに出る画像には件数が焼き込んである。作り直しにはブラウザが要るので
 * CIでは作れない。せめて、ずれたことに気づけるようにしておく。 */
let ogNote = '共有画像: 記録がありません（node scripts/og.mjs で作れます）';
try {
  const og = JSON.parse(readFileSync(d('site/assets/og.json'), 'utf8'));
  ogNote = og.records_total === stats.records_total
    ? `共有画像: ${og.records_total.toLocaleString('en-US')}件（最新）`
    : `共有画像: ${og.records_total.toLocaleString('en-US')}件のまま。いまは ${stats.records_total.toLocaleString('en-US')}件 → node scripts/og.mjs で作り直してください`;
} catch (_) {}

/* ---- 画面見本の数字 ----
 * test/*-preview.html の「574件の事案を照合」は手で書いてあった。
 * この見本はストアの掲載画像のもとでもあるので、ここが古いと
 * 公開する画像に古い件数が焼き込まれる（実際そうなっていた）。
 * データから入れ直す。中身から決まる値なので、CIの再生成確認は通る。 */
const PREVIEWS = ['test/popup-preview.html', 'test/results-preview.html', 'test/options-preview.html'];
let previewFixed = 0;
for (const f of PREVIEWS) {
  try {
    const before = readFileSync(d(f), 'utf8');
    const after = before
      .replace(/\b(scanned\s*:\s*)\d+/g, `$1${stats.incidents}`)
      .replace(/\b(count\s*:\s*)\d+/g, `$1${stats.incidents}`)
      .replace(/\b((?:db)?[Vv]ersion\s*:\s*')[\d.]+(')/g, `$1${meta.version}$2`);
    if (after !== before) { writeFileSync(d(f), after); previewFixed++; }
  } catch (_) {}
}

/* ---- 商品名に入れた年と、データの年が合っているか ----
 * 名前を「情報漏洩チェッカー2026」にした。収集スクリプトは年で絞っていないので、
 * 2027年の事案が公表されれば自動で入ってくる。そのとき名前とサイトの見出しは
 * 手で直すしかない。放っておけば、今日直したのと同じ間違い
 * （誰も書き換えない手書きの値）になる。だからずれたらここで言う。
 *
 * 年は商品名そのものから読む。ここにもう一度 '2026' と書くと、
 * 名前を変えたときに片方だけ古くなるため。 */
const brandName = JSON.parse(readFileSync(d('extension/manifest.json'), 'utf8')).name;
const brandYear = (brandName.match(/20\d\d/) || [])[0] || '';
const dataYears = [...new Set(entries
  .map((e) => String(e.disclosed || '').slice(0, 4))
  .filter((y) => /^20\d\d$/.test(y)))].sort();
const strayYears = brandYear ? dataYears.filter((y) => y !== brandYear) : [];
const yearNote = !brandYear
  ? `収録年: ${dataYears.join('・')}（商品名に年は入っていません）`
  : strayYears.length
    ? `収録年に ${strayYears.join('・')} が混ざっています。商品名は「${brandName}」のまま。`
      + ' extension/manifest.json と site/*.html の見出し・タイトル、scripts/og.mjs を見直してください'
    : `収録年: ${dataYears.join('・')}（商品名の ${brandYear} と一致）`;

console.log(`${entries.length} 件 / ${stats.companies} 社 / ドメイン ${stats.domains} 件`);
console.log('生成: data/breaches.csv, data/domains.tsv, data/stats.json');
console.log(stamped
  ? `更新日: ${meta.updated} に押した（事案の中身が変わったため）`
  : `更新日: ${meta.updated} のまま（事案の中身は変わっていない）`);
console.log('同期: site/data/, extension/data/');
console.log(`CSP: ページ内スクリプト ${csp.hashes.length} 件のハッシュ` +
  (csp.changed ? ' → site/_headers を更新' : '（site/_headers は最新）'));
console.log(ogNote);
console.log(yearNote);
console.log(previewFixed
  ? `画面見本: ${previewFixed}ファイルの件数を ${stats.incidents} に直した → node scripts/shots.mjs で撮り直してください`
  : `画面見本: ${stats.incidents}件（最新）`);

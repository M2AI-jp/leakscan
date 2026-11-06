#!/usr/bin/env node
/* LeakScan — dataset validation. No dependencies.
 * Checks structure, enums, and the safety rules that keep the extension
 * from producing false positives. Exits non-zero on any error. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entries = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const DENY = JSON.parse(readFileSync(join(ROOT, 'data/domain-denylist.json'), 'utf8')).domains;
const { rejectReason } = await import('./lib/shared-domains.mjs');
const { orgKey } = await import('./lib/source-feed.mjs');
const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

/* Domains that would match huge numbers of unrelated senders. */
const FORBIDDEN_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'google.com', 'yahoo.co.jp', 'yahoo.com',
  'outlook.com', 'hotmail.com', 'live.jp', 'icloud.com', 'me.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'i.softbank.jp',
  'amazon.co.jp', 'amazon.com', 'apple.com', 'microsoft.com', 'facebook.com',
  'line.me', 'x.com', 'twitter.com', 'github.com'
]);

const CJK = /[぀-ヿ一-鿿]/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

if (!Array.isArray(entries)) {
  console.error('data/breaches.json must be an array');
  process.exit(1);
}

const seenIds = new Set();
const domainOwners = new Map();

for (const e of entries) {
  const id = e.id || '(no id)';

  for (const k of ['id', 'company', 'service', 'sector', 'disclosed', 'records', 'status', 'cause', 'ai_link']) {
    if (typeof e[k] !== 'string' || !e[k]) err(id, `必須項目 ${k} が文字列でない`);
  }
  if (!ID_RE.test(e.id || '')) err(id, 'id は英小文字・数字・ハイフンのみ');
  if (seenIds.has(e.id)) err(id, 'id が重複');
  seenIds.add(e.id);

  if (!DATE_RE.test(e.disclosed || '')) err(id, 'disclosed は YYYY-MM-DD');
  else {
    const d = new Date(e.disclosed + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) err(id, 'disclosed が実在しない日付');
    if (d.getTime() > Date.now() + 86400000) err(id, 'disclosed が未来の日付');
  }

  if (!(e.records_num === null || Number.isInteger(e.records_num))) err(id, 'records_num は整数か null');
  if (Number.isInteger(e.records_num) && e.records_num < 0) err(id, 'records_num が負');

  if (!meta.status_labels[e.status]) err(id, `未知の status: ${e.status}`);
  if (!meta.cause_labels[e.cause]) err(id, `未知の cause: ${e.cause}`);
  if (!meta.ai_link_labels[e.ai_link]) err(id, `未知の ai_link: ${e.ai_link}`);

  if (!Array.isArray(e.categories) || !e.categories.length) err(id, 'categories が空');
  else for (const c of e.categories) if (!meta.categories[c]) err(id, `未知の category: ${c}`);

  if (!Array.isArray(e.sources) || !e.sources.length) err(id, 'sources が最低1件必要');
  else for (const s of e.sources) {
    if (!s || typeof s.title !== 'string' || !s.title) err(id, 'source.title が空');
    if (!s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url || '')) err(id, `source.url が不正: ${s && s.url}`);
  }

  const m = e.match;
  if (!m || !Array.isArray(m.domains) || !Array.isArray(m.names)) {
    err(id, 'match.domains / match.names が配列でない');
    continue;
  }
  if (!m.domains.length && !m.names.length) warn(id, '照合パターンが無いため拡張機能では検出されない');

  for (const d of m.domains) {
    if (d !== String(d).toLowerCase()) err(id, `domain は小文字で: ${d}`);
    if (!DOMAIN_RE.test(d)) err(id, `domain の書式が不正: ${d}`);
    if (FORBIDDEN_DOMAINS.has(d)) err(id, `共用/フリーメールのドメインは使用不可: ${d}`);
    const shared = rejectReason(d, DENY, { auto: !!e.auto });
    if (shared) err(id, `この企業だけのドメインではない: ${d}（${shared}）`);
    /* 同じ企業が年内に複数回漏洩した場合、同じドメインを両方の事案に持たせる。
       別企業と重複しているなら、どちらかが誤り。 */
    const co = orgKey(e.company);
    if (domainOwners.has(d) && domainOwners.get(d).co !== co) {
      err(id, `domain ${d} は別企業 ${domainOwners.get(d).co}（${domainOwners.get(d).id}）と重複`);
    } else if (!domainOwners.has(d)) {
      domainOwners.set(d, { id: e.id, co });
    }
  }

  for (const n of m.names) {
    const norm = String(n).normalize('NFKC').toLowerCase().replace(/[\s　・,，.。'"“”’`]/g, '');
    const min = CJK.test(norm) ? 2 : 4;
    if (norm.length < min) {
      err(id, `表示名パターンが短すぎる（${CJK.test(norm) ? '日本語は2' : '英字のみは4'}文字以上）: ${n}`);
    }
  }

  /* An entry claiming confirmed AI involvement needs a source saying so. */
  if (e.ai_link === 'confirmed' && (!e.scope || !e.scope.length)) {
    err(id, 'ai_link=confirmed には根拠を scope に明記すること');
  }
}

/* 片方がもう片方を飲み込むドメインの組み合わせを弾く。
   例: metro.tokyo.lg.jp は waterworks.metro.tokyo.lg.jp に一致してしまい、
   東京都全体のドメインが水道局の事案まで巻き込む。 */
const allDomains = [];
for (const e of entries) for (const d of e.match.domains || []) allDomains.push({ d, id: e.id, co: orgKey(e.company) });
for (const a of allDomains) {
  for (const b of allDomains) {
    if (a.d === b.d || !b.d.endsWith('.' + a.d)) continue;
    if (a.co === b.co) warn(a.id, `domain ${a.d} は ${b.d}（${b.id}）を含む。片方で足りる`);
    else err(a.id, `domain ${a.d} が別企業のドメイン ${b.d}（${b.id} / ${b.co}）を飲み込む`);
  }
}

console.log(`${entries.length} 件を検証`);
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 件:`);
  for (const w of warnings) console.log('  - ' + w);
}
if (errors.length) {
  console.error(`\nエラー ${errors.length} 件:`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('OK: エラーなし');

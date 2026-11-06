#!/usr/bin/env node
/* LeakScan — 情報源の公開JSONから未収録の事案を data/breaches.json に追記する。
 *
 * 守っていること:
 *  - 情報源の要約文は転載しない。構造化された項目から自分の言葉で書く。
 *  - 照合用ドメインは空のまま。公式発表のURLから取れるものだけを
 *    scripts/resolve-domains.mjs が後で入れる。推測で埋めない。
 *  - 確度は保守側に倒す。「漏洩を確認」と書くのは確定件数が公表されている場合だけ。
 *  - 検証に通らない形のものは、その1件だけを捨てる（全体を落とさない）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fetchFeed, isPersonal, knownIndex, isKnown, normCompany,
  categoriesOf, causeOf, statusOf, recordsOf, scopeOf
} from './lib/source-feed.mjs';
import { guessSector } from './lib/sector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 60);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 45);   // 0 = 制限なし

const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));

const CJK = /[぀-ヿ一-鿿]/;
/** 表示名として使うと誤検知するもの */
const TOO_GENERIC = new Set([
  'お客様', 'サービス', 'サポート', 'センター', '事務局', '会員', '情報', 'お知らせ',
  'カスタマー', 'インフォメーション', 'ショップ', 'ストア', 'オンライン', 'ネット'
]);

/** 表示名パターンとして安全に使えるか（validate.mjs と同じ基準） */
function usableName(n) {
  const norm = String(n).normalize('NFKC').toLowerCase().replace(/[\s　・,，.。'"“”’`]/g, '');
  if (norm.length < (CJK.test(norm) ? 2 : 4)) return false;
  if (TOO_GENERIC.has(String(n).trim())) return false;
  return true;
}

/** 法人格を外した呼び名。「株式会社ライフコーポレーション」→「ライフコーポレーション」 */
function shortName(name) {
  return String(name)
    .replace(/^(株式会社|有限会社|合同会社|一般財団法人|公益財団法人|公益社団法人|一般社団法人|国立大学法人|公立大学法人|学校法人|医療法人|特定非営利活動法人)\s*/, '')
    .replace(/\s*(株式会社|有限会社|合同会社)$/, '')
    .trim();
}

const feed = await fetchFeed();
const idx = knownIndex(db);
const cutoff = MAX_AGE_DAYS
  ? new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10)
  : '0000-00-00';

const cands = feed.incidents
  .filter((inc) => isPersonal(inc))
  .filter((inc) => String(inc.dates.first_published || '') >= cutoff)
  .filter((inc) => !isKnown(inc, idx))
  .sort((a, b) => String(b.dates.first_published).localeCompare(String(a.dates.first_published)));

const added = [];
const skipped = [];

for (const inc of cands) {
  if (added.length >= MAX_PER_RUN) break;

  const company = String(inc.organization.name || '').trim();
  const disclosed = String(inc.dates.first_published || '');
  if (!company || !/^\d{4}-\d{2}-\d{2}$/.test(disclosed)) {
    skipped.push(`${company || '(名称なし)'}: 必須項目が足りない`);
    continue;
  }

  /* 連名の事案は先頭の1社を代表にする。名前は使える形のものだけ残す */
  const names = [...new Set([company, shortName(company)])].filter(usableName);
  if (!names.length) {
    skipped.push(`${company}: 表示名として使える形にならない`);
    continue;
  }

  const r = recordsOf(inc);
  const entry = {
    id: `auto-${inc.id}`,
    company,
    service: company,
    sector: guessSector(company),
    match: { domains: [], names },
    disclosed,
    records: r.text,
    records_num: r.num,
    categories: categoriesOf(inc),
    status: statusOf(inc),
    scope: scopeOf(inc, meta),
    cause: causeOf(inc),
    ai_link: 'unconfirmed',
    auto: true,
    sources: [{ title: `${shortName(company)}の事案（情報源の記録）`, url: inc.url }]
  };

  if (db.some((e) => e.id === entry.id)) { skipped.push(`${company}: ID重複`); continue; }

  db.push(entry);
  idx.byId.add(inc.id);
  idx.named.push({ id: entry.id, day: Date.parse(disclosed) || 0, tokens: [normCompany(company)] });
  added.push(entry);
}

db.sort((a, b) => String(b.disclosed).localeCompare(String(a.disclosed)) || a.id.localeCompare(b.id));
writeFileSync(join(ROOT, 'data/breaches.json'), JSON.stringify(db, null, 2) + '\n');

console.log(`対象候補 ${cands.length} 件 / 今回の上限 ${MAX_PER_RUN} 件`);
console.log(`${added.length} 件を自動追記`);
for (const e of added) console.log(`  + ${e.disclosed}  ${e.sector.padEnd(12)} ${e.company}`);
if (skipped.length) {
  console.log(`\n追記しなかったもの ${skipped.length} 件`);
  for (const s of skipped.slice(0, 15)) console.log(`  - ${s}`);
}
console.log(`\n合計 ${db.length} 件`);

#!/usr/bin/env node
/* LeakScan — 情報源の公開JSONを読み、本データベースに未収録の事案を報告する。
 * 書き込みはしない。追記は scripts/autoadd.mjs が行う。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFeedOrSkip, isPersonal, knownIndex, isKnown, recordsOf, categoriesOf, causeOf, statusOf } from './lib/source-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 0);   // 0 = 制限なし

const feed = await fetchFeedOrSkip('未収録の事案の収集');
const idx = knownIndex(db);
const cutoff = MAX_AGE_DAYS
  ? new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10)
  : '0000-00-00';

let personal = 0, known = { id: 0, company: 0 }, old = 0;
const cands = [];

for (const inc of feed.incidents) {
  if (!isPersonal(inc)) continue;
  personal++;
  const pub = String(inc.dates.first_published || '');
  if (pub < cutoff) { old++; continue; }
  const k = isKnown(inc, idx);
  if (k) { known[k]++; continue; }
  cands.push(inc);
}

cands.sort((a, b) => String(b.dates.first_published).localeCompare(String(a.dates.first_published)));

console.log(`情報源 ${feed.incidents.length} 件 / 個人情報を含む ${personal} 件`);
console.log(`既収録 ${known.id + known.company} 件（事案ID一致 ${known.id} / 企業名と公表月一致 ${known.company}）`);
if (MAX_AGE_DAYS) console.log(`${MAX_AGE_DAYS}日より前のため対象外 ${old} 件`);
console.log(`未収録 ${cands.length} 件\n`);

for (const inc of cands) {
  const r = recordsOf(inc);
  console.log(`CAND ${inc.dates.first_published}\t${inc.organization.name}\t${statusOf(inc)}\t${causeOf(inc)}\t${r.text}\t${categoriesOf(inc).join('|')}\t${inc.url}`);
}

console.log(`\ndata_version: ${feed.data_version}`);

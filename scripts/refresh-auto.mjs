#!/usr/bin/env node
/* LeakScan — 自動追記した事案を、情報源の構造化データで作り直す。
 *
 * 目的:
 *  1. 以前は情報源の要約文をそのまま scope に入れていた。相手方の文章なので、
 *     構造化された項目から組み立てた自分の文に差し替える。
 *  2. 漏洩項目・原因・状態・件数を、文章からの推測ではなく情報源の列挙値から取り直す。
 *  3. 業種が未分類のものを埋める。
 *
 * 人が確認して入れた事案（auto でないもの）には触らない。
 * 照合用ドメインと、追加済みの公式発表の出典も触らない。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFeed, categoriesOf, causeOf, statusOf, recordsOf, scopeOf } from './lib/source-feed.mjs';
import { guessSector, sectorFromDomain } from './lib/sector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));

const feed = await fetchFeed();
const byId = new Map(feed.incidents.map((i) => [i.id, i]));

let touched = 0, sectors = 0, missing = 0;
const changes = [];

for (const e of db) {
  /* 業種の推定は人が入れた事案にも効かせる（未分類のものだけ） */
  if (e.sector === '未分類') {
    const s = guessSector(e.company, e.service);
    const t = s !== '未分類' ? s : sectorFromDomain(e.match.domains);
    if (t !== '未分類') { e.sector = t; sectors++; }
  }

  if (!e.auto) continue;

  const srcId = (e.sources || [])
    .map((s) => /incidents\/([0-9a-z-]+)\//.exec(s.url))
    .filter(Boolean)
    .map((m) => m[1])[0];
  const inc = srcId && byId.get(srcId);
  if (!inc) { missing++; continue; }

  const before = JSON.stringify([e.categories, e.cause, e.status, e.records, e.records_num, e.scope]);
  const r = recordsOf(inc);
  e.categories = categoriesOf(inc);
  e.cause = causeOf(inc);
  e.status = statusOf(inc);
  e.records = r.text;
  e.records_num = r.num;
  e.scope = scopeOf(inc, meta);
  if (JSON.stringify([e.categories, e.cause, e.status, e.records, e.records_num, e.scope]) !== before) {
    touched++;
    changes.push(e.company);
  }
}

db.sort((a, b) => String(b.disclosed).localeCompare(String(a.disclosed)) || a.id.localeCompare(b.id));
writeFileSync(join(ROOT, 'data/breaches.json'), JSON.stringify(db, null, 2) + '\n');

console.log(`情報源 ${feed.incidents.length} 件を参照`);
console.log(`自動追記分を更新: ${touched} 件`);
console.log(`業種を補完: ${sectors} 件`);
if (missing) console.log(`情報源に見つからず据え置き: ${missing} 件`);

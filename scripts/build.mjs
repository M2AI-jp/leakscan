#!/usr/bin/env node
/* LeakScan — derive publishable artifacts from data/ and sync them to the
 * site and the extension. Run after editing data/breaches.json. */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const d = (p) => join(ROOT, p);

const entries = JSON.parse(readFileSync(d('data/breaches.json'), 'utf8'));
const meta = JSON.parse(readFileSync(d('data/meta.json'), 'utf8'));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ---- breaches.csv : one row per incident ---- */
const COLS = ['id', 'company', 'service', 'sector', 'disclosed', 'records', 'records_num',
  'status', 'cause', 'ai_link', 'categories', 'domains', 'names', 'scope', 'source_urls'];
const csv = [COLS.join(',')];
for (const e of entries) {
  csv.push([
    e.id, e.company, e.service, e.sector, e.disclosed, e.records,
    e.records_num ?? '', e.status, e.cause, e.ai_link,
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
const sev3 = ['card', 'bank', 'password', 'id_document', 'login_credential'];
const stats = {
  generated: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
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

console.log(`${entries.length} 件 / ${stats.companies} 社 / ドメイン ${stats.domains} 件`);
console.log('生成: data/breaches.csv, data/domains.tsv, data/stats.json');
console.log('同期: site/data/, extension/data/');

#!/usr/bin/env node
/* LeakScan — link rot check. A breach list whose citations 404 is worthless,
 * so every source URL in the dataset is checked. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entries = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));

const urls = new Map();
for (const e of entries) for (const s of e.sources || []) {
  if (!urls.has(s.url)) urls.set(s.url, []);
  urls.get(s.url).push(e.id);
}

const UA = { 'user-agent': 'LeakScan-link-check/1.0 (+https://leakscan.matsunai.com)' };
const dead = [];
let ok = 0;

async function probe(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (res.ok) return { ok: true };
      if (method === 'GET') return { ok: false, status: res.status };
    } catch (e) {
      if (method === 'GET') return { ok: false, status: String(e.message || e) };
    }
  }
  return { ok: false, status: 'unknown' };
}

const list = [...urls.keys()];
for (let i = 0; i < list.length; i += 5) {
  const batch = list.slice(i, i + 5);
  const results = await Promise.all(batch.map(probe));
  batch.forEach((url, n) => {
    if (results[n].ok) ok++;
    else dead.push({ url, status: results[n].status, ids: urls.get(url) });
  });
}

console.log(`出典URL ${list.length} 件中 ${ok} 件が生存`);
if (dead.length) {
  console.log(`\nリンク切れ ${dead.length} 件:`);
  for (const d of dead) console.log(`  ✗ [${d.status}] ${d.url}\n      使用: ${d.ids.join(', ')}`);
  process.exit(1);
}

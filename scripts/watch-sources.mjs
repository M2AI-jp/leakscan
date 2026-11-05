#!/usr/bin/env node
/* LeakScan — detect that a monitored source has changed.
 *
 * Deliberately does NOT extract incidents automatically: publishing a company
 * name as a breach victim without a human reading the announcement is how you
 * libel someone. This only says "these pages changed, go look".
 *
 *   node scripts/watch-sources.mjs          # report, update the lock file
 *   node scripts/watch-sources.mjs --check  # report only, exit 1 if changed
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'data/sources.lock.json');
const checkOnly = process.argv.includes('--check');

const { watch } = JSON.parse(readFileSync(join(ROOT, 'data/sources.json'), 'utf8'));
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};

/* Strip the volatile parts of a page so ads and timestamps don't look like news. */
function fingerprint(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

const changed = [];
const failed = [];
const next = {};

for (const src of watch) {
  try {
    const res = await fetch(src.url, {
      headers: { 'user-agent': 'LeakScan-source-watch/1.0 (+https://leakscan.matsunai.com)' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fp = fingerprint(await res.text());
    next[src.url] = { name: src.name, weight: src.weight, fingerprint: fp, checked: new Date().toISOString() };
    const prev = lock[src.url];
    if (prev && prev.fingerprint !== fp) changed.push(src);
    else if (!prev) changed.push({ ...src, first: true });
  } catch (e) {
    failed.push({ ...src, error: String(e.message || e) });
    if (lock[src.url]) next[src.url] = lock[src.url];
  }
}

for (const c of changed) console.log(`CHANGED\t${c.weight}\t${c.name}\t${c.url}${c.first ? '\t(初回)' : ''}`);
for (const f of failed) console.log(`FAILED\t${f.name}\t${f.url}\t${f.error}`);
if (!changed.length && !failed.length) console.log('変更なし');

if (!checkOnly) writeFileSync(LOCK, JSON.stringify(next, null, 2) + '\n');
if (checkOnly && changed.length) process.exit(1);

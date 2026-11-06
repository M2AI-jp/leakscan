#!/usr/bin/env node
/* LeakScan — Chrome ウェブストアに上げる zip を作り、中身を点検する。
 *
 *   node scripts/package.mjs
 *
 * 点検すること:
 *  - manifest の必須項目と、宣言したファイルが実在すること
 *  - 同梱データが data/ の正本と一致していること（古いコピーを配らない）
 *  - 要らないものが混ざっていないこと（.DS_Store、ソースマップ、鍵など）
 *  - JavaScript が構文として読めること
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const OUT = join(ROOT, 'dist');

const errors = [];
const notes = [];

/* ---- manifest ---- */
const mf = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
for (const k of ['manifest_version', 'name', 'version', 'description', 'icons', 'permissions']) {
  if (mf[k] == null) errors.push(`manifest に ${k} がない`);
}
if (mf.manifest_version !== 3) errors.push(`manifest_version が ${mf.manifest_version}（3 であること）`);
if (!/^\d+\.\d+\.\d+$/.test(String(mf.version))) errors.push(`version の形式: ${mf.version}`);

/* ---- 同梱ファイルを集める ---- */
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);
const BAD_EXT = new Set(['.map', '.pem', '.crx', '.zip', '.log']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.startsWith('.')) { notes.push(`除外: ${relative(EXT, join(dir, name))}`); continue; }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(EXT);

for (const f of files) {
  const rel = relative(EXT, f);
  if (BAD_EXT.has(extname(f))) errors.push(`配布に含めてはいけないファイル: ${rel}`);
}

/* ---- manifest が指すファイルの実在 ---- */
const declared = [
  ...Object.values(mf.icons || {}),
  ...(mf.background?.service_worker ? [mf.background.service_worker] : []),
  ...(mf.action?.default_popup ? [mf.action.default_popup] : []),
  ...(mf.options_page ? [mf.options_page] : []),
  ...(mf.options_ui?.page ? [mf.options_ui.page] : []),
  ...(mf.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(mf.web_accessible_resources || []).flatMap((w) => w.resources || [])
];
for (const d of declared) {
  if (!existsSync(join(EXT, d))) errors.push(`manifest が指すファイルがない: ${d}`);
}

/* ---- 同梱データが正本と一致しているか ---- */
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const f of ['breaches.json', 'meta.json']) {
  const a = join(ROOT, 'data', f);
  const b = join(EXT, 'data', f);
  if (!existsSync(b)) { errors.push(`同梱データがない: data/${f}`); continue; }
  if (sha(a) !== sha(b)) errors.push(`同梱データが古い: data/${f}（node scripts/build.mjs を実行）`);
}

/* ---- JavaScript の構文 ---- */
for (const f of files.filter((f) => extname(f) === '.js')) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { errors.push(`構文エラー: ${relative(EXT, f)}`); }
}

/* ---- zip ---- */
const name = `leakscan-${mf.version}.zip`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync('zip', ['-r', '-q', '-X', join(OUT, name), '.', '-x', '.*', '-x', '*/.*'], { cwd: EXT });

const size = statSync(join(OUT, name)).size;
const entries = JSON.parse(readFileSync(join(EXT, 'data/breaches.json'), 'utf8')).length;

/* ---- 手動インストール用に、同じ zip をサイトへ置く ----
   審査待ちの間、技術が分かる人が自分で入れられるようにするため。
   ストアに出すものと同一のファイルを配り、照合できるよう SHA-256 を併記する。 */
const DL = join(ROOT, 'site/download');
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
const bytes = readFileSync(join(OUT, name));
copyFileSync(join(OUT, name), join(DL, name));
const zipSha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(
  join(DL, 'latest.json'),
  JSON.stringify(
    { version: mf.version, file: name, size, sha256: zipSha, entries, built: new Date().toISOString().slice(0, 10) },
    null,
    2
  ) + '\n'
);

console.log(`${mf.name} v${mf.version}`);
console.log(`ファイル ${files.length} 件 / 同梱事案 ${entries} 件`);
console.log(`dist/${name}  ${(size / 1024).toFixed(0)} KB`);
if (notes.length) console.log(`\n${notes.join('\n')}`);
if (errors.length) {
  console.error(`\nエラー ${errors.length} 件:`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('\n点検: 問題なし');

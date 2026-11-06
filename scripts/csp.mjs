/* site/_headers の Content-Security-Policy を組み立てる。
 *
 * ページ内に直接書いたスクリプトを許すために 'unsafe-inline' を使うと、
 * 誰かが差し込んだスクリプトも一緒に通ってしまう。そこで一つずつ
 * ハッシュを取り、その中身だけを許す。
 *
 * ハッシュはHTMLを直せば変わるので、手で書き写すと必ず古くなる。
 * build.mjs から呼び、CIでも差分を見て、古いままコミットできないようにしている。
 *
 *   node scripts/csp.mjs           # 書き換える
 *   node scripts/csp.mjs --check   # 古くなっていないか見るだけ
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const HEADERS = join(SITE, '_headers');

/** 外部から読むものの許可先。ここに無いものは一切読み込まれない。 */
const SOURCES = {
  /* 漏洩データの取得先。配信が止まっているときはGitHub側を読む */
  connect: ["'self'", 'https://raw.githubusercontent.com']
};

/** HTMLから、src属性のない <script> の中身を取り出す。 */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

/** CSPが照合するのは、タグの間の文字そのまま（前後も削らない）。 */
function sha256(text) {
  return "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";
}

export function buildCsp() {
  const pages = readdirSync(SITE).filter((f) => f.endsWith('.html')).sort();
  const hashes = [];
  const seen = new Set();
  const found = [];
  for (const page of pages) {
    const scripts = inlineScripts(readFileSync(join(SITE, page), 'utf8'));
    found.push(`${page}: ${scripts.length}`);
    for (const s of scripts) {
      const h = sha256(s);
      if (seen.has(h)) continue;
      seen.add(h);
      hashes.push(h);
    }
  }
  const csp = [
    /* 既定は全部禁止。以下で挙げたものだけを通す */
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${SOURCES.connect.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests'
  ].join('; ');
  return { csp, hashes, found };
}

const LINE = /^(\s*)Content-Security-Policy:.*$/m;

/** site/_headers の CSP を今のHTMLに合わせる。write:false なら書かずに判定だけ。 */
export function updateHeaders(write = true) {
  const { csp, hashes, found } = buildCsp();
  const before = readFileSync(HEADERS, 'utf8');
  if (!LINE.test(before)) {
    throw new Error('site/_headers に Content-Security-Policy の行が見つかりません');
  }
  const after = before.replace(LINE, (_m, indent) => `${indent}Content-Security-Policy: ${csp}`);
  const changed = after !== before;
  if (changed && write) writeFileSync(HEADERS, after);
  return { changed, hashes, found };
}

function main() {
  const check = process.argv.includes('--check');
  let r;
  try { r = updateHeaders(!check); }
  catch (e) { console.error(String(e.message || e)); process.exit(2); }

  console.log('ページ内スクリプト — ' + r.found.join(' / '));
  console.log(`ハッシュ ${r.hashes.length} 件`);
  if (!r.changed) { console.log('site/_headers は最新です'); return; }
  if (check) {
    console.error('site/_headers の CSP が古くなっています。node scripts/csp.mjs を実行してください。');
    process.exit(1);
  }
  console.log('更新: site/_headers');
}

/* パスに空白が入ると import.meta.url は符号化されるので、URL同士で比べる */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

/* SNSに貼ったときに出る画像（1200×630）を作る。
 *
 *   node scripts/og.mjs
 *
 * 数字は data/stats.json から入れるので、件数が増えれば作り直すだけで追従する。
 * Chromium は おことづけの広告工場のものを借りる（あちらには書き込まない）。 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const stats = JSON.parse(readFileSync(join(ROOT, 'data/stats.json'), 'utf8'));
const num = stats.records_total.toLocaleString('en-US').replace(/,/g, '<i>,</i>');

const html = `<!DOCTYPE html><html lang="ja"><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:#0c0f14;color:#e8ecf3;
  font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
  font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased;
  padding:66px 72px;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;align-items:center;gap:13px}
.top svg{width:38px;height:38px}
.top b{font-size:30px;font-weight:800;letter-spacing:-.01em;color:#fff}
.top b i{font-style:normal;font-size:20px;color:#6b7688;padding-left:4px}
.k{font-size:33px;font-weight:800;color:#9aa5b8;letter-spacing:-.01em;margin-bottom:14px}
.n{font-size:128px;font-weight:800;line-height:1;letter-spacing:-.045em;color:#fff;
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:12px}
.n i{font-style:normal;color:#3d4a60;padding:0 1px}
.n u{text-decoration:none;font-size:44px;color:#9aa5b8}
.sub{margin-top:20px;font-size:23px;color:#6b7688}
.cs{display:flex;gap:11px}
.cs span{font-size:21px;font-weight:700;padding:11px 22px;border-radius:999px;
  background:#13251e;border:1px solid #1e4435;color:#5ddba4}
.cs span.b{background:#101b28;border-color:#1d3b5c;color:#4da3ff}
</style>
<div class="top">
  <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#141923"/>
  <path d="M16 4.5 6 8.4v8.9c0 5.5 4.1 9.5 10 10.7 5.9-1.2 10-5.2 10-10.7V8.4L16 4.5Z" fill="none" stroke="#4da3ff" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M11.6 16.4l3.3 3.3 6-6.2" fill="none" stroke="#4da3ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <b>情報漏洩チェッカー<i>2026</i></b>
</div>
<div>
  <div class="k">2026年に漏洩した個人情報</div>
  <div class="n">${num}<u>件</u></div>
  <div class="sub">${stats.incidents}件・${stats.companies}社の公表値の合計（重複を含むのべ件数）</div>
</div>
<div class="cs">
  <span>完全無料</span><span>登録不要</span><span>本文は読まない</span><span>外部送信なし</span>
</div>
</html>`;

const require = createRequire('/Users/amano/dev/okotozuke-ads/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
mkdirSync(join(ROOT, 'site/assets'), { recursive: true });
await page.screenshot({ path: join(ROOT, 'site/assets/og.png') });
await browser.close();

/* 画像の中の数字と og:image:alt が食い違わないよう、alt はここで書く。
 * 手で写すと、件数が増えたときに必ずどちらかが取り残される。 */
const plain = stats.records_total.toLocaleString('en-US');
const alt = `2026年に漏洩した個人情報 ${plain}件`;
let touched = 0;
const SITE = join(ROOT, 'site');
for (const f of readdirSync(SITE).filter((x) => x.endsWith('.html')).sort()) {
  const path = join(SITE, f);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(/(<meta property="og:image:alt" content=")[^"]*(">)/, `$1${alt}$2`);
  if (after !== before) { writeFileSync(path, after); touched++; }
}

/* 何件で作った画像かを残す。build.mjs がこれを見て、古くなっていたら教える
 * （画像の生成にはブラウザが要るので、CIでは作り直せない）。 */
writeFileSync(join(ROOT, 'site/assets/og.json'),
  JSON.stringify({ records_total: stats.records_total, incidents: stats.incidents }, null, 2) + '\n');

console.log('生成: site/assets/og.png (1200x630)');
console.log(`alt: ${alt}` + (touched ? ` → ${touched}ページを更新` : '（変更なし）'));
console.log('記録: site/assets/og.json');

/* scene.html を1コマずつ書き出す。
 *
 *   node promo/v2/render.mjs [出力先]
 *
 * 時刻は promo/v2/cues.json が正。尺もコマ数もそこから取るので、
 * 間を変えたいときは cues.json だけ直せば、絵と音が一緒にずれる。
 *
 * 同じ時刻なら必ず同じ絵が出るように、状態はページ側の __seek(t) だけで決め、
 * CSSのアニメーションは使っていない（再生任せだとコマ落ちで揺れるため）。
 *
 * Chromium は おことづけの広告工場（~/dev/okotozuke-ads）のものを借りる。
 * あちらには何も書き込まない。読むだけ。 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PW = '/Users/amano/dev/okotozuke-ads/package.json';

const cues = JSON.parse(readFileSync(`${HERE}/cues.json`, 'utf8'));
const OUT = resolve(process.argv[2] || `${HERE}/frames`);
const { fps: FPS, dur: DUR } = cues;
const W = 1920, H = 1080;

const require = createRequire(PW);
const { chromium } = require('playwright');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(`${HERE}/scene.html`).href, { waitUntil: 'load' });
/* 書体が届く前に撮ると、1コマ目だけ別の字になる */
await page.evaluate(() => document.fonts.ready);
await page.evaluate((c) => window.__cues(c), cues);
await page.waitForTimeout(400);

const total = Math.round(DUR * FPS);
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate((x) => window.__seek(x), i / FPS);
  await page.screenshot({ path: `${OUT}/f${String(i).padStart(4, '0')}.png`, animations: 'disabled' });
  if (i % 120 === 0) process.stdout.write(`\r  ${i}/${total} コマ`);
}
process.stdout.write(`\r  ${total}/${total} コマ  ${((Date.now() - t0) / 1000).toFixed(1)}秒\n`);
await browser.close();

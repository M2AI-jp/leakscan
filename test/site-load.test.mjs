/* サイトがどちらのデータを出すかの検査。
 *
 *   node test/site-load.test.mjs
 *
 * 配信物はデプロイした時にしか変わらない。日次の収集結果は毎朝GitHubに入る。
 * site/assets/app.js の LeakScan.load はその両方を見比べて新しい方を出す。
 * ここが間違っていると、毎朝収集していても画面はデプロイした日のまま古く見える。
 *
 * app.js は window と fetch が無いと読めないので、入れ物を渡して動かす。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../site/assets/app.js', import.meta.url), 'utf8');
const GH = 'https://raw.githubusercontent.com/M2AI-jp/leakscan/main/data/';

/** 与えた応答を返す fetch で app.js を動かし、LeakScan を返す。 */
function boot(responses) {
  const win = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} }
  };
  const doc = { documentElement: { dataset: {} } };
  const fetch = async (url) => {
    const key = url.startsWith(GH) ? GH + url.slice(GH.length) : url;
    if (!(key in responses)) throw new Error('想定外の取得: ' + url);
    const v = responses[key];
    if (v === null) throw new Error('取得できない');
    return { ok: true, json: async () => v };
  };
  new Function('window', 'document', 'fetch', 'localStorage', 'matchMedia', 'AbortSignal', SRC)(
    win, doc, fetch, win.localStorage, win.matchMedia, undefined
  );
  return win.LeakScan;
}

const ENT_SITE = [{ id: 'a', service: 'S', match: { domains: [] }, sources: [] }];
const ENT_GH = [
  { id: 'a', service: 'S', match: { domains: [] }, sources: [] },
  { id: 'b', service: 'T', match: { domains: [] }, sources: [] }
];
const base = (o) => Object.assign({ schema: 1, updated: '2026-11-06', checked: '2026-11-06' }, o);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { fail++; console.error('NG ' + name + '\n   ' + (e && e.message)); }
};

/* ---------------------------------------------- 事案が増えた日 */
await ok('GitHubのデータが新しければ、そちらの事案を出す', async () => {
  const L = boot({
    'data/meta.json': base({}),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: base({ updated: '2026-11-07', checked: '2026-11-07' }),
    [GH + 'breaches.json']: ENT_GH
  });
  const r = await L.load();
  assert.equal(r.from, 'github');
  assert.equal(r.entries.length, 2);
  assert.equal(r.meta.updated, '2026-11-07');
});

/* ---------------------------------------------- 新しい事案が無かった日 */
await ok('事案が同じで確認日だけ新しければ、確認日だけ新しくする', async () => {
  const L = boot({
    'data/meta.json': base({}),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: base({ checked: '2026-11-09' })
    /* breaches.json を置いていない。取りにいったら「想定外の取得」で落ちる */
  });
  const r = await L.load();
  assert.equal(r.from, 'site+gh');
  assert.equal(r.meta.checked, '2026-11-09');
  assert.equal(r.meta.updated, '2026-11-06', 'データは変わっていないので更新日は動かさない');
  assert.equal(r.entries.length, 1, '事案は取り直さない（無駄な通信をしない）');
});

await ok('配信物のラベルは保たれる（GitHubのmetaで丸ごと置き換えない）', async () => {
  const L = boot({
    'data/meta.json': base({ status_labels: { confirmed: '漏洩を確認' } }),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: base({ checked: '2026-11-09' })
  });
  const r = await L.load();
  assert.deepEqual(r.meta.status_labels, { confirmed: '漏洩を確認' });
});

/* ---------------------------------------------- 動かしてはいけない時 */
await ok('GitHubが古ければ配信物をそのまま出す', async () => {
  const L = boot({
    'data/meta.json': base({ updated: '2026-11-06', checked: '2026-11-08' }),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: base({ updated: '2026-10-01', checked: '2026-10-01' })
  });
  const r = await L.load();
  assert.equal(r.from, 'site');
  assert.equal(r.meta.checked, '2026-11-08');
});

await ok('GitHubが読めなくても配信物で表示できる', async () => {
  const L = boot({
    'data/meta.json': base({}),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: null
  });
  const r = await L.load();
  assert.equal(r.from, 'site');
  assert.equal(r.entries.length, 1);
});

await ok('データが新しいのに事案が取れなければ、配信物に戻す', async () => {
  const L = boot({
    'data/meta.json': base({}),
    'data/breaches.json': ENT_SITE,
    [GH + 'meta.json']: base({ updated: '2026-11-07' }),
    [GH + 'breaches.json']: null
  });
  const r = await L.load();
  assert.equal(r.from, 'site');
  assert.equal(r.meta.updated, '2026-11-06');
});

/* ---------------------------------------------- 乗っ取られた場合 */
await ok('日付の形をしていない値は使わない', async () => {
  for (const bad of ['<img src=x onerror=alert(1)>', '9999-99', 'javascript:alert(1)',
                     '2026-11-09x', { toString: () => '2026-11-09' }, 99, null, true]) {
    const L = boot({
      'data/meta.json': base({}),
      'data/breaches.json': ENT_SITE,
      [GH + 'meta.json']: base({ checked: bad })
    });
    const r = await L.load();
    assert.equal(r.meta.checked, '2026-11-06', '通ってしまった: ' + JSON.stringify(bad));
  }
});

await ok('GitHubのmetaが配列や文字列でも落ちない', async () => {
  for (const bad of [[], 'x', 42, true]) {
    const L = boot({
      'data/meta.json': base({}),
      'data/breaches.json': ENT_SITE,
      [GH + 'meta.json']: bad
    });
    const r = await L.load();
    assert.equal(r.from, 'site');
  }
});

/* ---------------------------------------------- 表示する日付の選び方 */
await ok('lastChecked は新しい方を返し、checked が無くても動く', async () => {
  const L = boot({ 'data/meta.json': base({}), 'data/breaches.json': ENT_SITE, [GH + 'meta.json']: null });
  assert.equal(L.lastChecked({ updated: '2026-11-06' }), '2026-11-06');
  assert.equal(L.lastChecked({ updated: '2026-11-06', checked: '2026-11-09' }), '2026-11-09');
  assert.equal(L.lastChecked({ updated: '2026-11-06', checked: '2026-11-01' }), '2026-11-06');
  assert.equal(L.lastChecked({}), '');
  assert.equal(L.lastChecked(null), '');
});

console.log(`検査（サイトがどちらのデータを出すか）: ${pass} 件合格` + (fail ? ` / ${fail} 件失敗` : ''));
process.exit(fail ? 1 : 0);

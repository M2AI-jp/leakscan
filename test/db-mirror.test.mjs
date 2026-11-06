/* 漏洩データの入手先の選び方を確かめる。
 *
 * 拡張機能は配信サイトと公開リポジトリの両方を見て、更新日の新しい方を使う。
 * 配信が止まっていてもデータが古くならないことが要点なので、
 * そこをいちばん厚く確かめる。
 *
 *   node test/db-mirror.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SITE = 'https://leakscan.matsunai.com/data/';
const GH = 'https://raw.githubusercontent.com/M2AI-jp/leakscan/main/data/';

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ' — ' + e.message); }
}

/* ------------------------------------------------- 拡張機能の環境を用意する */

/** 1件だけの最小データ。中身の正しさは match.test.js が見ているので、
 *  ここでは「どの入手先から来たか」が分かればよい。 */
function dataset(tag) {
  return [{ id: tag, service: tag, match: { domains: [tag + '.example'], names: [] } }];
}

/** chrome.* の、このテストに要るところだけ。 */
function fakeChrome() {
  const store = {};
  const listeners = [];
  return {
    _listeners: listeners,
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: store[key] };
          return Object.assign({}, store);
        },
        async set(patch) { Object.assign(store, patch); },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; }
      }
    },
    runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} }
    },
    tabs: { onUpdated: { addListener: () => {}, removeListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
}

/** url → 返すもの の表を受け取り、載っていないURLは失敗させる。
 *  値が null なら「その入手先は落ちている」を表す。 */
function fakeFetch(table) {
  const seen = [];
  const fn = async (url) => {
    seen.push(String(url));
    const body = table[String(url)];
    if (body === undefined || body === null) throw new Error('network down: ' + url);
    return { ok: true, status: 200, json: async () => body };
  };
  fn.seen = seen;
  return fn;
}

/** 同梱のコピーは常に読める、という前提を表の既定として入れておく。 */
function bundled(table) {
  return Object.assign({
    'chrome-extension://test/data/meta.json': { updated: '2026-10-01', version: '2026.10.01' },
    'chrome-extension://test/data/breaches.json': dataset('bundled')
  }, table);
}

/* background.js はモジュールとして読み込むと一度しか評価されないので、
   原文を読んで、場合ごとに新しい入れ物の中で動かす。
   chrome と fetch を引数で渡せば、本物のグローバルには触らずに済む。 */
const SRC = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

/** 一から起動した拡張機能に LEAKSCAN_REFRESH_DB を送り、その答えを返す。 */
async function refresh(table) {
  const chromeStub = fakeChrome();
  // eslint-disable-next-line no-new-func
  new Function('chrome', 'fetch', SRC)(chromeStub, fakeFetch(bundled(table)));
  const listener = chromeStub._listeners[0];
  assert.ok(listener, 'background.js がメッセージを受け付けていない');
  return await new Promise((resolve) => {
    listener({ type: 'LEAKSCAN_REFRESH_DB' }, {}, resolve);
  });
}

/* ------------------------------------------------------------------ 本題 */

const siteOld = {
  [SITE + 'meta.json']: { updated: '2026-11-01', version: '2026.11.01' },
  [SITE + 'breaches.json']: dataset('site')
};
const ghNew = {
  [GH + 'meta.json']: { updated: '2026-11-06', version: '2026.11.06' },
  [GH + 'breaches.json']: dataset('github')
};

const r1 = await refresh(Object.assign({}, siteOld, ghNew));
check('配信物が古いときはGitHub側を使う', () => {
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'remote');
  assert.equal(r1.origin, GH);
});

const r2 = await refresh(Object.assign({}, siteOld, {
  [GH + 'meta.json']: { updated: '2026-10-20', version: '2026.10.20' },
  [GH + 'breaches.json']: dataset('github')
}));
check('配信物が新しいときは配信物を使う', () => {
  assert.equal(r2.origin, SITE);
});

const r3 = await refresh(Object.assign({}, siteOld, {
  [GH + 'meta.json']: { updated: '2026-11-01', version: '2026.11.01' },
  [GH + 'breaches.json']: dataset('github')
}));
check('更新日が同じときは配信物を優先する', () => {
  assert.equal(r3.origin, SITE);
});

const r4 = await refresh(Object.assign({}, ghNew, {
  [SITE + 'meta.json']: null,
  [SITE + 'breaches.json']: null
}));
check('配信サイトが落ちていてもGitHub側で動く', () => {
  assert.equal(r4.source, 'remote');
  assert.equal(r4.origin, GH);
});

const r5 = await refresh(Object.assign({}, siteOld, {
  [GH + 'meta.json']: null,
  [GH + 'breaches.json']: null
}));
check('GitHubが読めなくても配信物で動く', () => {
  assert.equal(r5.source, 'remote');
  assert.equal(r5.origin, SITE);
});

const r6 = await refresh({
  [SITE + 'meta.json']: null, [SITE + 'breaches.json']: null,
  [GH + 'meta.json']: null, [GH + 'breaches.json']: null
});
check('どちらも読めなければ同梱のコピーに戻る', () => {
  assert.equal(r6.source, 'bundled');
  assert.ok(r6.lastError, '失敗した理由が残っていない');
});

/* 更新日は読めたのに本体が読めない、という半端な状態。
   ここで止まらず、残った入手先に進めることを確かめる。 */
const r7 = await refresh(Object.assign({}, siteOld, {
  [GH + 'meta.json']: { updated: '2026-11-06', version: '2026.11.06' },
  [GH + 'breaches.json']: null
}));
check('新しい方の本体が読めなければ古い方へ下がる', () => {
  assert.equal(r7.source, 'remote');
  assert.equal(r7.origin, SITE);
});

const r8 = await refresh(Object.assign({}, siteOld, {
  [GH + 'meta.json']: { updated: '2026-11-06', version: '2026.11.06' },
  [GH + 'breaches.json']: []
}));
check('中身が空の入手先は使わない', () => {
  assert.equal(r8.origin, SITE);
});

/* ------------------------------------------------------------------ 結果 */

console.log(`入手先の選択: ${pass} 件合格`);
if (fails.length) {
  console.error('\n不合格:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}

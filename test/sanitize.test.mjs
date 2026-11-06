/* 配信元が乗っ取られて中身を差し替えられた場合の検査。
 *
 * breaches.json / meta.json は外から来る。ここが書き換えられても、
 * 画面やGmailの検索式に悪い文字列が流れ込まないことを確かめる。
 *
 *   node test/sanitize.test.mjs
 *
 * background.js は chrome が無いと読めないので、原文を読んで新しい入れ物の中で
 * 動かし、末尾で検査関数だけ返してもらう（本物のグローバルには触らない）。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
/* background.js が触る chrome の枝を、何もしない関数で埋める。
   どこを触るかは実装が変われば増えるので、無い枝は自動で生やす。 */
const noop = () => {};
const listener = () => ({ addListener: noop, removeListener: noop });
const stubChrome = new Proxy({}, {
  get(t, k) {
    if (k === 'runtime') return new Proxy({ getURL: (p) => 'chrome-extension://x/' + p },
      { get: (o, n) => (n in o ? o[n] : (String(n).startsWith('on') ? listener() : noop)) });
    if (k === 'storage') return { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } };
    if (k === 'alarms') return { create: noop, clear: noop, onAlarm: listener() };
    return new Proxy({}, { get: (o, n) => (String(n).startsWith('on') ? listener() : noop) });
  }
});
const { sanitizeEntries, sanitizeMeta } =
  new Function('chrome', 'fetch', SRC + '\nreturn { sanitizeEntries, sanitizeMeta };')(stubChrome, async () => {
    throw new Error('no network in this test');
  });

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('NG ' + name + '\n   ' + (e && e.message)); }
};

/* ---------------------------------------------- 出典のURL */
ok('javascript: の出典は捨てる', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S',
    sources: [{ url: 'javascript:alert(1)', title: '出典' }] }]);
  assert.equal(entries[0].sources.length, 0);
});

ok('data: の出典は捨てる', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S',
    sources: [{ url: 'data:text/html,<script>alert(1)</script>', title: 'x' }] }]);
  assert.equal(entries[0].sources.length, 0);
});

ok('大文字や空白で隠した javascript: も捨てる', () => {
  for (const u of ['JavaScript:alert(1)', '  javascript:alert(1)', 'jAvAsCrIpT:alert(1)',
                   'vbscript:msgbox(1)', 'chrome-extension://abc/x.html', 'file:///etc/passwd']) {
    const { entries } = sanitizeEntries([{ id: 'a', service: 'S', sources: [{ url: u, title: 't' }] }]);
    assert.equal(entries[0].sources.length, 0, u + ' が通ってしまう');
  }
});

ok('http と https の出典は残る', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S', sources: [
    { url: 'https://example.com/a', title: 'A' }, { url: 'http://example.com/b', title: 'B' }] }]);
  assert.equal(entries[0].sources.length, 2);
});

/* ---------------------------------------------- ドメイン（Gmailの検索式に入る） */
ok('検索演算子を混ぜたドメインは捨てる', () => {
  const bad = ['foo) OR (has:attachment', 'a.com in:anywhere', 'x.com"', "y.com'",
               'a b.com', 'a.com)', '*.com', 'a.com OR b.com', '(a.com)'];
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S', domains: bad }]);
  assert.deepEqual(entries[0].domains, [], '通ってしまった: ' + JSON.stringify(entries[0].domains));
});

ok('ふつうのドメインは残り、小文字になる', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S',
    domains: ['Example.COM', 'mail.example.co.jp', 'a-b.example.com'] }]);
  assert.deepEqual(entries[0].domains, ['example.com', 'mail.example.co.jp', 'a-b.example.com']);
});

/* ---------------------------------------------- 型と大きさ */
ok('文字列でない項目は空文字になる', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S',
    company: { toString: () => '<img src=x onerror=alert(1)>' }, scope: 42, status: ['x'] }]);
  assert.equal(entries[0].company, '');
  assert.equal(entries[0].scope, '');
  assert.equal(entries[0].status, '');
});

ok('idかserviceが無い事案は捨てる', () => {
  const { entries, dropped } = sanitizeEntries([
    { id: 'a', service: 'S' }, { id: '', service: 'S' }, { service: 'S' }, { id: 'c' }, null, 'x', 123]);
  assert.equal(entries.length, 1);
  assert.equal(dropped, 6);
});

ok('件数に上限がある（描画とGmail照会が終わらなくなるのを防ぐ）', () => {
  const huge = Array.from({ length: 20000 }, (_, i) => ({ id: 'i' + i, service: 'S' }));
  const { entries, dropped } = sanitizeEntries(huge);
  assert.equal(entries.length, 5000);
  assert.equal(dropped, 15000);
});

ok('長すぎる文字列は切られる', () => {
  const { entries } = sanitizeEntries([{ id: 'a', service: 'x'.repeat(10000),
    scope: 'y'.repeat(10000), names: ['z'.repeat(10000)] }]);
  assert.equal(entries[0].service.length, 120);
  assert.equal(entries[0].scope.length, 400);
  assert.equal(entries[0].names[0].length, 120);
});

ok('項目ごとの個数にも上限がある', () => {
  const many = Array.from({ length: 500 }, (_, i) => 'd' + i + '.example.com');
  const { entries } = sanitizeEntries([{ id: 'a', service: 'S', domains: many, names: many }]);
  assert.ok(entries[0].domains.length <= 40);
  assert.ok(entries[0].names.length <= 40);
});

ok('配列でないものを渡しても落ちない', () => {
  for (const v of [null, undefined, 42, 'x', {}, { length: 3 }]) {
    const r = sanitizeEntries(v);
    assert.deepEqual(r.entries, []);
  }
});

/* ---------------------------------------------- meta（画面に出る） */
ok('metaのラベルは文字列だけ通る', () => {
  const m = sanitizeMeta({ name: 'N', homepage: 'javascript:alert(1)',
    status_labels: { a: '確認', b: 123, c: { x: 1 } }, categories: null, schema: 1 });
  assert.equal(m.homepage, '');
  assert.deepEqual(m.status_labels, { a: '確認' });
  assert.deepEqual(m.categories, {});
});

ok('metaが壊れていても落ちない', () => {
  for (const v of [null, undefined, 'x', 42, []]) assert.ok(sanitizeMeta(v));
});

console.log(`検査（配信元が乗っ取られた場合）: ${pass} 件合格` + (fail ? ` / ${fail} 件失敗` : ''));
process.exit(fail ? 1 : 0);

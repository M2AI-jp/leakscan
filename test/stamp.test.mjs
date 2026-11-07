/* 更新日が自動で押されるかの検査。
 *
 *   node test/stamp.test.mjs
 *
 * これが無かったあいだ、data/meta.json の updated は手で書いた値のままだった。
 * 日次ジョブが事案を追記してもサイトの「最終更新」は動かず、
 * 新しい事案が古い日付のまま出ていた。気づけなかったのはテストが無かったため。
 *
 * 仮の作業場にリポジトリを写してから build.mjs / stamp.mjs を動かす。
 * 本物の data/ には触らない。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'leakscan-stamp-'));
for (const dir of ['scripts', 'data', 'site', 'extension']) {
  cpSync(join(ROOT, dir), join(WORK, dir), { recursive: true });
}

const build = () => execFileSync('node', ['scripts/build.mjs'], { cwd: WORK, encoding: 'utf8' });
const stamp = () => execFileSync('node', ['scripts/stamp.mjs'], { cwd: WORK, encoding: 'utf8' });
const meta = () => JSON.parse(readFileSync(join(WORK, 'data/meta.json'), 'utf8'));
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('NG ' + name + '\n   ' + (e && e.message)); }
};

/* ---------------------------------------------- 中身が変わっていないとき */
const before = meta();
build();
ok('中身が同じなら更新日は動かない（CIが毎回落ちないため）', () => {
  const m = meta();
  assert.equal(m.updated, before.updated);
  assert.equal(m.version, before.version);
  assert.equal(m.fingerprint, before.fingerprint);
});

ok('リポジトリの meta.json の指紋は、いまの事案と一致している', () => {
  assert.ok(before.fingerprint, 'fingerprint が空（build.mjs を実行してコミットすること）');
  assert.equal(meta().fingerprint, before.fingerprint);
});

/* ---------------------------------------------- 事案が変わったとき */
const bpath = join(WORK, 'data/breaches.json');
const entries = JSON.parse(readFileSync(bpath, 'utf8'));
entries[0].scope = (entries[0].scope || '') + '（テスト）';
writeFileSync(bpath, JSON.stringify(entries, null, 2) + '\n');
build();

ok('事案が変わったら更新日が今日になる', () => {
  assert.equal(meta().updated, today);
});

ok('version も更新日に合う（二つが食い違わない）', () => {
  assert.equal(meta().version, today.replace(/-/g, '.'));
});

ok('指紋が変わっている', () => {
  assert.notEqual(meta().fingerprint, before.fingerprint);
});

ok('配信物とブラウザ拡張の写しにも新しい日付が入る', () => {
  for (const f of ['site/data/meta.json', 'extension/data/meta.json']) {
    const m = JSON.parse(readFileSync(join(WORK, f), 'utf8'));
    assert.equal(m.updated, today, f);
  }
});

const after = meta();
build();
ok('もう一度ビルドしても何も変わらない', () => {
  assert.deepEqual(meta(), after);
});

/* ---------------------------------------------- 確認日 */
ok('stamp.mjs は確認日を今日にする', () => {
  writeFileSync(join(WORK, 'data/meta.json'),
    JSON.stringify({ ...after, checked: '2020-01-01' }, null, 2) + '\n');
  stamp();
  assert.equal(meta().checked, today);
});

ok('stamp.mjs は更新日に触らない（「確認した」と「変わった」は別のこと）', () => {
  assert.equal(meta().updated, after.updated);
  assert.equal(meta().fingerprint, after.fingerprint);
});

ok('stamp.mjs を二度動かしても何も変わらない', () => {
  const m1 = meta();
  stamp();
  assert.deepEqual(meta(), m1);
});

ok('確認日は更新日より古く表示されない', () => {
  /* site/assets/app.js の lastChecked と同じ規則 */
  const lastChecked = (m) => {
    const u = String(m.updated || ''), c = String(m.checked || '');
    return c > u ? c : u;
  };
  assert.equal(lastChecked({ updated: '2026-11-06' }), '2026-11-06', 'checked が無い古い配信物');
  assert.equal(lastChecked({ updated: '2026-11-06', checked: '2026-11-09' }), '2026-11-09');
  assert.equal(lastChecked({ updated: '2026-11-06', checked: '2026-11-01' }), '2026-11-06', '逆転していたら新しい方');
});

rmSync(WORK, { recursive: true, force: true });
console.log(`検査（更新日の押し方）: ${pass} 件合格` + (fail ? ` / ${fail} 件失敗` : ''));
process.exit(fail ? 1 : 0);

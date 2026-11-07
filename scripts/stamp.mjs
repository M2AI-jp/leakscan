#!/usr/bin/env node
/* 「情報源を見にいった日」を meta.json に押す。
 *
 *   node scripts/stamp.mjs
 *
 * 日次ジョブだけが実行する（CIは実行しない）。
 *
 * なぜ updated と分けるか:
 *   updated は「表示しているデータがいつのものか」。事案の中身が変わった日に
 *   build.mjs が押す。新しい漏洩が公表されない日は動かない。
 *   checked は「最後に情報源を確認した日」。何も無かった日も動く。
 * 一つにまとめると、どちらかが嘘になる。静かな日に updated が動けば
 * 「更新された」が嘘になり、checked を updated に合わせれば
 * 自動収集が止まっていても気づけない。
 *
 * build.mjs に入れない理由: この値は中身と関係なく毎日変わるので、
 * CIの「生成物が最新か確認」が毎日落ちる。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(ROOT, 'data/meta.json');

const meta = JSON.parse(readFileSync(path, 'utf8'));
/* 収集が走るのは日本の朝。GitHub Actions はUTCなので足して合わせる。 */
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

if (meta.checked === today) {
  console.log(`確認日: ${today}（すでに押してある）`);
} else {
  meta.checked = today;
  writeFileSync(path, JSON.stringify(meta, null, 2) + '\n');
  console.log(`確認日: ${today} に押した`);
}
/* 配信物への写しは build.mjs が作る。このあとに走らせること。 */

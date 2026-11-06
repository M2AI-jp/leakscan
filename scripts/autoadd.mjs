#!/usr/bin/env node
/* LeakScan — collect.mjs が拾った候補から事案を自動生成して追記する。
 *
 * 自動追記するのは、出典URL・公表日・公表主体・原因が情報源に揃っているものだけ。
 * 判断を伴う項目（照合用ドメイン、AI関与）は埋めず、確度は保守側に倒す。
 * 自動生成した事案には auto: true を立て、サイト上も「報道による」として表示する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 60);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 45);

const db = JSON.parse(readFileSync(join(ROOT, 'data/breaches.json'), 'utf8'));
const { candidates } = JSON.parse(readFileSync(join(ROOT, 'data/candidates.json'), 'utf8'));

/* ── 要約文から漏洩項目を機械的に拾う ── */
const CATS = [
  [/メールアドレス|メール アドレス/, 'email'],
  [/氏名|名前|会員名/, 'name'],
  [/住所|郵便番号/, 'address'],
  [/電話番号|連絡先電話/, 'phone'],
  [/生年月日/, 'dob'],
  [/性別/, 'gender'],
  [/ハッシュ化されたパスワード|暗号化されたパスワード/, 'password_hash'],
  [/パスワード/, 'password'],
  [/クレジットカード|カード番号|セキュリティコード/, 'card'],
  [/銀行口座|口座番号|金融機関/, 'bank'],
  [/運転免許|本人確認書類|マイナンバーカード/, 'id_document'],
  [/会員番号|会員ID|顧客番号/, 'member_id'],
  [/ポイント|残高/, 'point_balance'],
  [/購入履歴|注文|予約|利用履歴|申込/, 'purchase_history'],
  [/従業員|社員|勤務先|人事|応募者/, 'employment'],
  [/患者|診療|健康|医療/, 'medical'],
  [/ログイン情報|認証情報|ID.{0,3}パスワード/, 'login_credential']
];
function categories(text) {
  const out = [];
  for (const [re, c] of CATS) if (re.test(text) && !out.includes(c)) out.push(c);
  if (out.includes('password') && out.includes('password_hash')) {
    out.splice(out.indexOf('password'), 1);
  }
  return out.length ? out : ['unknown'];
}

/* ── 原因タグの対応付け ── */
const CAUSE = [
  [/ランサム/, 'ransomware'], [/マルウェア|ウイルス/, 'malware'],
  [/設定ミス|設定不備/, 'misconfiguration'],
  [/脆弱性/, 'vulnerability'],
  [/不正ログイン|認証情報/, 'credential'],
  [/不正アクセス/, 'unauthorized_access']
];
function cause(tags, summary) {
  const t = tags + ' ' + summary;
  for (const [re, c] of CAUSE) if (re.test(t)) return c;
  return 'unknown';
}

/* ── 確度 ── */
function status(st, summary) {
  if (/調査中/.test(st) || /調査(を)?(進めて|継続)/.test(summary)) return 'investigating';
  if (/流出(が|を)確認|漏えい(が|を)確認|漏洩(が|を)確認|確認された/.test(summary)) return 'confirmed';
  return 'possible';
}

/* ── 件数 ── */
function recordsNum(s) {
  const m = String(s || '').match(/([\d,]{3,})/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ── 照合用の表示名（社名から法人格を落とす） ──
 * validate.mjs と同じ長さの規則を適用する。日本語を含めば2文字以上、
 * 英字のみなら4文字以上。ここで弾いておかないと検証で全体が落ちる。 */
const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;
function okName(n) {
  const norm = String(n).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000・,，.。'"“”’`]/g, '');
  return norm.length >= (CJK.test(norm) ? 2 : 4);
}
function displayNames(org) {
  const base = String(org)
    .replace(/株式会社|有限会社|合同会社|一般社団法人|公益財団法人|生活協同組合|地方独立行政法人/g, '')
    .trim();
  const out = [];
  if (okName(base)) out.push(base);
  if (org !== base && okName(org)) out.push(org);
  return [...new Set(out)];
}

/* ── 業種は情報源にないので、原因から推定せず未分類にする ── */
const SECTOR = '未分類';

const haveIds = new Set(db.map((e) => e.id));
const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);

const added = [];
for (const c of candidates) {
  if (added.length >= MAX_PER_RUN) break;
  if (!c.date || c.date < cutoff) continue;
  if (!c.url || !c.org) continue;

  const sid = (c.url.match(/incidents\/([0-9a-f-]+)/i) || [])[1];
  if (!sid) continue;
  const id = 'auto-' + sid.toLowerCase();
  if (haveIds.has(id)) continue;

  const names = displayNames(c.org);
  if (!names.length) continue;

  const text = c.summary || '';
  added.push({
    id,
    company: c.org,
    service: c.org,
    sector: SECTOR,
    match: { domains: [], names },      // ドメインは判断を要するため自動では埋めない
    disclosed: c.date,
    records: c.records || '公表されていない',
    records_num: recordsNum(c.records),
    categories: categories(text),
    status: status(c.status, text),
    scope: text.slice(0, 400),
    cause: cause(c.cause || '', text),
    ai_link: 'unconfirmed',
    auto: true,
    sources: [{ title: '不正アクセス・情報漏えい事案（seory）', url: c.url }]
  });
  haveIds.add(id);
}

if (!added.length) {
  console.log('追記する候補はありません');
  process.exit(0);
}

db.push(...added);
writeFileSync(join(ROOT, 'data/breaches.json'), JSON.stringify(db, null, 2) + '\n');
console.log(`${added.length} 件を自動追記（収録 ${db.length} 件）`);
for (const a of added.slice(0, 50)) {
  console.log(`  + ${a.disclosed}  ${a.company}  ${a.records}  [${a.status}/${a.cause}]`);
}

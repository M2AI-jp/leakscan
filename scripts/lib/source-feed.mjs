/* 情報源（incidents.seory.co.jp）の構造化データを読み、本データベースの形に直す。
 *
 * 方針:
 *  - 情報源が公開している incidents.json の列挙値だけを使う。文章からの推測はしない。
 *  - 情報源の要約文は転載しない。相手方が書いた文章なので、
 *    こちらは構造化された項目から自分の言葉で説明文を組み立てる。
 *  - 迷ったら弱いほうに倒す。「確認」と書けるのは確定件数が公表されている場合だけ。
 */

export const FEED_URL = 'https://incidents.seory.co.jp/incidents.json';
export const UA = { 'user-agent': 'LeakScan/1.0 (+https://leakscan.matsunai.com)' };

/** 個人に関する情報。これを1つも含まない事案は収録しない */
const PERSONAL = [
  'email', 'name', 'address', 'phone', 'birthdate', 'card_number', 'card_expiry',
  'card_security_code', 'bank_account', 'password', 'my_number', 'health_medical'
];

/** 情報源の leaked_data → 本データベースの categories */
const CAT = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  birthdate: 'dob',
  /* 情報源は平文かハッシュ化かを区別しない。重く見せすぎないため
     「パスワード（平文）」ではなく「ログイン認証情報」に寄せる */
  password: 'login_credential',
  card_number: 'card',
  card_expiry: 'card',
  card_security_code: 'card',
  bank_account: 'bank',
  my_number: 'my_number',
  health_medical: 'medical',
  other: null            // 「その他」は中身が分からないので項目にしない
};

/** 侵入経路 → 原因。複数あるときは上にあるものを優先する */
const VECTOR = [
  ['supplier', 'vendor'],
  ['misconfiguration', 'misconfiguration'],
  ['stolen_credentials', 'credential'],
  ['credential_stuffing', 'credential'],
  ['phishing', 'credential'],
  ['cloud_account', 'credential'],
  ['web_app_vulnerability', 'vulnerability'],
  ['vulnerability', 'vulnerability'],
  ['vpn', 'vulnerability'],
  ['remote_desktop', 'vulnerability'],
  ['cms', 'vulnerability']
];

/** 事案の種別 → 原因。侵入経路より種別が強い場合（ランサム等）に使う */
const TYPE_CAUSE = {
  ransomware: 'ransomware',
  malware: 'malware',
  misconfiguration: 'misconfiguration',
  form_misconfiguration: 'misconfiguration',
  defacement: 'vulnerability'
};

const ja = (n) => Number(n).toLocaleString('ja-JP');

const HAS_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/** 法人格などを落として企業名を比べられる形にする */
export function normCompany(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社/g, '')
    .replace(/一般財団法人|公益財団法人|公益社団法人|一般社団法人|社会福祉法人/g, '')
    .replace(/国立大学法人|公立大学法人|学校法人|医療法人|宗教法人/g, '')
    .replace(/生活協同組合|農業協同組合|信用金庫|信用組合/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s・＆&,，.。、\u3000]/g, '')
    .toLowerCase();
}

/** 情報源の1件 → 本データベースの categories */
export function categoriesOf(inc) {
  const out = [];
  for (const d of inc.leaked_data || []) {
    const c = CAT[d];
    if (c && !out.includes(c)) out.push(c);
  }
  return out.length ? out : ['unknown'];
}

/** 情報源の1件 → 本データベースの cause */
export function causeOf(inc) {
  for (const t of inc.types || []) if (TYPE_CAUSE[t]) return TYPE_CAUSE[t];
  const vs = inc.entry_vectors || [];
  for (const [from, to] of VECTOR) if (vs.includes(from)) return to;
  if ((inc.types || []).includes('unauthorized_access')) return 'unauthorized_access';
  return 'unknown';
}

/** 件数の公表状況 → status。確定件数が出ている場合だけ「確認」と書く */
export function statusOf(inc) {
  const r = inc.records || {};
  if (r.confirmed != null) return 'confirmed';
  if (r.max != null) return 'possible';
  return 'investigating';
}

/** 公表件数の表示文と数値 */
export function recordsOf(inc) {
  const r = inc.records || {};
  if (r.confirmed != null) return { text: `${ja(r.confirmed)}件`, num: r.confirmed };
  if (r.max != null) return { text: `最大${ja(r.max)}件（可能性）`, num: r.max };
  return { text: '公表なし', num: null };
}

/** 事案の説明文。情報源の要約は転載せず、項目から組み立てる */
export function scopeOf(inc, meta) {
  const cats = categoriesOf(inc)
    .filter((c) => c !== 'unknown')
    .map((c) => meta.categories[c] || c);
  const r = recordsOf(inc);
  const cause = meta.cause_labels[causeOf(inc)] || '不明';

  const sure = statusOf(inc) === 'confirmed';
  const parts = [`${inc.organization.name}が公表した${cause}による事案`];
  if (cats.length) parts.push(`${sure ? '漏洩した情報は' : '漏洩した可能性がある情報は'}${cats.join('、')}`);
  if (r.num != null) parts.push(`公表件数は${r.text}`);
  if (inc.dates && inc.dates.discovered) parts.push(`発覚は${inc.dates.discovered}`);
  parts.push('詳細は出典の公式発表を参照');
  return parts.join('。') + '。';
}

/** 収録対象か（個人に関する情報を1つ以上含むか） */
export function isPersonal(inc) {
  return (inc.leaked_data || []).some((d) => PERSONAL.includes(d));
}

/** 「株式会社A、株式会社B」「X / Y」「親会社（子会社）」のような併記をばらす。
 *  括弧の中身も捨てずに1つの名前として扱う（ワールド子会社（ティンパンアレイ）など）。 */
function nameTokens(...sources) {
  const out = new Set();
  const push = (raw) => {
    const n = normCompany(raw);
    if (!n) return;
    if (HAS_CJK.test(n) ? n.length >= 2 : n.length >= 4) out.add(n);
  };
  for (const src of sources) {
    const str = String(src || '');
    for (const m of str.matchAll(/[（(]([^）)]+)[）)]/g)) push(m[1]);
    for (const piece of str.split(/[、,，\/｜|]+/)) push(piece);
  }
  return [...out];
}

/** 同じ事案を指していそうな名前か。
 *  片方がもう片方を含む場合も同一とみなす（松屋フーズ と 松屋フーズホールディングス など）。 */
function sameName(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.includes(s);
}

/** 同じ企業の別事案と区別するための許容日数。
 *  これより近い公表日で名前が一致したら、同じ事案の重複とみなす。 */
const SAME_INCIDENT_DAYS = 60;

/** 既存データベースから、既に収録済みと判断する手がかりを作る */
export function knownIndex(db) {
  const byId = new Set();
  const named = [];
  for (const e of db) {
    for (const s of e.sources || []) {
      const m = /incidents\/([0-9a-z-]+)\//.exec(s.url);
      if (m) byId.add(m[1]);
    }
    named.push({
      id: e.id,
      day: Date.parse(e.disclosed) || 0,
      tokens: nameTokens(e.company, e.service)
    });
  }
  return { byId, named };
}

/** この事案は既に収録されているか。'' なら未収録 */
export function isKnown(inc, idx) {
  if (idx.byId.has(inc.id)) return 'id';
  const tokens = nameTokens(inc.organization.name);
  const day = Date.parse(inc.dates.first_published) || 0;
  for (const e of idx.named) {
    if (Math.abs(day - e.day) > SAME_INCIDENT_DAYS * 86400000) continue;
    if (e.tokens.some((t) => tokens.some((u) => sameName(t, u)))) return 'company';
  }
  return '';
}

/** 情報源のJSONを取得する */
export async function fetchFeed() {
  const res = await fetch(FEED_URL, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`情報源の取得に失敗: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.incidents)) throw new Error('情報源の形が想定と違う');
  return j;
}

/** 組織の同一性を見るための鍵。
 *
 * 自治体は「局・課・室」や括弧付きの部署名で別名になって出てくるが、
 * 漏洩したのは同じ自治体である。先頭の自治体名まで切り詰めて同一とみなす。
 *   東京都水道局              → 東京都
 *   名古屋市(総務局○○推進課) → 名古屋市
 * 一方、財団・学校・病院などの別法人は AFFILIATED 側で弾いており、
 * ここで自治体に丸められても照合ドメインは持たない。
 */
export function orgKey(company) {
  const c = String(company || '').normalize('NFKC');
  const m = /^(.{1,8}?[都道府県])(?=[^都道府県]|$)/.exec(c) || /^(.{1,10}?[市区町村])(?=[^市区町村]|$)/.exec(c);
  if (m) return m[1];
  return normCompany(c);
}

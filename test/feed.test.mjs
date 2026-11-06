/* 情報源の構造化データ → 本データベースへの変換テスト
 * node test/feed.test.mjs（ネットワークは使わない）
 *
 * ここで守りたいこと:
 *  - 情報源の列挙値を取り違えない（漏洩項目・原因・状態）
 *  - 確度を強く書きすぎない（確定件数がなければ「確認」と書かない）
 *  - 情報源の要約文を転載しない
 *  - 同じ事案を二重に登録しない
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  categoriesOf, causeOf, statusOf, recordsOf, scopeOf,
  isPersonal, normCompany, knownIndex, isKnown
} from '../scripts/lib/source-feed.mjs';
import { guessSector } from '../scripts/lib/sector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
const section = (t) => console.log('\n' + t);

const inc = (over = {}) => ({
  id: '20261106-abc123',
  url: 'https://incidents.seory.co.jp/incidents/20261106-abc123/',
  organization: { name: '株式会社テスト' },
  types: ['unauthorized_access'],
  entry_vectors: ['supplier'],
  leaked_data: ['email', 'name'],
  records: { max: 1000, confirmed: null },
  dates: { first_published: '2026-11-06', discovered: null },
  status: 'investigating',
  summary: '情報源が書いた要約文。これは転載してはいけない。',
  ...over
});

section('1. 漏洩項目の対応');
eq('メール+氏名', categoriesOf(inc()), ['email', 'name']);
eq('カードは3項目まとめて1つ', categoriesOf(inc({ leaked_data: ['card_number', 'card_expiry', 'card_security_code'] })), ['card']);
eq('生年月日は dob', categoriesOf(inc({ leaked_data: ['birthdate'] })), ['dob']);
eq('マイナンバー', categoriesOf(inc({ leaked_data: ['my_number'] })), ['my_number']);
eq('医療情報', categoriesOf(inc({ leaked_data: ['health_medical'] })), ['medical']);
eq('「その他」だけなら項目にしない', categoriesOf(inc({ leaked_data: ['other'] })), ['unknown']);
ok('パスワードは平文と断定しない',
  categoriesOf(inc({ leaked_data: ['password'] }))[0] === 'login_credential',
  categoriesOf(inc({ leaked_data: ['password'] })).join());
ok('マイナンバーは meta に定義がある', !!meta.categories.my_number);

section('2. 原因の対応');
eq('委託先', causeOf(inc()), 'vendor');
eq('ランサムは侵入経路より優先', causeOf(inc({ types: ['ransomware'], entry_vectors: ['supplier'] })), 'ransomware');
eq('マルウェア', causeOf(inc({ types: ['malware'], entry_vectors: [] })), 'malware');
eq('設定不備', causeOf(inc({ types: ['misconfiguration'], entry_vectors: [] })), 'misconfiguration');
eq('フォーム設定不備も設定不備', causeOf(inc({ types: ['form_misconfiguration'], entry_vectors: [] })), 'misconfiguration');
eq('認証情報の窃取', causeOf(inc({ types: ['unauthorized_access'], entry_vectors: ['stolen_credentials'] })), 'credential');
eq('リスト型攻撃も認証情報', causeOf(inc({ types: ['unauthorized_access'], entry_vectors: ['credential_stuffing'] })), 'credential');
eq('脆弱性', causeOf(inc({ types: ['unauthorized_access'], entry_vectors: ['web_app_vulnerability'] })), 'vulnerability');
eq('手がかりなしは不明', causeOf(inc({ types: ['other'], entry_vectors: [] })), 'unknown');

section('3. 確度は強く書かない');
eq('確定件数があれば確認', statusOf(inc({ records: { max: 100, confirmed: 100 } })), 'confirmed');
eq('最大値だけなら可能性', statusOf(inc({ records: { max: 100, confirmed: null } })), 'possible');
eq('件数が未公表なら調査中', statusOf(inc({ records: { max: null, confirmed: null } })), 'investigating');
ok('情報源が investigation_complete でも確定件数がなければ確認にしない',
  statusOf(inc({ status: 'investigation_complete', records: { max: 500, confirmed: null } })) !== 'confirmed');

section('4. 件数の表示');
eq('確定', recordsOf(inc({ records: { max: 1889, confirmed: 1889 } })), { text: '1,889件', num: 1889 });
eq('可能性', recordsOf(inc({ records: { max: 14900000, confirmed: null } })), { text: '最大14,900,000件（可能性）', num: 14900000 });
eq('未公表', recordsOf(inc({ records: {} })), { text: '公表なし', num: null });

section('5. 説明文は情報源の文を使わない');
const sc = scopeOf(inc(), meta);
ok('要約文を含まない', !sc.includes('情報源が書いた要約文'), sc);
ok('企業名を含む', sc.includes('株式会社テスト'));
ok('原因を日本語で含む', sc.includes('委託先・サプライヤの侵害'));
ok('可能性の事案は「可能性がある」と書く', scopeOf(inc(), meta).includes('漏洩した可能性がある情報は'));
ok('確定の事案は「漏洩した情報は」と書く',
  scopeOf(inc({ records: { max: 10, confirmed: 10 } }), meta).includes('漏洩した情報は'));

section('6. 収録対象の線引き');
ok('メールアドレスは個人情報', isPersonal(inc({ leaked_data: ['email'] })));
ok('マイナンバーは個人情報', isPersonal(inc({ leaked_data: ['my_number'] })));
ok('「その他」だけなら収録しない', !isPersonal(inc({ leaked_data: ['other'] })));
ok('空なら収録しない', !isPersonal(inc({ leaked_data: [] })));

section('7. 企業名の正規化');
eq('法人格を落とす', normCompany('株式会社テスト'), 'テスト');
eq('括弧を落とす', normCompany('ワールド子会社（ティンパンアレイ）'), 'ワールド子会社');
ok('中黒の有無で差が出ない', normCompany('ドン・キホーテ') === normCompany('ドンキホーテ'));

section('8. 二重登録を防ぐ');
const db = [
  { id: 'a', company: '松屋フーズ', service: '松屋フーズ公式アプリ', disclosed: '2026-10-30', sources: [] },
  { id: 'b', company: 'カイカエクスチェンジ', service: 'Zaif', disclosed: '2026-11-02', sources: [] },
  { id: 'c', company: '駅探', service: '駅探メール配信', disclosed: '2026-11-03', sources: [] },
  { id: 'd', company: 'ワールド子会社（ティンパンアレイ）', service: 'RAGTAG / Tin Pan Alley', disclosed: '2026-10-30', sources: [] },
  { id: 'e', company: 'KDDI', service: 'ISPメール', disclosed: '2026-07-06', sources: [] },
  { id: 'f', company: 'テスト', service: 'テスト', disclosed: '2026-11-06', sources: [{ title: 's', url: 'https://incidents.seory.co.jp/incidents/20260101-aaaaaa/' }] }
];
const idx = knownIndex(db);
const K = (name, day) => isKnown({ id: 'x', organization: { name }, dates: { first_published: day } }, idx);
ok('社名に「ホールディングス」が付いても同一と見る', K('株式会社松屋フーズホールディングス', '2026-10-30') === 'company');
ok('サービス名で照合できる（Zaif）', K('Zaif', '2026-11-02') === 'company');
ok('短い社名でも照合できる（駅探）', K('株式会社駅探', '2026-11-03') === 'company');
ok('括弧の中の社名で照合できる', K('株式会社ティンパンアレイ', '2026-10-30') === 'company');
ok('同じ社名でも4か月離れていれば別事案', K('KDDI株式会社', '2026-10-30') === '');
ok('事案IDが一致すれば同一',
  isKnown({ id: '20260101-aaaaaa', organization: { name: '無関係' }, dates: { first_published: '2026-01-01' } }, idx) === 'id');
ok('無関係な企業は未収録', K('株式会社まったく別の会社', '2026-11-06') === '');

section('9. 業種の推定');
eq('都道府県', guessSector('富山県'), '公共');
eq('市', guessSector('鴨川市'), '公共');
eq('県立高校は教育（公共より優先）', guessSector('埼玉県立川越高等学校'), '教育');
eq('銀行', guessSector('株式会社十八親和銀行'), '金融・保険');
eq('損保', guessSector('東京海上ダイレクト損害保険株式会社'), '金融・保険');
eq('大学', guessSector('国立大学法人九州大学'), '教育');
eq('電力', guessSector('中国電力株式会社'), 'エネルギー');
eq('判定できなければ未分類', guessSector('株式会社あいうえお'), '未分類');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

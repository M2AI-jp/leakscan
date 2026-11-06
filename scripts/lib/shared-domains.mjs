/* 照合ドメインを自動で決めるときの安全弁。
 *
 * 「その組織だけのもの」でないドメインを照合に使うと、無関係な組織の
 * 利用者にまで「あなたのサービスが漏洩した」と表示してしまう。
 * それは誤報であり、無関係な企業の信用も傷つける。だから捨てる。 */

/** 都道府県の地域型JPドメイン。pref.X.jp と city.Y.X.jp が同じ下にぶら下がる */
export const JP_PREFECTURES = [
  'hokkaido', 'aomori', 'iwate', 'miyagi', 'akita', 'yamagata', 'fukushima',
  'ibaraki', 'tochigi', 'gunma', 'saitama', 'chiba', 'tokyo', 'kanagawa',
  'niigata', 'toyama', 'ishikawa', 'fukui', 'yamanashi', 'nagano', 'gifu',
  'shizuoka', 'aichi', 'mie', 'shiga', 'kyoto', 'osaka', 'hyogo', 'nara',
  'wakayama', 'tottori', 'shimane', 'okayama', 'hiroshima', 'yamaguchi',
  'tokushima', 'kagawa', 'ehime', 'kochi', 'fukuoka', 'saga', 'nagasaki',
  'kumamoto', 'oita', 'miyazaki', 'kagoshima', 'okinawa'
].map((p) => `${p}.jp`);

/** 複数の組織が共用しているドメイン */
export const INDUSTRY_SHARED = [
  'shinkin.co.jp',          // 全国の信用金庫が共用
  'shinkumi.jp',            // 信用組合
  'rokin.or.jp',            // 労働金庫
  'jabank.jp', 'ja-group.jp', 'nochubank.or.jp',
  'jp-bank.japanpost.jp',
  'prtimes.jp', 'atpress.ne.jp', 'value-press.com', 'dreamnews.jp',
  'kyodonewsprwire.jp'      // プレスリリース配信。発表元の持ち物ではない
];

/** 地域型・政府系は「ホスト名まるごと」で扱う必要がある階層 */
const WHOLE_HOST_SUFFIXES = ['.go.jp', '.lg.jp', ...JP_PREFECTURES.map((p) => '.' + p)];

/** 自治体の組織を表す先頭ラベル。ここから始まるホストは削ってはいけない
 *  （city.kawasaki.jp を kawasaki.jp にすると川崎市以外も巻き込む） */
const MUNICIPAL_PREFIX = /^(city|town|village|pref|metro|ward)\./;

/** このホストは、登録可能ドメインまで削ると別組織と混ざるか */
export function needsWholeHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\d*\./, '');
  if (MUNICIPAL_PREFIX.test(h)) return true;
  return WHOLE_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

/** 配信基盤・ストレージなど、企業の持ち物でないホスト */
const INFRA = /(^|\.)(assets?|cdn|static|files?|storage|blob|s3|img|images|media|dl|download)\./;
export function looksLikeInfra(host) {
  const h = String(host || '').toLowerCase();
  return INFRA.test(h) || /-assets?\.|\.amazonaws\.com$|\.cloudfront\.net$|\.blob\.core\.windows\.net$|\.r2\.dev$|\.pages\.dev$|\.netlify\.app$|\.vercel\.app$/.test(h);
}

/**
 * 照合ドメインとして採用してよいか。
 *
 * @param {string} domain   判定するドメイン
 * @param {object} denylist data/domain-denylist.json の domains
 * @param {object} [opts]   { auto: true } のとき、機械的な補完向けに厳しく判定する。
 *   省庁ドメインは「経済産業省の下に委員会がある」ような入れ子を機械では切り分けられないので
 *   自動補完では捨てる。人が確認して入れた場合（digital.go.jp = デジタル庁 など）は通す。
 * @returns {string} 空文字なら採用可。文字列が返ったら棄却理由。
 */
export function rejectReason(domain, denylist, opts) {
  const auto = !!(opts && opts.auto);
  const d = String(domain || '').toLowerCase();
  if (!d) return 'ドメインなし';
  const parts = d.split('.');

  if (denylist && denylist[d]) return `人が確認して除外: ${denylist[d]}`;
  if (looksLikeInfra(d)) return '配信基盤・ストレージのドメイン（企業の持ち物ではない）';

  if (parts.length < 2) return 'ドメインの形をしていない';
  if (JP_PREFECTURES.includes(d)) return '都道府県の地域型ドメイン（県内の他自治体も巻き込む）';
  if (INDUSTRY_SHARED.includes(d)) return '複数組織が共用しているドメイン';
  if (auto && d.endsWith('.go.jp') && parts.length <= 3) {
    return '省庁ドメイン（下位の委員会・局を切り分けられない）';
  }
  if ((d === 'lg.jp' || d === 'co.jp' || d === 'or.jp' || d === 'ne.jp' ||
       d === 'ac.jp' || d === 'go.jp') ) return '属性型JPドメインそのもの';
  return '';
}

/** 自治体・政府のドメインか（自前のドメインを持たない外郭団体の判定に使う） */
export function isGovDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (/\.(lg|go)\.jp$/.test(d)) return true;
  if (/^(pref|city|town|village|metro|ward)\./.test(d)) return true;
  return JP_PREFECTURES.some((p) => d === p || d.endsWith('.' + p));
}

/** 自前のドメインを持たず、親の自治体・省庁のサイトで発表する組織。
 *  その場合に親のドメインを照合に使うと、自治体そのものや
 *  他の外郭団体の利用者まで巻き込む。 */
const AFFILIATED = /(財団|社団|振興|公社|事業団|機構|協会|連合会|組合|センター|研究所|委員会|事務組合|広域連合|学校|大学|高等学校|中学校|小学校|高校|中学|小学|幼稚園|保育園|保育所|病院|医院|クリニック|診療所|図書館|美術館|博物館|教育委員会)/;

/**
 * 「この組織に、この自治体・省庁ドメインを使わせてよいか」
 * @returns {string} 空文字なら採用可。文字列が返ったら棄却理由。
 */
export function rejectForOrg(company, domain) {
  if (!isGovDomain(domain)) return '';
  if (AFFILIATED.test(String(company || ''))) {
    return '外郭団体が親の自治体・省庁のドメインを使うことになる（他の組織まで巻き込む）';
  }
  return '';
}

/* 出典が「公表した組織そのものの発表」かどうかの判定。
 *
 * サイトの各事案に出す「公式発表あり / 報道による」バッジの根拠。
 * 報道・集計サイト・プレスリリース配信だけを典拠にしている事案は
 * 「報道による」と表示し、読む人が強度を判断できるようにする。 */

/** 自社発表ではないホスト（報道・集計・配信・SNS） */
const NOT_OFFICIAL = [
  // 集計サイト（本データベースの主な情報源）
  'seory.co.jp',
  // プレスリリース配信
  'prtimes.jp', 'atpress.ne.jp', 'value-press.com', 'dreamnews.jp', 'kyodonewsprwire.jp',
  // 報道
  'nikkei.com', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp', 'sankei.com', 'tokyo-np.co.jp',
  'jiji.com', 'kyodo.co.jp', 'nhk.or.jp', 'news.yahoo.co.jp', 'yahoo.co.jp',
  'itmedia.co.jp', 'impress.co.jp', 'nikkeibp.co.jp', 'xtech.nikkei.com',
  'security-next.com', 'scan.netsecurity.ne.jp', 'cybersecurity-jp.com',
  'rocket-boys.co.jp',      // ScanNetSecurity の発行元
  'crystal-method.com',     // Codebook（セキュリティ報道）
  'cvejp.com',              // CVE日本語情報サイト
  'canon-its.co.jp',        // マルウェア情報局
  'trendmicro.com', 'kaspersky.co.jp', 'eset.com',
  'bloomberg.co.jp', 'reuters.com', 'jbpress.ismedia.jp', 'toyokeizai.net',
  'diamond.jp', 'president.jp', 'newsweekjapan.jp', 'bengo4.com',
  // SNS・ブログ基盤
  'x.com', 'twitter.com', 'facebook.com', 'note.com', 'hatena.ne.jp', 'ameblo.jp'
];

/** この出典URLは、公表した組織自身（または法定の開示基盤）によるものか */
export function isOfficialSource(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return !NOT_OFFICIAL.some((n) => host === n || host.endsWith('.' + n));
}

/** 事案に公式発表の出典が1つ以上あるか */
export function hasOfficialSource(entry) {
  return (entry.sources || []).some((s) => isOfficialSource(s.url));
}

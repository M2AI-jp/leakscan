/* LeakScan — 照合ロジック（純粋関数・DOMもネットワークも触らない） */
(function (root) {
  'use strict';

  /** NFKC + 小文字化 + 区切り除去。全角/半角や空白の違いで取りこぼさないため。 */
  function norm(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s　・,，.。'"“”’`]/g, '');
  }

  /* ───────── ドメインの分解 ───────── */

  /** 実務上必要な範囲の公開接尾辞。長いものから順に判定する。 */
  const SUFFIXES = [
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'lg.jp', 'ad.jp', 'gr.jp', 'ed.jp',
    'co.uk', 'com.au', 'co.kr', 'com.tw', 'com.cn', 'com.hk', 'com.sg',
    'jp', 'com', 'net', 'org', 'info', 'biz', 'io', 'ai', 'co', 'me', 'app',
    'dev', 'site', 'shop', 'store', 'online', 'tokyo', 'work', 'life', 'design', 'page'
  ];

  /** 都道府県の地域型JPドメイン。pref.X.jp と city.Y.X.jp が同じ下にぶら下がるため、
   *  ブランド部分（= 県名）での照合をすると県と市区町村が混ざる。 */
  const JP_GEO = [
    'hokkaido', 'aomori', 'iwate', 'miyagi', 'akita', 'yamagata', 'fukushima',
    'ibaraki', 'tochigi', 'gunma', 'saitama', 'chiba', 'tokyo', 'kanagawa',
    'niigata', 'toyama', 'ishikawa', 'fukui', 'yamanashi', 'nagano', 'gifu',
    'shizuoka', 'aichi', 'mie', 'shiga', 'kyoto', 'osaka', 'hyogo', 'nara',
    'wakayama', 'tottori', 'shimane', 'okayama', 'hiroshima', 'yamaguchi',
    'tokushima', 'kagawa', 'ehime', 'kochi', 'fukuoka', 'saga', 'nagasaki',
    'kumamoto', 'oita', 'miyazaki', 'kagoshima', 'okinawa'
  ].map(function (p) { return p + '.jp'; });

  /** 自治体・政府系のドメインか。
   *  これらは「完全一致とサブドメイン」だけで照合し、ブランド部分には広げない。
   *  pref.yamanashi.jp と city.yamanashi.yamanashi.jp は別の組織だが
   *  ブランド部分はどちらも yamanashi になってしまう。 */
  function isGeoOrGov(domain) {
    const d = String(domain || '').toLowerCase();
    if (/^(www\d*\.)?(pref|city|town|village|metro|ward)\./.test(d)) return true;
    if (/\.(lg|go)\.jp$/.test(d)) return true;
    for (let i = 0; i < JP_GEO.length; i++) {
      if (d === JP_GEO[i] || d.endsWith('.' + JP_GEO[i])) return true;
    }
    return false;
  }

  /** 登録可能部分のラベル。example.co.jp → "example" / news.example.com → "example" */
  function brandLabel(domain) {
    const d = String(domain || '').toLowerCase().replace(/\.+$/, '');
    if (!d) return '';
    const parts = d.split('.');
    for (const suf of SUFFIXES) {
      const sp = suf.split('.');
      if (parts.length > sp.length && parts.slice(-sp.length).join('.') === suf) {
        return parts[parts.length - sp.length - 1];
      }
    }
    return parts.length > 1 ? parts[parts.length - 2] : parts[0];
  }

  /** 配信用サブドメインや別ドメインで使われがちな接辞 */
  const AFFIXES = [
    'mail', 'email', 'mailmagazine', 'mg', 'news', 'newsletter', 'info', 'member',
    'members', 'shop', 'store', 'online', 'web', 'net', 'id', 'my', 'cs', 'support',
    'post', 'delivery', 'mm', 'e', 'm', 'go', 'app', 'club', 'point', 'card'
  ];

  /** ブランド照合に使ってはいけない、一般語すぎるラベル */
  const GENERIC = new Set([
    'life', 'next', 'net', 'web', 'one', 'top', 'best', 'first', 'group', 'japan',
    'tokyo', 'osaka', 'info', 'mail', 'news', 'shop', 'store', 'online', 'service',
    'system', 'data', 'cloud', 'tech', 'plus', 'link', 'point', 'card', 'pay',
    'bank', 'air', 'sky', 'star', 'blue', 'green', 'world', 'global', 'smart',
    'home', 'life', 'style', 'club', 'media', 'press', 'center', 'direct', 'prime',
    'trust', 'value', 'power', 'green', 'city', 'house', 'market', 'place', 'force'
  ]);

  const MIN_BRAND = 5;

  /** ブランド照合に使ってよいラベルか */
  function usableBrand(label) {
    return !!label && label.length >= MIN_BRAND && !GENERIC.has(label) && !/^\d+$/.test(label);
  }

  const deh = (s) => String(s || '').replace(/-/g, '');

  /** 送信元ラベルが、登録ブランドの変種とみなせるか */
  function labelRelated(senderLabel, brand) {
    const a = deh(senderLabel), b = deh(brand);
    if (!a || !b) return false;
    if (a === b) return true;
    /* brand + 接辞 / 接辞 + brand（mujimail, mail-muji, e-muji など） */
    for (const af of AFFIXES) {
      if (a === b + af || a === af + b) return true;
    }
    return false;
  }

  /* ───────── 照合 ───────── */

  /**
   * 戻り値の強さ:
   *   'domain'  完全一致またはサブドメイン（最も確か）
   *   'related' 同一ブランドの別ドメイン・配信用ドメイン（要確認）
   *   'name'    差出人の表示名のみ（なりすましの可能性あり）
   *   null      一致なし
   */
  function matchSender(sender, svc) {
    const email = String((sender && sender.email) || '').toLowerCase();
    const at = email.lastIndexOf('@');
    const domain = at > -1 ? email.slice(at + 1) : '';

    if (domain) {
      for (const d of svc.domains || []) {
        const dd = String(d).toLowerCase();
        if (domain === dd || domain.endsWith('.' + dd)) return 'domain';
      }
      /* 完全一致しなかった場合のみ、ブランド部分で照合する。
         自治体・政府系はブランド部分が県名・市名になり別組織と混ざるので広げない。 */
      const sLabel = brandLabel(domain);
      if (usableBrand(sLabel) && !isGeoOrGov(domain)) {
        for (const d of svc.domains || []) {
          const dd = String(d).toLowerCase();
          if (isGeoOrGov(dd)) continue;
          const brand = brandLabel(dd);
          if (!usableBrand(brand)) continue;
          if (labelRelated(sLabel, brand)) return 'related';
        }
      }
    }

    const nm = norm(sender && sender.name);
    if (nm) {
      for (const n of svc.names || []) {
        const nn = norm(n);
        if (nn.length >= minNameLen(nn) && nm.includes(nn)) return 'name';
      }
    }
    return null;
  }

  const CJK = /[぀-ヿ一-鿿]/;

  /** 日本語は1文字あたりの情報量が多い。英字のみは短いと誤検知源になる。 */
  function minNameLen(normalised) {
    return CJK.test(normalised) ? 2 : 4;
  }

  /* ───────── Gmail 検索クエリ ───────── */

  /** バッチ内の全パターンを1本の from: クエリにまとめる */
  function buildQuery(batch, opts) {
    const terms = [];
    const seen = new Set();
    const add = (t) => { if (t && !seen.has(t)) { seen.add(t); terms.push(t); } };

    for (const svc of batch) {
      for (const d of svc.domains || []) {
        const dd = String(d).toLowerCase();
        add(dd);
        /* 別ドメインや配信用サブドメインも拾えるよう、ブランド部分を素の語として足す。
           広く引いて、一致の判定は matchSender 側で厳密に行う。 */
        if (isGeoOrGov(dd)) continue;   // 県名・市名を素の語で引くと別自治体まで拾う
        const b = brandLabel(dd);
        if (usableBrand(b)) add(b);
      }
      for (const n of svc.names || []) {
        add('"' + String(n).replace(/"/g, '') + '"');
      }
    }
    let q = 'from:(' + terms.join(' OR ') + ')';
    if (opts && opts.includeSpamTrash) q += ' in:anywhere';
    return q;
  }

  const api = {
    norm, buildQuery, matchSender, minNameLen,
    brandLabel, usableBrand, labelRelated, isGeoOrGov,
    MIN_BRAND, GENERIC, AFFIXES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LEAKSCAN_MATCH = api;
})(typeof self !== 'undefined' ? self : this);

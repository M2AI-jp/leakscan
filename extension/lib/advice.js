/* LeakScan — rule-based action advice. No AI, no network: a lookup table. */
(function (root) {
  'use strict';

  const SEV3 = ['card', 'bank', 'password', 'id_document', 'login_credential'];
  const SEV2 = ['name', 'address', 'phone', 'dob', 'password_hash', 'medical', 'point_balance', 'purchase_history', 'employment'];

  function severity(cats) {
    if (!cats || !cats.length) return 0;
    if (cats.some((c) => SEV3.includes(c))) return 3;
    if (cats.some((c) => SEV2.includes(c))) return 2;
    if (cats.includes('email') || cats.includes('member_id') || cats.includes('identifier')) return 1;
    return 0;
  }

  /* urgency: 3 = 今すぐ / 2 = 数日のうちに / 1 = 覚えておく */
  const RULES = [
    { cats: ['password'], urgency: 3, title: 'このサービスのパスワードを今すぐ変更する',
      detail: 'パスワードが復元可能な形で漏れています。同じ・似たパスワードを使っている他のサービスも全て変更してください。使い回しの連鎖が最大の被害源です。' },
    { cats: ['password_hash'], urgency: 2, title: 'パスワードを変更する',
      detail: 'ハッシュ化されていますが、単純なパスワードは解析されます。念のため変更し、使い回しをやめてください。' },
    { cats: ['login_credential'], urgency: 3, title: 'パスワードを変更し、全端末からログアウトする',
      detail: 'ログイン情報やセッションが対象です。パスワード変更後、可能なら「すべての端末からログアウト」を実行し、二要素認証を有効にしてください。' },
    { cats: ['card'], urgency: 3, title: 'カードの利用明細を確認する',
      detail: '直近3か月の明細に見覚えのない請求がないか確認してください。少額のテスト決済から始まることが多いです。不安な場合はカード会社に連絡して再発行を依頼します。' },
    { cats: ['bank'], urgency: 3, title: '口座の入出金を確認する',
      detail: '口座番号が漏れています。不審な引き落とし・口座振替の登録がないか確認し、ネットバンキングのパスワードも変更してください。' },
    { cats: ['id_document'], urgency: 3, title: 'なりすまし利用に備える',
      detail: '運転免許証などの画像が対象です。携帯契約・ローン・古物取引などでのなりすましに使われる恐れがあります。身に覚えのない契約の連絡が来たら即座に相談窓口へ。' },
    { cats: ['email'], urgency: 2, title: 'そのアドレス宛のフィッシングに警戒する',
      detail: '「漏洩しました」「至急ご確認を」という件名のメールが、漏洩直後に実際に送られています。メール内のリンクは踏まず、必ず公式サイト・公式アプリから自分でアクセスしてください。' },
    { cats: ['phone'], urgency: 2, title: 'SMSと電話の詐欺に警戒する',
      detail: '宅配便の不在通知、未払い料金、金融機関を名乗るSMSに注意してください。番号を押して折り返すのではなく、公式の番号に自分でかけ直します。' },
    { cats: ['address', 'name'], urgency: 1, title: '郵便とDMの不審物に注意する',
      detail: '氏名と住所が揃っているため、実在感のある偽の請求書・架空請求の郵便が届くことがあります。心当たりのない支払い要求には応じないでください。' },
    { cats: ['dob'], urgency: 1, title: '生年月日を「本人確認」に使わない',
      detail: '生年月日は本人確認の質問やパスワードに使わないでください。漏れた属性は本人確認を突破する材料になります。' },
    { cats: ['medical'], urgency: 2, title: '医療情報の悪用に注意する',
      detail: '健康状態に関する情報は、保険や勧誘を装った接触に使われることがあります。医療機関を名乗る連絡は折り返し確認してください。' },
    { cats: ['point_balance'], urgency: 2, title: 'ポイント残高と交換履歴を確認する',
      detail: 'ポイントの不正交換は実被害が出ています。残高と交換履歴を確認し、心当たりのない交換があれば事業者へ連絡してください。' },
    { cats: ['purchase_history'], urgency: 1, title: '履歴を使った「本人を装う連絡」に注意する',
      detail: '実際の注文内容を引用した詐欺メールが作れます。注文番号を知っていることは本人確認になりません。' },
    { cats: ['member_id', 'identifier'], urgency: 1, title: '当面は様子を見る',
      detail: '現時点の公表範囲では、単体で個人を特定できない情報です。続報で範囲が広がることがあるため、公式発表を時々確認してください。' },
    { cats: ['employment'], urgency: 1, title: '勤務先を装う連絡に注意する',
      detail: '所属情報は、取引先や人事を装ったビジネスメール詐欺の材料になります。' },
    { cats: ['unknown'], urgency: 1, title: '公式発表の続報を待つ',
      detail: '漏洩項目がまだ公表されていません。公式サイトのお知らせを定期的に確認してください。' }
  ];

  const ALWAYS = {
    urgency: 1,
    title: 'このサービスでの二要素認証を有効にする',
    detail: 'パスワードが漏れても、二要素認証があれば乗っ取りはほぼ防げます。設定できるサービスなら必ず有効にしてください。'
  };

  function adviceFor(cats) {
    const set = new Set(cats || []);
    const out = [];
    for (const r of RULES) {
      if (r.cats.some((c) => set.has(c))) out.push({ urgency: r.urgency, title: r.title, detail: r.detail });
    }
    if (set.has('password') || set.has('password_hash') || set.has('login_credential')) out.push(ALWAYS);
    out.sort((a, b) => b.urgency - a.urgency);
    return out;
  }

  const api = { severity, adviceFor, SEV_LABEL: ['不明', '低', '中', '高'], URGENCY_LABEL: { 3: '今すぐ', 2: '数日のうちに', 1: '覚えておく' } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LEAKSCAN_ADVICE = api;
})(typeof self !== 'undefined' ? self : this);

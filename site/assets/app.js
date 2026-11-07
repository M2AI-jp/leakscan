/* LeakScan site — shared helpers. No external dependencies, no tracking. */
(function () {
  'use strict';

  const LeakScan = (window.LeakScan = {});

  /* ---------- theme ---------- */
  try {
    const saved = localStorage.getItem('leakscan-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (_) {}
  LeakScan.initThemeToggle = function (btn) {
    if (!btn) return;
    const paint = () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      btn.textContent = dark ? '☀ Light' : '☾ Dark';
    };
    paint();
    btn.addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      const next = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('leakscan-theme', next); } catch (_) {}
      paint();
    });
  };

  /* ---------- data ----------
     このサイトの配信物は、デプロイしたときにしか変わらない。
     一方で日次の収集結果は毎朝GitHubのリポジトリに入る。
     そこで、配信物を読むのと同時にGitHub側の更新日も見にいき、
     あちらが新しければそちらを使う。こうしておくと、
     デプロイが止まっていても表示は毎朝新しくなる。
     費用はかからない（公開リポジトリの読み取りだけ）。       */
  const GH_DATA = 'https://raw.githubusercontent.com/M2AI-jp/leakscan/main/data/';
  const GH_WAIT = 2500;   // GitHubが遅い・塞がれている時に表示を待たせない

  function ghFetch(name) {
    const opt = { cache: 'no-cache' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      opt.signal = AbortSignal.timeout(GH_WAIT);
    }
    return fetch(GH_DATA + name, opt)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  /** 配信元が乗っ取られても画面に変な文字を出さないよう、日付は形で絞る。 */
  const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
  /* typeof で文字列に限る。String(v) で寄せると、toString を持つ値まで
     日付として通ってしまう（本物のJSONには現れないが、絞っておく方が安い）。 */
  const day = (v) => (typeof v === 'string' && DATE_OK.test(v) ? v : '');

  LeakScan.load = async function () {
    const [meta, entries, ghMeta] = await Promise.all([
      fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/breaches.json', { cache: 'no-cache' }).then((r) => r.json()),
      ghFetch('meta.json')
    ]);
    const site = { meta, entries, from: 'site' };
    if (!ghMeta || typeof ghMeta !== 'object') return site;

    /* あちらのデータが新しい日。事案ごと取り直す。 */
    if (day(ghMeta.updated) > day(meta.updated)) {
      const ghEntries = await ghFetch('breaches.json');
      if (Array.isArray(ghEntries) && ghEntries.length) {
        return { meta: ghMeta, entries: ghEntries, from: 'github' };
      }
      return site;
    }

    /* 新しい事案が無かった日。データは同じだが「情報源を見にいった日」は進んでいる。
       事案を取り直す必要はないが、日付だけは新しい方を出す。
       さもないと、自動収集が毎朝動いていても、デプロイした日のまま古く見える
       （配信物はデプロイした時にしか変わらないため）。 */
    const ghChecked = day(ghMeta.checked);
    if (ghChecked && ghChecked > LeakScan.lastChecked(meta)) {
      const merged = {};
      for (const k in meta) merged[k] = meta[k];
      merged.checked = ghChecked;
      return { meta: merged, entries, from: 'site+gh' };
    }
    return site;
  };

  /* ---------- severity ----------
     3 = 金銭・なりすまし直結 / 2 = 連絡先・属性 / 1 = 識別子のみ         */
  const SEV3 = ['card', 'bank', 'password', 'id_document', 'my_number', 'login_credential'];
  const SEV2 = ['name', 'address', 'phone', 'dob', 'password_hash', 'medical', 'point_balance', 'purchase_history', 'employment'];
  LeakScan.severity = function (cats) {
    if (!cats || !cats.length) return 0;
    if (cats.some((c) => SEV3.includes(c))) return 3;
    if (cats.some((c) => SEV2.includes(c))) return 2;
    if (cats.includes('email') || cats.includes('member_id')) return 1;
    return 0;
  };
  LeakScan.sevLabel = ['不明', '低', '中', '高'];

  /* ---------- formatting ---------- */
  LeakScan.fmtNum = function (n) {
    if (n == null) return '—';
    if (n >= 100000000) return (n / 100000000).toFixed(n >= 1000000000 ? 0 : 2).replace(/\.?0+$/, '') + '億件';
    if (n >= 10000) return Math.round(n / 10000).toLocaleString('ja-JP') + '万件';
    return n.toLocaleString('ja-JP') + '件';
  };
  /** 大きな数は丸めず全桁で出す。桁区切りは <i> にして薄く見せる。 */
  LeakScan.bigNum = function (n) {
    const s = Math.round(Number(n) || 0).toLocaleString('en-US');
    return LeakScan.esc(s).replace(/,/g, '<i>,</i>');
  };
  /** 0から実数までカウントアップする。動きを減らす設定なら即座に確定値を出す。 */
  LeakScan.countUp = function (el, to, ms) {
    const target = Number(to) || 0;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !target || typeof requestAnimationFrame !== 'function') {
      el.innerHTML = LeakScan.bigNum(target);
      return;
    }
    const dur = ms || 1600;
    const t0 = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      el.innerHTML = LeakScan.bigNum(target * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  };
  /** 桁が増えても1行に収まるよう、実測して文字サイズを決める。
   *  サイズ指定はすべて em 基準なので、幅は文字サイズに比例する。 */
  LeakScan.fitBig = function (el) {
    const box = el.parentElement;
    const wrap = box && box.parentElement;
    if (!box || !wrap) return;
    box.style.fontSize = '';
    const avail = wrap.clientWidth;
    const base = parseFloat(getComputedStyle(box).fontSize) || 100;
    const need = box.scrollWidth;
    if (avail > 0 && need > avail) {
      box.style.fontSize = Math.max(20, Math.floor(base * (avail / need) * 0.99)) + 'px';
    }
  };
  /** 最後に情報源を見にいった日。
   *  meta.checked は日次ジョブが毎日押す。updated はデータが変わった日だけ動く。
   *  古い配信物に checked が無い場合もあるので updated に落とす。
   *  「確認」が「更新」より古く見えるのはおかしいので、新しい方を採る。 */
  LeakScan.lastChecked = function (meta) {
    const u = String((meta && meta.updated) || '');
    const c = String((meta && meta.checked) || '');
    return c > u ? c : u;
  };
  LeakScan.fmtDate = function (iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${y}年${Number(m)}月${Number(d)}日`;
  };
  LeakScan.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  };

  /* ---------- entry card ---------- */
  /** 公式発表を直接引いているか。
   *  判定は scripts/lib/sources.mjs がビルド時に行い、official に入っている。
   *  （照合ドメインの有無とは独立。ドメインを採用できなかった事案でも
   *    公式発表を引いていれば「公式発表あり」と表示する） */
  LeakScan.hasOfficial = function (e) {
    if (typeof e.official === 'boolean') return e.official;
    const doms = (e.match && e.match.domains) || [];
    return !!doms.length && (e.sources || []).some((s) => doms.some((d) => String(s.url).includes(d)));
  };

  LeakScan.entryCard = function (e, meta) {
    const esc = LeakScan.esc;
    const sev = LeakScan.severity(e.categories);
    const official = LeakScan.hasOfficial(e);
    const cats = (e.categories || [])
      .map((c) => `<span class="badge cat">${esc(meta.categories[c] || c)}</span>`)
      .join('');
    const srcs = (e.sources || [])
      .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`)
      .join(' / ');
    return `
      <article class="entry" id="${esc(e.id)}">
        <div class="entry-head">
          <span class="svc">${esc(e.service)}</span>
          ${e.company && e.company !== e.service ? `<span class="co">${esc(e.company)}</span>` : ''}
          <span class="date">公表 ${esc(LeakScan.fmtDate(e.disclosed))}</span>
        </div>
        <div class="entry-rec"><b>${esc(e.records)}</b></div>
        <div class="badges">
          <span class="badge s-${esc(e.status)}">${esc(meta.status_labels[e.status] || e.status)}</span>
          <span class="badge src-${official ? 'o' : 's'}">${official ? '公式発表あり' : '報道による'}</span>
          <span class="badge sev-${sev}">危険度 ${esc(LeakScan.sevLabel[sev])}</span>
          <span class="badge">${esc(meta.cause_labels[e.cause] || e.cause)}</span>
          <span class="badge">${esc(e.sector)}</span>
          ${cats}
        </div>
        ${e.scope ? `<div class="entry-scope">${esc(e.scope)}</div>` : ''}
        ${srcs ? `<div class="entry-src"><b>出典</b>${srcs}</div>` : ''}
      </article>`;
  };
})();

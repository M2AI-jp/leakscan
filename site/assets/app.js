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

  /* ---------- data ---------- */
  LeakScan.load = async function () {
    const [meta, entries] = await Promise.all([
      fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/breaches.json', { cache: 'no-cache' }).then((r) => r.json())
    ]);
    return { meta, entries };
  };

  /* ---------- severity ----------
     3 = 金銭・なりすまし直結 / 2 = 連絡先・属性 / 1 = 識別子のみ         */
  const SEV3 = ['card', 'bank', 'password', 'id_document', 'login_credential'];
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
  LeakScan.entryCard = function (e, meta) {
    const esc = LeakScan.esc;
    const sev = LeakScan.severity(e.categories);
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
          <span class="co">${esc(e.company)}</span>
          <span class="date">公表 ${esc(LeakScan.fmtDate(e.disclosed))}</span>
        </div>
        <div class="entry-rec"><b>${esc(e.records)}</b></div>
        <div class="badges">
          <span class="badge s-${esc(e.status)}">${esc(meta.status_labels[e.status] || e.status)}</span>
          <span class="badge sev-${sev}">危険度 ${esc(LeakScan.sevLabel[sev])}</span>
          <span class="badge">${esc(meta.cause_labels[e.cause] || e.cause)}</span>
          <span class="badge">${esc(e.sector)}</span>
          ${cats}
        </div>
        ${e.scope ? `<div class="entry-scope">${esc(e.scope)}</div>` : ''}
        ${srcs ? `<div class="entry-src">出典: ${srcs}</div>` : ''}
      </article>`;
  };
})();

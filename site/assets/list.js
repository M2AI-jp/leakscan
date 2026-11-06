/* LeakScan — database browser */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let ALL = [], META = null;

  function sectors(entries) {
    return [...new Set(entries.map((e) => e.sector))].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  /* 「集め方と限界」の数字。毎日変わるのでデータから出す。 */
  function fillMethod(entries, meta) {
    const n = entries.length;
    const put = (cls, v) => document.querySelectorAll('.' + cls).forEach((el) => { el.textContent = v; });
    const official = entries.filter((e) => window.LeakScan.hasOfficial(e)).length;
    const byStatus = {};
    for (const e of entries) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const byAi = {};
    for (const e of entries) byAi[e.ai_link] = (byAi[e.ai_link] || 0) + 1;

    put('m-total', n.toLocaleString('ja-JP'));
    put('m-official', official.toLocaleString('ja-JP'));
    put('m-official-pct', n ? Math.round((official / n) * 100) : 0);
    put('m-auto', entries.filter((e) => e.auto).length.toLocaleString('ja-JP'));
    put('m-ai-confirmed', (byAi.confirmed || 0).toLocaleString('ja-JP'));
    put('m-ai-supply', (byAi.supply_chain || 0).toLocaleString('ja-JP'));
    put('m-ai-unknown', ((byAi.unconfirmed || 0) + (byAi.suspected || 0)).toLocaleString('ja-JP'));
    put('m-status', Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `「${(meta.status_labels && meta.status_labels[k]) || k}」${v}件`)
      .join('／'));
  }

  function render() {
    const q = $('#q').value.trim().toLowerCase();
    const sec = $('#sector').value;
    const sev = $('#sev').value;
    const sort = $('#sort').value;

    let rows = ALL.filter((e) => {
      if (sec && e.sector !== sec) return false;
      if (sev && String(window.LeakScan.severity(e.categories)) !== sev) return false;
      if (!q) return true;
      const hay = [
        e.company, e.service, e.sector, e.scope || '',
        ...(e.match.domains || []), ...(e.match.names || []),
        ...(e.categories || []).map((c) => META.categories[c] || c)
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });

    rows.sort((a, b) => {
      if (sort === 'records') return (b.records_num || 0) - (a.records_num || 0);
      if (sort === 'sev') return window.LeakScan.severity(b.categories) - window.LeakScan.severity(a.categories);
      return (b.disclosed || '').localeCompare(a.disclosed || '');
    });

    const sum = rows.reduce((a, e) => a + (e.records_num || 0), 0);
    $('#count').textContent =
      `${rows.length} / ${ALL.length} 件 ・ ${window.LeakScan.fmtNum(sum)}`;
    $('#entries').innerHTML = rows.length
      ? rows.map((e) => window.LeakScan.entryCard(e, META)).join('')
      : '<div class="empty">該当する事案はありません。</div>';
  }

  (async function () {
    try {
      const { meta, entries } = await window.LeakScan.load();
      META = meta; ALL = entries;
      $('#sector').insertAdjacentHTML(
        'beforeend',
        sectors(entries).map((s) => `<option value="${window.LeakScan.esc(s)}">${window.LeakScan.esc(s)}</option>`).join('')
      );
      $('#updated').textContent = window.LeakScan.fmtDate(meta.updated);
      fillMethod(entries, meta);
      ['input', 'change'].forEach((ev) => {
        $('#q').addEventListener(ev, render);
      });
      ['#sector', '#sev', '#sort'].forEach((s) => $(s).addEventListener('change', render));
      render();
      if (location.hash) {
        const el = document.getElementById(location.hash.slice(1));
        if (el) el.scrollIntoView({ block: 'center' });
      }
    } catch (err) {
      $('#entries').innerHTML = '<div class="empty">データの読み込みに失敗しました。再読み込みしてください。</div>';
      console.error(err);
    }
  })();
})();

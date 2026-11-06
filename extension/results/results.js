/* LeakScan — results page */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const A = window.LEAKSCAN_ADVICE;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${y}年${Number(m)}月${Number(d)}日`;
  };
  const fmtTime = (ms) => new Date(ms).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

  /* theme */
  try { const s = localStorage.getItem('leakscan-theme'); if (s) document.documentElement.dataset.theme = s; } catch (_) {}
  const tb = $('#theme');
  const paint = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    tb.textContent = dark ? '☀ Light' : '☾ Dark';
  };
  paint();
  tb.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('leakscan-theme', document.documentElement.dataset.theme); } catch (_) {}
    paint();
  });

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  const HOW = { domain: 'アドレス一致', related: '関連ドメイン', name: '表示名一致' };

  function hitLine(h) {
    const by = HOW[h.how] || h.how;
    return `<span class="h">${esc(h.name ? h.name + ' <' + h.email + '>' : h.email)}
      <span class="by">— ${by}${h.date ? ' / 最新 ' + esc(h.date) : ''}</span></span>`;
  }

  function serviceCard(e, hits, meta) {
    const sev = A.severity(e.categories);
    const cats = (e.categories || [])
      .map((c) => `<span class="badge cat">${esc((meta.categories && meta.categories[c]) || c)}</span>`).join('');
    const srcs = (e.sources || [])
      .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join(' / ');
    const weak = hits.every((h) => h.how !== 'domain');
    const weakLabel = hits.some((h) => h.how === 'related') ? '関連ドメイン一致' : '表示名一致';
    const advice = A.adviceFor(e.categories)
      .map((a) => `<div class="action"><span class="u u${a.urgency}">${esc(A.URGENCY_LABEL[a.urgency])}</span>
        <div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p></div></div>`).join('');

    return `
      <article class="entry">
        <div class="entry-head">
          <span class="svc">${esc(e.service)}</span>
          <span class="co">${esc(e.company)}</span>
          <span class="date">公表 ${esc(fmtDate(e.disclosed))}</span>
        </div>
        <div class="entry-rec"><b>${esc(e.records)}</b></div>
        <div class="badges">
          <span class="badge s-${esc(e.status)}">${esc((meta.status_labels && meta.status_labels[e.status]) || e.status)}</span>
          <span class="badge sev-${sev}">危険度 ${esc(A.SEV_LABEL[sev])}</span>
          <span class="badge">${esc((meta.cause_labels && meta.cause_labels[e.cause]) || e.cause)}</span>
          ${weak ? `<span class="badge">${esc(weakLabel)}</span>` : ''}
          ${cats}
        </div>
        ${e.scope ? `<div class="entry-scope">${esc(e.scope)}</div>` : ''}
        <div class="hits">Gmailで一致した差出人:<br>${hits.map(hitLine).join('<br>')}</div>
        ${advice ? `<details class="detail"><summary>このサービスについての対応 (${A.adviceFor(e.categories).length}件)</summary><div class="advice actions">${advice}</div></details>` : ''}
        ${srcs ? `<div class="entry-src">出典: ${srcs}</div>` : ''}
      </article>`;
  }

  function aggregate(matched) {
    const map = new Map();
    for (const { entry } of matched) {
      for (const a of A.adviceFor(entry.categories)) {
        const k = a.title;
        if (!map.has(k)) map.set(k, { ...a, services: [] });
        map.get(k).services.push(entry.service);
      }
    }
    return [...map.values()].sort((x, y) => y.urgency - x.urgency || y.services.length - x.services.length);
  }

  (async function () {
    const view = await send({ type: 'LEAKSCAN_GET_VIEW' });
    const dbRes = await send({ type: 'LEAKSCAN_GET_DB' });
    const meta = (dbRes && dbRes.meta) || {};
    const entries = (dbRes && dbRes.entries) || [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const report = view && view.report;

    if (!report) {
      $('#headline').innerHTML = 'スキャン結果がありません';
      $('#meta').textContent = '拡張機能のアイコンから「スキャン開始」を実行してください。';
      $('#actions').hidden = true;
      $('#services').hidden = true;
      return;
    }

    const matched = (report.matches || [])
      .map((m) => ({ entry: byId.get(m.id), hits: m.hits || [] }))
      .filter((m) => m.entry)
      .sort((a, b) => A.severity(b.entry.categories) - A.severity(a.entry.categories) ||
        (b.entry.records_num || 0) - (a.entry.records_num || 0));

    const n = matched.length;
    const high = matched.filter((m) => A.severity(m.entry.categories) === 3).length;

    $('#headline').innerHTML = n
      ? `あなたが使っている<br><em>${n}件</em>のサービスで漏洩が公表されています`
      : `<span class="safe">照合した範囲では<br><em class="safe">該当なし</em>でした</span>`;
    $('#meta').textContent =
      `${fmtTime(report.generatedAt)} 実行 ／ ${report.scanned}件の事案を照合（Gmail検索 ${report.queries} 回） ／ ` +
      `危険度「高」${high}件 ／ DB ${report.dbVersion || '—'}（${report.dbSource === 'remote' ? '最新取得' : '同梱版'}） ／ ` +
      `アカウント u/${report.accountIndex}`;

    const acts = aggregate(matched);
    if (!acts.length) {
      $('#action-list').innerHTML =
        '<div class="action"><span class="u u1">参考</span><div><b>いまは個別の対応は不要です</b>' +
        '<p>ただし検出できる範囲には限りがあります。使っているサービスからの「漏洩のお知らせ」メールは、リンクを踏まずに公式サイトから確認する習慣をつけてください。</p></div></div>';
    } else {
      $('#action-list').innerHTML = acts.map((a) => `
        <div class="action">
          <span class="u u${a.urgency}">${esc(A.URGENCY_LABEL[a.urgency])}</span>
          <div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p>
            <div class="svcs">対象: ${esc([...new Set(a.services)].join('、'))}</div>
          </div>
        </div>`).join('');
    }

    $('#list').innerHTML = n
      ? matched.map((m) => serviceCard(m.entry, m.hits, meta)).join('')
      : '<div class="empty">一致したサービスはありませんでした。別のメールアドレスで登録したサービスは検出できないため、安全の証明ではありません。</div>';

    $('#rescan').addEventListener('click', async () => {
      $('#rescan').disabled = true;
      $('#rescan').textContent = 'スキャンを開始しました…';
      await send({ type: 'LEAKSCAN_START_SCAN' });
    });
    $('#clear').addEventListener('click', async () => {
      await send({ type: 'LEAKSCAN_CLEAR' });
      location.reload();
    });
  })();
})();

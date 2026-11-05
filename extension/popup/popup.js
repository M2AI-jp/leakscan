/* LeakScan — popup */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const A = window.LEAKSCAN_ADVICE;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  const resultsUrl = chrome.runtime.getURL('results/results.html');

  try { const s = localStorage.getItem('leakscan-theme'); if (s) document.documentElement.dataset.theme = s; } catch (_) {}

  $('#opts').addEventListener('click', (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });

  let DB = null;

  function btn(id, label, primary) {
    return `<button class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" id="${id}" type="button">${esc(label)}</button>`;
  }

  async function paint() {
    const view = await send({ type: 'LEAKSCAN_GET_VIEW' });
    if (!view) { $('#title').textContent = '拡張機能を再読み込みしてください'; return; }

    const { state, report, db } = view;
    $('#err').hidden = true;
    $('#prog').hidden = true;
    $('#top').innerHTML = '';
    $('#buttons').innerHTML = '';

    $('#foot').innerHTML =
      `収録 ${esc(db.count)} 事案 ／ DB ${esc(db.version || '—')}（${db.source === 'remote' ? '最新取得' : '同梱版'}${db.stale ? '・更新失敗' : ''}）<br>` +
      'Gmailの差出人のみをブラウザ内で照合します。本文は読まず、外部送信もしません。';

    if (state.status === 'running') {
      const p = state.progress || { settled: 0, total: 1, queries: 0 };
      $('#title').textContent = '照合しています…';
      $('#sub').textContent = 'Gmailのタブで検索が走っています。そのタブは触らずにお待ちください。';
      $('#prog').hidden = false;
      $('#fill').style.width = Math.round((p.settled / Math.max(1, p.total)) * 100) + '%';
      $('#pnote').textContent = `${p.settled} / ${p.total} 件照合 ／ 検索 ${p.queries} 回` + (p.note ? ' ／ ' + p.note : '');
      $('#buttons').innerHTML = btn('cancel', '中止する', false);
      $('#cancel').addEventListener('click', async () => { await send({ type: 'LEAKSCAN_CANCEL_SCAN' }); paint(); });
      return;
    }

    if (state.status === 'error') {
      $('#err').hidden = false;
      $('#err').textContent = state.error || '不明なエラー';
    }

    if (report) {
      if (!DB) DB = await send({ type: 'LEAKSCAN_GET_DB' });
      const byId = new Map((DB.entries || []).map((e) => [e.id, e]));
      const matched = (report.matches || []).map((m) => byId.get(m.id)).filter(Boolean)
        .sort((a, b) => A.severity(b.categories) - A.severity(a.categories));
      const n = matched.length;

      $('#title').innerHTML = n
        ? `使用中の<em>${n}件</em>のサービスで漏洩が公表されています`
        : '照合した範囲では<em class="safe">該当なし</em>でした';
      $('#sub').textContent =
        `${new Date(report.generatedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })} に ${report.scanned}件の事案を照合`;

      $('#top').innerHTML = matched.slice(0, 4).map((e) => {
        const sev = A.severity(e.categories);
        const cls = sev === 3 ? 'sev-3' : sev === 2 ? 'sev-2' : 'sev-1';
        return `<a href="${esc(resultsUrl)}#${esc(e.id)}" target="_blank" rel="noopener">
          <span class="sv">${esc(e.service)}</span>
          <span class="sb badge ${cls}">危険度 ${esc(A.SEV_LABEL[sev])}</span></a>`;
      }).join('') + (n > 4 ? `<a href="${esc(resultsUrl)}" target="_blank" rel="noopener"><span>ほか ${n - 4} 件を見る</span></a>` : '');

      $('#buttons').innerHTML = btn('open', '結果を詳しく見る', true) + btn('scan', 'もう一度スキャン', false);
      $('#open').addEventListener('click', () => chrome.tabs.create({ url: resultsUrl }));
      $('#scan').addEventListener('click', start);
      return;
    }

    $('#title').textContent = '漏洩していないか調べる';
    $('#sub').textContent =
      'Gmailを開いて、公表済みの漏洩事案とあなたが使っているサービスを突き合わせます。数分かかります。';
    $('#buttons').innerHTML = btn('scan', 'スキャン開始', true);
    $('#scan').addEventListener('click', start);
  }

  async function start() {
    $('#buttons').innerHTML = '';
    $('#title').textContent = 'Gmailを開いています…';
    $('#sub').textContent = '';
    const r = await send({ type: 'LEAKSCAN_START_SCAN' });
    if (r && !r.ok) { $('#err').hidden = false; $('#err').textContent = r.error; }
    paint();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'LEAKSCAN_STATE' || msg.type === 'LEAKSCAN_PROGRESS')) paint();
  });

  paint();
})();

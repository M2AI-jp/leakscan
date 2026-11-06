(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  try { const s = localStorage.getItem('leakscan-theme'); if (s) document.documentElement.dataset.theme = s; } catch (_) {}

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await send({
        type: 'LEAKSCAN_SET_OPTIONS',
        patch: {
          accountIndex: Math.max(0, Math.min(9, Number($('#account').value) || 0)),
          includeSpamTrash: $('#spam').checked,
          batchSize: Math.max(1, Math.min(24, Number($('#batch').value) || 16)),
          dbBase: ($('#dburl').value || '').trim() || 'https://leakscan.matsunai.com/data/'
        }
      });
    }, 300);
  }

  (async function () {
    const view = await send({ type: 'LEAKSCAN_GET_VIEW' });
    const o = view.options;
    $('#account').value = o.accountIndex;
    $('#spam').checked = !!o.includeSpamTrash;
    $('#batch').value = o.batchSize;
    $('#dburl').value = o.dbBase;
    const host = (view.db.origin || '').split('/')[2] || '';
    $('#dbinfo').textContent =
      `収録 ${view.db.count} 事案 / ` +
      (view.db.source === 'remote' ? `最新取得${host ? `（${host}）` : ''}` : '同梱版');

    ['#account', '#batch', '#dburl'].forEach((s) => $(s).addEventListener('input', save));
    $('#spam').addEventListener('change', save);

    $('#refresh').addEventListener('click', async () => {
      $('#dbinfo').textContent = '取得中…';
      const r = await send({ type: 'LEAKSCAN_REFRESH_DB' });
      $('#dbinfo').textContent = r && r.ok
        ? `更新しました（${r.count} 事案 / ${r.source === 'remote' ? `最新取得${(r.origin || '').split('/')[2] ? `（${(r.origin || '').split('/')[2]}）` : ''}` : '同梱版'}${r.lastError && r.source !== 'remote' ? '・取得失敗のため同梱版' : ''}）`
        : '更新に失敗しました: ' + ((r && r.error) || '');
    });

    $('#selftest').addEventListener('click', async () => {
      const box = $('#stresult');
      $('#selftest').disabled = true;
      box.innerHTML = '<p class="hint" style="margin:0">Gmailを開いて確認しています…</p>';
      const r = await send({ type: 'LEAKSCAN_SELFTEST' });
      $('#selftest').disabled = false;
      if (!r) { box.innerHTML = '<div class="note">応答がありませんでした。拡張機能を再読み込みしてください。</div>'; return; }
      const row = (label, good, value) =>
        `<div style="display:flex;gap:10px;align-items:baseline;font-size:13.5px;padding:3px 0">
           <span style="color:${good ? 'var(--ok)' : 'var(--danger)'};font-weight:800">${good ? '✓' : '✗'}</span>
           <span>${label}</span><span style="margin-left:auto;color:var(--fg-dim);font-variant-numeric:tabular-nums">${value}</span>
         </div>`;
      const verdict = r.ok
        ? '<b style="color:var(--ok)">正常に読み取れています。スキャンを実行できます。</b>'
        : '<b style="color:var(--danger)">読み取りに問題があります。</b>';
      box.innerHTML =
        `<div class="note" style="background:var(--bg-elev-2);border-color:var(--border-strong)">
           <p style="margin:0 0 10px">${verdict}</p>
           ${row('検索ボックスを検出', !!r.searchBoxFound, r.searchBoxFound ? 'OK' : '見つからない')}
           ${row('検索結果のリセット', !!r.resetOk, r.resetOk ? 'OK' : '失敗')}
           ${row('「該当なし」の判定', !!r.noResultsDetected, r.noResultsDetected ? 'OK' : '未検出')}
           ${row('一覧行の読み取り', r.rowSelector !== 'none' || r.rowCount === 0, r.rowSelector === 'tr.zA' ? '標準セレクタ' : (r.rowSelector === 'fallback' ? '代替セレクタ' : '行なし'))}
           ${row('差出人の読み取り', !!r.senderAttrsOk || r.rowCount === 0, r.senderCount + ' 件')}
           ${row('ページ送りの検出', !!r.paginationDetectable, r.paginationDetectable ? 'OK' : '不明（件数で代替）')}
           <div style="margin-top:10px;font-size:12px;color:var(--fg-dim)">所要 ${r.elapsedMs || 0} ms${r.error ? ' ／ エラー: ' + r.error : ''}</div>
         </div>`;
    });

    $('#clear').addEventListener('click', async () => {
      await send({ type: 'LEAKSCAN_CLEAR' });
      $('#cleared').textContent = '削除しました';
    });
  })();
})();

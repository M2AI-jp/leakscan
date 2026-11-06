/* LeakScan — Gmail content script.
 * Uses ONLY Gmail's own search UI. No Gmail API, no OAuth, no network calls.
 * Reads only the sender address / display name / date shown in the result list.
 */
(function () {
  'use strict';
  if (window.__leakscanContentLoaded) return;
  window.__leakscanContentLoaded = true;

  const POLL_MS = 120;
  const NAV_TIMEOUT = 15000;
  const RESET_TIMEOUT = 9000;
  /* Split a batch when the result page looks truncated and some services in it
     produced no hit — otherwise a chatty service could mask a quiet one. */
  const TRUNCATION_ROWS = 24;

  let cancelled = false;

  /* ------------------------------------------------------------------ utils */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const M = self.LEAKSCAN_MATCH;
  const norm = M.norm;
  const buildQuery = M.buildQuery;
  const matchSender = M.matchSender;

  async function waitFor(pred, timeout, label) {
    const t0 = Date.now();
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      let v;
      try { v = pred(); } catch (_) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('timeout:' + (label || ''));
      await sleep(POLL_MS);
    }
  }

  /* --------------------------------------------------------- gmail dom reads */
  function mainEl() {
    return document.querySelector('div[role="main"]');
  }

  function rowEls() {
    const main = mainEl();
    if (!main) return [];
    let rows = main.querySelectorAll('tr.zA');
    if (!rows.length) rows = main.querySelectorAll('table[role="grid"] tr[role="row"]');
    return Array.from(rows);
  }

  function noResults() {
    const main = mainEl();
    if (!main) return false;
    const txt = main.innerText || '';
    return /一致するメッセージはありません|該当するメッセージはありません|No messages matched|メッセージが見つかりません|条件に一致するメール/.test(txt);
  }

  function searchInputEl() {
    return (
      document.querySelector('input[name="q"]') ||
      document.querySelector('form[role="search"] input[type="text"]') ||
      document.querySelector('input[aria-label*="検索"]') ||
      document.querySelector('input[aria-label*="Search"]')
    );
  }

  /** Gmail mirrors the hash into the search box — our signal that the new
   *  query (not the previous one) is the one being displayed. */
  function searchBoxShows(fragment) {
    const el = searchInputEl();
    if (!el) return false;
    return norm(el.value).includes(norm(fragment));
  }

  /** true = more pages exist, false = this is everything, null = can't tell */
  function hasMorePages() {
    const btns = document.querySelectorAll('div[role="button"][aria-disabled], button[aria-disabled]');
    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || '');
      if (/古いメール|古い|Older|次のページ|Next page/.test(label)) {
        return b.getAttribute('aria-disabled') === 'false';
      }
    }
    return null;
  }

  function readSenders() {
    const out = [];
    const rows = rowEls();
    for (const tr of rows) {
      let date = '';
      const dateEl = tr.querySelector('td.xW span[title], span.xW span[title], td[role="gridcell"] span[title]');
      if (dateEl) date = dateEl.getAttribute('title') || dateEl.textContent || '';
      const spans = tr.querySelectorAll('span[email]');
      for (const sp of spans) {
        const email = (sp.getAttribute('email') || '').trim().toLowerCase();
        if (!email || email.indexOf('@') < 1) continue;
        out.push({ email, name: (sp.getAttribute('name') || '').trim(), date: date.trim() });
      }
    }
    if (!out.length) {
      const main = mainEl();
      if (main) {
        for (const sp of main.querySelectorAll('[email]')) {
          const email = (sp.getAttribute('email') || '').trim().toLowerCase();
          if (email.indexOf('@') > 0) out.push({ email, name: (sp.getAttribute('name') || '').trim(), date: '' });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- navigation */
  function goHash(query) {
    location.hash = '#search/' + encodeURIComponent(query);
  }

  /** Clear the list to a known-empty state so stale rows can never be read as
   *  the next query's result. */
  async function resetList(token) {
    const marker = 'leakscan' + token + 'zz';
    goHash(marker);
    await waitFor(
      () => searchBoxShows(marker) && (noResults() || rowEls().length === 0),
      RESET_TIMEOUT,
      'reset'
    );
  }

  async function runSearch(query, syncFragment, token) {
    await resetList(token);
    goHash(query);
    await waitFor(
      () => searchBoxShows(syncFragment) && (rowEls().length > 0 || noResults()),
      NAV_TIMEOUT,
      'search'
    );
    await sleep(180); // let the rest of the first page paint
    return { senders: readSenders(), rows: rowEls().length, more: hasMorePages() };
  }

  /* ------------------------------------------------------------------- scan */
  async function runScan(payload) {
    cancelled = false;
    const opts = payload.options || {};
    const services = payload.services || [];
    /* 1回のクエリに詰め込む上限。Gmailの検索は長いクエリも通るので、
       件数ではなく文字数で詰める。収録件数が増えても照会回数が比例して
       増えないようにするため（574件を8件ずつ引くと72回かかる）。 */
    const QUERY_BUDGET = Math.max(200, opts.queryBudget || 900);
    const BATCH_CAP = Math.max(1, Math.min(24, opts.batchSize || 16));

    /** services を、クエリ長が予算を超えない塊に分ける */
    function packBatches(list) {
      const out = [];
      let cur = [];
      for (const svc of list) {
        const next = cur.concat([svc]);
        if (cur.length && (next.length > BATCH_CAP || buildQuery(next, opts).length > QUERY_BUDGET)) {
          out.push(cur);
          cur = [svc];
        } else {
          cur = next;
        }
      }
      if (cur.length) out.push(cur);
      return out;
    }

    const ui = mountOverlay(services.length);
    const originalHash = location.hash || '#inbox';
    const results = Object.create(null);
    let queries = 0;
    let settled = 0;
    let token = Date.now() % 100000;

    const report = (note) => {
      ui.update(settled, services.length, queries, note);
      try {
        const p = chrome.runtime.sendMessage({
          type: 'LEAKSCAN_PROGRESS',
          settled, total: services.length, queries,
          found: Object.keys(results).length,
          note: note || ''
        });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (_) {}
    };

    async function scanBatch(batch) {
      if (cancelled) throw new Error('cancelled');
      if (!batch.length) return;
      const query = buildQuery(batch, opts);
      const sync = (batch[0].domains && batch[0].domains[0]) || (batch[0].names && batch[0].names[0]) || '';
      queries++;
      report(batch.length === 1 ? batch[0].label : batch.length + '件のサービスをまとめて照会中');

      let res;
      try {
        res = await runSearch(query, sync, token++);
      } catch (err) {
        if (String(err.message).startsWith('cancelled')) throw err;
        /* one retry, then give up on this batch and report it as unscanned */
        try {
          res = await runSearch(query, sync, token++);
        } catch (err2) {
          for (const svc of batch) { settled++; }
          report('一部の照会がタイムアウトしました');
          return;
        }
      }

      const unfound = [];
      for (const svc of batch) {
        const hits = [];
        for (const sd of res.senders) {
          const how = matchSender(sd, svc);
          if (how) hits.push({ email: sd.email, name: sd.name, date: sd.date, how });
        }
        if (hits.length) {
          const uniq = Object.create(null);
          for (const h of hits) if (!uniq[h.email] || h.how === 'domain') uniq[h.email] = h;
          results[svc.id] = { id: svc.id, hits: Object.values(uniq).slice(0, 6) };
          settled++;
        } else {
          unfound.push(svc);
        }
      }

      const truncated = res.more === true || (res.more === null && res.rows >= TRUNCATION_ROWS);
      if (unfound.length && truncated && batch.length > 1) {
        const mid = Math.ceil(unfound.length / 2);
        await scanBatch(unfound.slice(0, mid));
        await scanBatch(unfound.slice(mid));
      } else {
        settled += unfound.length;
      }
      report();
    }

    let error = null;
    try {
      for (const batch of packBatches(services)) {
        await scanBatch(batch);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }

    try { location.hash = originalHash; } catch (_) {}
    ui.done(error);

    return {
      ok: !error || error === 'cancelled',
      cancelled: error === 'cancelled',
      error: error && error !== 'cancelled' ? error : null,
      queries,
      scanned: services.length,
      matches: Object.values(results)
    };
  }


  /* --------------------------------------------------------------- selftest */
  /** Verifies that Gmail's DOM still matches what the scanner expects.
   *  Returns counts only — never addresses, names or subjects. */
  async function runSelfTest() {
    cancelled = false;
    const t0 = Date.now();
    const out = {
      ok: false,
      searchBoxFound: false,
      resetOk: false,
      noResultsDetected: false,
      rowSelector: 'none',
      rowCount: 0,
      senderCount: 0,
      senderAttrsOk: false,
      paginationDetectable: false,
      elapsedMs: 0,
      error: null
    };
    const originalHash = location.hash || '#inbox';
    try {
      out.searchBoxFound = !!searchInputEl();

      /* 1. a query that cannot match anything -> the "no results" path */
      await resetList(Date.now() % 100000);
      out.resetOk = true;
      out.noResultsDetected = noResults();

      /* 2. a broad query -> the row-reading path */
      goHash('newer_than:2y');
      await waitFor(
        () => searchBoxShows('newer_than') && (rowEls().length > 0 || noResults()),
        NAV_TIMEOUT,
        'selftest-search'
      );
      await sleep(250);

      const main = mainEl();
      if (main && main.querySelectorAll('tr.zA').length) out.rowSelector = 'tr.zA';
      else if (rowEls().length) out.rowSelector = 'fallback';
      out.rowCount = rowEls().length;

      const senders = readSenders();
      out.senderCount = senders.length;
      out.senderAttrsOk = senders.some((x) => x.email.indexOf('@') > 0);
      out.paginationDetectable = hasMorePages() !== null;

      /* A mailbox can legitimately be empty; only the plumbing must work. */
      out.ok = out.searchBoxFound && out.resetOk &&
               (out.rowCount === 0 || (out.rowSelector !== 'none' && out.senderAttrsOk));
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    try { location.hash = originalHash; } catch (_) {}
    out.elapsedMs = Date.now() - t0;
    return out;
  }

  /* ---------------------------------------------------------------- overlay */
  function mountOverlay(total) {
    const host = document.createElement('div');
    host.id = 'leakscan-overlay-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .bd { position:fixed; inset:0; background:rgba(8,10,14,.92);
              font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,system-ui,sans-serif;
              color:#e8ecf3; display:grid; place-items:center; padding:24px; }
        .box { width:min(520px,100%); background:#141923; border:1px solid #262e3d; border-radius:16px; padding:30px 32px; }
        .bi { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:.14em; font-size:16px; color:#4da3ff; }
        h2 { font-size:19px; margin:18px 0 6px; line-height:1.4; }
        p { margin:0; color:#9aa5b8; font-size:13.5px; line-height:1.7; }
        .bar { height:8px; border-radius:999px; background:#1b2130; overflow:hidden; margin:22px 0 10px; }
        .fill { height:100%; width:0%; background:#4da3ff; transition:width .25s ease; }
        .meta { display:flex; justify-content:space-between; font-size:12px; color:#6b7688; font-variant-numeric:tabular-nums; }
        .note { margin-top:14px; font-size:12.5px; color:#9aa5b8; min-height:1.6em; }
        .warn { margin-top:20px; padding:12px 14px; border-radius:10px; background:#2a2015; border:1px solid rgba(255,180,84,.35); font-size:12.5px; color:#ffb454; }
        button { margin-top:22px; background:none; border:1px solid #37425a; color:#9aa5b8; border-radius:10px;
                 padding:9px 18px; font:inherit; font-size:13px; cursor:pointer; }
        button:hover { color:#e8ecf3; }
        .ok .fill { background:#5ddba4; }
        .err .fill { background:#ff6b6b; }
      </style>
      <div class="bd" id="bd">
        <div class="box">
          <div class="bi">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 4.5 7v10.2c0 6.3 4.7 10.9 11.5 12.3 6.8-1.4 11.5-6 11.5-12.3V7L16 2.5Z" fill="none" stroke="#4da3ff" stroke-width="2.4" stroke-linejoin="round"/><path d="M11 16.2l3.6 3.6L21.5 13" fill="none" stroke="#4da3ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            LeakScan
          </div>
          <h2 id="ttl">漏洩データベースと照合しています</h2>
          <p id="desc">Gmailの検索機能で、該当サービスからのメールがあるかだけを確認しています。本文は読み取りません。このタブは触らずにお待ちください。</p>
          <div class="bar"><div class="fill" id="fill"></div></div>
          <div class="meta"><span id="cnt">0 / ${total}</span><span id="qs">検索 0 回</span></div>
          <div class="note" id="note"></div>
          <div class="warn" id="warn" hidden></div>
          <button id="cancel" type="button">中止する</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => root.getElementById(id);
    $('cancel').addEventListener('click', () => { cancelled = true; $('note').textContent = '中止しています…'; });

    return {
      update(settled, tot, queries, note) {
        $('fill').style.width = Math.round((settled / Math.max(1, tot)) * 100) + '%';
        $('cnt').textContent = settled + ' / ' + tot;
        $('qs').textContent = '検索 ' + queries + ' 回';
        if (note != null) $('note').textContent = note;
      },
      done(error) {
        if (error && error !== 'cancelled') {
          $('bd').classList.add('err');
          $('ttl').textContent = 'スキャンを完了できませんでした';
          $('warn').hidden = false;
          $('warn').textContent = 'Gmailの画面構成が変わっている可能性があります（' + error + '）。';
        } else if (error === 'cancelled') {
          $('ttl').textContent = 'スキャンを中止しました';
          $('fill').style.width = '0%';
        } else {
          $('bd').classList.add('ok');
          $('ttl').textContent = '照合が完了しました';
          $('desc').textContent = '結果ページに移動します。';
          $('fill').style.width = '100%';
        }
        $('cancel').textContent = '閉じる';
        $('cancel').onclick = () => host.remove();
        setTimeout(() => { try { host.remove(); } catch (_) {} }, 2500);
      }
    };
  }

  /* -------------------------------------------------------------- messaging */
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'LEAKSCAN_PING') {
      respond({ ok: true, ready: !!mainEl(), href: location.href });
      return;
    }
    if (msg.type === 'LEAKSCAN_SCAN') {
      runScan(msg.payload || {}).then(respond, (err) =>
        respond({ ok: false, error: String((err && err.message) || err) })
      );
      return true;
    }
    if (msg.type === 'LEAKSCAN_SELFTEST') {
      runSelfTest().then(respond, (err) =>
        respond({ ok: false, error: String((err && err.message) || err) })
      );
      return true;
    }
    if (msg.type === 'LEAKSCAN_CANCEL') {
      cancelled = true;
      respond({ ok: true });
    }
  });
})();

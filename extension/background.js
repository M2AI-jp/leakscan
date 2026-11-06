/* LeakScan — background service worker.
 * Owns: option storage, breach-DB caching, and driving one Gmail tab per scan.
 * Never sees mail content: the content script returns only matched sender data.
 */

/* Tried in order; the bundled copy is the last resort. */
const DB_MIRRORS = ['https://leakscan.matsunai.com/data/'];

const DEFAULTS = {
  dbBase: 'https://leakscan.matsunai.com/data/',
  accountIndex: 0,
  includeSpamTrash: false,
  batchSize: 16
};

const DB_TTL_MS = 12 * 60 * 60 * 1000;

/** Fire-and-forget: rejects when no popup/page is listening, which is normal. */
function notify(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

/* ----------------------------------------------------------------- storage */
async function getOptions() {
  const { options } = await chrome.storage.local.get('options');
  return Object.assign({}, DEFAULTS, options || {});
}

async function setOptions(patch) {
  const next = Object.assign(await getOptions(), patch || {});
  await chrome.storage.local.set({ options: next });
  return next;
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || { status: 'idle' };
}

async function setState(next) {
  await chrome.storage.local.set({ state: next });
  notify({ type: 'LEAKSCAN_STATE', state: next });
  return next;
}

/* ---------------------------------------------------------------------- db */
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadBundled() {
  const [meta, entries] = await Promise.all([
    fetchJson(chrome.runtime.getURL('data/meta.json')),
    fetchJson(chrome.runtime.getURL('data/breaches.json'))
  ]);
  return { meta, entries, source: 'bundled', fetchedAt: Date.now() };
}

async function loadDb(force) {
  const { db } = await chrome.storage.local.get('db');
  if (!force && db && Date.now() - db.fetchedAt < DB_TTL_MS && db.entries && db.entries.length) {
    return db;
  }
  const { dbBase } = await getOptions();
  const bases = [];
  for (const b of [dbBase].concat(DB_MIRRORS)) {
    const base = b.endsWith('/') ? b : b + '/';
    if (!bases.includes(base)) bases.push(base);
  }
  let fresh = null;
  let err = null;
  for (const base of bases) {
    try {
      const [meta, entries] = await Promise.all([
        fetchJson(base + 'meta.json'),
        fetchJson(base + 'breaches.json')
      ]);
      if (!Array.isArray(entries) || !entries.length) throw new Error('empty dataset');
      fresh = { meta, entries, source: 'remote', origin: base, fetchedAt: Date.now() };
      break;
    } catch (e) { err = e; }
  }
  if (!fresh) {
    /* Offline, or every mirror unreachable: the shipped copy still works. */
    if (db && db.entries && db.entries.length) {
      return Object.assign({}, db, { stale: true, lastError: String((err && err.message) || err) });
    }
    fresh = await loadBundled();
    fresh.lastError = String((err && err.message) || err);
  }
  await chrome.storage.local.set({ db: fresh });
  return fresh;
}

/* -------------------------------------------------------------------- scan */
let scanTabId = null;

function serviceList(entries) {
  return entries
    .filter((e) => e.match && ((e.match.domains || []).length || (e.match.names || []).length))
    .map((e) => ({
      id: e.id,
      label: e.service,
      domains: e.match.domains || [],
      names: e.match.names || []
    }));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 20000);
  });
}

async function pingUntilReady(tabId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'LEAKSCAN_PING' });
      if (res && res.ok && res.ready) return true;
    } catch (_) { /* content script not there yet */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function startScan() {
  const current = await getState();
  if (current.status === 'running') return current;

  const opts = await getOptions();
  const db = await loadDb(false);
  const services = serviceList(db.entries);

  await setState({
    status: 'running',
    startedAt: Date.now(),
    progress: { settled: 0, total: services.length, queries: 0, found: 0, note: 'Gmailを開いています…' }
  });

  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://mail.google.com/mail/u/${Number(opts.accountIndex) || 0}/#inbox`,
      active: true
    });
  } catch (err) {
    return setState({ status: 'error', error: 'Gmailのタブを開けませんでした: ' + (err.message || err) });
  }
  scanTabId = tab.id;

  await waitForTabLoad(tab.id);
  const ready = await pingUntilReady(tab.id);
  if (!ready) {
    scanTabId = null;
    return setState({
      status: 'error',
      error:
        'Gmailの画面を読み込めませんでした。Googleアカウントにログインしているか、' +
        '設定のアカウント番号（u/0, u/1 …）が合っているかを確認してください。'
    });
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, {
      type: 'LEAKSCAN_SCAN',
      payload: { services, options: opts }
    });
  } catch (err) {
    scanTabId = null;
    return setState({ status: 'error', error: 'スキャン中に接続が切れました: ' + (err.message || err) });
  }
  scanTabId = null;

  if (!res || (!res.ok && !res.cancelled)) {
    return setState({ status: 'error', error: (res && res.error) || '不明なエラー' });
  }
  if (res.cancelled) {
    return setState({ status: 'idle', note: 'スキャンを中止しました' });
  }

  const report = {
    generatedAt: Date.now(),
    dbVersion: (db.meta && db.meta.version) || '',
    dbSource: db.source,
    accountIndex: Number(opts.accountIndex) || 0,
    includeSpamTrash: !!opts.includeSpamTrash,
    scanned: res.scanned,
    queries: res.queries,
    matches: res.matches || []
  };
  await chrome.storage.local.set({ report });
  await setState({ status: 'done', finishedAt: Date.now(), summary: { matched: report.matches.length, scanned: report.scanned } });

  const resultsUrl = chrome.runtime.getURL('results/results.html');
  try { await chrome.tabs.update(tab.id, { url: resultsUrl }); }
  catch (_) { await chrome.tabs.create({ url: resultsUrl }); }

  const n = report.matches.length;
  await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: n ? '#c92a2a' : '#0f7a56' });

  return getState();
}

async function runSelfTest() {
  const opts = await getOptions();
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://mail.google.com/mail/u/${Number(opts.accountIndex) || 0}/#inbox`,
      active: true
    });
  } catch (err) {
    return { ok: false, error: 'Gmailのタブを開けませんでした: ' + (err.message || err) };
  }
  await waitForTabLoad(tab.id);
  const ready = await pingUntilReady(tab.id, 30);
  if (!ready) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return {
      ok: false,
      error: 'Gmailの画面を読み込めませんでした。ログイン状態とアカウント番号（u/0, u/1 …）を確認してください。'
    };
  }
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'LEAKSCAN_SELFTEST' });
  } catch (err) {
    res = { ok: false, error: String(err.message || err) };
  }
  try { await chrome.tabs.remove(tab.id); } catch (_) {}
  return res;
}

async function cancelScan() {
  if (scanTabId != null) {
    try { await chrome.tabs.sendMessage(scanTabId, { type: 'LEAKSCAN_CANCEL' }); } catch (_) {}
  }
  return setState({ status: 'idle', note: 'スキャンを中止しました' });
}

/* --------------------------------------------------------------- messaging */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'LEAKSCAN_GET_VIEW':
      (async () => {
        const [state, opts, db, { report }] = await Promise.all([
          getState(),
          getOptions(),
          loadDb(false),
          chrome.storage.local.get('report')
        ]);
        respond({
          state,
          options: opts,
          report: report || null,
          db: {
            version: (db.meta && db.meta.version) || '',
            updated: (db.meta && db.meta.updated) || '',
            count: db.entries.length,
            source: db.source,
            stale: !!db.stale,
            lastError: db.lastError || null
          }
        });
      })();
      return true;

    case 'LEAKSCAN_GET_DB':
      loadDb(false).then((db) => respond({ meta: db.meta, entries: db.entries }));
      return true;

    case 'LEAKSCAN_REFRESH_DB':
      loadDb(true).then(
        (db) => respond({ ok: true, count: db.entries.length, source: db.source, lastError: db.lastError || null }),
        (err) => respond({ ok: false, error: String(err.message || err) })
      );
      return true;

    case 'LEAKSCAN_START_SCAN':
      startScan().then((state) => respond({ ok: true, state }), (err) =>
        respond({ ok: false, error: String(err.message || err) })
      );
      return true;

    case 'LEAKSCAN_CANCEL_SCAN':
      cancelScan().then((state) => respond({ ok: true, state }));
      return true;

    case 'LEAKSCAN_SET_OPTIONS':
      setOptions(msg.patch).then((o) => respond({ ok: true, options: o }));
      return true;

    case 'LEAKSCAN_PROGRESS':
      getState().then((st) => {
        if (st.status !== 'running') return;
        st.progress = {
          settled: msg.settled, total: msg.total, queries: msg.queries,
          found: msg.found, note: msg.note || ''
        };
        setState(st);
      });
      return;

    case 'LEAKSCAN_SELFTEST':
      runSelfTest().then((r) => respond(r), (err) =>
        respond({ ok: false, error: String(err.message || err) })
      );
      return true;

    case 'LEAKSCAN_CLEAR':
      chrome.storage.local.remove(['report', 'state']).then(() => {
        chrome.action.setBadgeText({ text: '' });
        respond({ ok: true });
      });
      return true;
  }
});

chrome.runtime.onInstalled.addListener(() => { loadDb(true).catch(() => {}); });

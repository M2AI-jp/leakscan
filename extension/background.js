/* LeakScan — background service worker.
 * Owns: option storage, breach-DB caching, and driving one Gmail tab per scan.
 * Never sees mail content: the content script returns only matched sender data.
 */

/* 受け取ったデータの検査。
 *
 * 配信元が乗っ取られて中身を差し替えられても、画面や検索式に悪い文字列が
 * 流れ込まないようにする。ここを通った後の値しか使わない。
 *
 * ・ドメインはホスト名に使える文字だけ。Gmailの検索式に演算子を混ぜられないようにする
 * ・出典のURLは http/https のみ。javascript: や data: を弾く
 * ・文字列は長さで切る。件数にも上限を置く（描画やGmail照会が終わらなくなるのを防ぐ）
 * 捨てた件数は meta に残して、設定画面から見えるようにしている。 */
const MAX_ENTRIES = 5000;
const MAX_PER_FIELD = 40;
const MAX_TEXT = 200;

const text = (v, n) => (typeof v === 'string' ? v.slice(0, n || MAX_TEXT) : '');
const textList = (v, n) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string').slice(0, MAX_PER_FIELD)
    .map((x) => x.slice(0, n || MAX_TEXT)).filter(Boolean);

/** ホスト名に使える文字だけ。ここを緩めるとGmailの検索式に演算子を入れられる。 */
const DOMAIN_OK = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** 画面のリンクに入れてよいのは http/https だけ。 */
function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return '';
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '';
  } catch (_) { return ''; }
}

function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0 };
  let dropped = 0;
  const entries = [];
  for (const e of raw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') { dropped++; continue; }
    const id = text(e.id, 80);
    const service = text(e.service, 120);
    if (!id || !service) { dropped++; continue; }
    const domains = textList(e.domains, 253).map((d) => d.toLowerCase()).filter((d) => DOMAIN_OK.test(d));
    const sources = (Array.isArray(e.sources) ? e.sources : []).slice(0, MAX_PER_FIELD)
      .map((x) => ({ url: safeUrl(x && x.url), title: text(x && x.title, 200) }))
      .filter((x) => x.url);
    entries.push({
      id, service,
      company: text(e.company, 120),
      domains,
      names: textList(e.names, 120),
      categories: textList(e.categories, 40),
      status: text(e.status, 40),
      cause: text(e.cause, 40),
      ai_link: text(e.ai_link, 40),
      sector: text(e.sector, 80),
      disclosed: text(e.disclosed, 20),
      records: text(e.records, 80),
      records_num: typeof e.records_num === 'number' && isFinite(e.records_num) ? e.records_num : 0,
      scope: text(e.scope, 400),
      auto: e.auto === true,
      sources
    });
  }
  dropped += Math.max(0, raw.length - MAX_ENTRIES);
  return { entries, dropped };
}

/** meta も画面に出るので同じように通す。 */
function sanitizeMeta(m) {
  if (!m || typeof m !== 'object') return {};
  const dict = (o) => {
    const out = {};
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o).slice(0, 80)) {
        if (typeof o[k] === 'string') out[text(k, 40)] = text(o[k], 120);
      }
    }
    return out;
  };
  return {
    schema: typeof m.schema === 'number' ? m.schema : 1,
    name: text(m.name, 120), version: text(m.version, 40), updated: text(m.updated, 20),
    license: text(m.license, 40), homepage: safeUrl(m.homepage),
    disclaimer: text(m.disclaimer, 1000), ai_note: text(m.ai_note, 1000),
    categories: dict(m.categories), status_labels: dict(m.status_labels),
    ai_link_labels: dict(m.ai_link_labels), cause_labels: dict(m.cause_labels)
  };
}

/* データの入手先。どれも届かなければ同梱のコピーを使う。
 *
 * 配信サイトの中身はデプロイしたときにしか変わらないが、収集結果は毎朝
 * GitHubのリポジトリに入る。そこで両方の meta.json を見て、新しい方を使う。
 * これで配信が止まっていてもデータは古くならない。
 *
 * GitHub側は host_permissions に宣言して読む。access-control-allow-origin: * が
 * 返るのでCORSだけでも通りそうだが、サービスワーカーがCORSを免除されるのは
 * 「マニフェストに書いた相手」だけだと公式文書が言っているので、確実な方を採る。
 * 宣言しておけばインストール時の権限表示にも出るので、通信先を隠さずに済む。
 * どちらも公開リポジトリと静的配信なので、費用はかからない。 */
const DB_MIRRORS = [
  'https://leakscan.matsunai.com/data/',
  'https://raw.githubusercontent.com/M2AI-jp/leakscan/main/data/'
];

/* 片方が遅いときにスキャン開始を待たせないための上限。 */
const DB_FETCH_TIMEOUT_MS = 8000;

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
async function fetchJson(url, timeoutMs) {
  const init = { cache: 'no-cache' };
  /* AbortSignal.timeout は Chrome 103 以降。102 では単に上限なしで動く。 */
  if (timeoutMs && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadBundled() {
  const [meta, entries] = await Promise.all([
    fetchJson(chrome.runtime.getURL('data/meta.json')),
    fetchJson(chrome.runtime.getURL('data/breaches.json'))
  ]);
  /* 同梱物も遠隔のものと同じ検査を通す。展開して入れた場合に中身を
     書き換えられても、通る値が変わらないようにするため。 */
  return { meta: sanitizeMeta(meta), entries: sanitizeEntries(entries).entries,
           source: 'bundled', fetchedAt: Date.now() };
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
  /* まず meta.json だけを並行で取り、updated の新しい順に並べる。
     日付が同じなら設定・既定の順をそのまま保つ（Array#sort は安定）。 */
  let err = null;
  const probes = await Promise.all(
    bases.map((base) =>
      fetchJson(base + 'meta.json', DB_FETCH_TIMEOUT_MS).then(
        (meta) => ({ base, meta }),
        (e) => { err = e; return null; }
      )
    )
  );
  const ranked = probes
    .filter(Boolean)
    .sort((a, b) => String(b.meta.updated || '').localeCompare(String(a.meta.updated || '')));

  let fresh = null;
  for (const cand of ranked) {
    try {
      const raw = await fetchJson(cand.base + 'breaches.json', DB_FETCH_TIMEOUT_MS);
      const { entries, dropped } = sanitizeEntries(raw);
      if (!entries.length) throw new Error('empty dataset');
      const meta = sanitizeMeta(cand.meta);
      if (dropped) meta.dropped = dropped;
      fresh = { meta, entries, source: 'remote', origin: cand.base, fetchedAt: Date.now() };
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
            origin: db.origin || '',
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
        (db) => respond({
          ok: true, count: db.entries.length, source: db.source,
          origin: db.origin || '', lastError: db.lastError || null
        }),
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

/* LeakScan — pure matching helpers. No DOM, no network: unit-testable. */
(function (root) {
  'use strict';

  /** NFKC + lowercase + strip separators, so 全角/半角 and spacing differences
   *  in a sender's display name don't cause a miss. */
  function norm(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s　・,，.。'"“”’`]/g, '');
  }

  /** One Gmail `from:` query covering every pattern in the batch. */
  function buildQuery(batch, opts) {
    const terms = [];
    const seen = new Set();
    for (const svc of batch) {
      for (const d of svc.domains || []) {
        const t = String(d).toLowerCase();
        if (!seen.has(t)) { seen.add(t); terms.push(t); }
      }
      for (const n of svc.names || []) {
        const t = '"' + String(n).replace(/"/g, '') + '"';
        if (!seen.has(t)) { seen.add(t); terms.push(t); }
      }
    }
    let q = 'from:(' + terms.join(' OR ') + ')';
    if (opts && opts.includeSpamTrash) q += ' in:anywhere';
    return q;
  }

  const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;

  /** Japanese patterns carry far more signal per character than Latin ones:
   *  "ローソン" is safe at 4 chars, "au" would match "Paul" or "Auth". */
  function minNameLen(normalised) {
    return CJK.test(normalised) ? 2 : 4;
  }

  /** 'domain' (strong) | 'name' (weak, could be a spoofed display name) | null */
  function matchSender(sender, svc) {
    const email = String((sender && sender.email) || '').toLowerCase();
    const at = email.lastIndexOf('@');
    const domain = at > -1 ? email.slice(at + 1) : '';
    if (domain) {
      for (const d of svc.domains || []) {
        const dd = String(d).toLowerCase();
        if (domain === dd || domain.endsWith('.' + dd)) return 'domain';
      }
    }
    const nm = norm(sender && sender.name);
    if (nm) {
      for (const n of svc.names || []) {
        const nn = norm(n);
        if (nn.length >= minNameLen(nn) && nm.includes(nn)) return 'name';
      }
    }
    return null;
  }

  const api = { norm, buildQuery, matchSender, minNameLen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LEAKSCAN_MATCH = api;
})(typeof self !== 'undefined' ? self : this);

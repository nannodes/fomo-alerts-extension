// © 2026 FOMO Alerts. All rights reserved.
// Runs inside the fomo.family page itself.
// It only LOOKS at responses the site already receives from Fomo's own API (prod-api.fomo.family, built into
// rules.js: nothing can point it at another site). Every other request goes through untouched. It reads:
//   - POST /v2/users                    -> your own user id + username (so we ignore other people's portfolios),
//                                          who referred your account (shown in FOMO Alerts settings), and your
//                                          profile picture URL (shown in the hive on fomoalerts.family unless switched off)
//   - GET  /v2/users/userHandle/{name}  -> id of a profile you open (matches a username typed in the popup)
//   - GET  /v2/users/{id}/balances      -> your positions with average entry price
//   - GET  /v2/users/{id}/referrals, /referrerDetails -> the accounts that joined with your referral code (Fomo
//                                          loads these under Earnings). content.js only passes them on in the one
//                                          browser the FOMO Alerts admin paired: the code owner's (free access check)
// It also tells content.js about every Fomo API call (method, path, status); nothing is kept.
// It never reads or forwards login tokens or request headers, and never sends requests of its own.
(() => {
  if (window.__fomoAlertsHooked) return;
  window.__fomoAlertsHooked = true;

  // Fomo's API host and the paths we read: built into rules.js
  const RX = window.__faRules;
  const API = RX.rules;
  const T = { me: RX.pathTest(API.apiMe), balances: RX.pathTest(API.apiBalances), handle: RX.pathTest(API.apiUserHandle),
    referrals: RX.pathTest(API.apiReferrals), referrer: RX.pathTest(API.apiReferrerDetails) };
  const origFetch = window.fetch;

  const post = (type, payload) =>
    window.postMessage({ source: 'fomo-alerts-hook', type, payload }, window.location.origin);
  const log = (msg) => post('log', { msg });
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 25).join(', ') : typeof o);

  function toPositions(balances) {
    const out = [];
    for (const b of balances) {
      const bal = b && b.balance;
      const tf = (b && b.tokenFilterResult) || {};
      const ut = (b && b.userToken) || {};
      const tok = tf.token || {};
      if (!bal || !bal.tokenAddress) continue;
      out.push({
        tokenAddress: bal.tokenAddress,
        networkId: Number(tok.networkId ?? ut.networkId ?? String(bal.tokenId || '').split(':')[1]),
        symbol: tok.symbol || '',
        name: tok.name || '',
        image: (tok.info && tok.info.imageThumbUrl) || null,
        amount: Number(bal.shiftedBalance) || 0,
        priceUsd: Number(tf.priceUSD) || 0,
        entryPrice: Number(ut.averageEntryPriceUsd) || 0,
        costBasisUsd: Number(ut.currentCostBasisUsd) || 0,
        // Fomo's market cap = price × total supply (same as their chart)
        totalSupply: Number(tok.info && tok.info.totalSupply) || 0,
        marketCap: Number(tf.marketCap) || 0,
      });
    }
    return out;
  }

  // the account's profile picture: the first https URL in a picture-like field, on the account or one level down
  // (Fomo doesn't document the field name; banners and cover images are skipped)
  function avatarOf(me) {
    const pick = (o, path) => {
      for (const [k, v] of Object.entries(o || {})) {
        if (typeof v !== 'string' || !/^https:\/\/[^\s"'<>]{1,500}$/.test(v)) continue;
        if (/avatar|profile|picture|photo|pfp|image/i.test(path + k) && !/banner|cover|header|background/i.test(path + k)) return { url: v, field: path + k };
      }
      return null;
    };
    let found = pick(me, '');
    for (const [k, v] of Object.entries(me || {})) {
      if (found) break;
      if (v && typeof v === 'object' && !Array.isArray(v)) found = pick(v, k + '.');
    }
    if (found) log(`  profile picture from field "${found.field}"`);
    return found;
  }

  // the account's own wallets (public addresses only): Fomo sends them when it loads the account,
  // { address: Solana, evmAddress: EVM }. Used to recognise the one-time payment by who sent it.
  const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
  function walletsOf(body, me) {
    const w = {};
    for (const o of [body, me]) {
      if (!o || typeof o !== 'object') continue;
      const sol = o.address || o.solanaAddress || o.solanaWalletAddress;
      const evm = o.evmAddress || o.evmWalletAddress;
      if (!w.solana && typeof sol === 'string' && SOL_RE.test(sol)) w.solana = sol;
      if (!w.evm && typeof evm === 'string' && EVM_RE.test(evm)) w.evm = evm;
    }
    return w.solana || w.evm ? w : null;
  }
  function bodyJson(init) {
    try {
      return init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    } catch (_) {
      return null;
    }
  }

  // u: the request's URL, already checked to be on Fomo's API host (see hookedFetch)
  function handle(u, method, data, reqBody) {
    try {
      const t = T;

      if (method === 'POST' && t.me.test(u.pathname)) {
        const me = data && data.responseObject;
        if (me && me.id) {
          // who referred this account when it signed up (only shown to the account itself; can't be changed)
          const referral = { referred: !!me.isReferred, code: me.signupReferralCode || null, by: me.signupReferrerUserHandle || null };
          const pic = avatarOf(me);
          if (!pic) log(`  account response has no profile picture URL. Fields: ${keys(me)}`);
          post('me', { id: me.id, handle: me.userHandle || null, referral, avatar: pic ? pic.url : null, wallets: walletsOf(reqBody, me) });
        }
        else log(`  account response without a user id. Fields: ${keys(data)} / responseObject: ${keys(me)}`);
        if (me && me.id && !me.userHandle) log(`  account response has no userHandle. Fields: ${keys(me)}`);
        return;
      }

      const h = u.pathname.match(t.handle);
      if (h) {
        const user = data && data.responseObject;
        if (user && user.id) {
          const pic = avatarOf(user); // used when this is the username typed in the popup
          post('profile', { id: user.id, handle: user.userHandle || decodeURIComponent(h[1]), avatar: pic ? pic.url : null });
        }
        return;
      }

      // the accounts that joined with this account's referral code (newest first, 25 a page)
      const rl = u.pathname.match(t.referrals);
      if (rl) {
        const list = data && data.responseObject && data.responseObject.referrals;
        if (Array.isArray(list)) {
          post('referrals', {
            ownerId: decodeURIComponent(rl[1]),
            items: list
              .filter((r) => r && typeof r.referee === 'string')
              .map((r) => ({ referee: r.referee, handle: (r.refereeDetails && r.refereeDetails.userHandle) || null })),
          });
        }
        return;
      }
      const rd = u.pathname.match(t.referrer);
      if (rd) {
        const o = data && data.responseObject;
        if (o && typeof o.referralCode === 'string') post('referrerDetails', { ownerId: decodeURIComponent(rd[1]), code: o.referralCode });
        return;
      }

      const m = u.pathname.match(t.balances);
      const balances = data && data.responseObject && data.responseObject.balances;
      if (m && Array.isArray(balances)) {
        post('balances', { userId: decodeURIComponent(m[1]), positions: toPositions(balances) });
      } else if (m) {
        log(`  balances response in an unexpected shape. Fields: ${keys(data)} / responseObject: ${keys(data && data.responseObject)}`);
      }
    } catch (_) {
      /* never break the page */
    }
  }

  // one of the few paths we read (the list at the top of this file)
  const isUsed = (path) => [T.me, T.balances, T.handle, T.referrals, T.referrer].some((re) => re.test(path));

  // Coins in a Fomo response with their launchpad: { address / tokenAddress, networkId / chainId,
  // launchpad: { launchpadName, launchpadIconUrl } } or with launchpadName / launchpadIconUrl right on the coin.
  function findLaunchpads(data) {
    const items = [];
    const stack = [[data, 0]];
    for (let seen = 0; stack.length && seen < 50000; seen++) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== 'object' || depth > 10) continue;
      const lp = o.launchpad && typeof o.launchpad === 'object' ? o.launchpad : o;
      const name = typeof lp.launchpadName === 'string' ? lp.launchpadName : null;
      const address = o.address || o.tokenAddress;
      const networkId = Number(o.networkId || o.chainId);
      if (name && typeof address === 'string' && networkId) {
        items.push({ tokenAddress: address, networkId, name, icon: typeof lp.launchpadIconUrl === 'string' ? lp.launchpadIconUrl : null });
      }
      for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === 'object') stack.push([v, depth + 1]);
    }
    if (items.length) post('launchpads', { items: items.slice(0, 500) });
  }

  const hookedFetch = function (input, init) {
    let url = null;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url, window.location.href);
    } catch (_) {
      /* not a URL we can read: not Fomo's API */
    }
    // Not Fomo's API: straight through, untouched. (Chrome still lists this file in the stack trace of the
    // site's own blocked requests, e.g. "violates the Content Security Policy" for WalletConnect: those are
    // Fomo's requests and Fomo's policy, not something this extension does.)
    if (!url || url.hostname !== API.apiHost) return origFetch.apply(this, arguments);
    const p = origFetch.apply(this, arguments);
    try {
      const method = String(
        (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'
      ).toUpperCase();
      const started = performance.now();
      const path = url.pathname;
      const used = isUsed(path);
      // a request body is only read for the account call (POST /v2/users): it holds the account's public wallets
      const reqBody = method === 'POST' && used ? bodyJson(init) : null;
      p.then((res) => {
        const ms = Math.round(performance.now() - started);
        log(`${method} ${path} → ${res ? res.status : '?'} (${ms} ms)${used ? '  ← read by FOMO Alerts' : ''}`);
        if (used && res && res.ok) res.clone().json().then((d) => handle(url, method, d, reqBody)).catch(() => {});
        // any response with coins' launchpads in it (pump.fun, flap.sh, …): shown in the Telegram pictures
        if (res && res.ok && /json/.test(res.headers.get('content-type') || '')) {
          res.clone().text().then((t) => {
            if (t.length < 3e6 && t.includes('launchpadName')) findLaunchpads(JSON.parse(t));
          }).catch(() => {});
        }
      }).catch((e) => log(`${method} ${path} failed: ${e && e.message}`));
    } catch (_) {
      /* ignore */
    }
    return p;
  };
  window.fetch = hookedFetch;

  // the content script pings on start: answer that the hook runs
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'fomo-alerts-content') return;
    if (e.data.type === 'ping') post('hello', { fetchHooked: window.fetch === hookedFetch });
  });
})();

// Adds a "TP / SL alerts" card under the Buy/Sell box on fomo.family coin pages and in Fomo's Position popup,
// and keeps the take profit / stop loss / buy-the-dip lines on Fomo's charts (drawn by chart-bridge.js) in sync.
// Every level is its own alert (several dips, partial take profits, …). The card's fields set new alerts; the
// alerts already set are listed under them, each with a bin to remove it.
// Levels are measured from the current price at the moment you set them.
(() => {
  // ---------- debug log (read by the extension's Debug page) ----------
  const VERSION = chrome.runtime.getManifest().version;
  // state the code keeps for itself (the Debug page that showed it is gone; nothing is logged or kept)
  const debug = { hookAlive: false, fetchHooked: null, fomoCalls: 0, cardWhere: 'not placed yet', chart: null, popupCharts: new Map() };
  function dbg() {}
  // After the extension is reloaded or updated, this old copy keeps running in open Fomo tabs but can't reach
  // the extension anymore ("Extension context invalidated"). Then it stops quietly and takes its UI off the page
  // (refreshing the tab loads the new version).
  let dead = false;
  function extAlive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch {
      /* invalidated */
    }
    shutDown();
    return false;
  }
  function shutDown() {
    if (dead) return;
    dead = true;
    try {
      for (const el of document.querySelectorAll('.fa-panel, .fa-hist, .fa-hist-btn, .fa-hist-sep, .fa-menu-item, .fa-set-overlay, .fa-cf, #fa-cf-css')) el.remove();
      for (const el of document.querySelectorAll('[data-fa-hist]')) delete el.dataset.faHist;
    } catch {
      /* page changed meanwhile */
    }
  }
  function safe(fn) {
    if (!extAlive()) return;
    try {
      fn();
    } catch (e) {
      if (/Extension context invalidated/i.test(String(e && e.message))) return shutDown();
      report({ kind: 'crash', where: 'page', msg: (e && e.message) || String(e), stack: e && e.stack });
      console.error('[FOMO Alerts]', e);
    }
  }
  // Automatic error reports: crashes in this script and every error message people see go to our server in the
  // background (background.js batches them), so bugs get found without anyone reporting them. Only what went
  // wrong and where: no account data.
  function report(r) {
    if (dead) return;
    try {
      chrome.runtime.sendMessage({ type: 'report', report: r }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded */
    }
  }
  const reportShown = (where, text) => text && report({ kind: 'shown', where, msg: String(text).replace(/\{tg\}/g, 'Telegram') });
  // async code and anything else that throws in this script (not the page's own errors)
  self.addEventListener('error', (e) => {
    if (e.filename && e.filename.startsWith('chrome-extension://')) report({ kind: 'crash', where: 'page', msg: e.message, stack: e.error && e.error.stack });
  });
  self.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    const msg = (err && err.message) || String(err);
    if (/Extension context invalidated/i.test(msg)) return;
    report({ kind: 'crash', where: 'page (async)', msg, stack: err && err.stack });
  });
  // setInterval that stops doing anything once the extension is gone
  const every = (fn, ms) => setInterval(() => safe(fn), ms);
  dbg('extension', `v${VERSION} started on ${location.pathname}`);

  // How Fomo's boxes and data are found, and our texts: data in rules.js, updated from our server (see there)
  const RX = self.__faRules;
  const rule = () => RX.rules;
  // after our UI is drawn, put changed texts on it (before the browser shows it; nothing to do without changes)
  const TEXT_ROOTS = '.fa-panel, .fa-hist, .fa-hist-btn, .fa-menu-item, .fa-set-overlay, .fa-toast';
  let textsQueued = false;
  function queueTexts() {
    if (textsQueued || (!RX.exact.size && !RX.templates.length)) return;
    textsQueued = true;
    requestAnimationFrame(() => {
      textsQueued = false;
      for (const el of document.querySelectorAll(TEXT_ROOTS)) RX.translate(el);
    });
  }
  const SIDES = ['tp', 'sl', 'dip'];
  const DIR = { tp: 1, sl: -1, dip: -1 }; // take profit is above the price, stop loss and buy-the-dip below
  const GREEN = '#21c95e';
  const RED = '#ff622e';
  const BLUE = '#4f9dff';
  const SIDE = {
    tp: { name: 'Take profit', line: 'TP', color: GREEN, cls: 'fa-green', sign: '+' },
    sl: { name: 'Stop loss', line: 'SL', color: RED, cls: 'fa-red', sign: '−' },
    dip: { name: 'Buy the dip', line: 'DIP', color: BLUE, cls: 'fa-blue', sign: '−' },
  };
  const DEFAULT_CHIPS = { tp: [25, 50, 100, 300], sl: [10, 20, 30, 50], dip: [10, 20, 30, 50] };
  const FLOAT_AFTER_MS = 4000; // no Buy/Sell box found after this long: show the card in the corner
  const LIVE_MAX_AGE_MS = 60000; // chart price older than this: fall back to Fomo's position price
  const TRASH_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  // shown after hovering a label for a second
  const TIPS = {
    tp: 'Take profit: you get a {tg} message when the price rises this % above the price at the moment you set it. Set several to sell in parts; each one is sent once and the others keep running.',
    dip: 'Buy the dip: you get a {tg} message when the price dips this % below the price at the moment you set it, so you can buy more. Set several to buy at ever lower levels; each one is sent once.',
    sl: 'Stop loss: you get a {tg} message when the price falls this % below the price at the moment you set it. Set several to sell in parts; each one is sent once and the others keep running.',
    trail: 'Trailing stop: the stop loss follows the highest price since you set it and never moves down. You get a {tg} message when the price falls this % from that high. Then that alert ends.',
  };
  const CLEAR_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
  const TIP_DELAY_MS = 1000;
  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
  // icons/telegram.svg and icons/pencil.svg (Assets Imported/pencil_icon.svg), drawn inline in the text color
  const TG_ICON = {
    box: '0 0 24 24',
    d: 'm20.665 3.717-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701h-.002l.002.001-.314 4.692c.46 0 .663-.211.921-.46l2.211-2.15 4.599 3.397c.848.467 1.457.227 1.668-.785l3.019-14.228c.309-1.239-.473-1.8-1.282-1.434z',
  };
  // our bell logo (Assets Imported/logo_transparant_notext.png) drawn as lines, for the FOMO Alerts tab and menu item
  const BELL_ICON = {
    box: '0 0 24 24',
    stroke: true,
    paths: [
      'M12 6.5c-2.6 0-4.5 2-4.5 4.6 0 2.7-.4 4-1.7 5-.6.45-.3 1.4.45 1.4h11.5c.75 0 1.05-.95.45-1.4-1.3-1-1.7-2.3-1.7-5 0-2.6-1.9-4.6-4.5-4.6z',
      'M10.8 6.6a1.2 1.2 0 0 1 2.4 0',
      'M10.6 20.1a1.4 1.4 0 0 0 2.8 0',
      'M3.4 9.8c.4-1.9 1.4-3.5 2.9-4.7',
      'M20.6 9.8c-.4-1.9-1.4-3.5-2.9-4.7',
    ],
  };
  const PENCIL_ICON = {
    box: '0 0 12 12',
    d: 'M9.35807 5.71671C9.43607 5.79471 9.43607 5.92199 9.35807 5.99999L3.33333 11.9987H0V8.66536L5.9987 2.6407C6.0767 2.56203 6.2034 2.56203 6.28206 2.6407L9.35807 5.71671ZM11.6066 1.87206L10.1266 0.392C9.60396 -0.130667 8.75607 -0.130667 8.2334 0.392L6.98128 1.64403C6.90328 1.72203 6.90328 1.84867 6.98128 1.92667L10.0719 5.01733C10.1499 5.09533 10.2767 5.09533 10.3547 5.01733L11.6066 3.76537C12.1293 3.24271 12.1293 2.39473 11.6066 1.87206Z',
  };

  const norm = (a) => (a && a.startsWith('0x') ? a.toLowerCase() : a);
  const sameHandle = (a, b) => !!a && !!b && a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();

  function mergeSettings(s) {
    s = s || {};
    const chips = {};
    for (const side of SIDES) {
      const c = s.chips && s.chips[side];
      chips[side] = Array.isArray(c) && c.length === 4 && c.every((v) => v > 0) ? c : DEFAULT_CHIPS[side];
    }
    return { units: s.units === 'mcap' ? 'mcap' : 'price', chips };
  }

  const shared = {
    user: null, // { id, handle } of the Fomo account logged in on this browser
    manualHandle: null, // username typed in the popup when it could not be detected
    positions: new Map(), // norm(address) -> position
    live: new Map(), // norm(address) -> { price, at }: latest price read from Fomo's chart
    status: null, // server / Telegram status { configured, linked, error, ... }
    settings: mergeSettings(null),
    lines: { tp: false, sl: false, dip: false }, // chart lines switched on; not saved, so every page starts without them
  };
  const panels = new Set(); // every card on the page
  let pagePanel = null; // the card under the coin page's Buy/Sell box
  const modalPanels = new Map(); // Position popup element -> card
  const skippedDialogs = new WeakSet();
  let popupSeq = 0;

  // ---------- stored state ----------
  chrome.storage.local.remove('me'); // replaced by fomoUser
  // ----- rules and texts from our server (rules.js; background.js fetches and keeps them) -----
  function applyConfig(cfg) {
    RX.set(cfg || {});
    if (RX.problems.length) report({ kind: 'config', where: 'rules from the server', msg: 'Ignored: ' + RX.problems.join(', ') });
    // the page-world scripts (page-hook.js, chart-bridge.js) use the same rules
    window.postMessage({ source: 'fomo-alerts-content', type: 'rules', payload: cfg || {} }, location.origin);
    renderAll();
    if (sett.overlay && sett.overlay.isConnected) renderSettings();
  }
  chrome.storage.local.get('extConfig', (d) => applyConfig(d.extConfig && d.extConfig.config));
  // someone's invite link brought this person here: fomo.family/…?fa=<code>. Kept once (the first one);
  // background.js sends it with the profile.
  try {
    const fa = new URLSearchParams(location.search).get('fa');
    if (fa && /^[A-Za-z0-9]{4,16}$/.test(fa)) {
      chrome.storage.local.get('invitedBy', (d) => {
        if (!d.invitedBy) chrome.storage.local.set({ invitedBy: fa.toLowerCase() });
      });
    }
  } catch {
    /* no address to read */
  }
  setTimeout(() => send({ type: 'config' }), 0); // background.js looks for newer rules (at most every 30 minutes)

  chrome.storage.local.get(['fomoUser', 'manualHandle', 'positionsCache', 'settings'], (d) => {
    if (!shared.user) shared.user = d.fomoUser || null;
    shared.manualHandle = d.manualHandle || null;
    shared.settings = mergeSettings(d.settings);
    if (!shared.user && shared.manualHandle) sendProfile(); // typed username, account not detected (yet)
    if (Array.isArray(d.positionsCache) && shared.positions.size === 0) {
      for (const p of d.positionsCache) shared.positions.set(norm(p.tokenAddress), p);
    }
    renderAll();
    sendPrefs();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.manualHandle) {
      shared.manualHandle = changes.manualHandle.newValue || null;
      sendProfile(); // a newly typed username joins the hive
    }
    if (changes.settings) shared.settings = mergeSettings(changes.settings.newValue);
    if (changes.manualHandle || changes.settings) renderAll();
    if (changes.extConfig) applyConfig(changes.extConfig.newValue && changes.extConfig.newValue.config);
    if (changes.chainFilter) setChainsOff(changes.chainFilter.newValue); // (switched in another tab)
  });

  function saveSettings(patch) {
    shared.settings = mergeSettings({ ...shared.settings, ...patch });
    chrome.storage.local.set({ settings: shared.settings });
    if (patch.chips) sendPrefs();
    renderAll();
  }

  // Launchpads (pump.fun, flap.sh, …) seen in Fomo's data: norm(address) -> { networkId, tokenAddress, name, icon }.
  // Only the ones of coins you have alerts on go to the server, once each.
  const launchpads = new Map();
  const metaSent = new Set();
  function sendCoinMeta() {
    const withAlerts = [...hist.active, ...[...panels].flatMap((q) => q.alerts)];
    const coins = [];
    for (const a of withAlerts) {
      const k = norm(a.tokenAddress);
      const lp = launchpads.get(k);
      if (!lp || metaSent.has(k)) continue;
      metaSent.add(k);
      coins.push({ networkId: a.networkId, tokenAddress: a.tokenAddress, name: lp.name, icon: lp.icon });
    }
    if (coins.length) send({ type: 'coinMeta', coins }).then((r) => { if (!r.ok) coins.forEach((c) => metaSent.delete(norm(c.tokenAddress))); });
  }

  // the quick % buttons also show up in the Telegram bot: the server keeps a copy
  let prefsSent = '';
  function sendPrefs() {
    const json = JSON.stringify(shared.settings.chips);
    if (json === prefsSent) return;
    prefsSent = json;
    send({ type: 'prefs', prefs: { chips: shared.settings.chips } }).then((r) => {
      if (!r.ok) prefsSent = ''; // try again next time
    });
  }

  // ---------- messages from the page hook and the chart bridge ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'fomo-alerts-hook') safe(() => onHookMessage(e.data.type, e.data.payload));
    else if (e.data.source === 'fomo-alerts-chart') safe(() => onChartMessage(e.data.type, e.data.payload));
  });

  function onHookMessage(type, payload) {
    if (!payload) return;
    debug.hookAlive = true;
    if (type === 'log') {
      debug.fomoCalls++;
      dbg('fomo', payload.msg);
    } else if (type === 'hello') {
      debug.fetchHooked = payload.fetchHooked;
      dbg('extension', `Page hook active, watching Fomo's API calls: ${payload.fetchHooked ? 'yes' : 'NO (fetch was replaced by something else)'}`);
    } else if (type === 'me' && payload.id) {
      // Fomo loads the logged-in account on every page load
      if (shared.user && shared.user.id !== payload.id) {
        shared.positions = new Map(); // switched to another account
        chrome.storage.local.remove('positionsCache');
      }
      shared.user = { id: payload.id, handle: payload.handle || null, referral: payload.referral || null, avatar: payload.avatar || null, wallets: payload.wallets || null };
      chrome.storage.local.set({ fomoUser: shared.user });
      sendProfile();
      dbg('account', `Logged-in account detected: ${payload.handle ? '@' + payload.handle : '(no username in response)'} id ${payload.id}`);
      renderAll();
    } else if (type === 'profile' && payload.id) {
      // username typed in the popup: learn the account id once that profile page loads
      if (!shared.user && sameHandle(payload.handle, shared.manualHandle)) {
        shared.user = { id: payload.id, handle: payload.handle, avatar: payload.avatar || null };
        chrome.storage.local.set({ fomoUser: shared.user });
        dbg('account', `Matched your typed username @${payload.handle} to id ${payload.id}`);
        sendProfile();
        renderAll();
      }
    } else if (type === 'referrerDetails' && payload.ownerId) {
      refList.code.set(payload.ownerId, payload.code);
      flushReferrals(payload.ownerId);
    } else if (type === 'referrals' && payload.ownerId && Array.isArray(payload.items)) {
      refList.pending.set(payload.ownerId, [...(refList.pending.get(payload.ownerId) || []), ...payload.items]);
      flushReferrals(payload.ownerId);
    } else if (type === 'launchpads' && Array.isArray(payload.items)) {
      // where coins were launched (from Fomo's own data), for the Telegram pictures
      for (const it of payload.items) launchpads.set(norm(it.tokenAddress), it);
      sendCoinMeta();
    } else if (type === 'balances') {
      if (shared.user && payload.userId !== shared.user.id) {
        return dbg('positions', `Ignored positions of another user (${payload.userId})`);
      }
      if (!shared.user && /^\/(profile|u)\//.test(location.pathname)) {
        return dbg('positions', 'Ignored positions on a profile page (your account is not known yet)');
      }
      shared.positions = new Map(payload.positions.map((p) => [norm(p.tokenAddress), p]));
      chrome.storage.local.set({ positionsCache: payload.positions });
      sendHoldings(payload.positions);
      const tok = currentToken();
      const here = tok && shared.positions.get(norm(tok.address));
      dbg('positions', `${payload.positions.length} positions loaded` +
        (tok ? `, this coin: ${here ? `held, entry ${here.entryPrice || 'unknown'}` : 'not held'}` : ''));
      renderAll();
    }
  }

  // Free access with our code is checked against Fomo's own referral list of the code owner (see referrals() in
  // server.js). Fomo loads that list (and the account's code) under Earnings; only the browser the admin paired
  // (status.referralSync) passes it on, with the code it belongs to. In every other browser it stays in the page.
  const refList = { code: new Map(), pending: new Map() }; // ownerId -> code / referral entries not sent yet
  async function flushReferrals(ownerId) {
    const code = refList.code.get(ownerId);
    const items = refList.pending.get(ownerId);
    if (!code || !items || !items.length) return;
    refList.pending.delete(ownerId);
    if (!shared.status) {
      const r = await send({ type: 'status' });
      if (r.ok && r.status && !r.status.error) shared.status = r.status;
    }
    if (!(shared.status && shared.status.referralSync)) return;
    const r = await send({ type: 'referrals', list: { ownerId, code, items } });
    dbg('referrals', r.ok ? `Referral list: ${items.length} read, ${r.added} new, ${r.total} accounts confirmed` : `Referral list not taken: ${r.error}`);
    if (r.ok && r.added) toast(`FOMO Alerts: ${r.added} new referral${r.added === 1 ? '' : 's'} confirmed (${r.total} in total).`, 'ok');
    else if (!r.ok) toast('FOMO Alerts referral list: ' + r.error, 'err');
  }

  // The admin dashboard's one-time pairing link: https://fomo.family/#fomoalerts-pair=<code>. Taken out of the
  // address bar right away (on a fresh page this runs before Fomo's own scripts), then this browser is paired.
  // Opened in a tab that already shows that page, only the #part changes (no reload): hashchange catches that.
  function pairFromLink() {
    const m = location.hash.match(/^#fomoalerts-pair=([A-Za-z0-9_-]{10,64})$/);
    if (!m) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    send({ type: 'pairReferrals', code: m[1] }).then((r) => {
      if (!r.ok) return toast('FOMO Alerts: ' + (r.error || 'pairing failed'), 'err');
      if (shared.status) shared.status = { ...shared.status, referralSync: true };
      dbg('referrals', 'This browser is now paired for the referral list');
      toast('FOMO Alerts: this browser now confirms free access for your referral code. Open Earnings on Fomo to send the list.', 'ok', 12000);
    });
  }
  pairFromLink();
  window.addEventListener('hashchange', pairFromLink);

  // a short note in the bottom-right corner (for things that happen outside a card)
  function toast(text, kind, ms) {
    if (kind === 'err') reportShown('toast', text);
    const show = () => {
      const t = document.createElement('div');
      t.className = 'fa-toast' + (kind ? ' fa-toast-' + kind : '');
      t.setAttribute('role', 'status');
      t.textContent = RX.text(String(text));
      t.addEventListener('click', () => t.remove());
      document.body.append(t);
      setTimeout(() => t.remove(), ms || 6000);
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  function onChartMessage(type, payload) {
    if (!payload) return;
    if (type === 'log') {
      dbg('chart', payload.msg);
    } else if (type === 'status') {
      if (/^error/.test(String(payload.lines || ''))) report({ kind: 'chart', where: payload.target === 'popup' ? 'popup chart' : 'chart', msg: String(payload.lines) });
      const name = payload.target === 'popup' ? 'Popup chart' : 'Chart';
      dbg('chart', `${name} ${payload.chart ? 'found' : 'not found'}${payload.units ? `, shows ${payload.units}` : ''}, lines: ${payload.lines}` +
        (payload.offscreen && payload.offscreen.length ? ` (${payload.offscreen.join(' + ').toUpperCase()} outside the visible range)` : ''));
      if (payload.target === 'popup') {
        if (payload.key) debug.popupCharts.set(payload.key, payload);
      } else {
        debug.chart = payload;
      }
      renderAll();
    } else if (type === 'price') {
      const prev = shared.live.get(norm(payload.address));
      shared.live.set(norm(payload.address), { price: payload.price, at: Date.now() });
      if (!prev || prev.price !== payload.price) renderAll();
    } else if (type === 'dragging') {
      onChartDragging(payload.target, payload.key, payload.id, payload.price);
    } else if (type === 'moved') {
      onChartMoved(payload.target, payload.key, payload.id, payload.price);
    }
  }

  // ---------- helpers ----------
  function send(msg) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve({ ok: false, error: 'Extension was reloaded. Refresh this page.' });
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: 'No response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension was reloaded. Refresh this page.' });
      }
    });
  }

  function tokenFromPath(path) {
    const m = String(path || '').match(new RegExp('^' + RX.escape(rule().coinPath) + '([^/]+)/([^/?#]+)'));
    if (!m) return null;
    const slug = m[1].toLowerCase();
    const address = decodeURIComponent(m[2]);
    return { slug, address, networkId: rule().chains[slug] || null, key: slug + '/' + address };
  }
  const currentToken = () => tokenFromPath(location.pathname);
  const positionFor = (p) => shared.positions.get(norm(p.tok.address));

  // what a card works with: your position, or for a coin you don't hold just the coin itself
  // (price, symbol, logo and supply from the server's price lookup), so Buy the dip still works
  const coins = new Map(); // norm(address) -> { price, supply, symbol, image }
  function coinOf(p) {
    const pos = positionFor(p);
    if (pos && pos.amount > 0) return pos;
    const c = coins.get(norm(p.tok.address)) || {};
    return {
      notHeld: true,
      tokenAddress: (pos && pos.tokenAddress) || p.tok.address,
      networkId: (pos && pos.networkId) || p.tok.networkId,
      symbol: (pos && pos.symbol) || c.symbol || '',
      image: (pos && pos.image) || c.image || null,
      amount: 0,
      priceUsd: c.price || (pos && pos.priceUsd) || 0,
      totalSupply: c.supply || (pos && pos.totalSupply) || 0,
    };
  }
  const allowed = (side, holds) => holds || side === 'dip'; // you can always buy (more)

  // current price: newest candle on Fomo's chart if we have it, else the price Fomo sent with your positions
  function nowPrice(pos) {
    if (!pos) return 0;
    const live = shared.live.get(norm(pos.tokenAddress));
    if (live && live.price > 0 && Date.now() - live.at < LIVE_MAX_AGE_MS) return live.price;
    return pos.priceUsd > 0 ? pos.priceUsd : 0;
  }

  function fmtPrice(p) {
    if (p == null || !isFinite(p)) return '—';
    if (p === 0) return '$0';
    if (p >= 1) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 2 : 4 });
    const zeros = Math.ceil(-Math.log10(p)) - 1; // leading zeros after "0."
    const digits = Math.round(p * Math.pow(10, zeros + 4)).toString().replace(/0+$/, '') || '0';
    if (zeros >= 4) {
      const sub = String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('');
      return '$0.0' + sub + digits;
    }
    return '$' + p.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  // $813.4K MC, like Fomo shows it
  function fmtMc(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    const n = (v / div).toFixed(unit === 'M' || unit === 'B' ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + n + unit + ' MC';
  }

  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    return (v < 0 ? '−$' : '$') + (a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toFixed(2));
  }
  const fmtSigned = (v) => (v >= 0 ? '+' : '−') + fmtUsd(Math.abs(v));
  const fmtPct = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + '%';

  // Fomo's market cap is price × total supply (same as on their chart)
  function supplyOf(pos) {
    if (!pos) return 0;
    if (pos.totalSupply > 0) return pos.totalSupply;
    return pos.marketCap > 0 && pos.priceUsd > 0 ? pos.marketCap / pos.priceUsd : 0;
  }

  // what your position would be worth at a price, and the profit/loss vs. what you invested
  function moneyAt(pos, price) {
    if (!pos || !(pos.amount > 0) || !(price > 0)) return null;
    const value = pos.amount * price;
    const invested = pos.costBasisUsd > 0 ? pos.costBasisUsd : pos.entryPrice > 0 ? pos.amount * pos.entryPrice : null;
    return { value, pnl: invested === null ? null : value - invested };
  }
  const moneyText = (m) => (m ? `≈ ${fmtUsd(m.value)}` + (m.pnl === null ? '' : ` (${fmtSigned(m.pnl)})`) : '');
  // the position an alert was set for: your live Fomo position if loaded, else what the alert remembers
  function positionOfAlert(a) {
    const pos = shared.positions.get(norm(a.tokenAddress));
    if (pos && pos.amount > 0) return pos;
    return { amount: a.amount, costBasisUsd: a.invested, entryPrice: a.entryPrice, totalSupply: a.supply };
  }

  // ---------- alerts already set (one per level) ----------
  const isActive = (a) => a && a.status === 'active' && SIDE[a.kind];
  const alertLabel = (a, pct) =>
    `${SIDE[a.kind].line}${a.kind === 'sl' && a.trailing ? ' trailing' : ''} ${SIDE[a.kind].sign}${pct === undefined ? a.pct : pct}%`;
  // highest first: take profits on top, then buy-the-dip levels, then stop losses
  const sortAlerts = (list) => [...list].sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
  // where an alert triggers now: a trailing stop also follows the live price the server hasn't seen yet
  function alertLevel(a, now) {
    if (a.kind === 'sl' && a.trailing) {
      const peak = Math.max(a.peakPrice || 0, now || 0);
      return peak > 0 ? peak * (1 - a.pct / 100) : a.price;
    }
    return a.price;
  }

  // % between a level and the current price, positive in the side's direction
  const pctFrom = (side, price, now) => Math.round(DIR[side] * (price / now - 1) * 1000) / 10;
  const validPct = (side, pct) => pct > 0 && (DIR[side] > 0 ? pct <= 100000 : pct < 100);
  const fromNow = (side, pct, now) => (now > 0 ? now * (1 + (DIR[side] * pct) / 100) : null);
  const invalidMsg = (side) =>
    side === 'tp' ? 'Take profit must be above the current price.'
      : side === 'sl' ? 'Stop loss must be below the current price.'
      : 'Buy-the-dip level must be below the current price.';

  function span(text, cls) {
    const s = document.createElement('span');
    s.textContent = text;
    if (cls) s.className = cls;
    return s;
  }

  function icon(def, cls, label) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', def.box);
    svg.setAttribute('class', cls);
    if (label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    for (const d of def.paths || [def.d]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      if (def.stroke) {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
      } else path.setAttribute('fill', 'currentColor');
      svg.append(path);
    }
    return svg;
  }

  // set text where "{tg}" becomes the Telegram icon
  function fillText(el, text) {
    const key = text + '\u0000' + RX.v; // (a text change from the server redraws it)
    if (el.dataset.faText === key) return;
    el.dataset.faText = key;
    el.textContent = '';
    String(RX.text(String(text))).split('{tg}').forEach((part, i) => {
      if (i) el.append(icon(TG_ICON, 'fa-tg', 'Telegram'));
      if (part) el.append(part);
    });
  }

  // ---------- finding Fomo's boxes ----------
  // Fomo's trade box starts with a row of [Buy] [Sell] [settings gear].
  // Matched by layout instead of text, so it also works when Fomo is in another language.
  const isTradeRow = (row) => {
    const btns = row.children;
    if (btns.length !== 3 || [...btns].some((b) => b.tagName !== 'BUTTON')) return false;
    if (!btns[0].classList.contains(rule().sideButtonClass) || !btns[1].classList.contains(rule().sideButtonClass)) return false;
    return btns[2].hasAttribute('aria-label') && !row.closest('.fa-panel');
  };
  // the trade box ([Buy] [Sell] [⚙] + amount) inside root, or null
  function tradeCardIn(root, skipDialogs) {
    const rows = [];
    const gear = root.querySelector(rule().tradeGear);
    if (gear && gear.parentElement) rows.push(gear.parentElement);
    rows.push(...root.querySelectorAll(rule().tradeRow));
    for (const row of rows) {
      if (!isTradeRow(row) || (skipDialogs && inPopup(row))) continue;
      const card = row.closest(rule().tradeCard);
      if (card && card.getClientRects().length) return card; // skip hidden copies
    }
    return null;
  }
  // inside one of Fomo's popups (one we marked, or a dialog with a title). Fomo's page layout itself can also
  // use role="dialog", so that alone doesn't count.
  function inPopup(el) {
    if (el.closest('[data-fa-popup]')) return true;
    const dlg = el.closest(rule().dialog);
    return !!(dlg && dlg.querySelector(rule().dialogTitle));
  }
  // the coin page's own trade box (not the one in a popup); when unsure, any trade box
  const findTradeCard = () => tradeCardIn(document, true) || tradeCardIn(document, false);

  // Row of exactly two buttons, [Buy] [Sell], as in the Position popup
  function findBuySellRow(root) {
    for (const row of root.querySelectorAll(rule().tradeRow)) {
      if (row.closest('.fa-panel')) continue;
      const b = row.children;
      if (b.length !== 2 || b[0].tagName !== 'BUTTON' || b[1].tagName !== 'BUTTON') continue;
      if (b[0].classList.contains(rule().sideButtonClass) && b[1].classList.contains(rule().sideButtonClass)) return row;
    }
    return null;
  }

  // Fomo's Position popup: a dialog with a coin link and a [Buy] [Sell] row
  // Fomo popups with a coin's small chart:
  //  - Position popup: [Buy] [Sell] row + position summary (yours, or someone else's from their profile)
  //  - trade popup (Buy / Sell on a trade, e.g. on someone's profile): your own trade box [Buy] [Sell] [⚙]
  function findPositionDialogs() {
    const out = [];
    for (const title of document.querySelectorAll(rule().dialogTitle)) {
      let dlg = title.parentElement;
      let row = null;
      let trade = null;
      for (let i = 0; dlg && i < 3; i++, dlg = dlg.parentElement) {
        if ((row = findBuySellRow(dlg)) || (trade = tradeCardIn(dlg))) break;
      }
      if (!dlg || !(row || trade) || !dlg.getClientRects().length) continue;
      const link = dlg.querySelector(rule().coinLink);
      const tok = link && tokenFromPath(link.getAttribute('href'));
      if (!tok) continue;
      if (trade) {
        // your own trade box: the card goes under it, whoever's profile the popup came from. Placed in the
        // column itself (not in the box's wrapper) so it can shrink and scroll in the popup.
        // (the box sits in a wrapper with more parts; walk up to the wrapper's place in the column)
        let wrap = trade;
        while (wrap.parentElement && wrap.parentElement !== dlg &&
          !rule().popupColumnClasses.split(' ').every((c) => wrap.parentElement.classList.contains(c))) {
          wrap = wrap.parentElement;
        }
        out.push({ dlg, tok, owner: null, anchor: wrap, trade: true });
        continue;
      }
      const ownerLink = dlg.querySelector(rule().profileLink);
      const owner = ownerLink ? decodeURIComponent(ownerLink.getAttribute('href').split('/')[2] || '') || null : null;
      // card goes under the position summary (value, avg. entry, invested), else under the Buy/Sell row
      const next = row.nextElementSibling;
      const summary = next && next.firstElementChild;
      const anchor = summary && summary.classList.contains(rule().positionSummaryClass) ? summary : row;
      out.push({ dlg, tok, owner, anchor });
    }
    return out;
  }

  // ---------- card ----------
  function sideHtml(side) {
    const s = SIDE[side];
    const trail = side === 'sl'
      ? '<label class="fa-trail" data-tip="trail"><input type="checkbox" class="fa-trail-toggle"><span>Trailing</span></label>'
      : '';
    return `
      <div class="fa-side" data-side="${side}">
        <div class="fa-side-head">
          <span class="fa-label ${s.cls}" data-tip="${side}">${s.name}</span>
          ${trail}
          <button type="button" class="fa-line-btn"></button>
          <button type="button" class="fa-icon fa-clear" title="Clear this field">${CLEAR_SVG}</button>
        </div>
        <div class="fa-row">
          <div class="fa-input"><span>${s.sign}</span><input class="fa-in" type="number" min="0" step="any" placeholder="off"><span>%</span></div>
          <div class="fa-target"><span class="fa-lvl"></span><span class="fa-money"></span></div>
        </div>
        <div class="fa-chips"></div>
      </div>`;
  }

  function createPanel(kind, tok) {
    const p = {
      kind, // 'page' (coin page) or 'modal' (Position popup)
      tok,
      el: null,
      alerts: [], // active alerts on this coin, one per level
      dirty: { tp: false, sl: false, dip: false }, // field changed since it was last cleared
      dragPrice: { tp: null, sl: null, dip: null }, // exact level from dragging a chart line
      preview: { tp: null, sl: null, dip: null }, // level under the mouse while a line is being dragged
      dragOrig: {}, // field before a drag, to put back if the drop is not allowed
      alertPreview: null, // { id, price }: an active alert's line being dragged
      trailing: false, // new stop loss trails the highest price
      saving: false,
      chartKey: null, // popup: marks the popup element for the chart bridge
      chipsKey: '',
      crossedMsg: '',
      lastChart: '',
    };
    const el = document.createElement('div');
    el.className = 'fa-panel' + (kind === 'modal' ? ' fa-in-modal' : '');
    el.innerHTML = `
      <div class="fa-head">
        <span class="fa-title">TP / SL alerts</span>
        <button type="button" class="fa-user"></button>
        <button type="button" class="fa-conn"></button>
        <button type="button" class="fa-icon fa-gear" title="Settings">${GEAR_SVG}</button>
        <button type="button" class="fa-icon fa-min" title="Minimize">–</button>
      </div>
      <div class="fa-settings">
        <div class="fa-set-row">
          <span>Show levels as</span>
          <div class="fa-seg">
            <button type="button" data-units="price">Price</button>
            <button type="button" data-units="mcap">Market cap</button>
          </div>
        </div>
        <div class="fa-set-note"></div>
      </div>
      <div class="fa-pos"></div>
      <div class="fa-block">${sideHtml('tp')}<div class="fa-divider"></div>${sideHtml('dip')}</div>
      <div class="fa-block">${sideHtml('sl')}</div>
      <div class="fa-actions">
        <button type="button" class="fa-save">Set alert</button>
      </div>
      <div class="fa-msg"></div>
      <div class="fa-list"></div>
      <div class="fa-foot">% from the current price. Every level is its own alert. Notification only, you still trade yourself on Fomo.</div>
      <div class="fa-tip" role="tooltip"></div>`;

    for (const side of SIDES) {
      const box = sideEl(p, side, el);
      box.querySelector('.fa-in').addEventListener('input', () => edited(p, side));
      box.querySelector('.fa-line-btn').addEventListener('click', () => toggleLine(p, side));
      box.querySelector('.fa-clear').addEventListener('click', () => clearSide(p, side));
    }
    setupTips(p, el);
    el.querySelector('.fa-trail-toggle').addEventListener('change', (e) => {
      p.trailing = e.target.checked;
      edited(p, 'sl');
    });
    el.querySelector('.fa-conn').addEventListener('click', () => openSettings());
    el.querySelector('.fa-user').addEventListener('click', () => openSettings());
    el.querySelector('.fa-gear').addEventListener('click', () => {
      el.classList.toggle('fa-show-settings'); // also turns the quick % buttons into editors
      safe(() => renderPanel(p));
    });
    el.querySelector('.fa-min').addEventListener('click', () => el.classList.toggle('fa-collapsed'));
    for (const b of el.querySelectorAll('.fa-seg button')) {
      b.addEventListener('click', () => saveSettings({ units: b.dataset.units }));
    }
    el.querySelector('.fa-save').addEventListener('click', () => savePanel(p));
    // bins in the list of alerts already set
    el.querySelector('.fa-list').addEventListener('click', (e) => {
      const bin = e.target.closest('.fa-bin');
      const row = bin && bin.closest('[data-id]');
      if (row) removeAlert(row.dataset.id, p);
    });
    // keep Fomo's own keyboard shortcuts from firing while typing here
    el.addEventListener('keydown', (e) => e.stopPropagation());

    p.el = el;
    panels.add(p);
    return p;
  }

  function sideEl(p, side, root) {
    return (root || p.el).querySelector(`.fa-side[data-side="${side}"]`);
  }
  const inputOf = (p, side) => sideEl(p, side).querySelector('.fa-in');

  function edited(p, side) {
    p.dirty[side] = true;
    p.dragPrice[side] = null;
    safe(() => renderPanel(p));
  }

  // × next to a field: empties it (alerts already set stay; their bins in the list remove them)
  function clearSide(p, side) {
    const input = inputOf(p, side);
    if (!input.value && !(side === 'sl' && p.trailing)) return;
    resetSide(p, side);
    renderPanel(p);
    setMsg(p, '');
  }

  function resetSide(p, side) {
    inputOf(p, side).value = '';
    p.dirty[side] = false;
    p.dragPrice[side] = null;
    p.preview[side] = null;
    if (side === 'sl') p.trailing = false;
  }

  // explanation after hovering a label (Take profit, Buy the dip, Stop loss, Trailing) for a second
  function setupTips(p, el) {
    const tip = el.querySelector('.fa-tip');
    let timer = 0;
    let pending = null;
    const hide = () => {
      clearTimeout(timer);
      timer = 0;
      pending = null;
      tip.classList.remove('fa-tip-on');
    };
    el.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tip]');
      if (target === pending) return;
      hide();
      if (!target || !el.contains(target)) return;
      pending = target;
      timer = setTimeout(() => {
        const box = el.getBoundingClientRect();
        const at = target.getBoundingClientRect();
        fillText(tip, TIPS[target.dataset.tip]);
        tip.style.top = at.bottom - box.top + 6 + 'px';
        tip.classList.add('fa-tip-on');
      }, TIP_DELAY_MS);
    });
    el.addEventListener('mouseleave', hide);
  }

  // quick % buttons; with the settings (gear) open they become editors with a pencil
  function renderChips(p) {
    const editing = p.el.classList.contains('fa-show-settings');
    const key = JSON.stringify(shared.settings.chips) + editing;
    if (p.chipsKey === key) return;
    p.chipsKey = key;
    for (const side of SIDES) {
      const box = sideEl(p, side).querySelector('.fa-chips');
      box.textContent = '';
      shared.settings.chips[side].forEach((v, i) => box.append(editing ? chipEditor(side, i, v) : chipButton(p, side, v)));
    }
  }

  function chipButton(p, side, v) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fa-chip';
    b.textContent = SIDE[side].sign + v + '%';
    b.addEventListener('click', () => {
      inputOf(p, side).value = v;
      edited(p, side);
    });
    return b;
  }

  function chipEditor(side, i, v) {
    const wrap = document.createElement('label');
    wrap.className = 'fa-chip fa-chip-edit';
    wrap.title = 'Type a new %';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = v;
    input.setAttribute('aria-label', `${SIDE[side].name} quick button ${i + 1}`);
    const commit = () => {
      const n = Math.round(parseFloat(input.value.replace(',', '.')) * 100) / 100;
      if (!validPct(side, n)) {
        input.value = shared.settings.chips[side][i]; // not a valid % for this side: put the old one back
        return;
      }
      if (n === shared.settings.chips[side][i]) return;
      const chips = { ...shared.settings.chips, [side]: shared.settings.chips[side].map((x, k) => (k === i ? n : x)) };
      saveSettings({ chips });
    };
    input.addEventListener('change', commit);
    input.addEventListener('focus', () => setTimeout(() => input.select(), 0)); // typing replaces the old %
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    wrap.append(span(SIDE[side].sign, 'fa-dim'), input, span('%', 'fa-dim'), icon(PENCIL_ICON, 'fa-pencil'));
    return wrap;
  }

  function readPct(p, side) {
    const v = parseFloat(inputOf(p, side).value);
    return v > 0 ? v : null;
  }
  const sidesToSave = (p) => {
    const holds = !coinOf(p).notHeld;
    return SIDES.filter((s) => {
      const pct = readPct(p, s);
      return allowed(s, holds) && pct && validPct(s, pct);
    });
  };

  // where the alert typed in a field would trigger (a new trailing stop starts at the current price)
  function targetPrice(p, side, now) {
    if (p.preview[side]) return p.preview[side]; // line being dragged right now
    const pct = readPct(p, side);
    if (!pct || !validPct(side, pct)) return null;
    if (side === 'sl' && p.trailing) return now > 0 ? now * (1 - pct / 100) : null;
    return p.dragPrice[side] || fromNow(side, pct, now);
  }

  const isDirty = (p) => SIDES.some((s) => p.dirty[s]);

  function setMsg(p, text, kind) {
    if (kind === 'red') reportShown(p.kind === 'page' ? 'card' : 'popup card', text);
    const m = p.el.querySelector('.fa-msg');
    fillText(m, text || '');
    m.className = 'fa-msg' + (kind ? ' fa-' + kind : '');
  }

  // "Set alert": every filled-in field becomes its own new alert, next to the ones already set
  async function savePanel(p) {
    if (!shared.status || !shared.status.linked) return openSettings();
    if (shared.status.update && shared.status.update.required) return setMsg(p, UPDATE_NOTE, 'red');
    if (shared.status.access && !shared.status.access.allowed) return openSettings(shared.status.access.reason !== 'referral_waiting');
    if (p.saving) return;
    const pos = coinOf(p);
    const holds = !pos.notHeld;
    const now = nowPrice(pos);
    if (!(now > 0)) return setMsg(p, 'No current price yet. Try again in a few seconds.', 'red');
    for (const side of SIDES) {
      const pct = readPct(p, side);
      if (allowed(side, holds) && pct && !validPct(side, pct)) return setMsg(p, `${SIDE[side].name} must be below 100%.`, 'red');
    }
    const sides = sidesToSave(p);
    if (!sides.length) return setMsg(p, 'Enter a take profit, stop loss or buy-the-dip %.', 'red');
    p.saving = true;
    setMsg(p, 'Saving…');
    renderPanel(p);
    const made = [];
    let error = null;
    for (const side of sides) {
      const trailing = side === 'sl' && p.trailing;
      const r = await send({
        type: 'saveAlert',
        alert: {
          networkId: pos.networkId || p.tok.networkId,
          tokenAddress: pos.tokenAddress,
          symbol: pos.symbol || null, // the server looks it up when missing
          image: pos.image || null, // coin logo for the alert lists
          entryPrice: pos.entryPrice > 0 ? pos.entryPrice : null,
          basePrice: now, // the current price the % is measured from
          kind: side,
          pct: readPct(p, side),
          price: targetPrice(p, side, now),
          trailing,
          peakPrice: trailing ? now : null,
          // for "your position would be worth …" and market cap in the Telegram message
          amount: pos.amount > 0 ? pos.amount : null,
          invested: pos.costBasisUsd > 0 ? pos.costBasisUsd : null,
          supply: supplyOf(pos) || null,
        },
      });
      if (!r.ok) {
        error = r.error;
        break;
      }
      made.push(r.alert);
      resetSide(p, side);
    }
    p.saving = false;
    if (made.length) {
      setAlerts(p.tok.address, [...p.alerts.filter((a) => !made.some((m) => m.id === a.id)), ...made]);
      refreshHistory();
    }
    if (error) return setMsg(p, (made.length ? `${made.length} set, then: ` : '') + error, 'red');
    setMsg(p, `${made.length > 1 ? made.length + ' alerts' : 'Alert'} set. You will get a {tg} message when ${made.length > 1 ? 'each one hits' : 'it hits'}.`, 'green');
  }

  // bin next to an alert that is already set (in a card or in the list in Fomo's Alerts panel)
  async function removeAlert(id, from) {
    const r = await send({ type: 'deleteAlert', id });
    if (!r.ok) {
      if (from) setMsg(from, r.error, 'red');
      return;
    }
    for (const q of panels) {
      if (!q.alerts.some((a) => a.id === id)) continue;
      q.alerts = q.alerts.filter((a) => a.id !== id);
      setMsg(q, 'Alert removed.');
    }
    hist.active = hist.active.filter((a) => a.id !== id);
    renderAll();
    refreshHistory();
  }

  // a dragged chart line of an alert that is already set: move that alert
  async function moveAlert(p, a, price) {
    const now = nowPrice(coinOf(p));
    const trailing = a.kind === 'sl' && a.trailing;
    const peak = Math.max(a.peakPrice || 0, now || 0);
    const pct = trailing ? Math.round((1 - price / peak) * 1000) / 10 : pctFrom(a.kind, price, now);
    const putBack = (msg) => {
      p.alertPreview = null;
      p.lastChart = ''; // makes the chart put the line back
      renderAll();
      setMsg(p, msg, 'red');
    };
    if (!(now > 0)) return putBack('No current price yet. Try again in a few seconds.');
    if (!validPct(a.kind, pct)) return putBack(trailing ? 'A trailing stop must be below the highest price.' : invalidMsg(a.kind));
    p.alertPreview = { id: a.id, price };
    setMsg(p, 'Saving…');
    const r = await send({ type: 'saveAlert', alert: { id: a.id, kind: a.kind, pct, price: trailing ? null : price, basePrice: now } });
    if (!r.ok) return putBack(r.error);
    p.alertPreview = null;
    setAlerts(a.tokenAddress, p.alerts.map((x) => (x.id === a.id ? r.alert : x)));
    dbg('chart', `${SIDE[a.kind].name} alert moved to ${fmtPrice(r.alert.price)} (${alertLabel(r.alert)})`);
    setMsg(p, `Alert moved: ${alertLabel(r.alert)}.`, 'green');
    refreshHistory();
  }

  // which coins this account holds, for the server: a take profit or stop loss on a coin you sold completely is
  // paused there (greyed out here, no alert) and comes back when you hold the coin again. Sent when it changes.
  let holdingsSent = '';
  function sendHoldings(positions) {
    const list = positions.map((p) => ({ networkId: p.networkId, tokenAddress: p.tokenAddress, amount: p.amount > 0 ? p.amount : 0 }));
    const key = JSON.stringify(list.map((x) => [x.networkId, norm(x.tokenAddress), x.amount > 0]).sort());
    if (key === holdingsSent) return;
    holdingsSent = key;
    send({ type: 'holdings', positions: list }).then((r) => {
      if (!r.ok) holdingsSent = ''; // try again with the next positions
      else if (r.changed) {
        for (const p of panels) loadPanel(p);
        refreshHistory();
      }
    });
  }
  // sold completely: its take profit / stop loss is paused (see sendHoldings)
  const isPaused = (a) => !!(a && a.noPosition && (a.kind === 'tp' || a.kind === 'sl'));
  const PAUSED_NOTE = 'Paused: you sold this coin. It comes back on when you hold it again.';

  // keep every card of the same coin (coin page + Position popup) in step
  function setAlerts(address, alerts) {
    const list = alerts.filter(isActive);
    for (const q of panels) if (norm(q.tok.address) === norm(address)) q.alerts = list;
    renderAll();
  }

  async function loadPanel(p) {
    const r = await send({ type: 'getAlerts', tokenAddress: p.tok.address });
    if (!panels.has(p)) return; // closed meanwhile
    shared.status = r.ok ? r.status : { configured: false, linked: false, error: r.error };
    // keep the list as it is while one of its lines is being dragged
    if (r.ok && !p.alertPreview) p.alerts = (r.alerts || []).filter(isActive);
    sendCoinMeta();
    renderAll();
    // a coin you don't hold: get its price etc. for Buy the dip
    if (r.ok && r.status.linked && coinOf(p).notHeld && p.tok.networkId) {
      const c = await send({ type: 'coinInfo', networkId: p.tok.networkId, tokenAddress: p.tok.address });
      if (!panels.has(p)) return;
      if (c.ok && c.coin) coins.set(norm(p.tok.address), c.coin);
      else if (!coins.has(norm(p.tok.address))) dbg('card', `No price for ${p.tok.key} on the server: ${c.error || 'unknown'}`);
      renderAll();
    }
  }

  function renderAll() {
    for (const p of panels) safe(() => renderPanel(p));
    safe(renderHistory);
  }

  // which lines the chart really shows right now (from chart-bridge.js)
  function chartStatus(p) {
    return p.kind === 'page' ? debug.chart : debug.popupCharts.get(p.chartKey) || null;
  }
  function lineShown(p, side) {
    const st = chartStatus(p);
    const drawn = (st && st.chart && st.drawn) || [];
    return drawn.some((id) => id === 'new-' + side || p.alerts.some((a) => a.kind === side && id === 'a:' + a.id));
  }

  // Show / Hide line button: "Hide" only while the line is really on the chart
  function toggleLine(p, side) {
    shared.lines = { ...shared.lines, [side]: !shared.lines[side] };
    for (const q of panels) q.lastChart = ''; // send the lines again, even if nothing changed
    renderAll();
  }

  // why a switched-on line isn't on the chart, in the chart side's own words
  function lineIssue(p) {
    const st = chartStatus(p);
    if (!st) return 'no answer from the chart yet';
    if (!st.chart) return st.lines || 'chart not found';
    return st.lines;
  }

  // a line that's switched on but not on the chart for a while: say why in the card
  function reportLineIssue(p, side, waiting) {
    p.lineWait = p.lineWait || {};
    if (!waiting) {
      if (p.lineWait[side] && p.lineWait[side].msg && p.el.querySelector('.fa-msg').dataset.faText === p.lineWait[side].msg) setMsg(p, '');
      delete p.lineWait[side];
      return;
    }
    const w = p.lineWait[side] || (p.lineWait[side] = { since: Date.now(), msg: '' });
    if (Date.now() - w.since < 1500) {
      if (!w.timer) w.timer = setTimeout(() => safe(() => renderPanel(p)), 1600);
      return;
    }
    const name = side === 'dip' ? 'Dip' : SIDE[side].line;
    const msg = `${name} line isn't on the chart: ${lineIssue(p)}.`;
    if (msg !== w.msg) {
      w.msg = msg;
      setMsg(p, msg, 'red');
      dbg('chart', `${p.kind === 'page' ? 'Chart' : 'Popup chart'}: ${msg}`);
    }
  }

  function renderPanel(p) {
    queueTexts();
    const el = p.el;
    const pos = coinOf(p); // your position, or just the coin when you don't hold it
    const st = shared.status;
    const supply = supplyOf(pos) || (p.alerts[0] && p.alerts[0].supply) || 0;
    const mcap = shared.settings.units === 'mcap' && supply > 0;
    const lvl = (price) => (mcap ? fmtMc(price * supply) : fmtPrice(price));
    const holds = !pos.notHeld;
    const now = nowPrice(pos);

    // Fomo account
    const handle = (shared.user && shared.user.handle) || shared.manualHandle;
    const userEl = el.querySelector('.fa-user');
    userEl.textContent = handle ? '@' + handle : 'Set username';
    const badge = handle && badgeEl(st);
    if (badge) userEl.prepend(badge);
    userEl.className = 'fa-user' + (handle ? '' : ' fa-warn');
    userEl.title = shared.user && shared.user.handle
      ? 'Fomo account logged in on this browser'
      : handle ? 'Username you entered in the extension' : 'Tell the extension your Fomo username';
    userEl.hidden = !(st && st.linked); // nothing about the account until Telegram is linked

    // Telegram badge
    const conn = el.querySelector('.fa-conn');
    if (!st) { fillText(conn, '…'); conn.className = 'fa-conn'; conn.title = ''; }
    else if (st.linked) { fillText(conn, '{tg} ✓'); conn.className = 'fa-conn fa-ok'; conn.title = 'Telegram linked'; }
    else if (st.error) { fillText(conn, 'Server offline'); conn.className = 'fa-conn fa-warn'; conn.title = st.error; }
    else { fillText(conn, '{tg} Link'); conn.className = 'fa-conn fa-warn'; conn.title = 'Link Telegram'; }

    // settings menu
    for (const b of el.querySelectorAll('.fa-seg button')) b.classList.toggle('fa-on', b.dataset.units === shared.settings.units);
    el.querySelector('.fa-set-note').textContent =
      shared.settings.units === 'mcap' && pos && !supply ? 'Fomo sent no supply for this coin, so prices are shown instead.' : '';
    renderChips(p);

    // position line
    const posEl = el.querySelector('.fa-pos');
    posEl.textContent = '';
    if (holds) {
      if (pos.entryPrice > 0) {
        const pnl = (now / pos.entryPrice - 1) * 100;
        posEl.append(
          span('Entry ', 'fa-dim'), span(lvl(pos.entryPrice)),
          span('  ·  Now ', 'fa-dim'), span(lvl(now)),
          span('  ·  ', 'fa-dim'), span(fmtPct(pnl), pnl >= 0 ? 'fa-green' : 'fa-red')
        );
      } else {
        posEl.append(span('Now ', 'fa-dim'), span(lvl(now)), span('  ·  no entry price (received, not bought)', 'fa-dim'));
      }
    } else {
      if (now > 0) posEl.append(span('Now ', 'fa-dim'), span(lvl(now)), span('  ·  ', 'fa-dim'));
      posEl.append(span("You don't hold this coin: Buy the dip works, take profit and stop loss unlock once you buy it.", 'fa-dim'));
    }

    // not holding this coin: gray out take profit and stop loss; Buy the dip, the quick-% editors and the
    // list of alerts stay usable
    el.classList.toggle('fa-off', !holds);
    for (const side of SIDES) {
      const off = !allowed(side, holds);
      const box = sideEl(p, side);
      box.classList.toggle('fa-side-off', off);
      for (const c of box.querySelectorAll('.fa-in, button.fa-chip, .fa-trail-toggle')) c.disabled = off;
    }
    el.querySelector('.fa-trail-toggle').checked = !!p.trailing;

    // fields: target (price or market cap) and, for TP / SL, what the position would be worth there
    const st2 = chartStatus(p);
    const chartReachable = p.kind === 'page' || !!(st2 && st2.chart);
    const target = {};
    for (const side of SIDES) {
      target[side] = allowed(side, holds) && now > 0 ? targetPrice(p, side, now) : null;
      const box = sideEl(p, side);
      const price = target[side];
      box.querySelector('.fa-lvl').textContent = price
        ? '→ ' + lvl(price) + (side === 'sl' && p.trailing ? ' (trails the high)' : '')
        : '';
      const moneyEl = box.querySelector('.fa-money');
      moneyEl.textContent = '';
      const m = side !== 'dip' && price && moneyAt(pos, price);
      if (m) {
        moneyEl.append(span('≈ ' + fmtUsd(m.value) + ' '));
        if (m.pnl !== null) moneyEl.append(span('(' + fmtSigned(m.pnl) + ')', m.pnl >= 0 ? 'fa-green' : 'fa-red'));
      }
      // one Show / Hide button per line; "Hide" only while the line is really on the chart
      const btn = box.querySelector('.fa-line-btn');
      const on = !!shared.lines[side];
      const shown = on && lineShown(p, side);
      const name = side === 'dip' ? 'dip' : SIDE[side].line;
      const usable = allowed(side, holds) && now > 0 && chartReachable;
      btn.style.display = usable ? '' : 'none';
      // switched on but not (yet) on the chart: "Cancel", and after a moment the card says why
      btn.textContent = (shown ? 'Hide ' : on ? 'Cancel ' : 'Show ') + name + ' line';
      btn.classList.toggle('fa-on', shown);
      btn.classList.toggle('fa-wait', on && !shown);
      btn.title = on && !shown ? `Not on the chart: ${lineIssue(p)}` : '';
      reportLineIssue(p, side, usable && on && !shown);
      // ×: only when the field has something to clear
      box.querySelector('.fa-clear').style.display = allowed(side, holds) && (readPct(p, side) || (side === 'sl' && p.trailing)) ? '' : 'none';
    }
    const crossed =
      (now && target.tp && now >= target.tp && 'take profit') ||
      (now && target.sl && now <= target.sl && 'stop loss') ||
      (now && target.dip && now <= target.dip && 'buy-the-dip level');
    // warn while editing a level the price is already past; leave other messages alone
    const crossedMsg = isDirty(p) && crossed ? `⚠ The price is already past your ${crossed}, so it will alert right away.` : '';
    if (!Object.keys(p.dragOrig).length && crossedMsg !== p.crossedMsg) {
      if (crossedMsg) setMsg(p, crossedMsg, 'red');
      else if (el.querySelector('.fa-msg').dataset.faText === p.crossedMsg) setMsg(p, '');
      p.crossedMsg = crossedMsg;
    }

    renderAlertList(p, lvl, now);

    // Set alert button
    const save = el.querySelector('.fa-save');
    const count = sidesToSave(p).length;
    if (!st || !st.linked) {
      fillText(save, st && st.error ? 'Server offline' : 'Connect {tg} first');
      save.disabled = false; // opens the extension page
    } else if (st.update && st.update.required) {
      // a newer version is required for new alerts: the alerts below keep working
      fillText(save, 'Update FOMO Alerts to add alerts');
      save.disabled = false;
    } else if (st.access && !st.access.allowed) {
      // locked (FREE_FOR_ALL=false on the server, no referral code, not paid): opens the payment. Joined with our
      // code but Fomo hasn't confirmed it yet: opens the settings, which say so
      fillText(save, st.access.reason === 'referral_waiting' ? 'Checking your free access…' : `Unlock FOMO Alerts · $${st.access.price || '10'}`);
      save.disabled = false;
    } else if (!(now > 0)) {
      fillText(save, 'Waiting for the price…');
      save.disabled = true;
    } else {
      fillText(save, p.saving ? 'Saving…' : count > 1 ? `Set ${count} alerts` : p.alerts.length ? 'Add alert' : 'Set alert');
      save.disabled = p.saving || !count;
    }
    if (st && st.error && !st.linked) setMsg(p, st.error, 'red');

    syncChart(p, pos, holds, now);
  }

  // the alerts already set on this coin, one row each with a bin
  function renderAlertList(p, lvl, now) {
    const box = p.el.querySelector('.fa-list');
    const rows = sortAlerts(p.alerts).map((a) => {
      const dragging = p.alertPreview && p.alertPreview.id === a.id ? p.alertPreview.price : null;
      const price = dragging || alertLevel(a, now);
      const trailing = a.kind === 'sl' && a.trailing;
      const pct = dragging && now > 0 && !trailing ? pctFrom(a.kind, price, now) : a.pct;
      const off = isPaused(a);
      const m = a.kind !== 'dip' && !off ? moneyAt(positionOfAlert(a), price) : null;
      return { a, label: alertLabel(a, pct), level: lvl(price), money: m, noPrice: a.priceStatus === 'unavailable', off };
    });
    const key = JSON.stringify(rows.map((r) => [r.a.id, r.label, r.level, r.money && moneyText(r.money), r.noPrice, r.off]));
    if (box.dataset.faKey === key) return; // rebuilding under the mouse would swallow clicks on the bins
    box.dataset.faKey = key;
    box.textContent = '';
    if (!rows.length) return;
    box.append(span(`Active alerts (${rows.length})`, 'fa-list-title'));
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'fa-alert' + (r.off ? ' fa-alert-off' : '');
      row.dataset.id = r.a.id;
      const main = document.createElement('div');
      main.className = 'fa-alert-main';
      main.append(span((r.off ? '⏸ ' : '') + r.label, 'fa-tag ' + SIDE[r.a.kind].cls), span('→ ' + r.level, 'fa-alert-lvl'));
      if (r.off) {
        main.append(span('sold, paused', 'fa-alert-paused'));
        row.title = PAUSED_NOTE;
      }
      if (r.money) {
        const money = span('', 'fa-alert-money');
        money.append('≈ ' + fmtUsd(r.money.value));
        if (r.money.pnl !== null) money.append(' ', span('(' + fmtSigned(r.money.pnl) + ')', r.money.pnl >= 0 ? 'fa-green' : 'fa-red'));
        main.append(money);
      }
      if (r.noPrice) {
        const warn = span('⚠', 'fa-red');
        warn.title = 'The server has no price source for this coin yet, so this alert cannot trigger.';
        main.append(warn);
      }
      if (r.a.source === 'telegram' && !r.off) main.title = 'Set in Telegram';
      const bin = document.createElement('button');
      bin.type = 'button';
      bin.className = 'fa-icon fa-bin';
      bin.title = 'Remove this alert';
      bin.innerHTML = TRASH_SVG;
      row.append(main, bin);
      box.append(row);
    }
  }

  // ---------- chart lines (drawn by chart-bridge.js inside the page) ----------
  // Line ids: "new-tp" / "new-sl" / "new-dip" for the fields, "a:<alert id>" for the alerts already set.
  function postChart(payload) {
    window.postMessage({ source: 'fomo-alerts-content', type: 'chart-levels', payload }, location.origin);
  }

  function syncChart(p, pos, holds, now) {
    const target = p.kind === 'page' ? 'main' : 'popup';
    const on = shared.lines;
    const lines = [];
    if (now > 0 && SIDES.some((s) => on[s])) {
      for (const side of SIDES) {
        if (!on[side] || !allowed(side, holds)) continue;
        const s = SIDE[side];
        // the field: a dashed "drag to set" line until a % is filled in
        const price = targetPrice(p, side, now);
        if (!price) {
          lines.push({ id: 'new-' + side, side, ghost: true, draggable: true, color: s.color, text: `New ${s.line} · drag to set`, short: 'New ' + s.line });
        } else {
          const pct = p.preview[side] ? pctFrom(side, price, now) : readPct(p, side);
          const short = `New ${s.line} ${s.sign}${pct}%${side === 'sl' && p.trailing ? ' trailing' : ''}`;
          const m = side !== 'dip' ? moneyText(moneyAt(pos, price)) : '';
          lines.push({ id: 'new-' + side, side, ghost: false, draggable: true, price, color: s.color, short, text: m ? `${short} · ${m}` : short });
        }
        // the alerts already set on this side
        for (const a of p.alerts) {
          if (a.kind !== side) continue;
          const dragging = p.alertPreview && p.alertPreview.id === a.id ? p.alertPreview.price : null;
          const level = dragging || alertLevel(a, now);
          const trailing = a.kind === 'sl' && a.trailing;
          const short = alertLabel(a, dragging && !trailing ? pctFrom(side, level, now) : a.pct);
          if (isPaused(a)) { // greyed out: the coin was sold
            lines.push({ id: 'a:' + a.id, side, ghost: false, dashed: true, draggable: false, price: level, color: '#6e6f7a', short: '⏸ ' + short, text: `⏸ ${short} · sold, paused` });
            continue;
          }
          const m = side !== 'dip' ? moneyText(moneyAt(positionOfAlert(a), level)) : '';
          lines.push({ id: 'a:' + a.id, side, ghost: false, draggable: true, price: level, color: s.color, short: short + ' ✓', text: (m ? `${short} · ${m}` : short) + ' ✓' });
        }
      }
    }
    const address = (pos && pos.tokenAddress) || p.tok.address;
    const supply = supplyOf(pos) || (p.alerts[0] && p.alerts[0].supply) || 0;
    // without lines the chart still reports its latest price for this coin (more up to date than Fomo's positions)
    const payload = lines.length
      ? { target, key: p.chartKey, enabled: true, address, price: now, supply, lines }
      : { target, key: p.chartKey, enabled: false, ...(now > 0 ? { address, price: now, supply } : {}) };
    const json = JSON.stringify(payload);
    if (json === p.lastChart) return;
    p.lastChart = json;
    postChart(payload);
  }

  const panelForChart = (target, key) =>
    target === 'popup' ? [...modalPanels.values()].find((q) => q.chartKey === key) : pagePanel;
  const lineSide = (id) => (typeof id === 'string' && id.startsWith('new-') && SIDES.includes(id.slice(4)) ? id.slice(4) : null);
  const lineAlert = (p, id) => (typeof id === 'string' && id.startsWith('a:') ? p.alerts.find((a) => 'a:' + a.id === id) : null);

  // a line is being dragged: the card follows live (%, level, money), nothing is saved yet
  function onChartDragging(target, key, id, price) {
    const p = panelForChart(target, key);
    if (!p || !(price > 0)) return;
    const now = nowPrice(coinOf(p));
    if (!(now > 0)) return;
    const a = lineAlert(p, id);
    if (a) {
      p.alertPreview = { id: a.id, price };
      renderPanel(p);
      return;
    }
    const side = lineSide(id);
    if (!side) return;
    const input = inputOf(p, side);
    if (!p.dragOrig[side]) p.dragOrig[side] = { value: input.value, dirty: p.dirty[side], dragPrice: p.dragPrice[side] };
    const pct = pctFrom(side, price, now);
    p.preview[side] = price;
    input.value = pct;
    renderPanel(p);
    if (validPct(side, pct)) setMsg(p, '');
    else setMsg(p, invalidMsg(side), 'red');
  }

  // a line was dropped: a field's line fills in that field, an alert's line moves that alert
  function onChartMoved(target, key, id, price) {
    const p = panelForChart(target, key);
    if (!p || !(price > 0)) return;
    const a = lineAlert(p, id);
    if (a) {
      if (!shared.status || !shared.status.linked) return;
      moveAlert(p, a, price);
      return;
    }
    const side = lineSide(id);
    if (!side) return;
    const orig = p.dragOrig[side];
    delete p.dragOrig[side];
    p.preview[side] = null;
    const now = nowPrice(coinOf(p));
    if (!(now > 0)) return;
    const pct = pctFrom(side, price, now);
    const input = inputOf(p, side);
    if (!validPct(side, pct)) {
      if (orig) {
        input.value = orig.value;
        p.dirty[side] = orig.dirty;
        p.dragPrice[side] = orig.dragPrice;
      }
      p.lastChart = ''; // makes the chart put the line back
      renderPanel(p);
      setMsg(p, invalidMsg(side), 'red');
      return;
    }
    input.value = pct;
    p.dirty[side] = true;
    p.dragPrice[side] = price;
    dbg('chart', `${SIDE[side].name} dragged to ${fmtPrice(price)} (${SIDE[side].sign}${pct}% from now)`);
    renderPanel(p);
    setMsg(p, `${SIDE[side].name} set to ${SIDE[side].sign}${pct}% from the chart. Click "Set alert" to save it.`);
  }

  // ---------- "FOMO Alerts" tab in Fomo's side panels: active alerts and the alerts that were sent ----------
  // Fomo has up to 4 side panels, each with a header of tabs [Alerts | Tokens | Leaderboard | Feed]. Every
  // panel gets a "FOMO Alerts" tab after the last one; it shows our list over that panel's content.
  const HISTORY_POLL_MS = 60000;
  const hist = {
    panes: new Set(), // one per Fomo panel: { root, header, row, btn, sep, view, open, tab, autoTab }
    items: [], // sent alerts, newest first
    active: [], // active alerts on every coin
    lastSeen: 0,
    status: null,
    loaded: false,
    saved: {}, // panel position -> 'active' / 'sent': panels showing our list, so it comes back after a reload
  };
  chrome.storage.local.get('faPanels', (d) => {
    hist.saved = d.faPanels && typeof d.faPanels === 'object' ? d.faPanels : {};
    for (const pane of hist.panes) restorePane(pane);
  });
  const savePanels = () => chrome.storage.local.set({ faPanels: hist.saved });
  function rememberPane(pane) {
    if (pane.open) hist.saved[pane.index] = pane.tab;
    else delete hist.saved[pane.index];
    savePanels();
  }
  // a panel was closed (by = -1) or split (by = +1, the new one comes right after it): later panels move
  function shiftPanels(from, by) {
    const next = {};
    for (const [k, v] of Object.entries(hist.saved)) {
      const i = Number(k);
      if (i < from || (i === from && by > 0)) next[i] = v;
      else if (i > from) next[i + by] = v;
    }
    hist.saved = next;
    savePanels();
  }
  function restorePane(pane) {
    const tab = hist.saved[pane.index];
    if (!tab || pane.open) return;
    pane.tab = tab === 'sent' ? 'sent' : 'active';
    openView(pane, true);
  }
  const SENT_LABEL = { tp: 'TP hit', sl: 'SL hit', dip: 'Buy the dip' };

  chrome.storage.local.get('historySeenAt', (d) => {
    hist.lastSeen = d.historySeenAt || 0;
    renderHistory();
  });

  // Fomo's panels: a rounded box whose header (rounded top) holds a scrolling row of tab buttons with thin
  // separators. Found by layout, not by the tab names, so other languages work too.
  function findFomoPanels() {
    const out = [];
    for (const row of document.querySelectorAll(rule().panelTabRow)) {
      if (row.closest('.fa-hist, .fa-panel')) continue;
      const tabs = [...row.children].filter((c) => c.tagName === 'BUTTON' && !c.classList.contains('fa-hist-btn'));
      const seps = [...row.children].filter((c) => c.tagName === 'DIV' && c.classList.contains(rule().panelSeparatorClass) && !c.classList.contains('fa-hist-sep'));
      if (tabs.length < 3 || !seps.length) continue;
      const header = row.closest(rule().panelHeader) || (row.parentElement && row.parentElement.parentElement);
      const root = header && header.parentElement;
      if (!root || !root.classList.contains(rule().panelRootClass) || !root.getClientRects().length) continue;
      // the first tab (Alerts) has a bell icon, or the header has Fomo's close-panel button
      if (!tabs[0].querySelector('svg') && !header.querySelector(rule().panelClose)) continue;
      out.push({ root, header, row, tabs, seps });
    }
    return out;
  }

  function newPane(f) {
    const pane = { root: f.root, header: f.header, row: f.row, open: false, tab: 'active', autoTab: false, view: null };
    pane.sep = document.createElement('div');
    pane.sep.className = f.seps[0].className + ' fa-hist-sep'; // same look as Fomo's separators
    pane.sep.setAttribute('aria-hidden', 'true');
    pane.btn = document.createElement('button');
    pane.btn.type = 'button';
    pane.btn.className = 'fa-hist-btn';
    pane.btn.title = 'Your FOMO Alerts: active and sent';
    pane.btn.append(icon(BELL_ICON, 'fa-tg'), span('FOMO Alerts', 'fa-hist-label'), span('', 'fa-hist-badge'));
    pane.btn.addEventListener('click', () => {
      pane.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (pane.open) closeView(pane);
      else openView(pane);
      rememberPane(pane);
    });
    f.root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.closest('.fa-hist-btn, .fa-hist')) return;
      if (pane.row.contains(b)) {
        // one of Fomo's own tabs: back to Fomo's content
        if (pane.open) {
          closeView(pane);
          rememberPane(pane);
        }
      } else if (pane.header.contains(b) && /close/i.test(b.getAttribute('aria-label') || '')) {
        shiftPanels(pane.index, -1); // the panel closes
      } else if (b.closest(rule().panelSplitMenu)) {
        shiftPanels(pane.index, +1); // Split bottom / Split right: a new panel comes after this one
      }
    }, true);
    pane.resize = new ResizeObserver(() => safe(() => fitTab(pane)));
    return pane;
  }

  // Fomo's tab row scrolls sideways without a scrollbar. Our tab always shows its full name (shrinking it to the
  // icon left nothing to scroll to); when it's opened it scrolls into view.
  function fitTab(pane) {
    pane.btn.classList.remove('fa-compact');
  }

  function ensureHistoryTabs() {
    const live = new Set();
    findFomoPanels().forEach((f, index) => {
      let pane = [...hist.panes].find((x) => x.root === f.root);
      const isNew = !pane;
      if (isNew) {
        pane = newPane(f);
        hist.panes.add(pane);
        dbg('card', `FOMO Alerts tab added to Fomo panel ${index + 1}`);
        if (!hist.loaded) refreshHistory();
      }
      pane.index = index;
      live.add(pane);
      pane.header = f.header;
      pane.row = f.row;
      // our tab sits after the last of Fomo's tabs (only moved when it isn't there, so this stays quiet)
      if (f.row.lastElementChild !== pane.btn || pane.btn.previousElementSibling !== pane.sep) {
        f.row.append(pane.sep, pane.btn);
        pane.resize.disconnect();
        pane.resize.observe(f.row);
        renderHistory();
      }
      fitTab(pane);
      if (isNew) restorePane(pane); // it showed our list before the reload / re-render
      if (pane.open) placeView(pane);
    });
    for (const pane of hist.panes) {
      if (live.has(pane)) continue;
      if (pane.view) pane.view.remove();
      pane.resize.disconnect();
      hist.panes.delete(pane);
    }
  }

  // Our list takes the place of the panel's content, right under its header. Fomo's content is hidden by
  // CSS while it's open; its Split bottom / Split right bar (last in the panel, on hover) stays.
  function placeView(pane) {
    if (!pane.view) pane.view = makeView(pane);
    if (pane.view.parentElement !== pane.root || pane.view.previousElementSibling !== pane.header) pane.header.after(pane.view);
    if (pane.root.dataset.faHist !== 'open') pane.root.dataset.faHist = 'open'; // also dims Fomo's own tabs
  }

  function makeView(pane) {
    const view = document.createElement('div');
    view.className = 'fa-hist';
    const head = document.createElement('div');
    head.className = 'fa-hist-head';
    const tabs = document.createElement('div');
    tabs.className = 'fa-hist-tabs';
    for (const [tab, text] of [['active', 'Active'], ['sent', 'Sent']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fa-hist-tab';
      b.dataset.tab = tab;
      b.append(span(text), span('', 'fa-hist-count'));
      b.addEventListener('click', () => {
        pane.tab = tab;
        pane.autoTab = false;
        rememberPane(pane);
        if (tab === 'sent') markHistorySeen();
        renderHistory();
      });
      tabs.append(b);
    }
    head.append(tabs);
    const body = document.createElement('div');
    body.className = 'fa-hist-list';
    // bins on active alerts
    body.addEventListener('click', (e) => {
      const bin = e.target.closest('.fa-bin');
      if (!bin) return;
      e.preventDefault();
      e.stopPropagation();
      removeAlert(bin.dataset.id, null);
    });
    view.append(head, body);
    return view;
  }

  function openView(pane, restoring) {
    pane.open = true;
    // new sent alerts first, else the tab you used last
    pane.autoTab = !restoring;
    if (!restoring && hist.items.some((h) => h.at > hist.lastSeen)) pane.tab = 'sent';
    placeView(pane);
    if (pane.tab === 'sent') markHistorySeen();
    renderHistory();
    refreshHistory();
  }

  function closeView(pane) {
    pane.open = false;
    if (pane.view) pane.view.remove();
    delete pane.root.dataset.faHist;
    renderHistory();
  }

  function markHistorySeen() {
    const newest = hist.items.length ? hist.items[0].at : 0;
    if (newest > hist.lastSeen) {
      hist.lastSeen = newest;
      chrome.storage.local.set({ historySeenAt: newest });
    }
  }

  async function refreshHistory() {
    hist.loaded = true;
    const [r, l] = await Promise.all([send({ type: 'history' }), send({ type: 'listAlerts' })]);
    hist.status = r.ok ? r.status : { error: r.error };
    if (r.ok) hist.items = r.history || [];
    if (l.ok) hist.active = (l.alerts || []).filter(isActive);
    sendCoinMeta();
    const unseen = hist.items.some((h) => h.at > hist.lastSeen);
    for (const pane of hist.panes) {
      if (pane.open && pane.autoTab && unseen) pane.tab = 'sent';
      pane.autoTab = false;
    }
    if ([...hist.panes].some((pane) => pane.open && pane.tab === 'sent')) markHistorySeen();
    renderHistory();
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  // a row in the list: coin logo, then the details; clicking it opens that coin
  function coinRow(x) {
    const a = document.createElement('a');
    a.className = 'fa-hist-item';
    try {
      a.href = x.fomoUrl ? new URL(x.fomoUrl).pathname : '#';
    } catch {
      a.href = '#';
    }
    const logo = document.createElement(x.image ? 'img' : 'span');
    logo.className = 'fa-hist-logo';
    if (x.image) logo.src = x.image;
    else logo.textContent = (x.symbol || '?').slice(0, 1);
    const main = document.createElement('div');
    main.className = 'fa-hist-main';
    a.append(logo, main);
    return { a, main };
  }

  const levelFormatter = (supply) => {
    const mcap = shared.settings.units === 'mcap' && supply > 0;
    return (v) => (mcap ? fmtMc(v * supply) : fmtPrice(v));
  };

  function historyItem(h) {
    const kind = h.kind || h.side;
    const { a, main } = coinRow(h);
    const top = document.createElement('div');
    top.className = 'fa-hist-top';
    const label = kind === 'sl' && h.trailing ? 'Trailing stop' : SENT_LABEL[kind] || kind;
    const time = span(ago(h.at), 'fa-hist-time');
    time.title = new Date(h.at).toLocaleString();
    top.append(span(h.symbol || 'token', 'fa-hist-sym'), span(label, 'fa-hist-tag ' + (SIDE[kind] ? SIDE[kind].cls : '')), time);
    const lvl = levelFormatter(h.supply);
    let detail = 'at ' + lvl(h.price);
    if (h.amount > 0) {
      const value = h.amount * h.price;
      const invested = h.invested > 0 ? h.invested : h.entryPrice > 0 ? h.amount * h.entryPrice : null;
      detail += ` · ≈ ${fmtUsd(value)}` + (invested ? ` (${fmtSigned(value - invested)})` : '');
    }
    main.append(top, span(detail, 'fa-hist-detail'));
    return a;
  }

  // an active alert: coin, level, where the price is now, what the position would be worth there
  function activeItem(x) {
    const { a, main } = coinRow(x);
    const live = shared.live.get(norm(x.tokenAddress));
    const now = live && Date.now() - live.at < LIVE_MAX_AGE_MS ? live.price : x.lastPrice || 0;
    const level = alertLevel(x, now);
    const lvl = levelFormatter(x.supply || supplyOf(shared.positions.get(norm(x.tokenAddress))));
    const top = document.createElement('div');
    top.className = 'fa-hist-top';
    const bin = document.createElement('button');
    bin.type = 'button';
    bin.className = 'fa-bin';
    bin.dataset.id = x.id;
    bin.title = 'Remove this alert';
    bin.innerHTML = TRASH_SVG;
    const off = isPaused(x);
    if (off) {
      a.classList.add('fa-off');
      a.title = PAUSED_NOTE;
    }
    top.append(span(x.symbol || 'token', 'fa-hist-sym'), span((off ? '⏸ ' : '') + alertLabel(x), 'fa-hist-tag ' + SIDE[x.kind].cls), bin);
    const lines = [span('→ ' + lvl(level), 'fa-hist-lvl')];
    const m = x.kind !== 'dip' && !off ? moneyAt(positionOfAlert(x), level) : null;
    if (m) {
      const money = span(' · ≈ ' + fmtUsd(m.value) + (m.pnl === null ? '' : ' '));
      if (m.pnl !== null) money.append(span('(' + fmtSigned(m.pnl) + ')', m.pnl >= 0 ? 'fa-green' : 'fa-red'));
      lines.push(money);
    }
    const detail = span('', 'fa-hist-detail');
    detail.append(...lines);
    const sub = [];
    if (off) sub.push('⏸ paused: you sold it. Back on when you hold it again');
    else if (x.priceStatus === 'unavailable') sub.push('⚠ no price source, cannot trigger');
    else if (now > 0) {
      const away = Math.abs(level / now - 1) * 100;
      sub.push(`now ${lvl(now)} · ${away < 0.05 ? 'at the level' : away.toFixed(1) + '% away'}`);
    }
    if (x.source === 'telegram') sub.push('set in Telegram');
    main.append(top, detail);
    if (sub.length) main.append(span(sub.join(' · '), 'fa-hist-sub' + (x.priceStatus === 'unavailable' ? ' fa-red' : '')));
    return a;
  }

  // only touches the page when something changed (page changes wake the card placement code)
  function renderHistory() {
    const unseen = hist.items.filter((h) => h.at > hist.lastSeen).length;
    for (const pane of hist.panes) {
      const badge = pane.btn.querySelector('.fa-hist-badge');
      const text = unseen ? String(unseen > 99 ? '99+' : unseen) : '';
      if (badge.textContent !== text) badge.textContent = text;
      if (pane.btn.classList.contains('fa-on') !== pane.open) pane.btn.classList.toggle('fa-on', pane.open);
      if (pane.open && pane.view) renderPane(pane, unseen);
    }
  }

  function renderPane(pane, unseen) {
    queueTexts();
    for (const b of pane.view.querySelectorAll('.fa-hist-tab')) {
      b.classList.toggle('fa-on', b.dataset.tab === pane.tab);
      const count = b.dataset.tab === 'active' ? (hist.active.length ? String(hist.active.length) : '') : unseen ? String(unseen) : '';
      const c = b.querySelector('.fa-hist-count');
      if (c.textContent !== count) c.textContent = count;
      c.classList.toggle('fa-new', b.dataset.tab === 'sent');
    }
    const body = pane.view.querySelector('.fa-hist-list');
    const data = pane.tab === 'active'
      ? hist.active.map((a) => [a.id, a.pct, a.price, a.peakPrice, a.lastPrice, a.priceStatus])
      : hist.items.map((h) => h.id);
    const key = JSON.stringify([pane.tab, hist.status, data, shared.settings.units, Math.floor(Date.now() / 60000)]);
    if (body.dataset.faKey === key && body.childNodes.length) return;
    body.dataset.faKey = key;
    body.textContent = '';
    const st = hist.status;
    const note = (text) => {
      const p = document.createElement('p');
      p.className = 'fa-hist-note';
      fillText(p, text);
      body.append(p);
    };
    if (!st) return note('Loading…');
    if (st.error) return note('Cannot reach the FOMO Alerts server: ' + st.error);
    if (!st.linked) return note('Link {tg} to get alerts: click your profile icon, then FOMO Alerts.');
    if (pane.tab === 'active') {
      if (!hist.active.length) return note('No active alerts. Set them under the Buy/Sell box on a coin page, or in {tg}.');
      // grouped per coin, highest level first
      const coins = new Map();
      for (const a of hist.active) {
        const k = norm(a.tokenAddress);
        if (!coins.has(k)) coins.set(k, []);
        coins.get(k).push(a);
      }
      for (const list of coins.values()) for (const a of sortAlerts(list)) body.append(activeItem(a));
      return;
    }
    if (!hist.items.length) return note('No alerts sent yet. They show up here once a take profit, stop loss or buy-the-dip alert fires.');
    for (const h of hist.items) body.append(historyItem(h));
  }

  every(() => {
    if (hist.panes.size && !document.hidden) refreshHistory();
  }, HISTORY_POLL_MS);

  // ---------- "FOMO Alerts" in Fomo's account menu: our settings (Telegram accounts, referral, access) ----------
  // Looks like Fomo's own Settings window: a centered title and plain rows, one icon each.
  const UPDATE_NOTE = 'A new version of FOMO Alerts is out. Update it to set new alerts (your alerts keep working). Chrome updates it by itself, usually within a few hours; refresh this page after.';
  const REF_LINK = 'https://fomo.family/r/ALERTSFAMILY'; // our Fomo referral link: joining with it = free access
  // X, Discord and website, as icon buttons at the bottom of the settings window
  const SOCIAL = [
    { url: 'https://x.com/ALERTS_FAMILY', title: 'X', svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>' },
    { url: 'https://discord.gg/jvjMrvdmy3', title: 'Discord', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 127.14 96.36"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69c-6.27 0-11.43-5.73-11.43-12.78s5.05-12.79 11.43-12.79 11.54 5.78 11.43 12.79-5.07 12.78-11.43 12.78Zm42.24 0c-6.27 0-11.43-5.73-11.43-12.78s5.05-12.79 11.43-12.79 11.54 5.78 11.43 12.79-5.06 12.78-11.43 12.78Z"/></svg>' },
    { url: 'https://fomoalerts.family', title: 'Website', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M9.99996 1.66675C12.0844 3.94871 13.2689 6.91011 13.3333 10.0001C13.2689 13.0901 12.0844 16.0515 9.99996 18.3334M9.99996 1.66675C7.91556 3.94871 6.731 6.91011 6.66663 10.0001C6.731 13.0901 7.91556 16.0515 9.99996 18.3334M9.99996 1.66675C5.39759 1.66675 1.66663 5.39771 1.66663 10.0001C1.66663 14.6025 5.39759 18.3334 9.99996 18.3334M9.99996 1.66675C14.6023 1.66675 18.3333 5.39771 18.3333 10.0001C18.3333 14.6025 14.6023 18.3334 9.99996 18.3334M2.08331 7.50008H17.9166M2.08329 12.5001H17.9166" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"></path></svg>' },
  ];
  const socialHtml = () => SOCIAL.map((s) => `<a class="fa-set-soc" href="${s.url}" target="_blank" rel="noopener noreferrer" title="${s.title}" aria-label="${s.title}">${s.svg}</a>`).join('');
  const sett = { item: null, overlay: null, status: null, msg: '', confirm: null, poll: 0, link: null };
  // unlocking with a one-time payment: the networks, the $10 to send from your Fomo wallet, the picked network
  const pay = { open: false, menu: false, data: null, net: null, msg: '', msgKind: '', busy: false, poll: 0 };
  const ROW_ICONS = {
    discord: '<svg viewBox="0 0 127.14 96.36"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69c-6.27 0-11.43-5.73-11.43-12.78s5.05-12.79 11.43-12.79 11.54 5.78 11.43 12.79-5.07 12.78-11.43 12.78Zm42.24 0c-6.27 0-11.43-5.73-11.43-12.78s5.05-12.79 11.43-12.79 11.54 5.78 11.43 12.79-5.06 12.78-11.43 12.78Z"/></svg>',
    // Fomo's own icons (profile, rewards, security) and a few simple line icons
    user: '<svg viewBox="0 0 20 20" fill="none"><path d="M6.67 5.42C6.67 3.58 8.17 2.08 10.01 2.08C11.85 2.08 13.34 3.58 13.34 5.42C13.34 7.26 11.85 8.75 10.01 8.75C8.17 8.75 6.67 7.26 6.67 5.42ZM11.67 10.42H8.33C4.95 10.42 3.75 12.89 3.75 15.02C3.75 16.91 4.76 17.92 6.67 17.92H13.33C15.24 17.92 16.25 16.91 16.25 15.02C16.25 12.89 15.05 10.42 11.67 10.42Z" fill="currentColor"/></svg>',
    gift: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3.58 11.25H9.38V17.25C9.38 17.39 9.26 17.5 9.12 17.5H5.83C4.17 17.5 3.33 16.67 3.33 15V11.5C3.33 11.36 3.45 11.25 3.58 11.25ZM16.42 11.25H10.63V17.25C10.63 17.39 10.74 17.5 10.88 17.5H14.17C15.83 17.5 16.67 16.67 16.67 15V11.5C16.67 11.36 16.56 11.25 16.42 11.25ZM17.5 7.08V9.75C17.5 9.89 17.39 10 17.25 10H10.63V7.08H9.38V10H2.75C2.61 10 2.5 9.89 2.5 9.75V7.08C2.5 6.39 3.06 5.83 3.75 5.83H4.64C4.37 5.32 4.27 4.7 4.51 4.04C4.75 3.37 5.28 2.82 5.96 2.61C6.89 2.32 7.85 2.62 8.43 3.34C8.46 3.37 9.4 4.62 10 5.42C10.6 4.62 11.54 3.37 11.56 3.34C12.15 2.62 13.1 2.32 14.03 2.61C14.68 2.8 15.21 3.32 15.46 3.95C15.74 4.65 15.64 5.3 15.36 5.83H16.25C16.94 5.83 17.5 6.39 17.5 7.08ZM8.75 5.83C8.18 5.08 7.5 4.18 7.46 4.12C7.27 3.89 6.98 3.75 6.67 3.75C6.09 3.75 5.63 4.22 5.63 4.79C5.63 5.37 6.09 5.83 6.67 5.83H8.75ZM14.38 4.79C14.38 4.22 13.91 3.75 13.33 3.75C13.02 3.75 12.73 3.89 12.53 4.13C12.49 4.18 11.81 5.09 11.25 5.83H13.33C13.91 5.83 14.38 5.37 14.38 4.79Z"/></svg>',
    shield: '<svg viewBox="0 0 40 40" fill="none"><path d="M20.03 3.33C16.3 5.18 13.33 6.67 5 8.33C5 10.23 5 16.17 5 18.15C5 29.26 14.45 34.81 20 36.67C25.56 34.81 35 29.26 35 18.15C35 16.11 35 10.32 35 8.33C26.67 6.67 23.7 5.18 20.03 3.33ZM21.25 20.5V25C21.25 25.69 20.69 26.25 20 26.25C19.31 26.25 18.75 25.69 18.75 25V20.47C18.02 20.03 17.52 19.24 17.52 18.33C17.52 16.95 18.64 15.83 20.02 15.83H20.03C21.42 15.83 22.53 16.95 22.53 18.33C22.53 19.27 22.01 20.08 21.25 20.5Z" fill="currentColor"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C10.41 2 8.88 2.63 7.76 3.76C6.63 4.88 6 6.41 6 8C6 11.09 5.22 13.21 4.35 14.61C3.62 15.79 3.25 16.38 3.26 16.54C3.28 16.72 3.31 16.79 3.46 16.9C3.59 17 4.19 17 5.39 17H18.61C19.81 17 20.41 17 20.54 16.9C20.69 16.79 20.72 16.72 20.74 16.54C20.75 16.38 20.38 15.79 19.65 14.61C18.78 13.21 18 11.09 18 8C18 6.41 17.37 4.88 16.24 3.76C15.12 2.63 13.59 2 12 2Z"/><path d="M9.35 21C10.06 21.62 10.99 22 12 22C13.01 22 13.94 21.62 14.65 21H9.35Z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" fill="none" class="fa-set-chev"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // one settings row: [icon] label (+ small second line) ... right side
  // the badge in front of your Fomo username: top 1, 2, 3 or 100 holder among FOMO Alerts users (status.holder),
  // else the check of a verified member (Discord connected)
  function badgeEl(st) {
    const rank = st && st.holder && st.holder.rank;
    const kind = rank >= 1 && rank <= 3 ? String(rank) : rank >= 1 && rank <= 100 ? '100' : st && st.discord ? 'user' : null;
    if (!kind) return null;
    const b = document.createElement('span');
    b.className = 'fa-badge fa-badge-' + kind;
    b.title = kind === 'user' ? 'Verified member' : `Top ${kind} holder`;
    return b;
  }

  function setRow(iconName, label, sub, right, asButton) {
    const row = document.createElement(asButton ? 'button' : 'div');
    if (asButton) row.type = 'button';
    row.className = 'fa-set-row' + (asButton ? ' fa-set-rowbtn' : '');
    const left = document.createElement('div');
    left.className = 'fa-set-left';
    const ic = document.createElement('span');
    ic.className = 'fa-set-ic';
    ic.innerHTML = ROW_ICONS[iconName]; // fixed icons from this file
    const text = document.createElement('div');
    text.className = 'fa-set-text';
    text.append(label instanceof Node ? label : span(label));
    if (sub) text.append(span(sub, 'fa-set-sub'));
    left.append(ic, text);
    row.append(left);
    if (right) row.append(right);
    return row;
  }

  // Fomo's account menu: a dropdown with a link to your profile and buttons (Manage account, Settings, …)
  function findAccountMenu() {
    for (const box of document.querySelectorAll(rule().accountMenu)) {
      if (!box.querySelector(rule().accountProfileLink)) continue;
      const buttons = [...box.children].filter((c) => c.tagName === 'BUTTON' && !c.classList.contains('fa-menu-item'));
      if (buttons.length < 2) continue;
      // Settings: by its sliders icon (three circles), else by name, else the second button
      const settings = buttons.find((b) => b.querySelectorAll('svg circle').length === 3) ||
        buttons.find((b) => new RegExp(RX.escape(rule().settingsWord), 'i').test(b.textContent)) || buttons[1];
      return { box, settings };
    }
    return null;
  }

  function ensureSettingsMenu() {
    queueTexts();
    const found = findAccountMenu();
    if (!found) return;
    if (sett.item && sett.item.isConnected && sett.item.previousElementSibling === found.settings) return;
    if (!sett.item) {
      sett.item = document.createElement('button');
      sett.item.type = 'button';
      const text = document.createElement('div');
      text.className = 'text-sm';
      text.textContent = 'FOMO Alerts';
      sett.item.append(icon(BELL_ICON, 'w-4 h-4 text-text-primary fa-tg'), text);
      sett.item.addEventListener('click', (e) => {
        // let Fomo close its menu, then open ours
        e.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        openSettings();
      });
    }
    sett.item.className = found.settings.className + ' fa-menu-item'; // same look as Fomo's menu items
    found.settings.after(sett.item);
  }

  // tell the server which Fomo account this is and who referred it (decides free access),
  // plus the profile picture and whether to show it in the hive on fomoalerts.family
  function sendProfile() {
    const u = shared.user;
    if (!u || !u.id) {
      // account not detected: the username typed in the popup still puts you in the hive
      if (shared.manualHandle) send({ type: 'profile', profile: { handle: shared.manualHandle, manual: true } });
      return;
    }
    const ref = u.referral || {};
    send({ type: 'profile', profile: { userId: u.id, handle: u.handle, referred: !!ref.referred, referralCode: ref.code, referrer: ref.by, avatar: u.avatar || null, wallets: u.wallets || null } })
      .then((r) => {
        if (r.ok && r.access && shared.status) shared.status = { ...shared.status, access: r.access };
        if (r.ok && r.access && sett.status) sett.status = { ...sett.status, access: r.access };
        renderSettings();
        renderAll();
      });
  }

  // another Fomo account was logged in, and the extension switched to this account's own session (background.js):
  // everything on screen belonged to the other one, so it's all loaded again
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'sessionChanged') return;
    shared.status = null;
    for (const p of panels) {
      p.alerts = [];
      loadPanel(p);
    }
    refreshHistory();
    if (sett.overlay && sett.overlay.isConnected) refreshSettings();
  });

  // withPay: straight to unlocking (the card's Unlock button)
  function openSettings(withPay) {
    if (!sett.overlay) {
      sett.overlay = document.createElement('div');
      sett.overlay.className = 'fa-set-overlay';
      sett.overlay.innerHTML = `
        <div class="fa-set-dlg" role="dialog" aria-modal="true" aria-label="FOMO Alerts settings" tabindex="-1">
          <div class="fa-set-title">FOMO Alerts</div>
          <div class="fa-set-body"></div>
          <div class="fa-set-socials">${socialHtml()}</div>
        </div>`;
      sett.overlay.addEventListener('click', (e) => {
        if (e.target === sett.overlay) return closeSettings(); // click outside, like Fomo's windows
        const rm = e.target.closest('.fa-set-rm');
        if (rm) return removeChat(rm.dataset.id);
        if (e.target.closest('.fa-set-add')) return addTelegram();
        if (e.target.closest('.fa-set-test')) return sendTest();
        if (e.target.closest('.fa-set-copy')) return copyRefLink();
        if (e.target.closest('.fa-set-dc')) return connectDiscord();
        if (e.target.closest('.fa-set-dc-rm')) return removeDiscord();
        if (e.target.closest('.fa-set-unlock')) return openPay();
        if (e.target.closest('.fa-link-back')) return stopLinking();
        if (e.target.closest('.fa-link-pc')) return void window.open(sett.link.url, '_blank', 'noopener');
        if (e.target.closest('.fa-pay-back')) {
          pay.open = false;
          pay.menu = false;
          clearInterval(pay.poll);
          pay.poll = 0;
          return renderSettings();
        }
        if (e.target.closest('.fa-pay-select')) {
          pay.menu = !pay.menu;
          return renderSettings();
        }
        const net = e.target.closest('.fa-pay-net');
        if (net) {
          pay.net = net.dataset.net;
          pay.menu = false;
          pay.msg = '';
          return renderSettings();
        }
        if (pay.menu && !e.target.closest('.fa-pay-menu')) {
          pay.menu = false;
          renderSettings();
        }
        const cp = e.target.closest('.fa-pay-copy');
        if (cp) return copyPay(cp.dataset.copy, cp.dataset.what);
        if (e.target.closest('.fa-pay-check')) return payCheck();
      });
      // keep Fomo's keyboard shortcuts out; Escape closes
      sett.overlay.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeSettings();
      });
    }
    sett.confirm = null;
    sett.msg = '';
    sett.link = null;
    pay.open = false;
    document.body.append(sett.overlay);
    sett.overlay.querySelector('.fa-set-dlg').focus();
    renderSettings();
    refreshSettings();
    sendProfile();
    if (withPay === true) openPay();
  }

  function closeSettings() {
    clearInterval(sett.poll);
    sett.poll = 0;
    sett.link = null;
    clearInterval(pay.poll);
    pay.poll = 0;
    pay.open = false;
    if (sett.overlay) sett.overlay.remove();
    for (const p of panels) loadPanel(p); // linked / unlinked may have changed
  }

  async function refreshSettings() {
    const r = await send({ type: 'status' });
    sett.status = r.ok ? r.status : { error: r.error, chats: [] };
    if (!sett.status.error) shared.status = sett.status;
    renderSettings();
    return sett.status;
  }

  function settMsg(text, kind) {
    if (kind === 'err') reportShown('settings', text);
    sett.msg = text;
    sett.msgKind = kind || '';
    renderSettings();
  }

  async function sendTest() {
    settMsg('Sending…');
    const r = await send({ type: 'test' });
    settMsg(r.ok ? `Test sent to ${r.sent || 1} Telegram account${r.sent > 1 ? 's' : ''}.` : r.error, r.ok ? 'ok' : 'err');
  }

  // "Connect Discord": Discord's login in a new tab; this window updates by itself once it's done
  async function connectDiscord() {
    const r = await send({ type: 'discordLink' });
    if (!r.ok) return settMsg(r.error, 'err');
    window.open(r.url, '_blank', 'noopener');
    settMsg('Log in with Discord in the new tab. This updates by itself.');
    clearInterval(sett.poll);
    let tries = 0;
    sett.poll = setInterval(async () => {
      const st = await refreshSettings();
      if (st && st.discord) {
        clearInterval(sett.poll);
        settMsg('Discord connected. Your roles are on their way.', 'ok');
      } else if (++tries > 60) {
        clearInterval(sett.poll);
        settMsg('Not connected yet. The login works for 15 minutes; press Connect Discord again to retry.');
      }
    }, 3000);
  }
  async function removeDiscord() {
    if (sett.confirm !== 'discord') {
      sett.confirm = 'discord';
      return renderSettings();
    }
    sett.confirm = null;
    const r = await send({ type: 'discordUnlink' });
    if (!r.ok) return settMsg(r.error, 'err');
    await refreshSettings();
    settMsg('Discord removed.', 'ok');
  }
  // your own invite link once you have one (see renderSettings), else Fomo's link with our code
  function copyRefLink() {
    const own = sett.status && sett.status.invite && sett.status.invite.url;
    const link = own || REF_LINK;
    navigator.clipboard.writeText(link).then(
      () => settMsg(own ? 'Invite link copied.' : 'Referral link copied.', 'ok'),
      () => settMsg(link)
    );
  }

  // ----- unlocking: one payment in USDC / USDG, found by the server within seconds -----
  function payMsg(text, kind) {
    if (kind === 'err') reportShown('pay screen', text);
    pay.msg = text;
    pay.msgKind = kind || '';
    renderSettings();
  }

  // the server's answer about the payment: unlocked → everything updates; else keep the amount
  function payResult(r) {
    if (!r.ok) return false;
    pay.data = r;
    if (r.access) {
      if (sett.status) sett.status = { ...sett.status, access: r.access };
      if (shared.status) shared.status = { ...shared.status, access: r.access };
    }
    if (r.access && r.access.allowed) {
      clearInterval(pay.poll);
      pay.poll = 0;
      pay.open = false;
      settMsg('Unlocked! FOMO Alerts is yours for good. Thank you!', 'ok');
      renderAll();
      return true;
    }
    return false;
  }

  async function openPay() {
    pay.open = true;
    pay.msg = '';
    renderSettings();
    const r = await send({ type: 'pay', start: true });
    if (!r.ok) return payMsg(r.error, 'err');
    if (payResult(r)) return;
    if (!pay.net && r.networks && r.networks.length) pay.net = r.networks[0].key;
    renderSettings();
    // while this is open the server listens closely; it unlocks by itself when the payment arrives
    clearInterval(pay.poll);
    pay.poll = setInterval(async () => {
      if (!sett.overlay || !sett.overlay.isConnected || !pay.open) return clearInterval(pay.poll);
      const p = await send({ type: 'pay' });
      payResult(p);
    }, 4000);
  }

  function copyPay(value, what) {
    navigator.clipboard.writeText(value).then(
      () => payMsg(`${what} copied.`, 'ok'),
      () => payMsg(value)
    );
  }

  async function payCheck() {
    if (pay.busy) return;
    pay.busy = true;
    payMsg('Looking on every network…');
    const r = await send({ type: 'payCheck' });
    pay.busy = false;
    if (!r.ok) return payMsg(r.error, 'err');
    if (!payResult(r)) payMsg('Not here yet. It unlocks by itself as soon as it arrives.');
  }

  const payIcon = (name, cls) => {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    if (extAlive()) img.src = chrome.runtime.getURL(`icons/pay/${name}.svg`);
    return img;
  };

  // Fomo's own icons: back arrow, chevron, copy
  const PAY_SVG = {
    back: '<svg viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M20 12C20 12.5523 19.5523 13 19 13L7.41421 13L12.7071 18.2929C13.0976 18.6834 13.0976 19.3166 12.7071 19.7071C12.3166 20.0976 11.6834 20.0976 11.2929 19.7071L4.29289 12.7071C3.90237 12.3166 3.90237 11.6834 4.29289 11.2929L11.2929 4.29289C11.6834 3.90237 12.3166 3.90237 12.7071 4.29289C13.0976 4.68342 13.0976 5.31658 12.7071 5.70711L7.41421 11L19 11C19.5523 11 20 11.4477 20 12Z" fill="currentColor"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    copy: '<svg viewBox="0 0 20 20" fill="none"><path d="M8.01676 4.58333C5.86676 4.58333 4.58333 5.86666 4.58333 8.01666V13.8958C4.58333 14.0417 4.45408 14.1642 4.30908 14.15C3.10742 14.03 2.5 13.3033 2.5 11.9833V4.68333C2.5 3.23333 3.23343 2.5 4.68343 2.5H11.9832C13.3032 2.5 14.03 3.10752 14.15 4.30918C14.165 4.45418 14.0425 4.58333 13.8967 4.58333H8.01676ZM15.3125 5.83333H14.1667H8.02083C6.5625 5.83333 5.83333 6.5625 5.83333 8.02083V14.1667V15.3125C5.83333 16.7708 6.5625 17.5 8.02083 17.5H15.3125C16.7708 17.5 17.5 16.7708 17.5 15.3125V8.02083C17.5 6.5625 16.7708 5.83333 15.3125 5.83333Z" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  // The address as a QR code in Fomo's style: light round dots, rounded corner squares, on the dark box.
  // (Built from vendor/qrcode.js, drawn with plain SVG shapes.)
  function qrSvg(text, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code of the address');
    if (typeof qrcode !== 'function') return svg;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 13;
    const cell = (size - 2 * margin) / count;
    const color = '#F7F7F7';
    const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= count - 7) || (r >= count - 7 && c < 7);
    // QR versions 2-6 (every address fits) have one small alignment square near the bottom right. Drawn as
    // loose dots, scanners often miss it (tested: under half of the codes scanned), so it's drawn solid too.
    const ac = count - 7;
    const hasAlign = count >= 25 && count <= 41;
    const align = (r, c) => hasAlign && Math.abs(r - ac) <= 2 && Math.abs(c - ac) <= 2;
    let d = '';
    const rad = cell * 0.46;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c) || finder(r, c) || align(r, c)) continue;
        const cx = margin + (c + 0.5) * cell;
        const cy = margin + (r + 0.5) * cell;
        d += `M${(cx - rad).toFixed(2)} ${cy.toFixed(2)}a${rad.toFixed(2)} ${rad.toFixed(2)} 0 1 0 ${(2 * rad).toFixed(2)} 0a${rad.toFixed(2)} ${rad.toFixed(2)} 0 1 0 ${(-2 * rad).toFixed(2)} 0`;
      }
    }
    const dots = document.createElementNS(ns, 'path');
    dots.setAttribute('d', d);
    dots.setAttribute('fill', color);
    svg.append(dots);
    for (const [r0, c0] of [[0, 0], [0, count - 7], [count - 7, 0]]) {
      const x = margin + c0 * cell;
      const y = margin + r0 * cell;
      const ring = document.createElementNS(ns, 'rect');
      ring.setAttribute('x', x + cell / 2);
      ring.setAttribute('y', y + cell / 2);
      ring.setAttribute('width', 6 * cell);
      ring.setAttribute('height', 6 * cell);
      ring.setAttribute('rx', 2 * cell);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', cell);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', x + 3.5 * cell);
      dot.setAttribute('cy', y + 3.5 * cell);
      dot.setAttribute('r', 1.5 * cell);
      dot.setAttribute('fill', color);
      svg.append(ring, dot);
    }
    if (hasAlign) {
      const x = margin + (ac - 2) * cell;
      const ring = document.createElementNS(ns, 'rect');
      ring.setAttribute('x', x + cell / 2);
      ring.setAttribute('y', x + cell / 2);
      ring.setAttribute('width', 4 * cell);
      ring.setAttribute('height', 4 * cell);
      ring.setAttribute('rx', 1.2 * cell);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', cell);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', x + 2.5 * cell);
      dot.setAttribute('cy', x + 2.5 * cell);
      dot.setAttribute('r', 0.5 * cell);
      dot.setAttribute('fill', color);
      svg.append(ring, dot);
    }
    return svg;
  }

  const shortAddr = (a) => (a && a.length > 14 ? a.slice(0, 4) + '…' + a.slice(-4) : a);

  // One version per network, all in the same grid cell: the cell is as big as the biggest one, so the window
  // keeps its size when you switch networks (only the picked one shows).
  function payStack(cls, nets, picked, make) {
    const wrap = document.createElement('div');
    wrap.className = 'fa-pay-stack ' + cls;
    for (const x of nets) {
      const el = make(x);
      if (x.key !== picked) {
        el.classList.add('fa-pay-hidden');
        el.setAttribute('aria-hidden', 'true');
        el.inert = true;
      }
      wrap.append(el);
    }
    return wrap;
  }

  // Same screen as Fomo's "Deposit with crypto": back arrow + title, the network picker, the address as a
  // QR code and a copy button. Always exactly $10, sent from your own Fomo wallet: the server sees who sent
  // it, so that's how it knows the payment is yours (other wallets don't unlock anything).
  function renderPay(body) {
    const d = pay.data;
    const box = document.createElement('div');
    box.className = 'fa-pay';
    const head = document.createElement('div');
    head.className = 'fa-pay-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'fa-pay-back';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = PAY_SVG.back; // fixed icon from this file
    const sp = document.createElement('div');
    sp.className = 'fa-pay-sp';
    head.append(back, span('Unlock with crypto', 'fa-pay-title'), sp);
    box.append(head);
    if (!d || !d.networks) {
      box.append(span(pay.msg || 'Loading…', 'fa-pay-text' + (pay.msgKind ? ' fa-set-' + pay.msgKind : '')));
      return body.append(box);
    }
    const n = d.networks.find((x) => x.key === pay.net) || d.networks[0];
    pay.net = n.key;

    // network picker (a dropdown like Fomo's)
    const pick = document.createElement('div');
    pick.className = 'fa-pay-pick';
    const sel = document.createElement('button');
    sel.type = 'button';
    sel.className = 'fa-pay-select';
    sel.setAttribute('role', 'combobox');
    sel.setAttribute('aria-expanded', pay.menu ? 'true' : 'false');
    sel.setAttribute('aria-label', 'Network');
    const selLeft = document.createElement('span');
    selLeft.className = 'fa-pay-selval';
    selLeft.append(payIcon(n.key, 'fa-pay-chain'), span(n.name));
    const chev = document.createElement('span');
    chev.className = 'fa-pay-chev';
    chev.innerHTML = PAY_SVG.chevron;
    sel.append(selLeft, chev);
    pick.append(sel);
    if (pay.menu) {
      const list = document.createElement('div');
      list.className = 'fa-pay-menu';
      list.setAttribute('role', 'listbox');
      for (const x of d.networks) {
        const o = document.createElement('button');
        o.type = 'button';
        o.className = 'fa-pay-net fa-pay-opt' + (x.key === n.key ? ' fa-pay-on' : '');
        o.dataset.net = x.key;
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', x.key === n.key ? 'true' : 'false');
        const tick = document.createElement('span');
        tick.className = 'fa-pay-tick';
        if (x.key === n.key) tick.innerHTML = PAY_SVG.check;
        o.append(payIcon(x.key, 'fa-pay-chain'), span(x.name), span(x.token, 'fa-pay-optok'), tick);
        list.append(o);
      }
      pick.append(list);
    }
    box.append(pick);

    // what to send, and from where
    const inv = d.invoice;
    const amount = (inv && inv.amount) || d.price || '10';
    const fromOf = (x) => (d.from ? (x.key === 'solana' ? d.from.solana : d.from.evm) : null);
    box.append(payStack('fa-pay-texts', d.networks, n.key, (x) => {
      const from = fromOf(x);
      const t = document.createElement('div');
      t.className = 'fa-pay-textset';
      const l1 = document.createElement('div');
      l1.className = 'fa-pay-text';
      l1.append(`Send exactly ${amount} `, payIcon(x.token.toLowerCase(), 'fa-pay-tokin'), ` ${x.token} on the ${x.name} network to this address.`);
      const l2 = span(
        from
          ? `Send it from your Fomo wallet (${shortAddr(from)}). Only payments from this wallet unlock FOMO Alerts.`
          : 'Send it from your Fomo wallet. Only payments from it unlock FOMO Alerts.',
        'fa-pay-text'
      );
      if (from) l2.title = from;
      t.append(l1, l2);
      return t;
    }));

    // QR code of the address
    const qrBox = document.createElement('div');
    qrBox.className = 'fa-pay-qr';
    qrBox.append(qrSvg(n.address, 200));
    box.append(qrBox);

    // address and amount, each a copy button
    const copyBtn = (cls, content, value, what) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fa-pay-copy ' + cls;
      b.dataset.copy = value;
      b.dataset.what = what;
      b.title = 'Copy ' + what.toLowerCase();
      const ic = document.createElement('span');
      ic.className = 'fa-pay-copyic';
      ic.innerHTML = PAY_SVG.copy;
      b.append(...content, ic);
      return b;
    };
    box.append(payStack('fa-pay-addrs', d.networks, n.key, (x) => copyBtn('fa-pay-addrbtn', [span(x.address, 'fa-pay-addr')], x.address, 'Address')));
    box.append(payStack('fa-pay-amts', d.networks, n.key, (x) => copyBtn('fa-pay-amtbtn', [payIcon(x.token.toLowerCase(), 'fa-pay-tokin'), span(`${amount} ${x.token}`)], amount, 'Amount')));

    // one status line that always takes the same room: waiting, or the latest message
    box.append(span(
      pay.msg || '⏳ Waiting for your payment. It unlocks by itself within seconds after it arrives.',
      'fa-pay-status ' + (pay.msg ? 'fa-pay-msg' + (pay.msgKind ? ' fa-set-' + pay.msgKind : '') : 'fa-pay-wait')
    ));
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'fa-pay-check';
    check.textContent = pay.busy ? 'Checking…' : 'I paid, check now';
    box.append(check);
    body.append(box);
  }

  // Add (or switch to) a Telegram account. Most people have Telegram on their phone, not on this computer: a QR code
  // of the bot's link (the phone's camera opens Telegram there; press START), and a button to open it on this PC.
  // It updates by itself as soon as the account is added (the link works for 15 minutes).
  async function addTelegram() {
    const r = await send({ type: 'link' });
    if (!r.ok) return settMsg(r.error, 'err');
    sett.link = { url: r.url };
    sett.msg = '';
    renderSettings();
    const before = ((sett.status && sett.status.chats) || []).map((c) => c.id).join();
    clearInterval(sett.poll);
    let tries = 0;
    sett.poll = setInterval(async () => {
      const st = await refreshSettings();
      const now = (st.chats || []).map((c) => c.id).join();
      if (now !== before) {
        stopLinking();
        settMsg('Telegram account added.', 'ok');
        for (const p of panels) loadPanel(p);
      } else if (++tries > 300) {
        stopLinking();
        settMsg('No new Telegram account yet. The link works for 15 minutes; add again to retry.');
      }
    }, 3000);
  }
  function stopLinking() {
    clearInterval(sett.poll);
    sett.poll = 0;
    sett.link = null;
    renderSettings();
  }
  function renderLink(body) {
    const box = document.createElement('div');
    box.className = 'fa-pay fa-link';
    const head = document.createElement('div');
    head.className = 'fa-pay-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'fa-pay-back fa-link-back';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = PAY_SVG.back; // fixed icon from this file
    const sp = document.createElement('div');
    sp.className = 'fa-pay-sp';
    head.append(back, span('Link Telegram', 'fa-pay-title'), sp);
    box.append(head);
    box.append(span("Scan this with your phone's camera. Telegram opens there: press START and you're linked.", 'fa-pay-text'));
    const qr = document.createElement('div');
    qr.className = 'fa-pay-qr';
    qr.append(qrSvg(sett.link.url, 200));
    box.append(qr);
    const pc = document.createElement('button');
    pc.type = 'button';
    pc.className = 'fa-pay-check fa-link-pc';
    pc.textContent = 'Open Telegram on this PC';
    box.append(pc);
    body.append(box);
  }

  async function removeChat(id) {
    // first click asks, second click removes
    if (sett.confirm !== id) {
      sett.confirm = id;
      return renderSettings();
    }
    sett.confirm = null;
    const r = await send({ type: 'removeChat', chatId: id });
    if (!r.ok) return settMsg(r.error, 'err');
    await refreshSettings();
    settMsg(r.chats && r.chats.length ? 'Telegram account removed.' : 'Telegram account removed. Add one to get alerts again.', 'ok');
    for (const p of panels) loadPanel(p);
  }

  function renderSettings() {
    queueTexts();
    if (!sett.overlay || !sett.overlay.isConnected) return;
    const st = sett.status;
    const body = sett.overlay.querySelector('.fa-set-body');
    body.textContent = '';
    // Until a Telegram account is linked, the window shows nothing about the Fomo account (username, referral,
    // paid or not) and only Link Telegram works: alerts, payment and access belong to the Telegram account
    // (see offerJoin in server.js), so a new browser shows them once it's linked.
    const linked = !!(st && st.chats && st.chats.length);
    const paying = !!(linked && pay.open && !(st && st.access && st.access.allowed));
    sett.overlay.querySelector('.fa-set-dlg').classList.toggle('fa-set-paying', paying || !!sett.link);
    if (sett.link) return renderLink(body);
    if (paying) return renderPay(body);
    const label = (text) => body.append(span(text, 'fa-set-label'));

    // Telegram accounts
    label('Telegram accounts');
    if (!st) body.append(span('Loading…', 'fa-set-note'));
    else if (st.error) {
      reportShown('settings', 'Cannot reach the FOMO Alerts server: ' + st.error);
      body.append(span('Cannot reach the FOMO Alerts server: ' + st.error, 'fa-set-note fa-set-err'));
    }
    else if (!st.chats || !st.chats.length) body.append(span('No Telegram account linked yet, so no alerts are sent.', 'fa-set-note'));
    else {
      for (const c of st.chats) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'fa-set-pill fa-set-rm' + (sett.confirm === c.id ? ' fa-set-sure' : '');
        rm.dataset.id = c.id;
        rm.textContent = sett.confirm === c.id ? 'Remove?' : 'Remove';
        rm.title = 'Stop sending alerts to this Telegram account';
        body.append(setRow('user', c.name || 'Telegram account', c.at ? 'Linked ' + new Date(c.at).toLocaleDateString() : null, rm));
      }
    }
    const add = setRow('plus', linked ? 'Add another Telegram account' : 'Link Telegram', linked ? 'Alerts go to every account here' : null, null, true);
    add.classList.add('fa-set-add');
    add.insertAdjacentHTML('beforeend', ROW_ICONS.chevron);
    body.append(add);
    if (linked) {
      const test = setRow('bell', 'Send test message', null, null, true);
      test.classList.add('fa-set-test');
      test.insertAdjacentHTML('beforeend', ROW_ICONS.chevron);
      body.append(test);
    }
    if (sett.msg) body.append(span(sett.msg, 'fa-set-note fa-set-msg' + (sett.msgKind ? ' fa-set-' + sett.msgKind : '')));
    if (st && st.update && st.update.required) body.append(span(UPDATE_NOTE, 'fa-set-note fa-set-err'));

    if (!linked) {
      if (st && !st.error) body.append(span('Link Telegram first. Your account, access and alerts show up here once it is linked.', 'fa-set-note'));
      const off = document.createElement('div');
      off.className = 'fa-set-off';
      off.setAttribute('aria-disabled', 'true');
      off.append(span('Fomo account', 'fa-set-label'));
      off.append(setRow('user', 'Account', null, span('—', 'fa-set-val')));
      off.append(setRow('gift', 'Referred by', null, span('—', 'fa-set-val')));
      off.append(setRow('shield', 'Access', null, span('—', 'fa-set-val')));
      off.append(setRow('link', 'Referral link', null, span('—', 'fa-set-val')));
      body.append(off);
      return;
    }

    // Discord: verify in our server (roles, all channels)
    label('Discord');
    if (st.discord) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'fa-set-pill fa-set-dc-rm' + (sett.confirm === 'discord' ? ' fa-set-sure' : '');
      rm.textContent = sett.confirm === 'discord' ? 'Remove?' : 'Remove';
      body.append(setRow('discord', st.discord.username || 'Discord account', 'Verified in the FOMO Alerts Discord', rm));
    } else if (st.discordAvailable) {
      const dc = setRow('discord', 'Connect Discord', 'Join our Discord and get your roles', null, true);
      dc.classList.add('fa-set-dc');
      dc.insertAdjacentHTML('beforeend', ROW_ICONS.chevron);
      body.append(dc);
    } else body.append(setRow('discord', 'Connect Discord', 'Coming soon', null));

    // Fomo account, who referred it, and access
    label('Fomo account');
    const u = shared.user;
    const handle = (u && u.handle) || shared.manualHandle;
    const who = span(handle ? '@' + handle : 'not detected', 'fa-set-val');
    const badge = handle && badgeEl(st);
    if (badge) who.prepend(badge);
    body.append(setRow('user', 'Account', null, who));
    const ref = u && u.referral;
    const refText = !ref ? 'refresh the page' : ref.referred && (ref.code || ref.by)
      ? [ref.by ? '@' + ref.by : '', ref.code || ''].filter(Boolean).join(' · ')
      : ref.referred ? 'yes' : 'nobody';
    body.append(setRow('gift', 'Referred by', 'Set at sign-up, nobody can change it', span(refText, 'fa-set-val')));
    const acc = st && st.access;
    const free = acc && (acc.reason === 'referral' || acc.reason === 'free');
    const price = (acc && acc.price) || '10';
    const accText = !acc ? '…' : free ? 'Free ✓' : acc.reason === 'paid' ? 'Unlocked ✓' : acc.allowed ? 'Free for now' : acc.reason === 'referral_waiting' ? 'Checking…' : 'Locked';
    const accSub = !acc ? null : acc.reason === 'free' ? 'Given free by FOMO Alerts'
      : acc.reason === 'referral' ? `Fomo confirmed you joined with code ${acc.code}`
      : acc.reason === 'paid' && acc.paid ? `Paid ${acc.paid.amount} ${acc.paid.token} on ${acc.paid.name}`
      : acc.allowed ? `Stays free for everyone who joins Fomo with referral code ${acc.code}`
      : acc.reason === 'referral_waiting' ? `You joined with code ${acc.code}: we're confirming it with Fomo, you get a Telegram message when it's done. Or unlock now for $${price}.`
      : acc.reason === 'referral_taken' ? 'Your Fomo account already uses FOMO Alerts on another Telegram account: add this one from there (Add another Telegram account).'
      : `One payment of $${price}, or free with Fomo referral code ${acc.code}`;
    let accRight = span(accText, 'fa-set-val' + (free || (acc && acc.reason === 'paid') ? ' fa-set-ok' : ''));
    if (acc && !acc.allowed && !pay.open) {
      accRight = span(`Unlock $${price}`, 'fa-set-pill fa-set-on fa-set-unlock');
      accRight.setAttribute('role', 'button');
    }
    body.append(setRow('shield', 'Access', accSub, accRight));
    // once you have your own invite link it takes the place of the plain referral link, so nobody shares the wrong
    // one by mistake: it signs people up with our code too, and counts them as your invites (airdrops)
    const own = st.invite && st.invite.url;
    const friends = own ? st.invite.counted : 0;
    const copy = own
      ? setRow('link', 'Your invite link', `${own.replace('https://', '')} · ${friends} ${friends === 1 ? 'friend' : 'friends'}`, null, true)
      : setRow('link', 'Referral link', REF_LINK.replace('https://', ''), null, true);
    copy.classList.add('fa-set-copy');
    copy.title = own
      ? 'Copy your invite link: new Fomo accounts that sign up with it use FOMO Alerts for free and count as your invites'
      : 'Copy the link: people who join Fomo with it use FOMO Alerts for free';
    copy.append(span('Copy', 'fa-set-pill'));
    body.append(copy);
  }

  // ---------- placing the cards ----------
  function cardAt(where) {
    if (debug.cardWhere === where) return;
    debug.cardWhere = where;
    dbg('card', where);
  }

  function destroyPanel(p) {
    p.el.remove();
    panels.delete(p);
    // a popup card says which popup closed, so it can't switch off the lines of a newer popup
    if (p.kind === 'page') postChart({ target: 'main', enabled: false });
    else if (p.chartKey) postChart({ target: 'popup', key: p.chartKey, closed: true });
  }

  function ensurePagePanel() {
    const tok = currentToken();
    if (!tok) {
      if (pagePanel) destroyPanel(pagePanel);
      pagePanel = null;
      cardAt('not a coin page, no card');
      return;
    }
    if (!pagePanel || pagePanel.tok.key !== tok.key) {
      dbg('card', `Coin page: ${tok.key}`);
      if (pagePanel) destroyPanel(pagePanel);
      pagePanel = createPanel('page', tok);
      pagePanel.card = null;
      pagePanel.missingSince = 0;
      loadPanel(pagePanel);
    }
    const p = pagePanel;
    // still sitting under the Buy/Sell box: nothing to do
    if (p.card && p.card.isConnected && p.el.isConnected && p.el.previousElementSibling === p.card) return;

    const card = findTradeCard();
    if (card) {
      p.card = card;
      p.missingSince = 0;
      p.el.classList.remove('fa-floating', 'fa-collapsed');
      card.after(p.el);
      cardAt('Placed under the Buy/Sell box');
      renderPanel(p);
      return;
    }
    if (p.el.isConnected && p.el.classList.contains('fa-floating')) return;
    if (!p.missingSince) {
      p.missingSince = Date.now();
      cardAt('Waiting for the Buy/Sell box…');
      setTimeout(() => safe(ensure), FLOAT_AFTER_MS + 50);
      return;
    }
    if (Date.now() - p.missingSince < FLOAT_AFTER_MS) return;
    console.info("[FOMO Alerts] Fomo's Buy/Sell box was not found, showing the alerts card in the corner instead.");
    p.el.classList.add('fa-floating');
    document.body.append(p.el);
    cardAt('Buy/Sell box not found, card shown in the bottom-right corner');
    renderPanel(p);
  }

  function ensureModalPanels() {
    const live = new Set();
    for (const f of findPositionDialogs()) {
      const myHandle = (shared.user && shared.user.handle) || shared.manualHandle;
      if (f.owner && myHandle && !sameHandle(f.owner, myHandle)) {
        if (!skippedDialogs.has(f.dlg)) {
          skippedDialogs.add(f.dlg);
          dbg('card', `Position popup of @${f.owner} (not you): no alerts card`);
        }
        continue;
      }
      live.add(f.dlg);
      let p = modalPanels.get(f.dlg);
      if (p && p.tok.key !== f.tok.key) {
        destroyPanel(p);
        p = null;
      }
      if (!p) {
        p = createPanel('modal', f.tok);
        p.chartKey = 'p' + ++popupSeq;
        p.el.classList.toggle('fa-in-trade', !!f.trade);
        modalPanels.set(f.dlg, p);
        dbg('card', `${f.trade ? 'Trade' : 'Position'} popup for ${f.tok.key}: card added`);
        loadPanel(p);
      }
      // lets the chart bridge find this popup's chart
      if (f.dlg.getAttribute('data-fa-popup') !== p.chartKey) f.dlg.setAttribute('data-fa-popup', p.chartKey);
      if (!p.el.isConnected || p.el.previousElementSibling !== f.anchor) {
        f.anchor.after(p.el);
        renderPanel(p);
      }
    }
    for (const [dlg, p] of modalPanels) {
      if (live.has(dlg)) continue;
      destroyPanel(p);
      modalPanels.delete(dlg);
      debug.popupCharts.delete(p.chartKey);
    }
  }

  function ensure() {
    ensurePagePanel();
    ensureModalPanels();
    ensureHistoryTabs();
    ensureSettingsMenu();
    ensureChainFilter();
  }

  // ---------- chain filter, next to Fomo's search bar ----------
  // A logo per chain Fomo trades, green = shown. Switching one off (grey) hides that chain's coins in the search
  // results (also Recents), with a style rule, so they never show. (Not in Fomo's other lists: those keep a place
  // for every coin, so hiding one leaves a gap.) Saved in this browser.
  const FILTER_CHAINS = { solana: 'Solana', bnb: 'BNB Chain', ethereum: 'Ethereum', base: 'Base', monad: 'Monad', robinhood: 'Robinhood Chain', arc: 'Arc' };
  const chainsOff = new Set();
  let cfBar = null;
  chrome.storage.local.get('chainFilter', (d) => setChainsOff(d.chainFilter));
  function setChainsOff(list) {
    chainsOff.clear();
    for (const c of Array.isArray(list) ? list : []) if (FILTER_CHAINS[c]) chainsOff.add(c);
    applyChainFilter();
  }
  // every way Fomo writes a hidden chain in a coin link (bnb and bsc, ethereum and eth: rule chains)
  function slugsOff() {
    const chains = rule().chains;
    const ids = new Set([...chainsOff].map((c) => chains[c]).filter(Boolean));
    return Object.keys(chains).filter((k) => ids.has(chains[k]));
  }
  function applyChainFilter() {
    let st = document.getElementById('fa-cf-css');
    if (!st) {
      st = document.createElement('style');
      st.id = 'fa-cf-css';
      (document.head || document.documentElement).append(st);
    }
    const r = rule();
    const off = slugsOff();
    st.textContent = off.length ? `:is(${r.searchResult}):is(${off.map((c) => `[href^="${r.coinPath}${c}/"]`).join(', ')}) { display: none !important; }` : '';
    if (cfBar) paintBar();
  }
  function paintBar() {
    for (const b of cfBar.children) {
      const off = chainsOff.has(b.dataset.chain);
      b.classList.toggle('fa-cf-off', off);
      b.setAttribute('aria-pressed', String(!off));
      b.title = `${FILTER_CHAINS[b.dataset.chain]} coins: ${off ? 'hidden' : 'shown'} in search. Click to ${off ? 'show' : 'hide'} them.`;
    }
  }
  function buildBar() {
    const bar = document.createElement('div');
    bar.className = 'fa-cf';
    for (const c of Object.keys(FILTER_CHAINS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fa-cf-chain';
      b.dataset.chain = c;
      b.setAttribute('aria-label', FILTER_CHAINS[c]);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (chainsOff.has(c)) chainsOff.delete(c);
        else chainsOff.add(c);
        applyChainFilter();
        if (extAlive()) chrome.storage.local.set({ chainFilter: [...chainsOff] });
      });
      bar.append(b);
      // Fomo's chain logo (our copy), its mark drawn in the button's color
      if (extAlive()) {
        fetch(chrome.runtime.getURL(`icons/pay/${c}.svg`)).then((res) => res.text()).then((txt) => {
          const svg = new DOMParser().parseFromString(txt.replace(/#9899A3/gi, 'currentColor'), 'image/svg+xml').documentElement;
          if (svg.nodeName !== 'svg') return;
          svg.removeAttribute('class');
          svg.setAttribute('width', '22');
          svg.setAttribute('height', '22');
          b.replaceChildren(document.importNode(svg, true));
        }).catch(() => {});
      }
    }
    return bar;
  }
  function ensureChainFilter() {
    const r = rule();
    const input = document.querySelector(r.searchInput);
    const box = input && input.closest(r.searchBox);
    const wrap = box && box.parentElement;
    if (!wrap || !wrap.parentElement) return;
    if (!cfBar) {
      cfBar = buildBar();
      paintBar();
    }
    if (cfBar.previousElementSibling !== wrap) wrap.after(cfBar);
  }
  // ---------- keep the cards in place (Fomo is a single-page app) ----------
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      safe(ensure);
    }, 250);
  };
  const start = () => {
    dbg('extension', 'Page loaded, looking for the Buy/Sell box');
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    safe(ensure);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.postMessage({ source: 'fomo-alerts-content', type: 'ping' }, location.origin); // page hook answers "hello"

  // send every card's lines again now and then, so the chart side can never stay out of step
  every(() => {
    for (const p of panels) if (p.lastChart) postChart(JSON.parse(p.lastChart));
  }, 4000);

  // refresh link status / alerts when coming back to the tab, and now and then so alerts that fired
  // (or were changed in Telegram) update by themselves
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !extAlive()) return;
    for (const p of panels) loadPanel(p);
  });
  every(() => {
    if (!document.hidden) for (const p of panels) loadPanel(p);
  }, 30000);
})();

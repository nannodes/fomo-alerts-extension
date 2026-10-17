// Service worker: the only part that talks to your FOMO Alerts server.
// The server URL lives in config.js. What's stored: the random client id the server gave this browser for the Fomo
// account that's logged in, and the ids of other Fomo accounts used in this browser (see "one id per Fomo account").
importScripts('config.js');

const norm = (a) => (a && a.startsWith('0x') ? a.toLowerCase() : a);

async function getConfig() {
  const { clientId, clientServer } = await chrome.storage.local.get(['clientId', 'clientServer']);
  // A client id only works on the server that issued it. Exception: the data of the local test server was
  // moved to the VPS, so an id from localhost is tried there too (an unknown id just registers a new one).
  if (clientId && clientServer !== SERVER_URL && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(clientServer || '')) {
    await chrome.storage.local.set({ clientServer: SERVER_URL });
    return { serverUrl: SERVER_URL, clientId };
  }
  return { serverUrl: SERVER_URL, clientId: clientServer === SERVER_URL ? clientId : null };
}

function logServer() {} // the Debug page that showed these is gone: nothing is logged

// ---------- updates ----------
// The server only lets the newest version set new alerts. When it says this one is too old, ask Chrome to look
// for the update now (at most every 10 minutes) instead of waiting hours; once it's downloaded, reload into it.
let updateAskedAt = 0;
function askForUpdate() {
  if (Date.now() - updateAskedAt < 10 * 60_000 || !chrome.runtime.requestUpdateCheck) return;
  updateAskedAt = Date.now();
  chrome.runtime.requestUpdateCheck().catch(() => {});
}
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

// ---------- automatic error reports ----------
// Errors people run into are sent to our server in the background (POST /api/errors), so bugs get found without
// anyone having to report them: failed server requests, error messages shown on fomo.family, crashes in the
// extension. A report says what went wrong and where, with the extension and Chrome version and the page path
// (e.g. /tokens/solana/<coin>). Nothing about the account. The same error is sent at most every 5 minutes
// (repeats in between are counted), and a batch goes out a few seconds after the first one.
const REPORT_EVERY_MS = 5 * 60_000;
const reports = { pending: new Map(), sentAt: new Map(), timer: 0 };
const chromeVersion = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || null;
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
function report(r, path) {
  const msg = cut(r && r.msg, 500);
  if (!msg) return;
  const item = { kind: cut(r.kind || 'error', 40), where: cut(r.where || '', 100), msg, stack: cut(r.stack, 3000), path: cut(path, 200), count: 1, at: Date.now() };
  const sig = item.kind + '|' + item.where + '|' + item.msg;
  const p = reports.pending.get(sig);
  if (p) p.count++;
  else reports.pending.set(sig, item);
  if (!reports.timer) reports.timer = setTimeout(flushReports, 4000);
}
async function flushReports() {
  reports.timer = 0;
  const batch = [];
  for (const [sig, item] of reports.pending) {
    if (Date.now() - (reports.sentAt.get(sig) || 0) < REPORT_EVERY_MS) continue;
    batch.push(item);
    reports.pending.delete(sig);
    reports.sentAt.set(sig, Date.now());
    if (batch.length >= 20) break;
  }
  if (batch.length) {
    const { clientId } = await getConfig().catch(() => ({}));
    await fetch(SERVER_URL + '/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(clientId ? { 'X-Client-Id': clientId } : {}) },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version, chrome: chromeVersion, reports: batch }),
    }).catch(() => {
      // server not reachable: try again later (these count as new again)
      for (const item of batch) {
        reports.sentAt.delete(item.kind + '|' + item.where + '|' + item.msg);
        if (!reports.pending.has(item.kind + '|' + item.where + '|' + item.msg)) reports.pending.set(item.kind + '|' + item.where + '|' + item.msg, item);
      }
    });
  }
  if (reports.pending.size) reports.timer = setTimeout(flushReports, 60_000);
}
// errors in this service worker itself
self.addEventListener('error', (e) => report({ kind: 'crash', where: 'background', msg: e.message, stack: e.error && e.error.stack }));
self.addEventListener('unhandledrejection', (e) => report({ kind: 'crash', where: 'background (async)', msg: (e.reason && e.reason.message) || String(e.reason), stack: e.reason && e.reason.stack }));
// /api/alerts/abc123… -> /api/alerts/:id, so the same failing request groups together
const routeOf = (path) => String(path).split('?')[0].replace(/\/[A-Za-z0-9_-]{12,}|\/-?\d+/g, '/:id');

async function rawApi(path, { method = 'GET', body, asClient } = {}) {
  const config = await getConfig();
  const serverUrl = config.serverUrl;
  const clientId = asClient || config.clientId;
  const started = Date.now();
  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(clientId ? { 'X-Client-Id': clientId } : {}),
        // new alerts need the newest version (the server says update_required otherwise)
        'X-Ext-Version': chrome.runtime.getManifest().version,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    logServer(`${method} ${serverUrl}${path} → cannot reach server (${e.message})`);
    report({ kind: 'network', where: `${method} ${routeOf(path)}`, msg: 'Cannot reach the server: ' + e.message });
    throw new Error('Cannot reach the server. Is it running, and is the URL right?');
  }
  const data = await res.json().catch(() => ({}));
  logServer(`${method} ${path} → ${res.status} (${Date.now() - started} ms)${res.ok ? '' : ': ' + (data.error || '')}`);
  // every failed request except an unknown browser id and another account's id (both handled by themselves)
  if (!res.ok && data.code !== 'unknown_client' && data.code !== 'account_changed') report({ kind: 'api', where: `${method} ${routeOf(path)} → ${res.status}`, msg: data.error || `Server error (${res.status})` });
  if (data.code === 'update_required' || (data.update && data.update.required)) askForUpdate();
  if (!res.ok) {
    const err = new Error(data.error || `Server error (${res.status})`);
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

let registering = null; // popup and coin page can ask at the same time: register only once
async function ensureClient() {
  const { clientId } = await getConfig();
  if (clientId) return clientId;
  if (!registering) {
    registering = rawApi('/api/register', { method: 'POST' })
      .then(async ({ clientId: id }) => {
        await chrome.storage.local.set({ clientId: id, clientServer: SERVER_URL });
        return id;
      })
      .finally(() => (registering = null));
  }
  return registering;
}

async function api(path, opts) {
  await ensureClient();
  try {
    return await rawApi(path, opts);
  } catch (e) {
    if (e.code === 'unknown_client') {
      // Server lost its data or was replaced: register again.
      await chrome.storage.local.remove(['clientId', 'clientServer']);
      await ensureClient();
      return rawApi(path, opts);
    }
    throw e;
  }
}

// ---------- one browser id per Fomo account ----------
// The server keeps Telegram, alerts, the unlock and Discord per browser id. Logging in to another Fomo account on
// fomo.family must not carry any of that over, so there's an id per Fomo account (accounts: {Fomo user id: id}).
// When the server says the current id belongs to another account (account_changed), that id is kept for that
// account and this one gets its own: the one it had before in this browser, or a new one. A new one starts logged
// out; if that Fomo account has Telegram elsewhere, the server asks there "Was this you?" before linking it.
// Open fomo.family tabs are told, so they show the right account's alerts.
let profileQueue = Promise.resolve();
function sendProfile(profile) {
  const run = profileQueue.then(() => profileFor(profile));
  profileQueue = run.catch(() => {});
  return run;
}
async function profileFor(profile) {
  const inv = await invitedBy().catch(() => null);
  const body = { ...profile, ...(inv ? { invitedBy: inv } : {}) };
  const userId = !profile.manual && profile.userId;
  let switched = false;
  for (let tries = 0; ; tries++) {
    let err;
    try {
      const r = await api('/api/profile', { method: 'POST', body });
      if (userId) await keepAccount(userId);
      if (switched) tellTabs();
      return r;
    } catch (e) {
      if (e.code !== 'account_changed' || !userId || tries >= 2) throw e;
      err = e;
    }
    const { accounts = {} } = await chrome.storage.local.get('accounts');
    const { clientId: old } = await getConfig();
    if (old && err.data && err.data.account) accounts[err.data.account] = old;
    const own = accounts[userId];
    if (own && own !== old && tries === 0) {
      await chrome.storage.local.set({ accounts, clientId: own, clientServer: SERVER_URL });
    } else {
      delete accounts[userId];
      await chrome.storage.local.set({ accounts });
      await chrome.storage.local.remove(['clientId', 'clientServer']); // a new id (api() registers it)
    }
    switched = true;
  }
}
async function keepAccount(userId) {
  const { clientId } = await getConfig();
  const { accounts = {} } = await chrome.storage.local.get('accounts');
  if (!clientId || accounts[userId] === clientId) return;
  accounts[userId] = clientId;
  const keys = Object.keys(accounts);
  if (keys.length > 20) delete accounts[keys[0]];
  await chrome.storage.local.set({ accounts });
}
function tellTabs() {
  chrome.tabs.query({ url: 'https://fomo.family/*' }, (tabs) => {
    for (const t of tabs || []) chrome.tabs.sendMessage(t.id, { type: 'sessionChanged' }).catch(() => {});
  });
}

// ---------- Telegram linked on the website ----------
// fomoalerts.family saves its Telegram link in the cookie below. If this browser linked Telegram there (for
// example in the demo, before installing the extension), the extension takes that link over: no second link.
const SITE_COOKIE = '__Host-fa_client';
// Someone's invite link (fomoalerts.family/i/<code>) leaves the code in this cookie on our site (or on the fomo.family
// address as ?fa=, which content.js saves). It's kept once (the first one) and sent with the profile, so the server
// knows who invited this person.
const INVITE_COOKIE = '__Host-fa_inv';
async function invitedBy() {
  const { invitedBy: kept } = await chrome.storage.local.get('invitedBy');
  if (kept) return kept;
  if (!chrome.cookies || !/^https:\/\//.test(SERVER_URL)) return null;
  const c = await chrome.cookies.get({ url: SERVER_URL + '/', name: INVITE_COOKIE }).catch(() => null);
  const code = c && /^[A-Za-z0-9]{4,16}$/.test(c.value) ? c.value.toLowerCase() : null;
  if (code) await chrome.storage.local.set({ invitedBy: code });
  return code;
}
let lastAdoptTry = { id: null, at: 0 };
async function adoptWebsiteLink() {
  if (!chrome.cookies || !/^https:\/\//.test(SERVER_URL)) return false; // the cookie only exists on the live site
  const cookie = await chrome.cookies.get({ url: SERVER_URL + '/', name: SITE_COOKIE }).catch(() => null);
  const webId = cookie && cookie.value;
  if (!webId || !/^[A-Za-z0-9_-]{20,64}$/.test(webId)) return false;
  const { clientId } = await getConfig();
  if (webId === clientId) return false;
  // a website link that wasn't finished yet: don't ask the server again for 30 s
  if (lastAdoptTry.id === webId && Date.now() - lastAdoptTry.at < 30000) return false;
  lastAdoptTry = { id: webId, at: Date.now() };
  if (clientId) {
    const own = await rawApi('/api/status').catch(() => null);
    if (own && own.linked) return false; // the extension's own link wins
  }
  const web = await rawApi('/api/status', { asClient: webId }).catch(() => null);
  if (!web || !web.linked) return false;
  await chrome.storage.local.set({ clientId: webId, clientServer: SERVER_URL });
  logServer('Telegram link taken over from fomoalerts.family');
  return true;
}
// ---------- rules and texts from our server (only data: see rules.js) ----------
const CONFIG_EVERY_MS = 30 * 60_000;
let configLoading = null;
async function refreshConfig(force) {
  const { extConfig } = await chrome.storage.local.get('extConfig');
  if (!force && extConfig && Date.now() - (extConfig.fetchedAt || 0) < CONFIG_EVERY_MS) return extConfig.config;
  if (!configLoading) {
    configLoading = rawApi('/api/ext-config')
      .then(async (r) => {
        const config = { rules: (r && r.rules) || {}, texts: (r && r.texts) || {} };
        const same = extConfig && JSON.stringify(extConfig.config) === JSON.stringify(config);
        // only a real change is written (content.js redraws on a change)
        if (same) await chrome.storage.local.set({ extConfig: { ...extConfig, fetchedAt: Date.now() } });
        else await chrome.storage.local.set({ extConfig: { config, fetchedAt: Date.now() } });
        return config;
      })
      .catch(() => (extConfig && extConfig.config) || {}) // server not reachable: keep what we have
      .finally(() => (configLoading = null));
  }
  return configLoading;
}

chrome.runtime.onInstalled.addListener(() => {
  adoptWebsiteLink().catch(() => {});
  refreshConfig(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  adoptWebsiteLink().catch(() => {});
  refreshConfig().catch(() => {});
});
if (chrome.cookies) {
  chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (!removed && cookie.name === SITE_COOKIE && SERVER_URL.endsWith('//' + cookie.domain)) adoptWebsiteLink().catch(() => {});
  });
}

async function getStatus() {
  try {
    let s = await api('/api/status');
    if (!s.linked && (await adoptWebsiteLink().catch(() => false))) s = await api('/api/status');
    // chats: the Telegram accounts that get the alerts (several can be linked); access: free via our referral
    // code, free during launch, or not (see accessOf in server.js)
    // referralSync: the admin paired this browser to pass on Fomo's referral list of our code (see content.js)
    return { configured: true, linked: !!s.linked, botUsername: s.botUsername, serverUrl: SERVER_URL, chats: s.chats || [], access: s.access || null, referralSync: !!s.referralSync,
      // update: a newer version is required for new alerts
      update: s.update || null,
      // Discord (verified in our server), this account's invite link and its holder badge (top 1, 2, 3, 100)
      discord: s.discord || null, discordAvailable: !!s.discordAvailable, invite: s.invite || null, holder: s.holder || null };
  } catch (e) {
    return { configured: true, linked: false, error: e.message, serverUrl: SERVER_URL };
  }
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'status':
      return { status: await getStatus() };

    case 'getAlerts': {
      // active alerts on one coin (one per level)
      const status = await getStatus();
      if (!status.linked) return { status, alerts: [] };
      const { alerts } = await api('/api/alerts');
      return { status, alerts: alerts.filter((a) => a.status === 'active' && norm(a.tokenAddress) === norm(msg.tokenAddress)) };
    }

    case 'listAlerts': {
      const status = await getStatus();
      if (!status.linked) return { status, alerts: [] };
      const { alerts } = await api('/api/alerts');
      return { status, alerts };
    }

    case 'coinInfo': {
      // price, symbol, logo and supply of a coin you don't hold (the server asks Jupiter / GeckoTerminal / DexScreener)
      const q = `networkId=${encodeURIComponent(msg.networkId)}&tokenAddress=${encodeURIComponent(msg.tokenAddress)}`;
      return api('/api/coin?' + q);
    }

    case 'history': {
      // alerts that were sent, for the "FOMO Alerts" list in Fomo's Alerts panel
      const status = await getStatus();
      if (!status.linked) return { status, history: [] };
      const { history } = await api('/api/history');
      return { status, history };
    }

    case 'saveAlert':
      return api('/api/alerts', { method: 'POST', body: msg.alert });

    case 'deleteAlert':
      return api('/api/alerts/' + encodeURIComponent(msg.id), { method: 'DELETE' });

    case 'link':
      return api('/api/link', { method: 'POST' });

    case 'test':
      return api('/api/test', { method: 'POST' });

    case 'profile':
      // the Fomo account logged in on fomo.family and who referred it (decides free access), and who invited this
      // person (if anyone, see invitedBy). Another account than before: its own id (see one id per Fomo account)
      return sendProfile(msg.profile);

    case 'holdings':
      // the coins this account holds on Fomo: alerts on coins sold completely get paused on the server
      return api('/api/holdings', { method: 'POST', body: { positions: msg.positions } });

    case 'coinMeta':
      // launchpads of coins that have alerts, for the Telegram pictures
      return api('/api/coin-meta', { method: 'POST', body: { coins: msg.coins } });

    case 'prefs':
      // the quick % buttons from the card's settings, so the Telegram bot offers the same ones
      return api('/api/prefs', { method: 'POST', body: msg.prefs });

    case 'config':
      // rules and texts (see rules.js): fetched from our server at most every 30 minutes, kept in storage
      return { config: await refreshConfig() };

    case 'pay':
      // one-time payment: msg.start opens this browser's payment ($10, from its Fomo wallet); without it, is it paid yet
      return api('/api/pay', msg.start ? { method: 'POST' } : undefined);

    case 'payCheck':
      // "I paid, check": the server looks on every network right away
      return api('/api/pay/check', { method: 'POST' });

    case 'pairReferrals':
      // the admin dashboard's one-time link was opened here: this browser passes on Fomo's referral list from now on
      return api('/api/referrals/pair', { method: 'POST', body: { code: msg.code } });

    case 'referrals':
      // a page of Fomo's referral list of our code (only sent from the paired browser; the server checks that too)
      return api('/api/referrals', { method: 'POST', body: msg.list });

    case 'discordLink':
      // "Connect Discord": a Discord login link for this browser
      return api('/api/discord/link', { method: 'POST' });

    case 'discordUnlink':
      return api('/api/discord', { method: 'DELETE' });

    case 'removeChat':
      // stop sending alerts to one Telegram account
      return api('/api/chats/' + encodeURIComponent(msg.chatId), { method: 'DELETE' });

    default:
      throw new Error('Unknown request');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'report') {
    // from content.js: the page path only (no query, no #)
    let path = null;
    try {
      path = sender.tab && sender.tab.url ? new URL(sender.tab.url).pathname : null;
    } catch {
      /* no tab */
    }
    report(msg.report, path);
    return false;
  }
  handle(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});

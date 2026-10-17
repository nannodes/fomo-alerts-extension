// FOMO Alerts: how it finds Fomo's boxes and data, and its texts, kept as DATA so they can be changed from our
// server without a new version (admin dashboard, "Extension rules & texts"). Only data: CSS selectors, class names,
// URL paths and plain texts. Nothing from the server is ever run as code: every value is checked against the kind
// it must be (a selector must be a valid selector, a path only letters/digits/slashes, …) and a bad value keeps the
// built-in default. Texts are only ever put on the page as text, never as HTML.
//
// Loaded in every part: the page world (page-hook.js, chart-bridge.js), the extension world (content.js) and the
// toolbar popup. It sets self.__faRules: { rules, text(s), translate(root), set(config), v }.
// rules-page.js is an exact copy for the page world: Chrome loads a file only once per page, even when the
// manifest lists it for two worlds. Change rules.js, then copy it (node deploy/ext-defaults.js checks they match).
(() => {
  if (self.__faRules) return;
  const DEFAULTS = {
    // Fomo's trade box: a row of [Buy] [Sell] [⚙] in a rounded card
    tradeGear: 'button[aria-label="Swap settings"]',
    tradeRow: 'div.flex.gap-2',
    sideButtonClass: 'flex-1',
    tradeCard: '.rounded-2xl',
    // Fomo's popups (Position popup, trade popup)
    dialog: '[role="dialog"]',
    dialogTitle: '[data-slot="dialog-title"]',
    coinLink: 'a[href^="/tokens/"]',
    profileLink: 'a[href^="/profile/"], a[href^="/u/"]',
    positionSummaryClass: 'rounded-xl',
    popupColumnClasses: 'min-h-0 flex-col',
    // Fomo's side panels (Alerts, Leaderboard, Feed, … and our tab)
    panelTabRow: 'div.no-scrollbar',
    panelSeparatorClass: 'w-px',
    panelHeader: '.rounded-t-xl',
    panelRootClass: 'rounded-xl',
    panelClose: 'button[aria-label="Close panel"]',
    panelSplitMenu: '.mx-2.mt-1',
    // Fomo's account menu (where "FOMO Alerts" is added under Settings)
    accountMenu: '[data-slot="navigation-menu-content"] > div',
    accountProfileLink: 'a[href^="/profile/"]',
    settingsWord: 'settings',
    // Fomo's search bar (our chain filter goes right after it) and its result rows (also Recents)
    searchInput: 'input[placeholder^="Search for tokens"]',
    searchBox: '[class*="@container/search"]',
    searchResult: 'a[data-search-result]',
    // coin pages: /tokens/<chain>/<address>
    coinPath: '/tokens/',
    chains: { solana: 1399811149, bnb: 56, bsc: 56, ethereum: 1, eth: 1, base: 8453, monad: 143, robinhood: 4663, arc: 5042 },
    // Fomo's charts
    tvChartFrame: 'iframe[id^="tradingview_"]',
    popupChart: '.tv-lightweight-charts',
    // Fomo's own data, read from the responses Fomo's page already gets ({id} and {name} are parts of the path)
    apiHost: 'prod-api.fomo.family',
    apiMe: '/v2/users',
    apiBalances: '/v2/users/{id}/balances',
    apiUserHandle: '/v2/users/userHandle/{name}',
    apiReferrals: '/v2/users/{id}/referrals',
    apiReferrerDetails: '/v2/users/{id}/referrerDetails',
  };
  // what each rule must look like
  const KIND = {
    tradeGear: 'sel', tradeRow: 'sel', tradeCard: 'sel', dialog: 'sel', dialogTitle: 'sel', coinLink: 'sel', profileLink: 'sel',
    panelTabRow: 'sel', panelHeader: 'sel', panelClose: 'sel', panelSplitMenu: 'sel', accountMenu: 'sel', accountProfileLink: 'sel',
    tvChartFrame: 'sel', popupChart: 'sel', searchInput: 'sel', searchBox: 'sel', searchResult: 'sel',
    sideButtonClass: 'class', positionSummaryClass: 'class', panelSeparatorClass: 'class', panelRootClass: 'class', popupColumnClasses: 'classes',
    settingsWord: 'word', coinPath: 'path', chains: 'chains', apiHost: 'host',
    apiMe: 'path', apiBalances: 'path', apiUserHandle: 'path', apiReferrals: 'path', apiReferrerDetails: 'path',
  };
  const validSelector = (s) => {
    try {
      document.createDocumentFragment().querySelector(s);
      return true;
    } catch {
      return false;
    }
  };
  const OK = {
    sel: (v) => typeof v === 'string' && v.length > 0 && v.length <= 300 && validSelector(v),
    class: (v) => typeof v === 'string' && /^[A-Za-z0-9_:/.[\]%-]{1,80}$/.test(v),
    classes: (v) => typeof v === 'string' && /^[A-Za-z0-9_:/.[\]%-]{1,80}( [A-Za-z0-9_:/.[\]%-]{1,80}){0,5}$/.test(v),
    word: (v) => typeof v === 'string' && /^[\p{L}\p{N} ]{1,40}$/u.test(v),
    path: (v) => typeof v === 'string' && /^\/[A-Za-z0-9_./{}-]{0,120}$/.test(v),
    host: (v) => typeof v === 'string' && /^[a-z0-9.-]{3,80}$/.test(v),
    chains: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 40 &&
      Object.entries(v).every(([k, n]) => /^[a-z0-9-]{1,30}$/.test(k) && Number.isInteger(n) && n > 0 && n < 1e10),
  };

  const R = {
    defaults: DEFAULTS,
    kinds: KIND,
    rules: { ...DEFAULTS, chains: { ...DEFAULTS.chains } },
    v: 0, // changes every time new rules or texts are applied
    problems: [],
    exact: new Map(), // "Add alert" -> "Add it"
    templates: [], // [regex for "Set {n} alerts", "Place {n} alerts", names]
  };
  // config: { rules: {key: value}, texts: {"text as it is": "new text"} } from our server (or {} for the defaults)
  R.set = (config) => {
    const c = config && typeof config === 'object' ? config : {};
    const rules = { ...DEFAULTS, chains: { ...DEFAULTS.chains } };
    const problems = [];
    for (const [k, v] of Object.entries((c.rules && typeof c.rules === 'object' && c.rules) || {})) {
      if (!KIND[k]) problems.push(`unknown rule ${k}`);
      else if (!OK[KIND[k]](v)) problems.push(`bad value for ${k}`);
      else rules[k] = KIND[k] === 'chains' ? { ...DEFAULTS.chains, ...v } : v;
    }
    const exact = new Map();
    const templates = [];
    const texts = (c.texts && typeof c.texts === 'object' && c.texts) || {};
    for (const [from, to] of Object.entries(texts).slice(0, 400)) {
      if (typeof to !== 'string' || !from || from.length > 500 || to.length > 500) continue;
      if (/\{[a-z0-9]{1,12}\}/i.test(from)) {
        // "Set {n} alerts": the {…} parts match whatever is there and go into the new text
        const names = [];
        const src = from.split(/(\{[a-z0-9]{1,12}\})/i).map((part) => {
          const m = part.match(/^\{([a-z0-9]{1,12})\}$/i);
          if (m) {
            names.push(m[1]);
            return '(.+?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('');
        templates.push([new RegExp('^' + src + '$'), to, names]);
      } else exact.set(from, to);
    }
    R.rules = rules;
    R.exact = exact;
    R.templates = templates;
    R.problems = problems;
    R.v++;
  };
  // the text to show instead of s (or s itself)
  R.text = (s) => {
    if (typeof s !== 'string' || (!R.exact.size && !R.templates.length)) return s;
    const t = s.trim();
    if (!t) return s;
    let out = R.exact.get(t);
    if (out === undefined) {
      for (const [re, to, names] of R.templates) {
        const m = t.match(re);
        if (!m) continue;
        out = to.replace(/\{([a-z0-9]{1,12})\}/gi, (all, name) => {
          const i = names.indexOf(name);
          return i >= 0 ? m[i + 1] : all;
        });
        break;
      }
    }
    if (out === undefined) return s;
    return s.replace(t, out); // keep the spaces around it
  };
  // put the new texts on our own elements under root (text, title, placeholder and aria-label)
  R.translate = (root) => {
    if (!root || (!R.exact.size && !R.templates.length)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest('[data-fa-text], script, style, code')) continue; // fillText already did those
      const to = R.text(n.nodeValue);
      if (to !== n.nodeValue) n.nodeValue = to;
    }
    const els = root.querySelectorAll ? [root, ...root.querySelectorAll('[title], [placeholder], [aria-label]')] : [];
    for (const el of els) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) {
          const to = R.text(v);
          if (to !== v) el.setAttribute(a, to);
        }
      }
    }
  };
  // a path rule ("/v2/users/{id}/balances") as a test for a request path, with the {…} parts captured
  R.pathTest = (rule) => new RegExp('^' + rule.split(/(\{[a-z]+\})/).map((p) => (/^\{[a-z]+\}$/.test(p) ? '([^/]+)' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '\\/?$');
  R.escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // (the page world gets this object too: it holds only these rules, nothing private)
  Object.defineProperty(self, '__faRules', { value: R, enumerable: false });
})();

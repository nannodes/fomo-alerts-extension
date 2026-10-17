// © 2026 FOMO Alerts. All rights reserved.
// FOMO Alerts: how it finds Fomo's boxes and data. Built in on purpose: nothing here can be changed from outside,
// not even from our own server, so what people install is exactly what runs. A change means a new version.
//
// Loaded in every part that needs it: the page world (page-hook.js, chart-bridge.js) and the extension world
// (content.js). It sets self.__faRules: { rules, pathTest, escape }, frozen so nothing on the page can change it.
// rules-page.js is an exact copy for the page world: Chrome loads a file only once per page, even when the
// manifest lists it for two worlds. Change rules.js, then copy it (node deploy/check-extension.js checks they match).
(() => {
  if (self.__faRules) return;
  const rules = {
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
    chains: Object.freeze({ solana: 1399811149, bnb: 56, bsc: 56, ethereum: 1, eth: 1, base: 8453, monad: 143, robinhood: 4663, arc: 5042 }),
    // Fomo's charts
    tvChartFrame: 'iframe[id^="tradingview_"]',
    popupChart: '.tv-lightweight-charts',
    // Fomo's own data, read from the responses Fomo's page already gets from Fomo's own API ({id} and {name} are
    // parts of the path). Only this host: page-hook.js lets every other request through untouched.
    apiHost: 'prod-api.fomo.family',
    apiMe: '/v2/users',
    apiBalances: '/v2/users/{id}/balances',
    apiUserHandle: '/v2/users/userHandle/{name}',
    apiReferrals: '/v2/users/{id}/referrals',
    apiReferrerDetails: '/v2/users/{id}/referrerDetails',
  };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a path rule ("/v2/users/{id}/balances") as a test for a request path, with the {…} parts captured
  const pathTest = (rule) => new RegExp('^' + rule.split(/(\{[a-z]+\})/).map((p) => (/^\{[a-z]+\}$/.test(p) ? '([^/]+)' : escape(p))).join('') + '\\/?$');
  // (the page world gets this object too: it holds only these rules, nothing private)
  Object.defineProperty(self, '__faRules', { value: Object.freeze({ rules: Object.freeze(rules), pathTest, escape }), enumerable: false });
})();

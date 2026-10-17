// © 2026 FOMO Alerts. All rights reserved.
// Runs inside the fomo.family page. Draws alert levels as draggable lines on Fomo's charts and tells the
// extension while and after you drag one. Every line has an id from the extension:
//   new-tp / new-sl / new-dip  = the level being typed in the card (dashed "drag to set" until filled in)
//   a:<alertId>                = an active alert
// Charts:
//  - main:  the TradingView chart on the coin page (horizontal-line drawings, never saved to your layout)
//  - popup: the small chart in the Position popup (Lightweight Charts price lines + drag handles; the chart
//           rescales so the lines stay in view)
// It also reports the chart's latest price, so levels can be measured from the current price.
(() => {
  if (window.__fomoAlertsChart) return;
  window.__fomoAlertsChart = true;

  const post = (type, payload) =>
    window.postMessage({ source: 'fomo-alerts-chart', type, payload }, window.location.origin);
  const log = (target, msg) => post('log', { target, msg });

  const wants = { main: null }; // latest lines for the coin page chart
  // One entry per open Position popup card. Fomo can swap a popup's content right after opening it; keeping
  // them apart means closing the old card can't wipe the lines of the new one.
  const popupWants = new Map(); // popup key -> latest lines
  let popupKey = null; // popup whose chart we draw on
  const currentPopup = () => (popupKey ? popupWants.get(popupKey) || null : null);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'fomo-alerts-content') return;
    const { type, payload } = e.data;
    if (type !== 'chart-levels' || !payload) return;
    if (payload.target === 'popup') {
      if (!payload.key) return;
      if (payload.closed) {
        popupWants.delete(payload.key);
        if (popupKey === payload.key) popupKey = [...popupWants.keys()].pop() || null;
      } else {
        popupWants.set(payload.key, payload);
        popupKey = payload.key;
      }
      popup.sync(true);
    } else {
      wants.main = payload;
      main.sync();
    }
  });
  // Fomo rebuilds charts on coin / price-mode changes, and prices move: check every 2 s
  setInterval(() => {
    if (wants.main && (wants.main.enabled || wants.main.address)) main.sync();
    if (popupKey) popup.sync();
  }, 2000);

  // ---------- shared ----------
  // where a "drag to set" line spawns: this share of the way from the current price to the chart edge
  const GHOST_SPOT = { tp: 0.45, sl: 0.45, dip: 0.25 };

  // Fomo charts show either price or market cap (price × total supply): pick whichever matches the scale
  function pickFactor(mid, price, supply) {
    if (!(supply > 0) || !(price > 0)) return 1;
    if (!(mid > 0)) return null; // chart not drawn yet
    return Math.abs(Math.log(mid / (price * supply))) < Math.abs(Math.log(mid / price)) ? supply : 1;
  }

  function ghostValue(side, cur, lo, hi) {
    if (!(cur > 0)) return null;
    const share = GHOST_SPOT[side] || 0.4;
    if (side === 'tp') {
      const room = hi - cur;
      return room > cur * 0.01 ? cur + room * share : cur * 1.05;
    }
    const room = cur - lo;
    return room > cur * 0.01 ? cur - room * share : cur * (side === 'dip' ? 0.97 : 0.95);
  }

  const levelKey = (l) => (l.ghost ? 'ghost' : 'set:' + l.price);
  const changed = (a, b) => Math.abs(a - b) > Math.abs(b) * 1e-9;
  const wantedLines = (want) => (want && want.enabled && Array.isArray(want.lines) ? want.lines : []);

  function makeStatus(target) {
    let last = '';
    return (s) => {
      const payload = { target, ...s };
      const json = JSON.stringify(payload);
      if (json === last) return;
      last = json;
      post('status', payload);
    };
  }

  function makeLiveReporter(target) {
    let last = '';
    return (address, price) => {
      if (!(price > 0)) return;
      const key = address + ':' + price.toPrecision(6);
      if (key === last) return;
      last = key;
      post('price', { target, address, price });
    };
  }

  // ---------- main: TradingView chart on the coin page ----------
  const main = (() => {
    const status = makeStatus('main');
    const reportLive = makeLiveReporter('main');
    let chart = null; // IChartWidgetApi (may be a fresh wrapper on every call)
    let chartFrame = null; // its iframe: a new iframe means Fomo rebuilt the chart
    let subscribedApi = null;
    let factor = 1; // chart units per USD: 1 = price chart, total supply = market cap chart
    const drawn = new Map(); // line id -> { shapeId, side, value, spawn, key, text, ghost, color }
    const removedByUser = new Map(); // line id -> level key the user deleted from the chart
    const moveTimers = new Map();
    let pointerDown = false;
    let dragId = null; // line being dragged with the mouse right now
    let quietUntil = 0; // ignore drawing events caused by our own updates
    let busy = false;
    let again = false;
    let mismatch = null; // { address, since }: the chart showed another coin since then
    const SWITCH_GRACE_MS = 10000;

    // The chart lives in a same-origin iframe that exposes TradingView's API as `tradingViewApi`.
    // Fomo can have more than one for a moment (an old chart still on the page while the new one loads): take
    // the one showing this coin, else the first visible one.
    function findChart(address) {
      let first = null;
      for (const iframe of document.querySelectorAll(window.__faRules.rules.tvChartFrame)) {
        if (!iframe.getClientRects().length) continue;
        let cw;
        try {
          cw = iframe.contentWindow;
        } catch {
          continue;
        }
        const api = cw && cw.tradingViewApi;
        if (!api || typeof api.activeChart !== 'function') continue;
        let c;
        try {
          c = api.activeChart();
        } catch {
          continue;
        }
        if (!c) continue;
        const hit = { iframe, cw, api, chart: c };
        if (!address || symbolMatches(c, address)) return hit;
        if (!first) first = hit;
      }
      return first;
    }

    // what the chart shows, for the Debug page ("<address>:<chain id>")
    function symbolOf(c) {
      try {
        const ext = typeof c.symbolExt === 'function' ? c.symbolExt() : null;
        return String((ext && ext.ticker) || c.symbol() || '');
      } catch {
        return '';
      }
    }

    // Fomo names the chart "<address>:<chain id>". TradingView hands symbol() back in CAPITALS, which breaks
    // case-sensitive Solana addresses, so compare without case (symbolExt().ticker keeps the real case).
    function symbolMatches(c, address) {
      const a = String(address || '').toLowerCase();
      if (!a) return false;
      try {
        const ext = typeof c.symbolExt === 'function' ? c.symbolExt() : null;
        for (const v of [ext && ext.ticker, ext && ext.pro_name]) {
          if (typeof v === 'string' && v.toLowerCase().includes(a)) return true;
        }
      } catch {
        /* older library: symbol() only */
      }
      try {
        return String(c.symbol() || '').toLowerCase().includes(a);
      } catch {
        return false;
      }
    }

    function visibleRange(c) {
      try {
        const r = c.getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange();
        return r && r.to > r.from ? r : null;
      } catch {
        return null;
      }
    }

    // close of the newest candle (chart units)
    function lastValue(c) {
      try {
        const bar = c.getSeries().data().bars().last();
        const v = bar && bar.value && bar.value[4];
        return v > 0 ? v : null;
      } catch {
        return null;
      }
    }

    function shapeExists(id) {
      try {
        chart.getShapeById(id);
        return true;
      } catch {
        return false;
      }
    }

    function shapeValue(id) {
      try {
        const pts = chart.getShapeById(id).getPoints();
        const v = pts && pts[0] && pts[0].price;
        return v > 0 ? v : null;
      } catch {
        return null;
      }
    }

    function anchorTime() {
      try {
        const r = chart.getVisibleRange();
        if (r && r.to) return r.to;
      } catch {
        /* fall through */
      }
      return Math.floor(Date.now() / 1000);
    }

    function removeLine(id) {
      const d = drawn.get(id);
      drawn.delete(id);
      if (!d || !chart || !shapeExists(d.shapeId)) return;
      quietUntil = Date.now() + 300;
      try {
        chart.removeEntity(d.shapeId, { disableUndo: true });
      } catch {
        /* already gone */
      }
    }

    function clearAll() {
      for (const id of [...drawn.keys()]) removeLine(id);
    }

    function lineProps(l) {
      return {
        linecolor: l.color,
        linewidth: 2,
        linestyle: l.ghost || l.dashed ? 2 : 0, // dashed until set (and a paused alert's line)
        showLabel: true,
        text: l.text,
        textcolor: l.color,
        fontsize: 12,
        bold: true,
        horzLabelsAlign: 'right',
        vertLabelsAlign: 'bottom',
        showPrice: true,
      };
    }

    async function syncLine(l, cur, range) {
      let d = drawn.get(l.id);
      if (d && !shapeExists(d.shapeId)) {
        drawn.delete(l.id); // chart rebuilt or line deleted
        d = null;
      }
      const key = levelKey(l);
      if (removedByUser.get(l.id) === key) return;
      removedByUser.delete(l.id);

      // a "drag to set" line stays where it spawned; a set line sits on its level
      const value = l.ghost
        ? d && d.ghost ? d.spawn : ghostValue(l.side, cur, range ? range.from : 0, range ? range.to : 0)
        : l.price * factor;
      if (!(value > 0)) return;
      const props = lineProps(l);
      if (!d) {
        quietUntil = Date.now() + 500;
        const shapeId = await chart.createShape(
          { time: anchorTime(), price: value },
          {
            shape: 'horizontal_line',
            text: l.text,
            overrides: props,
            lock: !l.draggable,
            disableSave: true,
            disableUndo: true,
            showInObjectsTree: false,
            zOrder: 'top',
          }
        );
        drawn.set(l.id, { shapeId, side: l.side, value, spawn: l.ghost ? value : null, key, text: l.text, ghost: l.ghost, color: l.color });
        return;
      }
      if (l.ghost && !d.ghost) d.spawn = value;
      const shape = chart.getShapeById(d.shapeId);
      // never move a line under the user's mouse
      if (changed(d.value, value) && !pointerDown && dragId !== l.id) {
        quietUntil = Date.now() + 300;
        shape.setPoints([{ time: anchorTime(), price: value }]);
        d.value = value;
      }
      if (d.text !== l.text || d.ghost !== l.ghost || d.color !== l.color) {
        shape.setProperties(props);
        Object.assign(d, { text: l.text, ghost: l.ghost, color: l.color });
      }
      d.side = l.side;
      d.key = key;
    }

    function idOfShape(shapeId) {
      for (const [id, d] of drawn) if (d.shapeId === shapeId) return id;
      return null;
    }

    // a line was moved without the mouse (keyboard, undo, …): report it once it settles
    function onDrawingEvent(shapeId, type) {
      const id = idOfShape(shapeId);
      if (!id) return;
      const d = drawn.get(id);
      if (type === 'remove') {
        if (Date.now() < quietUntil) return;
        removedByUser.set(id, d.key); // respect it until the level changes
        drawn.delete(id);
        log('main', `${d.text} line deleted on the chart (the alert itself is unchanged)`);
        return;
      }
      if (type !== 'points_changed' && type !== 'move') return;
      if (Date.now() < quietUntil || pointerDown) return;
      clearTimeout(moveTimers.get(id));
      moveTimers.set(id, setTimeout(() => {
        const cur = drawn.get(id);
        const value = cur && shapeValue(cur.shapeId);
        if (!value || !changed(value, cur.value)) return;
        cur.value = value;
        post('moved', { target: 'main', id, side: cur.side, price: value / factor });
      }, 150));
    }

    // while the mouse is down, follow the dragged line every frame so the card can show live numbers
    function followDrag() {
      if (!pointerDown) return;
      for (const [id, d] of drawn) {
        const value = shapeValue(d.shapeId);
        if (!value) continue;
        if (dragId === id ? changed(value, d.dragValue) : changed(value, d.value)) {
          dragId = id;
          d.dragValue = value;
          post('dragging', { target: 'main', id, side: d.side, price: value / factor });
        }
      }
      requestAnimationFrame(followDrag);
    }

    function watchPointer(cw) {
      if (cw.__fomoAlertsPointer) return;
      cw.__fomoAlertsPointer = true;
      const down = () => {
        pointerDown = true;
        dragId = null;
        requestAnimationFrame(followDrag);
      };
      const up = () => {
        if (!pointerDown) return;
        pointerDown = false;
        // report the final spot right away, before anything else can touch the line
        for (const [id, d] of drawn) {
          const value = shapeValue(d.shapeId);
          if (value && changed(value, d.value)) {
            d.value = value;
            post('moved', { target: 'main', id, side: d.side, price: value / factor });
          }
        }
        dragId = null;
      };
      cw.addEventListener('pointerdown', down, true);
      cw.addEventListener('pointerup', up, true);
      cw.addEventListener('pointercancel', up, true);
    }

    async function sync() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const want = wants.main;
        const found = findChart(want && want.address);
        if (found && found.iframe !== chartFrame) {
          chartFrame = found.iframe;
          drawn.clear();
        }
        chart = found ? found.chart : null;
        const lines = wantedLines(want);
        if (!lines.length) {
          if (chart) clearAll();
          // no lines: still report the chart's latest price for the coin, when we can tell its units
          if (found && want && want.address && want.price > 0 && want.supply > 0 && symbolMatches(chart, want.address)) {
            const range = visibleRange(chart);
            const f = pickFactor(range ? (range.from + range.to) / 2 : 0, want.price, want.supply);
            const live = f && lastValue(chart);
            // far off from the price we know: the units guess was wrong, don't report it
            if (live && Math.abs(Math.log(live / f / want.price)) < Math.log(3)) {
              factor = f;
              reportLive(want.address, live / f);
            }
          }
          status({ chart: !!found, lines: 'off', drawn: [] });
          return;
        }
        if (!found) return status({ chart: false, lines: 'waiting for the chart', drawn: [] });
        if (!symbolMatches(chart, want.address)) {
          clearAll();
          // Fomo switches the chart a moment after the page (and loads a saved layout first): give it time
          if (!mismatch || mismatch.address !== want.address) mismatch = { address: want.address, since: Date.now() };
          const switching = Date.now() - mismatch.since < SWITCH_GRACE_MS;
          return status({
            chart: true,
            lines: switching ? 'waiting for the chart to switch to this coin' : 'chart shows another coin',
            shows: symbolOf(chart),
            want: want.address,
            drawn: [],
          });
        }
        mismatch = null;
        if (subscribedApi !== found.api) {
          found.api.subscribe('drawing_event', onDrawingEvent);
          subscribedApi = found.api;
        }
        watchPointer(found.cw);
        const range = visibleRange(chart);
        const f = pickFactor(range ? (range.from + range.to) / 2 : 0, want.price, want.supply);
        if (f === null) return status({ chart: true, lines: 'waiting for chart data', drawn: [] });
        factor = f;
        const live = lastValue(chart);
        if (live) reportLive(want.address, live / factor);
        const cur = live || want.price * factor;
        const keep = new Set(lines.map((l) => l.id));
        for (const id of [...drawn.keys()]) if (!keep.has(id)) removeLine(id);
        for (const l of lines) await syncLine(l, cur, range);
        status({ chart: true, units: factor === 1 ? 'price' : 'market cap', lines: drawn.size ? `drawn: ${drawn.size}` : 'none', drawn: [...drawn.keys()] });
      } catch (e) {
        status({ chart: true, lines: 'error: ' + e.message, drawn: [] });
      } finally {
        busy = false;
        if (again) {
          again = false;
          setTimeout(sync, 50);
        }
      }
    }

    return { sync };
  })();

  // ---------- popup: Lightweight Charts chart in Fomo's Position popup ----------
  // Fomo keeps that chart and its series in React refs; we read them from the container's React data.
  const popup = (() => {
    const status = makeStatus('popup');
    const reportLive = makeLiveReporter('popup');
    let chart = null; // IChartApi
    let series = null; // ISeriesApi (Fomo replaces it when you switch candles / line)
    let root = null; // .tv-lightweight-charts element
    let overlay = null; // our drag handles (on top)
    let back = null; // our copy of the lines, under the chart's canvas so candles and labels stay readable
    let factor = 1;
    let raf = 0;
    let dragging = null; // line id being dragged
    let provider = null; // our autoscale wrapper on Fomo's series
    let scaleValues = []; // line levels the chart's autoscale must include
    const lines = new Map(); // line id -> { line, side, value, spawn, ghost, color, label, title, handle }
    let lastDiag = '';
    let retryTimer = 0; // lines made but not in view yet: look again shortly (the chart rescales a frame later)
    let retries = 0;

    const isChartApi = (v) => !!v && typeof v === 'object' && typeof v.addSeries === 'function' && typeof v.timeScale === 'function';
    const isSeriesApi = (v) => !!v && typeof v === 'object' && typeof v.createPriceLine === 'function' && typeof v.priceToCoordinate === 'function';

    // Look through React's data for the chart's container and its parents: the chart and series objects
    // Fomo keeps in refs, state or props.
    function reactRefs(el) {
      const found = { chart: null, series: null, fiber: false };
      for (let node = el, up = 0; node && up < 4 && !(found.chart && found.series); node = node.parentElement, up++) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
        if (!key) continue;
        found.fiber = true;
        for (let fiber = node[key], depth = 0; fiber && depth < 25 && !(found.chart && found.series); depth++, fiber = fiber.return) {
          const values = [];
          for (let h = fiber.memoizedState, i = 0; h && typeof h === 'object' && 'next' in h && i < 120; i++, h = h.next) {
            const v = h.memoizedState;
            values.push(v, v && typeof v === 'object' ? v.current : null);
          }
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            for (const k of Object.keys(props)) {
              const v = props[k];
              values.push(v, v && typeof v === 'object' ? v.current : null);
            }
          }
          for (const v of values) {
            if (!found.chart && isChartApi(v)) found.chart = v;
            else if (!found.series && isSeriesApi(v)) found.series = v;
          }
        }
      }
      // newer Lightweight Charts can hand out the series from the chart itself
      if (found.chart && !found.series) {
        try {
          const panes = typeof found.chart.panes === 'function' ? found.chart.panes() : [];
          for (const pane of panes) {
            const s = pane.getSeries().find(isSeriesApi);
            if (s) {
              found.series = s;
              found.viaPanes = true;
              break;
            }
          }
        } catch {
          /* no panes api */
        }
      }
      return found;
    }

    // charts that are really on screen, biggest first (a tiny or hidden chart is never the one you look at)
    const area = (r) => {
      const b = r.getBoundingClientRect();
      return b.width * b.height;
    };
    const visibleCharts = (el) =>
      [...el.querySelectorAll(window.__faRules.rules.popupChart)].filter((r) => area(r) > 400).sort((a, b) => area(b) - area(a));
    const openDialogs = () =>
      [...document.querySelectorAll(window.__faRules.rules.dialogTitle)].map((t) => t.closest(window.__faRules.rules.dialog) || t.parentElement).filter(Boolean);

    // the popup's chart, or { diag } saying why it can't be used
    function findLw(key) {
      let dlg = key && document.querySelector(`[data-fa-popup="${key}"]`);
      // the marked element can be a part of the popup without the chart, or the mark got lost when Fomo
      // swapped the popup's content: then the whole dialog, or any open popup with a chart, will do
      if (dlg && !visibleCharts(dlg).length) dlg = dlg.closest(window.__faRules.rules.dialog) || dlg;
      if (!dlg || !visibleCharts(dlg).length) dlg = openDialogs().find((d) => visibleCharts(d).length) || dlg;
      if (!dlg) return { diag: 'popup not found' };
      const roots = visibleCharts(dlg);
      if (!roots.length) return { diag: 'no chart in the popup yet' };
      let last = null;
      for (const r of roots) {
        const refs = reactRefs(r.parentElement || r);
        if (refs.chart && refs.series) return { root: r, chart: refs.chart, series: refs.series, viaPanes: !!refs.viaPanes };
        last = refs;
      }
      return { diag: !last.fiber ? 'chart found, but no React data on it' : !last.chart ? 'chart found, but not its controls' : 'chart found, series not ready yet' };
    }

    function pane() {
      let w = 0;
      let h = 0;
      try {
        w = chart.timeScale().width();
      } catch {
        /* fall back below */
      }
      try {
        h = root.clientHeight - chart.timeScale().height();
      } catch {
        /* fall back below */
      }
      return { w: w > 0 ? w : root.clientWidth, h: h > 0 ? h : root.clientHeight };
    }

    function lastValue() {
      try {
        const data = series.data();
        const bar = data[data.length - 1];
        const v = bar && (bar.close !== undefined ? bar.close : bar.value);
        return v > 0 ? v : null;
      } catch {
        return null;
      }
    }

    // price at a y position; outside the chart the library gives none, so extend the visible scale
    function priceAt(y, height) {
      let v = y >= 0 && y <= height ? series.coordinateToPrice(y) : null;
      if (v === null) {
        const top = series.coordinateToPrice(0);
        const bottom = series.coordinateToPrice(height);
        if (top !== null && bottom !== null) v = top + ((bottom - top) * y) / height;
      }
      return v;
    }

    // the chart we drew on is still on the page (once Fomo throws a chart away, touching it causes errors)
    const alive = () => !!(series && root && root.isConnected);

    // Make the chart's autoscale include our lines, so they never sit outside the small chart.
    // Wraps whatever Fomo set; with no lines it behaves exactly like Fomo's own setting.
    function keepLinesInView() {
      if (!alive() || dragging) return;
      const values = [...lines.values()].map((l) => l.value);
      let current;
      try {
        current = series.options().autoscaleInfoProvider;
      } catch {
        return;
      }
      const same = values.length === scaleValues.length && values.every((v, i) => v === scaleValues[i]);
      if (provider && current === provider && same) return;
      const fomoProvider = current && current === provider ? provider.fomo : current;
      scaleValues = values;
      provider = (base) => {
        const info = fomoProvider ? fomoProvider(base) : base();
        if (!info || !info.priceRange || !values.length) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, ...values),
            maxValue: Math.max(info.priceRange.maxValue, ...values),
          },
        };
      };
      provider.fomo = fomoProvider;
      try {
        series.applyOptions({ autoscaleInfoProvider: provider });
      } catch {
        /* series gone */
      }
    }

    // take a line off the chart; when Fomo already replaced the chart or series, only forget it
    function dropLine(id, forgetOnly) {
      const l = lines.get(id);
      lines.delete(id);
      if (!l) return;
      if (!forgetOnly && alive()) {
        try {
          series.removePriceLine(l.line);
        } catch {
          /* series already gone */
        }
      }
      if (l.handle) l.handle.remove();
      if (l.back) l.back.remove();
    }

    function removeAll() {
      for (const id of [...lines.keys()]) dropLine(id);
      if (overlay) overlay.remove();
      overlay = null;
      if (back) back.remove();
      back = null;
      keepLinesInView(); // back to Fomo's own scaling
    }

    function ensureOverlay() {
      if (overlay && overlay.isConnected && overlay.parentElement === root) return;
      if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
      overlay = document.createElement('div');
      overlay.className = 'fa-lw-overlay';
      root.appendChild(overlay);
      for (const l of lines.values()) l.handle = null;
    }

    // The chart's plot area is a box holding its canvases (the biggest ones); our lines go first in that box,
    // under the (transparent) canvases.
    function ensureBack() {
      if (back && back.isConnected) return back;
      const canvas = [...root.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const box = canvas && canvas.parentElement;
      if (!box) return null;
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      back = document.createElement('div');
      back.className = 'fa-lw-back';
      box.prepend(back);
      for (const l of lines.values()) l.back = null;
      return back;
    }

    function makeHandle(id) {
      const h = document.createElement('div');
      h.className = 'fa-lw-handle';
      h.title = 'Drag to move this level';
      h.append(document.createElement('span')); // the label pill
      h.addEventListener('pointerdown', (e) => startDrag(e, id, h));
      overlay.append(h);
      return h;
    }

    function startDrag(e, id, h) {
      const l = lines.get(id);
      if (!l || !l.draggable || !series) return;
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      dragging = id;
      const startValue = l.value;
      let frame = 0;
      const move = (ev) => {
        const rect = overlay.getBoundingClientRect();
        // past the chart edge keeps going (up to 3 chart heights), so a far level can still be set
        const y = Math.max(-3 * rect.height, Math.min(4 * rect.height, ev.clientY - rect.top));
        const v = priceAt(y, rect.height);
        const cur = lines.get(id);
        if (!cur || !(v > 0)) return;
        cur.value = v;
        cur.line.applyOptions({ price: v });
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            const c = lines.get(id);
            if (c) post('dragging', { target: 'popup', key: popupKey, id, side: c.side, price: c.value / factor });
          });
        }
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        cancelAnimationFrame(frame);
        dragging = null;
        const cur = lines.get(id);
        if (cur && cur.value > 0 && cur.value !== startValue) {
          post('moved', { target: 'popup', key: popupKey, id, side: cur.side, price: cur.value / factor });
        }
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    }

    // keep the handles on their lines while the chart scrolls / rescales
    function place() {
      raf = 0;
      if (!overlay || !overlay.isConnected || !series) return;
      const { w, h } = pane();
      overlay.style.width = w + 'px';
      overlay.style.height = h + 'px';
      for (const [id, l] of lines) {
        if (!l.handle || !l.handle.isConnected) l.handle = makeHandle(id);
        let y = null;
        try {
          y = series.priceToCoordinate(l.value);
        } catch {
          /* hidden below */
        }
        if (y === null || !isFinite(y)) {
          l.handle.style.display = 'none';
          continue;
        }
        const top = Math.max(8, Math.min(h - 8, y));
        l.handle.style.display = '';
        l.handle.style.top = top + 'px';
        l.handle.classList.toggle('fa-lw-ghost', !!l.ghost);
        l.handle.classList.toggle('fa-lw-fixed', !l.draggable);
        const pill = l.handle.firstChild;
        const text = (y < 8 ? '▲ ' : y > h - 8 ? '▼ ' : l.draggable ? '⇕ ' : '') + l.label;
        if (pill.textContent !== text) pill.textContent = text;
        pill.style.background = l.color;
        // our own copy of the line, under the chart: shows even when the chart doesn't paint its price lines
        const layer = ensureBack();
        if (layer) {
          if (!l.back || !l.back.isConnected) {
            l.back = document.createElement('div');
            l.back.className = 'fa-lw-line';
            layer.append(l.back);
          }
          l.back.style.top = y - 1 + 'px';
          l.back.style.borderTopColor = l.color;
          l.back.style.borderTopStyle = l.ghost ? 'dashed' : 'solid';
          l.back.style.display = y >= 0 && y <= h ? '' : 'none';
        }
      }
      raf = requestAnimationFrame(place);
    }

    function syncLine(l, cur, lo, hi) {
      const d = lines.get(l.id);
      if (dragging === l.id) {
        // follow the card's live label while dragging, but leave the line under the mouse
        if (d && d.title !== l.short) {
          d.line.applyOptions({ title: l.short });
          d.title = l.short;
          d.label = l.short;
        }
        return;
      }
      const value = l.ghost ? (d && d.ghost ? d.spawn : ghostValue(l.side, cur, lo, hi)) : l.price * factor;
      if (!(value > 0)) return;
      const opts = {
        price: value,
        color: l.color,
        lineWidth: 2,
        lineStyle: l.ghost || l.dashed ? 2 : 0, // dashed until set (and a paused alert's line)
        axisLabelVisible: true,
        title: l.short,
      };
      if (!d) {
        lines.set(l.id, {
          line: series.createPriceLine(opts),
          side: l.side,
          value,
          spawn: l.ghost ? value : null,
          ghost: l.ghost,
          color: l.color,
          title: l.short,
          label: l.short,
          draggable: !!l.draggable,
          handle: null,
        });
        return;
      }
      if (l.ghost && !d.ghost) d.spawn = value;
      if (d.value !== value || d.ghost !== l.ghost || d.color !== l.color || d.title !== l.short) {
        d.line.applyOptions(opts);
        Object.assign(d, { value, ghost: l.ghost, color: l.color, title: l.short, label: l.short });
      }
      d.side = l.side;
      d.draggable = !!l.draggable;
    }

    // what the Debug page needs when the popup lines don't show
    function diag(res, extra) {
      const text = JSON.stringify({ ...res, ...extra });
      if (text === lastDiag) return;
      lastDiag = text;
      log('popup', 'popup chart check: ' + text);
    }

    function sync(fresh) {
      if (fresh) retries = 0;
      const want = currentPopup();
      const res = want ? findLw(want.key) : null;
      const found = res && res.root ? res : null;
      if (found && (found.series !== series || found.root !== root)) {
        // new chart or series (Fomo switched candles / line): our lines went with the old one
        for (const id of [...lines.keys()]) dropLine(id, true);
        if (overlay) overlay.remove();
        overlay = null;
        if (back) back.remove();
        back = null;
        provider = null;
        scaleValues = [];
        chart = found.chart;
        series = found.series;
        root = found.root;
      }
      const key = want ? want.key : null;
      const wanted = wantedLines(want);
      if (!found) {
        removeAll();
        series = chart = root = null;
        provider = null;
        if (want) diag({ diag: res.diag, charts: document.querySelectorAll(window.__faRules.rules.popupChart).length });
        return status({ key, chart: false, lines: want ? res.diag : 'no popup', drawn: [] });
      }
      if (!wanted.length) {
        removeAll();
        return status({ key, chart: true, lines: 'off', drawn: [] });
      }
      try {
        const { h } = pane();
        const top = series.coordinateToPrice(0);
        const bottom = series.coordinateToPrice(h);
        const live = lastValue();
        // price or market cap chart: judged from the visible range, else from the last candle
        const f = pickFactor(top > 0 && bottom > 0 ? (top + bottom) / 2 : live || 0, want.price, want.supply);
        let dataLen = -1;
        try {
          dataLen = series.data().length;
        } catch {
          /* no data api */
        }
        diag({ viaPanes: !!found.viaPanes, paneHeight: h, top, bottom, live, dataLen, factor: f, wanted: wanted.length });
        if (f === null) return status({ key, chart: true, lines: `the small chart has no prices yet (${dataLen} candles)`, drawn: [] });
        factor = f;
        if (live) reportLive(want.address, live / factor);
        const cur = live || want.price * factor;
        ensureOverlay();
        const keep = new Set(wanted.map((l) => l.id));
        for (const id of [...lines.keys()]) if (!keep.has(id)) dropLine(id);
        for (const l of wanted) syncLine(l, cur, bottom, top);
        keepLinesInView();
        if (!raf) raf = requestAnimationFrame(place);
        // a line counts as shown once it sits inside the visible chart (the chart rescales to fit them)
        const ys = new Map();
        for (const [id, l] of lines) {
          let y = null;
          try {
            y = series.priceToCoordinate(l.value);
          } catch {
            /* series gone */
          }
          ys.set(id, y);
        }
        const shown = [...ys].filter(([, y]) => y !== null && isFinite(y) && y >= -2 && y <= h + 2).map(([id]) => id);
        let text = shown.length ? `drawn: ${shown.length}` : 'none';
        if (lines.size && shown.length < lines.size) {
          const out = [...ys].filter(([id]) => !shown.includes(id)).map(([, y]) => (y === null ? '?' : Math.round(y)));
          text = `${shown.length ? `drawn: ${shown.length}, ` : ''}outside the chart (height ${Math.round(h)}, line at ${out.join(' / ')})`;
          // the chart rescales to fit the lines a frame later: look again a few times, and switch the
          // chart's auto-scaling back on in case it was turned off by dragging its price axis
          if (!retryTimer && retries < 4) {
            retries++;
            if (retries === 2) {
              try {
                series.priceScale().applyOptions({ autoScale: true });
              } catch {
                /* no price scale api */
              }
            }
            retryTimer = setTimeout(() => {
              retryTimer = 0;
              sync();
            }, 400);
          }
        } else {
          retries = 0;
        }
        status({ key, chart: true, units: factor === 1 ? 'price' : 'market cap', lines: text, drawn: shown });
      } catch (e) {
        status({ key, chart: true, lines: 'error: ' + e.message, drawn: [] });
      }
    }

    return { sync };
  })();
})();

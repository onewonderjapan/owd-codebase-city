import * as echarts from 'echarts';
/* Shared behaviour for dashboard pages.
 *
 * Kit.chart() exists because of a bug worth not repeating: ECharts bakes the
 * resolved CSS colours in at init, so a theme toggle used to need a page reload,
 * which threw away the theme that had just been chosen. Charts register their
 * builder here instead, and a theme change re-runs every builder in place.
 */
const Kit = (() => {
  const root = document.documentElement;
  const charts = [];
  const listeners = [];

  /* ── theme ─────────────────────────────────────────────────────────────── */
  const STORE = 'kit-theme';
  function theme(next) {
    if (next) {
      root.dataset.theme = next;
      try { localStorage.setItem(STORE, next) } catch (e) { /* private mode */ }
      retheme();
      listeners.forEach(f => f(next));
      // Broadcast as well as call back: the canvas and WebGL layers in fx.js
      // are ES modules loaded independently of whoever calls this, and
      // an event is the only channel that doesn't require them to be registered.
      dispatchEvent(new CustomEvent('kit:theme', {detail: next}));
    }
    return root.dataset.theme;
  }
  function toggle() { return theme(theme() === 'dark' ? 'light' : 'dark') }
  function onTheme(f) { listeners.push(f) }

  (function boot() {
    let saved = null;
    try { saved = localStorage.getItem(STORE) } catch (e) { /* ignore */ }
    root.dataset.theme = saved
      || root.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  })();

  const css = n => getComputedStyle(root).getPropertyValue('--' + n).trim();

  /* ── charts ────────────────────────────────────────────────────────────── */
  // A shared axis/grid style, so every chart keeps the same look.
  function base() {
    return {
      animationDuration: 620,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: getComputedStyle(root).getPropertyValue('--sans').trim(), fontSize: 11 },
      grid: { left: 8, right: 8, top: 18, bottom: 4, containLabel: true },
      tooltip: {
        backgroundColor: css('panel'),
        borderColor: css('line'),
        borderWidth: 1,
        padding: [7, 10],
        textStyle: { color: css('ink'), fontSize: 11.5 },
        extraCssText: 'border-radius:6px;box-shadow:none;backdrop-filter:blur(6px)',
        axisPointer: { lineStyle: { color: css('faint'), width: 1, type: [3, 3] } }
      },
      categoryAxis: {
        axisLine: { lineStyle: { color: css('line') } },
        axisTick: { show: false },
        axisLabel: { color: css('faint'), fontSize: 10.5 },
        splitLine: { show: false }
      },
      valueAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: css('faint'), fontSize: 10.5,
          fontFamily: getComputedStyle(root).getPropertyValue('--mono').trim()
        },
        // One faint dashed rule per gridline is all a reader needs to compare
        // heights; a full grid competes with the data.
        splitLine: { lineStyle: { color: css('line-soft'), type: [3, 4] } }
      }
    };
  }

  function axis(kind, extra) { return Object.assign({}, base()[kind + 'Axis'], extra || {}) }

  function chart(el, build) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return null;
    const rec = { el, build, inst: echarts.init(el, null, { renderer: 'canvas' }) };
    rec.inst.setOption(Object.assign(base(), build(rec.inst)));
    charts.push(rec);
    return rec.inst;
  }

  function retheme() {
    charts.forEach(r => {
      // Rebuild in place (notMerge) instead of dispose+init: callers keep the
      // instance Kit.chart returned, and disposing here would orphan every handle.
      r.inst.setOption(Object.assign(base(), r.build(r.inst)), true);
    });
  }

  /* replace=true rebuilds from scratch: merge mode keeps stale series when the
     new option has fewer of them, which quietly no-ops series-count toggles. */
  function update(inst, option, replace) { inst && inst.setOption(option, !!replace) }

  /* Charts living in rebuild-on-open UI (drawers, modals) must leave the
     retheme registry when their DOM dies — otherwise retheme() keeps rebuilding
     detached nodes with stale closures on every theme toggle. */
  function release(inst) {
    const i = charts.findIndex(r => r.inst === inst);
    if (i >= 0) { charts.splice(i, 1); inst.dispose(); }
  }

  /* Pages that build their charts with their own draw() helper can't be
     rethemed by Kit.retheme(), because their options were built with colours
     already resolved. They hand over their redraw instead, and get the button
     for free rather than each growing its own. */
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">'
    + '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M22 12h-2.4M4.4 12H2'
    + 'M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7M19.1 19.1l-1.7-1.7M6.6 6.6L4.9 4.9"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">'
    + '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';

  function themeToggle(redraw, mount) {
    const btn = document.createElement('button');
    btn.className = 'kit-theme';
    btn.type = 'button';
    btn.title = '切换明暗 · Toggle theme';
    btn.setAttribute('aria-label', 'Toggle theme');
    const paint = () => { btn.innerHTML = theme() === 'dark' ? SUN : MOON };
    paint();
    if (typeof mount === 'string') mount = document.querySelector(mount);
    if (mount) {
      mount.appendChild(btn);
    } else {
      // Floating, so a page with no room in its header still gets one.
      btn.classList.add('kit-theme-float');
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', () => {
      toggle();
      paint();
      try { if (redraw) redraw() } catch (e) { console.error('redraw after theme change', e) }
    });
    return btn;
  }

  addEventListener('resize', () => charts.forEach(r => r.inst.resize()));

  /* ── numbers ───────────────────────────────────────────────────────────── */
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d });

  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return fmt(n);
  }

  /* Counting up is the one animation a dashboard genuinely earns: it shows a
     figure changed, which a silent re-render hides. */
  function count(el, to, { d = 1, ms = 600, prefix = '', suffix = '' } = {}) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = prefix + fmt(to, d) + suffix;
      return;
    }
    const from = parseFloat((el.dataset.v || '0')) || 0;
    el.dataset.v = to;
    const t0 = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + fmt(from + (to - from) * e, d) + suffix;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ── entrance ──────────────────────────────────────────────────────────── */
  function reveal(sel = '[data-reveal]') {
    const els = [...document.querySelectorAll(sel)];
    els.forEach((el, i) => el.style.setProperty('--i', i % 12));
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
    }), { rootMargin: '0px 0px -5% 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ── segmented control ─────────────────────────────────────────────────── */
  /* Wires the sliding pill and calls back with the chosen value. Returns a
     setter so code can move the selection without faking a click. */
  function seg(container, onPick) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) return () => {};
    const items = [...container.children].filter(c => !c.classList.contains('pill'));
    let pill = container.querySelector('.pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.e2e = 'noop';
      container.appendChild(pill);
    }
    function place(el, animate = true) {
      if (!animate) pill.style.transition = 'none';
      pill.style.width = el.offsetWidth + 'px';
      pill.style.transform = `translateX(${el.offsetLeft - container.clientLeft - 2}px)`;
      if (!animate) requestAnimationFrame(() => { pill.style.transition = '' });
    }
    function pick(el, fire = true) {
      items.forEach(i => i.classList.toggle('on', i === el));
      place(el);
      if (fire && onPick) onPick(el.dataset.v ?? el.textContent.trim(), el);
    }
    items.forEach(el => el.addEventListener('click', () => pick(el)));
    const on = items.find(i => i.classList.contains('on')) || items[0];
    if (on) { items.forEach(i => i.classList.toggle('on', i === on)); place(on, false) }
    addEventListener('resize', () => {
      const cur = items.find(i => i.classList.contains('on'));
      if (cur) place(cur, false);
    });
    // The setter deliberately does not fire onPick. Settings syncs its theme
    // control from the current theme, and firing here would call back into
    // Kit.theme, which re-renders the view, which syncs the control again.
    return v => { const el = items.find(i => (i.dataset.v ?? i.textContent.trim()) === v); if (el) pick(el, false) };
  }

  /* ── sortable table ────────────────────────────────────────────────────── */
  /* Sorting is declared on the header (data-sort="n" for numeric) and applied to
     whatever rows are in the tbody, so a re-render doesn't need to re-bind. */
  function sortable(table) {
    if (typeof table === 'string') table = document.querySelector(table);
    if (!table) return;
    table.querySelectorAll('thead th[data-sort]').forEach((th, idx) => {
      th.classList.add('sortable');
      if (!th.querySelector('.caret')) th.insertAdjacentHTML('beforeend', '<span class="caret">↓</span>');
      th.addEventListener('click', () => {
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        table.querySelectorAll('thead th').forEach(o => { delete o.dataset.dir; });
        th.dataset.dir = dir;
        th.querySelector('.caret').textContent = dir === 'asc' ? '↑' : '↓';
        const col = [...th.parentElement.children].indexOf(th);
        const num = th.dataset.sort === 'n';
        const tb = table.tBodies[0];
        const rows = [...tb.rows].sort((a, b) => {
          const av = a.cells[col]?.textContent.trim() ?? '';
          const bv = b.cells[col]?.textContent.trim() ?? '';
          const cmp = num
            ? (parseFloat(av.replace(/[^\d.-]/g, '')) || 0) - (parseFloat(bv.replace(/[^\d.-]/g, '')) || 0)
            : av.localeCompare(bv, 'zh-Hans-CN');
          return dir === 'asc' ? cmp : -cmp;
        });
        rows.forEach(r => tb.appendChild(r));
      });
    });
  }

  /* ── deterministic demo data ───────────────────────────────────────────── */
  /* Seeded so a screenshot taken now matches one taken tomorrow — the sample
     figures must not move between reloads. */
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  }

  function download(name, text, mime = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: mime }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toCSV(rows) {
    return rows.map(r => r.map(c => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  }

  /* A toast is how an export or a save reports success when there is no backend
     to report it — silence would be indistinguishable from a dead button. */
  function toast(msg) {
    let host = document.querySelector('.kit-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'kit-toasts';
      host.style.cssText = 'position:fixed;z-index:9999;right:18px;bottom:18px;display:flex;'
        + 'flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'background:var(--ink);color:var(--bg);font-size:12.5px;padding:8px 13px;'
      + 'border-radius:var(--r-sm);opacity:0;transform:translateY(6px);'
      + 'transition:opacity .26s var(--ease),transform .26s var(--ease)';
    host.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'none' });
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }

  return { theme, toggle, onTheme, css, chart, retheme, update, release, base, axis, themeToggle,
           fmt, compact, count, reveal, seg, sortable, rng, download, toCSV, toast };
})();

export default Kit;

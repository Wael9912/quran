/* Quran Researcher — front end (Cytoscape.js 3 + fCoSE + layers, no build step)
 *
 * The graph is hierarchical: query ★ → theme boxes → sub-theme boxes → ayat. Roots sit inside the
 * theme they belong to, or between boxes when they bridge themes. Three layouts share one graph:
 *   organised  fCoSE inside each theme, theme boxes placed on a ring around the query (default)
 *   radial     ayat on a circle grouped by theme, roots inside, cross-theme links bundled via the centre
 *   free       force layout over every link, themes drawn as hulls
 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  // Tanzil writes pause marks as their own space-separated token; a no-break space keeps each mark
  // on the line of the word it belongs to instead of letting it wrap to the start of the next line
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    .replace(/ ([\u06D6-\u06DC\u06E9])/g, '\u00A0$1');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const RLM = '‏', LRM = '‎';

  // interface text comes from i18n.js (t), in the language the page is in (L); see the CLAUDE.md note
  const { t } = window.I18N;
  const L = () => window.I18N.lang;
  // data in a fixed language (Arabic words, names, the English translation) keeps its own lang + dir,
  // so it renders with the right font and direction inside either UI
  const isAr = (s) => /[؀-ۿ]/.test(String(s || ''));
  const bdiAr = (s) => `<bdi lang="ar" dir="rtl">${esc(s)}</bdi>`;
  const bdiAuto = (s) => (isAr(s) ? bdiAr(s) : `<bdi lang="en" dir="ltr">${esc(s)}</bdi>`);
  const enAttr = 'lang="en" dir="ltr"';
  const times = (n) => `<bdi dir="ltr">${n}×</bdi>`;   // «58×» stays in that order inside Arabic text

  // browser build (build/web): no server, the engine runs in a worker (static/worker.js) that answers
  // the same API calls; WEB.call resolves to what fetch would give: { status, body }
  const WEB = window.QR_WEB ? (() => {
    let w = null;
    const queue = [];                  // calls made before the worker exists
    const waiting = new Map();
    let next = 0, fatal = null;
    const el = $('#webLoad');
    const show = (msg) => { el.textContent = msg; el.hidden = !msg; };
    show(t('web.py'));
    swControl().then(() => {
      w = new Worker('static/worker.js', { type: 'module' });
      w.onmessage = onMessage;
      for (const m of queue.splice(0)) w.postMessage(m);
    });
    function onMessage({ data: m }) {
      if (m.type === 'reply') {
        const p = waiting.get(m.id); waiting.delete(m.id);
        if (p) p({ status: m.status, body: (() => { try { return JSON.parse(m.text); } catch (_) { return null; } })() });
      } else if (m.type === 'progress') {
        if (m.stage === 'model') show(t('web.model', { p: Math.round(100 * m.loaded / m.total), mb: Math.round(m.total / 1e6) }));
        else if (m.stage === 'modelReady') show('');
        else if (m.stage === 'modelFail') { console.error(m.error); show(t('web.modelFail')); }
        else show(t('web.' + m.stage));
      } else if (m.type === 'fatal') {
        fatal = m.error; show(t('web.fail'));
        for (const p of waiting.values()) p({ status: 0, body: null });
        waiting.clear();
      }
    }
    return {
      call(url, opts = {}) {
        if (fatal) return Promise.resolve({ status: 0, body: null });
        return new Promise((resolve) => {
          const id = next++;
          waiting.set(id, resolve);
          const m = { id, method: opts.method || 'GET', url, body: opts.body ?? null };
          if (w) w.postMessage(m); else queue.push(m);
        });
      },
    };
  })() : null;

  // the service worker (sw.js, browser build) keeps what the engine worker downloads, so the installed
  // app opens offline. A worker is only served by the service worker that controlled the page when it
  // started: on a first visit wait (up to 4 s) for it to take over, so that first download is kept too
  async function swControl() {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    try {
      const taken = new Promise((ok) => sw.addEventListener('controllerchange', ok, { once: true }));
      await sw.register('sw.js', { updateViaCache: 'none' });
      if (!sw.controller) await Promise.race([taken, new Promise((ok) => setTimeout(ok, 4000))]);
    } catch (err) { console.warn('service worker:', err); }
  }

  async function api(url, opts) {
    if (WEB) {
      const { status, body } = await WEB.call(url, opts);
      if (status === 0) throw new Error((body && body.error) || t('web.fail'));
      if (status >= 400) throw new Error((body && body.error && I18N.note(body.error)) || t('err.server', { n: status }));
      return body;
    }
    let r;
    try { r = await fetch(url, opts); } catch (_) {
      throw new Error(t('err.offline'));
    }
    let body = null;
    try { body = await r.json(); } catch (_) { /* not JSON */ }
    if (!r.ok) throw new Error((body && body.error && I18N.note(body.error)) || t('err.server', { n: r.status }));
    return body;
  }

  // graph colours per UI theme; canvas can't read CSS variables, so the two sets live here
  const GRAPH = {
    dark: {
      pal: ['#5aa9e6', '#7bd389', '#f2c14e', '#b388eb', '#4ecdc4', '#ff7eb6', '#c3e88d', '#f78c6c',
        '#82aaff', '#89ddff', '#f07178', '#9ccc65', '#ba68c8', '#4db6ac', '#ffd54f', '#90a4ae'],
      query: '#f0c35a', root: '#ef8a3c', seed: '#fff1c9', misc: '#8a94a3', node: '#9aa7b8',
      meccan: '#5aa9e6', medinan: '#7bd389', surahL: 62, surahS: 58,
      label: '#e2dccf', ayahLabel: '#c3cad5', rootLabel: '#f5c899', bridgeLabel: '#ffd7aa', bridgeRing: '#ffd9a8',
      outline: '#0f141c', bg: '#0f141c', subFill: '#ffffff', subLine: '#75849a', subLabel: '#bcc4d0',
      pin: '#ffffff', match: '#ffe08a', sel: '#ffe7ad', tlLabel: '#b8c1ce', tlLabelOn: '#e2dccf',
      distText: '#929cac', distTitle: '#e9e3d6',
      frame: '#5b6577', frameOn: '#f0c35a', frozen: '#9fb3cc', twin: '#5ad6c9', card: '#1a2230', cardText: '#f3ead2',
      e: { root: '#b98a5e', bridge: '#d0a072', meaning: '#4cc3b8', phrase: '#c886ea', cooc: '#9cb0cc', tlink: '#9aa8bc', anchor: '#f0c35a', form: '#c9a86a' },
      op: { root: 0.55, bridge: 0.38, meaning: 0.7, phrase: 0.9, cooc: 0.5, tl0: 0.22, tl1: 0.6, faded: 0.06 },
    },
    light: {
      pal: ['#2b78c2', '#2e9a4a', '#b88600', '#7b4fc9', '#12897f', '#cf3f7c', '#5c8d17', '#d0601f',
        '#3d5fd9', '#0b86ad', '#c93a3a', '#4a8a24', '#9c3fb0', '#18877c', '#a37400', '#5b6b7a'],
      query: '#c98a0b', root: '#c45a0e', seed: '#3a2a05', misc: '#7a828e', node: '#8794a6',
      meccan: '#2f7fc1', medinan: '#2f9a4c', surahL: 42, surahS: 60,
      label: '#2a2e35', ayahLabel: '#4a525e', rootLabel: '#9a4306', bridgeLabel: '#8a3a02', bridgeRing: '#8a3a02',
      outline: '#faf8f3', bg: '#faf8f3', subFill: '#000000', subLine: '#9aa3b0', subLabel: '#4f5864',
      pin: '#1f2329', match: '#e0a100', sel: '#b37a00', tlLabel: '#4f5864', tlLabelOn: '#2a2e35',
      distText: '#646c78', distTitle: '#1f2329',
      frame: '#aab2bf', frameOn: '#c98a0b', frozen: '#6f8099', twin: '#12897f', card: '#fffaf0', cardText: '#1d1a12',
      e: { root: '#9a6a3c', bridge: '#a86f38', meaning: '#138a80', phrase: '#9246c0', cooc: '#6c7f99', tlink: '#7d8796', anchor: '#c98a0b', form: '#a0814a' },
      op: { root: 0.55, bridge: 0.5, meaning: 0.7, phrase: 0.85, cooc: 0.5, tl0: 0.25, tl1: 0.6, faded: 0.07 },
    },
  };
  const themeName = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  let G = GRAPH[themeName()];
  // [query, hint key]: the queries are data (searched as typed); English topics get a hint only in Arabic
  const EXAMPLES = [
    ['الصبر', 'ex.word'], ['ص ب ر', 'ex.root'], ['موسى', 'ex.name'], ['اليتامى', 'ex.orphans'],
    ['يوم القيامة', 'ex.phrase'], ['patience in hardship', 'ex.topicEn'], ['mercy and forgiveness', 'ex.topicEn'],
    ['justice between people', 'ex.topicEn'], ['2:255', 'ex.kursi'], ['الحمد لله رب العالمين', 'ex.text'],
  ];

  const S = {
    view: 'search', cy: null, layer: null, badges: null, rootNet: null,
    mode: 'organized', colorBy: 'theme', edgeOn: { root: true, meaning: true, phrase: true, tlink: true, cooc: true, anchor: true, form: true },
    xMode: 'focus', labelMode: 'snippet', sortBy: 'theme', showShared: false,
    hover: null, focusTheme: null, selected: null,
    find: { matches: [], i: -1 },
    ayahCache: new Map(),
    // the ayah open in Details (index), its last position in the results list, per-tab scroll, passage cache
    selI: null, listPos: -1, tabScroll: { results: 0, node: 0, detail: 0, notes: 0 }, passCache: new Map(), reader: null, restIO: null,
    // what Details shows ({kind, ref|r, phrase}) and the open tooltip, so a language switch can redraw both
    detail: null, tip: null, rootCache: new Map(), phrases: null,
    seq: { search: 0, detail: 0 }, busy: 0, modeTok: 0, modeChain: Promise.resolve(), boxChain: Promise.resolve(),
    // the root clicked in the graph ({id, root, marks, cid}) and the list Details steps through ('results' | 'node')
    selRoot: null, listSrc: 'results',
    // the workspace: every search is a cluster (a network) on the one canvas; the active one feeds the side panel.
    // copies: ayah index -> the ids of its nodes across clusters; undo: removed / refined clusters; row: slot placement
    clusters: new Map(), active: null, mru: [], copies: new Map(), undo: [], cseq: 0, anyBig: false, row: null, menu: null,
    hydrating: 0,
  };
  const EMPTY = Object.freeze({ map: new Map(), arr: Object.freeze([]) });
  const act = () => (S.active && S.clusters.get(S.active)) || null;
  // the active cluster's search state under the old names, so the panel code reads naturally
  Object.defineProperties(S, {
    data: { get: () => (act() ? act().data : null) },
    resultByI: { get: () => (act() ? act().resultByI : EMPTY.map) },
    order: { get: () => (act() ? act().order : EMPTY.arr) },
    kind: { get: () => (act() ? act().kind : null) },
  });

  /* ------------------------------------------------------------ cluster ids
   * 'c3' is a network's frame node, 'c3:q' its ★, 'c3:a:120' an ayah, 'c3:r:صبر' a root, 'c3:t0' a theme box,
   * 'c3:t0.1' a sub-theme, 'c3:t0:a' a theme's anchor, 'c3:e17' / 'c3:tl:t0|t1' its edges; 'X:anc:c3' is the
   * branch link into c3 from another network. Every element carries data.cid. Never build '#id' selectors. */
  const mk = (cid, local) => `${cid}:${local}`;
  const cidOf = (id) => { const m = /^(c\d+)(?::|$)/.exec(String(id)); return m ? m[1] : null; };
  const localOf = (id) => { const c = cidOf(id); return c && id.length > c.length ? id.slice(c.length + 1) : ''; };
  const ayahIdx = (id) => { const m = /(?:^|:)a:(\d+)$/.exec(String(id)); return m ? +m[1] : null; };
  const ayahId = (c, i) => `${c}:a:${i}`;
  const rootId = (c, r) => `${c}:r:${r}`;
  const qId = (c) => `${c}:q`;
  const cl = (id) => S.clusters.get(cidOf(id)) || null;            // the cluster an element id belongs to
  const clOf = (ele) => S.clusters.get(ele.data('cid')) || null;
  const copiesOf = (i) => S.copies.get(i) || EMPTY_SET;             // every network's node for ayah i
  const EMPTY_SET = new Set();
  const allC = () => [...S.clusters.values()];
  const nodesOf = (C) => S.cy.nodes(`[cid="${C.id}"]`).not('[kind="cluster"]');
  const frameOf = (C) => S.cy.$id(C.id);
  const qOf = (C) => S.cy.$id(qId(C.id));
  const themesOf = (C) => S.cy.nodes(`[kind="theme"][cid="${C.id}"]`);
  const themesSortedOf = (C) => themesOf(C).sort((a, b) => a.data('order') - b.data('order'));
  const ayahNodesOf = (C) => S.cy.nodes(`[kind="ayah"][cid="${C.id}"]`);
  // what is drawn: not inside a closed theme box, not inside a folded network
  const drawn = (n) => !n.hasClass('hidden') && !n.hasClass('ch');

  /* ------------------------------------------------------------ Arabic helpers */
  const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
  function normAr(s) {
    return String(s || '').replace(TASHKEEL, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/[ؤئ]/g, 'ء').replace(/[^\u0621-\u064A0-9: ]/g, '').trim();
  }
  const nospace = (s) => s.replace(/\s+/g, '');
  const toLatinDigits = (s) => s.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6F0).replace(/[：٫]/g, ':');

  /* ------------------------------------------------------------ seeded random (stable layouts) */
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------ colours and labels */
  const themeColor = (t) => (t.misc ? G.misc : G.pal[t.c % G.pal.length]);
  // a theme's names in the UI language: Arabic shows label_ar only; English shows label_en first with
  // label_ar after it (label_ar alone when the server has no English name, or the user renamed the theme)
  function themeNames(d) {
    const ar = d.label_ar || '·', en = L() === 'en' ? d.label_en : '';
    return en ? { main: en, sub: ar } : { main: ar, sub: '' };
  }
  // HTML for a list row / heading: the main name, then (English UI, withSub) the Arabic one, each with its own lang
  function nameHtml(d, withSub = true) {
    const nm = themeNames(d);
    const main = `<bdi class="nm-main"${isAr(nm.main) ? ' lang="ar" dir="rtl"' : ''}>${d.related ? '≈ ' : ''}${esc(nm.main)}</bdi>`;
    return withSub && nm.sub ? `${main} <bdi class="nm-sub" lang="ar" dir="rtl">${esc(nm.sub)}</bdi>` : main;
  }
  const countOf = (n) => t(S.kind === 'roots' ? 'cnt.roots' : 'cnt.ayat', { n });
  // an Arabic run in a canvas label (#graph is ltr): the RLMs keep its neutrals inside the run, and in the
  // English UI a trailing LRM keeps the « · 13 ayat» after it from being pulled into the Arabic run
  const cv = (s) => (isAr(s) ? `${RLM}${s}${RLM}${L() === 'en' ? LRM : ''}` : s);
  // Cytoscape draws labels on OffscreenCanvas contexts, which take the document's direction when they are
  // created (rtl in the Arabic UI, and they keep it after a language switch); an isolate per line makes each
  // label lay out in the UI language's direction whatever its canvas thinks (FSI: the query, by its own text)
  const isoLine = (s) => `${L() === 'ar' ? '\u2067' : '\u2066'}${s}\u2069`;
  const isoAuto = (s) => `\u2068${s}\u2069`;
  // the canvas label of a theme box: its name, then a line with the count (and the Arabic name in English)
  function themeLabel(d, collapsed = false) {
    const nm = themeNames(d);
    const meta = [nm.sub ? cv(nm.sub) : '', countOf(d.size), d.related ? t('g.byMeaning') : '', d.pulled ? t('g.pulled') : '']
      .filter(Boolean).join(' · ');
    return `${isoLine(cv(`${d.related ? '≈ ' : ''}${nm.main}`))}\n${isoLine(`${L() === 'ar' ? `${RLM}${meta}${RLM}` : meta}${collapsed ? '  ⊞' : ''}`)}`;
  }
  // sub-theme boxes: the same rule, on one line
  function subLabel(d) {
    const nm = themeNames(d);
    if (!d.label_ar) return isoLine(t('g.part', { k: d.k + 1 }));
    return isoLine(nm.sub ? `${nm.main} · ${cv(nm.sub)}` : cv(nm.main));
  }
  function ayahColor(d) {
    if (S.colorBy === 'place') return d.stype === 'Meccan' ? G.meccan : G.medinan;
    if (S.colorBy === 'surah') return `hsl(${(d.s * 137.508) % 360}, ${G.surahS}%, ${G.surahL}%)`;
    const t = S.cy && d.theme ? S.cy.$id(d.theme) : null;
    return t && t.nonempty() ? t.data('col') : G.misc;
  }

  /* ------------------------------------------------------------ cytoscape style */
  const FONT = 'NotoNaskh, Amiri, serif';
  const LABEL_MAX = 34;   // model size of a theme name assumed when spacing the ring (labels are sized by zoom: sizeLabels)
  const BIG_GRAPH = 200;   // ayat above which a search graph opens as the theme map (see mountGraph; = LARGE_GRAPH)
  const buildStyle = () => [
    { selector: 'node', style: {
      label: 'data(label)', 'font-family': FONT, color: G.label, 'font-size': 11, 'min-zoomed-font-size': 7,
      'text-valign': 'bottom', 'text-margin-y': 3, 'background-color': G.node,
      'text-outline-color': G.outline, 'text-outline-width': 2, 'text-outline-opacity': 0.85, 'overlay-opacity': 0,
      'transition-property': 'opacity', 'transition-duration': 150 } },
    { selector: 'node[sz]', style: { width: 'data(sz)', height: 'data(sz)' } },
    { selector: 'node[col]', style: { 'background-color': 'data(col)' } },
    { selector: 'node[kind="ayah"]', style: { 'font-family': '-apple-system, BlinkMacSystemFont, sans-serif', 'font-size': 9, color: G.ayahLabel } },
    { selector: 'node[kind="ayah"][!lexical][col]', style: { 'background-opacity': 0.18, 'border-width': 2, 'border-color': 'data(col)' } },
    { selector: 'node[role="seed"]', style: { 'border-width': 3, 'border-color': G.seed, 'font-size': 11, color: G.seed, 'font-weight': 'bold' } },
    { selector: 'node[kind="root"]', style: {
      shape: 'round-diamond', 'background-color': 'data(col)', 'font-size': 12, 'font-weight': 'bold', color: G.rootLabel, 'min-zoomed-font-size': 6 } },
    { selector: 'node[kind="root"][?bridge]', style: { 'border-width': 2, 'border-color': G.bridgeRing, color: G.bridgeLabel } },
    { selector: 'node[kind="query"]', style: {
      shape: 'star', 'background-color': G.query, width: 38, height: 38, 'font-size': 18, color: G.query,
      'font-weight': 'bold', 'min-zoomed-font-size': 0, 'text-margin-y': 5 } },
    { selector: 'node[kind="theme"]', style: {
      shape: 'round-rectangle', 'background-color': 'data(col)', 'background-opacity': 0.07, 'border-color': 'data(col)',
      'border-width': 2, 'border-opacity': 0.9, 'text-valign': 'top', 'text-halign': 'center', 'font-size': 16,
      'font-weight': 'bold', color: 'data(col)', padding: 18, 'text-wrap': 'wrap', 'text-max-width': 320,
      'text-margin-y': -6, 'min-zoomed-font-size': 0, 'line-height': 1.25, 'corner-radius': 14,
      'compound-sizing-wrt-labels': 'exclude' } },   // children's zoom-sized labels must not swell the box
    { selector: 'node[kind="theme"][?related]', style: { 'border-style': 'dashed', 'background-opacity': 0.04 } },
    { selector: 'node[kind="sub"]', style: {
      shape: 'round-rectangle', 'background-color': G.subFill, 'background-opacity': 0.03, 'border-style': 'dashed',
      'border-width': 1, 'border-color': G.subLine, 'text-valign': 'top', 'text-halign': 'center', 'font-size': 12,
      color: G.subLabel, padding: 12, 'min-zoomed-font-size': 0, 'text-margin-y': -3, 'text-wrap': 'wrap', 'text-max-width': 220,
      'compound-sizing-wrt-labels': 'exclude' } },
    // list layout (snippet labels in an organised box): the ayat under each other, each label on the right of its
    // node; the box reserves that width (`mw`, model px) on the label's side so nothing spills. Elsewhere an ayah
    // label sits on the side of its node its links leave empty (`placeLabelSides`): .sl left, .sr right, .su above
    { selector: 'node[kind="theme"][mw], node[kind="sub"][mw]', style: {
      'min-width': 'data(mw)', 'min-width-bias-left': 'data(bl)', 'min-width-bias-right': 'data(br)' } },
    { selector: 'node.sl', style: { 'text-halign': 'left', 'text-valign': 'center', 'text-justification': 'right', 'text-margin-x': -5 } },
    { selector: 'node.sr', style: { 'text-halign': 'right', 'text-valign': 'center', 'text-justification': 'left', 'text-margin-x': 5 } },
    { selector: 'node.su', style: { 'text-valign': 'top' } },
    { selector: 'node.collapsed', style: {
      'min-width': 240, 'min-height': 84, 'text-valign': 'center', 'background-opacity': 0.2, 'text-margin-y': 0, 'text-max-width': 230 } },
    { selector: 'node.ghost', style: { 'background-opacity': 0, 'border-width': 0, label: '', events: 'no' } },
    { selector: 'node.nolabel', style: { label: '' } },
    { selector: 'node.lz', style: { label: '' } },   // no room for it at this zoom (declutter)
    { selector: 'node[kind="anchor"]', style: { width: 1, height: 1, opacity: 0, events: 'no', label: '' } },
    { selector: 'node.pinned', style: { 'border-width': 2, 'border-color': G.pin, 'border-style': 'double' } },
    { selector: 'node.match', style: { 'border-width': 4, 'border-color': G.match, 'border-style': 'solid' } },
    { selector: 'node:selected', style: { 'border-width': 4, 'border-color': G.sel, 'border-style': 'solid', 'z-index': 20 } },
    { selector: 'node.pinned-box', style: { 'border-style': 'double', 'border-width': 4 } },
    // a network's frame: a faint box around one search; the active one is gold, a frozen one double-lined.
    // (its padding is fixed and it never gets a cascading class: a restyle of the frame would walk every descendant)
    { selector: 'node[kind="cluster"]', style: {
      shape: 'round-rectangle', 'background-opacity': 0, 'border-width': 1.5, 'border-style': 'dashed', 'border-color': G.frame,
      'border-opacity': 0.55, padding: 56, 'corner-radius': 28, 'text-valign': 'top', 'text-halign': 'center', 'font-size': 16,
      'font-weight': 'bold', color: G.frame, 'text-margin-y': -8, 'min-zoomed-font-size': 0, 'text-outline-width': 0,
      'compound-sizing-wrt-labels': 'exclude', 'z-index-compare': 'manual', 'z-index': 0 } },
    { selector: 'node[kind="cluster"].solo', style: { 'border-opacity': 0, label: '' } },   // one network alone needs no frame
    { selector: 'node[kind="cluster"].cl-active', style: { 'border-color': G.frameOn, 'border-opacity': 0.9, color: G.frameOn, 'border-style': 'solid' } },
    { selector: 'node[kind="cluster"].cl-frozen', style: { 'border-style': 'double', 'border-width': 4, 'border-color': G.frozen, 'border-opacity': 0.9 } },
    { selector: 'node[kind="cluster"].cl-frozen.cl-active', style: { 'border-color': G.frameOn } },
    { selector: 'node[kind="cluster"].cl-folded', style: { 'border-opacity': 0, label: '' } },
    { selector: 'node[kind="cluster"]:selected', style: { 'border-width': 1.5, 'border-color': G.frame, 'z-index': 0 } },
    { selector: '.ch', style: { display: 'none' } },   // inside a folded network
    { selector: 'node[kind="query"].folded', style: { width: 54, height: 54, 'font-size': 16 } },
    { selector: 'node.twin', style: { 'border-width': 3, 'border-color': G.twin, 'border-style': 'solid' } },   // the same ayah in another network
    // ayah labels with text: wrapped by hand into a few isolate-wrapped lines (Cytoscape must never re-split them)
    { selector: 'node.snip, node.full', style: {
      'font-family': FONT, 'text-wrap': 'wrap', 'text-max-width': 100000, 'line-height': 1.35, 'text-justification': 'center' } },
    { selector: 'node.full', style: {
      'text-background-color': G.card, 'text-background-opacity': 0.96, 'text-background-shape': 'round-rectangle',
      'text-background-padding': 8, 'text-border-width': 1, 'text-border-color': G.frame, 'text-border-opacity': 0.8, color: G.cardText,
      'text-outline-width': 0, 'z-index': 30 } },

    { selector: 'edge', style: {
      'curve-style': 'haystack', 'haystack-radius': 0, width: 0.9, 'line-color': G.e.root, opacity: G.op.root } },
    { selector: 'edge[type="root"][cross="bridge"]', style: { opacity: G.op.bridge, width: 1, 'line-color': G.e.bridge } },
    // the branch link from a node to the ★ of the network searched from it
    { selector: 'edge[type="anchor"]', style: {
      'curve-style': 'straight', 'line-style': 'dashed', 'line-dash-pattern': [8, 6], 'line-color': G.e.anchor, width: 2.2, opacity: 0.85,
      'target-arrow-shape': 'triangle', 'target-arrow-color': G.e.anchor, 'arrow-scale': 1.1, 'z-index': 25, 'z-index-compare': 'manual' } },
    // an ayah that also holds another form (lemma) of the searched root: a faint link to that form's box
    { selector: 'edge[type="form"]', style: { 'curve-style': 'straight', 'line-style': 'dotted', 'line-color': G.e.form, width: 1, opacity: 0.45 } },
    { selector: 'edge[type="meaning"]', style: { 'line-color': G.e.meaning, width: 1.3, opacity: G.op.meaning } },
    { selector: 'edge[type="phrase"]', style: { 'curve-style': 'bezier', 'line-color': G.e.phrase, width: 2.2, opacity: G.op.phrase } },
    { selector: 'edge[type="cooc"]', style: { 'line-color': G.e.cooc, width: 'mapData(w, 0, 12, 0.6, 3)', opacity: G.op.cooc } },
    { selector: 'edge[type="tlink"]', style: {
      'curve-style': 'straight', 'line-color': G.e.tlink, width: 'data(wd)', opacity: `mapData(n, 1, 12, ${G.op.tl0}, ${G.op.tl1})`, 'line-cap': 'round',
      label: 'data(tl)', 'font-size': 10, color: G.tlLabel, 'text-background-color': G.bg, 'text-background-opacity': 0.85,
      'text-background-padding': 3, 'min-zoomed-font-size': 0, 'text-rotation': 'none' } },
    { selector: 'edge[type="tlink"][tl != ""]', style: { 'font-size': 14, color: G.tlLabelOn, opacity: Math.max(0.7, G.op.tl1) } },
    { selector: 'edge.quiet', style: { opacity: G.op.tl0 * 0.6, label: '' } },
    { selector: 'edge.x', style: { display: 'none' } },
    { selector: 'edge.x.show', style: { display: 'element', opacity: 0.75, width: 1.4 } },
    { selector: 'edge.bund', style: {
      'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(cpd)', 'control-point-weights': 'data(cpw)',
      'edge-distances': 'node-position' } },
    { selector: 'edge.off, edge.tl-hide', style: { display: 'none' } },
    { selector: '.hidden', style: { display: 'none' } },
    { selector: 'edge.hl', style: { opacity: 0.95, width: 2, 'z-index': 10 } },
    { selector: 'node.faded', style: { opacity: 0.13, 'text-opacity': 0 } },
    { selector: 'node[kind="theme"].faded, node[kind="sub"].faded', style: { opacity: 0.3, 'text-opacity': 0.35 } },
    { selector: 'edge.faded', style: { opacity: G.op.faded } },
  ];

  /* ------------------------------------------------------------ mounting */
  // the Cytoscape elements of one network: its frame, ★, theme boxes, ayat, roots and inner links, every id
  // prefixed with the network's id and every element tagged with it (data.cid)
  function elementsFor(C, g, queryLabel, big = false) {
    const cid = C.id, kind = C.kind, p = (x) => mk(cid, x);
    const els = [];
    const tcol = new Map((g.themes || []).map((t) => [t.id, themeColor(t)]));
    els.push({ group: 'nodes', classes: 'solo', data: { id: cid, kind: 'cluster', cid, label: '', n: C.n } });
    if (kind === 'search') {
      const q = queryLabel.length > 28 ? queryLabel.slice(0, 26) + '…' : queryLabel;
      els.push({ group: 'nodes', data: { id: qId(cid), kind: 'query', cid, parent: cid, label: isoAuto(q), q: queryLabel, sz: 38, col: G.query } });
    }
    (g.themes || []).forEach((t) => {
      // a lemma box carries `lemma` (its note key, shared with the notes module); `pulled` / `added` mark an
      // expansion's theme, which a saved project keeps beside the server's graph
      els.push({ group: 'nodes', data: {
        id: p(t.id), kind: 'theme', cid, parent: cid, c: t.c, misc: t.misc, related: !!t.related, size: t.size, order: t.order, col: themeColor(t),
        label_ar: t.label_ar, label_en: t.label_en, roots: t.roots, tkind: t.kind || 'theme', key: t.key || null, tn: t.n, label: '',
        lemma: t.kind === 'lemma' && t.key ? t.key : null, pulled: !!t.pulled, added: !!t.added } });
      els.push(anchorEl(cid, p(t.id)));
    });
    (g.subthemes || []).forEach((s, k) => {
      const d = { id: p(s.id), kind: 'sub', cid, parent: p(s.parent), size: s.size, theme: p(s.parent), k, label_ar: s.label_ar, label_en: s.label_en };
      els.push({ group: 'nodes', data: { ...d, label: subLabel(d) } });
    });
    g.nodes.forEach((n) => {
      const d = { id: p(n.id), kind: n.type, cid, label: n.label, theme: n.theme ? p(n.theme) : null, parent: n.parent ? p(n.parent) : cid, added: !!n.added };
      if (n.type === 'ayah') {
        Object.assign(d, { ref: n.ref, role: n.role, s: n.s, stype: n.stype, lexical: !!n.lexical, rank: n.rank, col: tcol.get(n.theme) || G.misc,
          sz: n.sz != null ? n.sz : n.role === 'seed' ? 22 : 16 - 7 * (n.rank || 0), boxes: (n.boxes || []).map(p) });
      } else {
        const bridge = kind === 'search' && !n.parent;
        Object.assign(d, { root: n.root, n: n.n, na: n.na, gloss: n.gloss, bridge,
          sz: kind === 'roots' ? 8 + 2.2 * Math.sqrt(n.na / 6) : (bridge ? 18 + 2 * Math.sqrt(n.themes ? n.themes.length : 1) : 13),
          col: G.root });
      }
      els.push({ group: 'nodes', data: d });
    });
    g.edges.forEach((e, k) => {
      const cross = e.cross || '';
      els.push({ group: 'edges', classes: cross === 'theme' ? 'x' : '', data: {
        id: p(`e${k}`), cid, source: p(e.s), target: p(e.t), type: e.type, cross, w: e.w, n: e.n, phrase: e.label, added: !!e.added } });
    });
    // an ayah holding another form of the searched root too: a faint link to that form's box (drawn on focus, like cross-theme links)
    g.nodes.forEach((n) => (n.boxes || []).forEach((b, k) => {
      if (b !== n.theme) els.push({ group: 'edges', classes: 'x', data: { id: p(`f${n.id}_${k}`), cid, source: p(n.id), target: p(b), type: 'form', cross: 'theme' } });
    }));
    let links = g.theme_links || [];
    const maxN = Math.max(1, ...links.map((l) => l.n));
    if (big) {
      // hundreds of ayat link nearly every pair of themes: the map keeps each theme's 3 strongest links
      const keep = new Set();
      new Set(links.flatMap((l) => [l.s, l.t])).forEach((tid) => links.filter((l) => l.s === tid || l.t === tid)
        .sort((a, b) => b.n - a.n).slice(0, 3).forEach((l) => keep.add(l)));
      links = links.filter((l) => keep.has(l));
    }
    links.forEach((l) => els.push({ group: 'edges', data: {
      id: p(`tl:${l.s}|${l.t}`), cid, source: p(l.s), target: p(l.t), type: 'tlink', n: l.n, tl: '',
      wd: big ? 1.5 + 6.5 * Math.sqrt(l.n / maxN) : 1 + 1.6 * Math.sqrt(l.n),
      meaning: l.meaning, phrase: l.phrase, roots: l.roots } }));
    return els;
  }

  // Cytoscape stops moving a compound once all its children are hidden, so every theme carries an
  // invisible anchor child that is shown only while the box is closed and carries the box around
  const anchorEl = (cid, tid) => ({ group: 'nodes', classes: 'hidden', data: { id: `${tid}:a`, kind: 'anchor', cid, parent: tid, theme: tid, label: '' } });

  // every network's node for an ayah (its copies), kept up to date as nodes come and go
  function addCopy(n) { const i = ayahIdx(n.id()); if (i == null) return; let s = S.copies.get(i); if (!s) S.copies.set(i, (s = new Set())); s.add(n.id()); }
  function dropCopy(n) { const i = ayahIdx(n.id()); const s = i != null && S.copies.get(i); if (s) { s.delete(n.id()); if (!s.size) S.copies.delete(i); } }

  // the one canvas, created once; networks are added to it and removed from it, it is never rebuilt
  function ensureCy() {
    if (S.cy) return S.cy;
    $('#stage').classList.toggle('with-legend', !$('#legend').classList.contains('closed'));
    const cy = cytoscape({
      container: $('#graph'), elements: [], style: buildStyle(), layout: { name: 'preset', fit: false },
      minZoom: 0.03, maxZoom: 6, boxSelectionEnabled: false, selectionType: 'single', autoungrabify: false,
    });
    lightenStyleTriggers(cy);
    pinBackgrounding(cy);
    S.cy = cy;
    S.layer = cy.layers().nodeLayer.insertBefore('canvas');
    S.layer.callback(drawLayer);
    mountBadges(cy);
    bindGraphEvents(cy);
    return cy;
  }

  // the renderer's big-graph flags follow whether any network is big (3.34 reads them every frame; unofficial, so guarded)
  function syncBig() {
    const any = allC().some((C) => C.big);
    if (any === S.anyBig || !S.cy) return;
    S.anyBig = any;
    const R = S.cy.renderer();
    if (R && 'textureOnViewport' in R) { R.textureOnViewport = any; R.hideEdgesOnViewport = any; }
    if (any && !S.cy.__qrDrawOnly) { drawOnlyDisplayed(S.cy); S.cy.__qrDrawOnly = true; }
  }

  // everything off the canvas (a new project): the instance stays, the networks go
  function clearWorkspace() {
    releaseRoot({ graph: false });
    closeMenu();
    if (S.cy) S.cy.elements().remove();
    S.clusters.clear(); S.active = null; S.mru = []; S.copies.clear(); S.undo = []; S.row = null; S.hover = null; S.focusTheme = null; S.selected = null;
    S.cseq = 0;   // an empty canvas numbers its networks from ① again
    S.find = { matches: [], i: -1 };
    S.selI = null; S.listPos = -1; S.detail = null; S.reader = null;
    syncBig();
    $('#find').value = ''; $('#findCount').textContent = ''; delete $('#findCount').dataset.i18n;
    $('#btnThemesOnly').setAttribute('aria-pressed', 'false');
    $('#tooltip').hidden = true;
    $('#welcome').hidden = false;
    showChrome(false);
    $('#tab-results').innerHTML = `<div class="empty" data-i18n="empty.start">${t('empty.start')}</div>`;
    $('#tab-detail').innerHTML = `<div class="empty" data-i18n="empty.pickNode">${t('empty.pickNode')}</div>`;
    renderThemeList();
    updateSwitcher();
    emit('change');
  }

  // Cytoscape re-validates a compound node's whole subtree (descendants, parents and all their edges) for
  // every style property applied to it. Only display / visibility / opacity / events / width / height /
  // curve-style feed the cached state functions (visible, interactive, takesUpSpace, isBundledBezier) that
  // subtree check exists for; every other property (font size, colours, labels…) only needs the bounds and
  // z-order triggers. Skipping the subtree walk for those makes styling a theme box with hundreds of ayat
  // cheap: the first paint of a graph of every match and the zoom-time label resize depend on it.
  // (min-width / min-height / padding can take a compound from zero size, so they cascade too; they rarely change)
  const CASCADE = new Set(['display', 'visibility', 'opacity', 'events', 'width', 'height', 'curve-style',
    'min-width', 'min-height', 'padding']);
  function lightenStyleTriggers(cy) {
    const proto = Object.getPrototypeOf(cy.style());
    const own = proto.checkTriggers;
    if (proto.__qrLight || typeof own !== 'function' || !['checkZOrderTrigger', 'checkBoundsTrigger',
      'checkConnectedEdgesBoundsTrigger', 'checkParallelEdgesBoundsTrigger'].every((k) => typeof proto[k] === 'function')) return;
    proto.checkTriggers = function (ele, name, from, to) {
      if (CASCADE.has(name)) return own.call(this, ele, name, from, to);
      ele._private.styleCache = null;
      this.checkZOrderTrigger(ele, name, from, to);
      this.checkBoundsTrigger(ele, name, from, to);
      this.checkConnectedEdgesBoundsTrigger(ele, name, from, to);
      this.checkParallelEdgesBoundsTrigger(ele, name, from, to);
    };
    proto.__qrLight = true;
  }

  // Cytoscape 3.34 restyles every node it draws, twice a frame: a node without a background image flips its
  // `backgrounding` flag between the two image passes of drawNode, and each flip calls updateStyle, which for a
  // theme box marks its whole subtree (hundreds of ayat) dirty. No background images are used here, so the flag
  // is pinned to false on every node (new ones too).
  function pinBackgrounding(cy) {
    const pin = (n) => {
      const p = n._private;
      const d = Object.getOwnPropertyDescriptor(p, 'backgrounding');
      if (!d || !d.get) Object.defineProperty(p, 'backgrounding', { get: () => false, set: () => {}, configurable: true });
    };
    cy.nodes().forEach(pin);
    cy.on('add', 'node', (e) => pin(e.target));
  }

  // Cytoscape draws from a z-sorted list of every element and, for each frame, recomputes the rendered style of
  // hidden ones only to skip them: on a large graph's theme map (thousands of ayat hidden in closed boxes) that
  // cost ~60 ms a frame, so every hover stalled. Drop what isn't displayed from the list a large graph draws:
  // an element whose display is none, or an edge with a hidden end. (pstyle applies a pending style first, so
  // an element just shown is never left out.)
  function drawOnlyDisplayed(cy) {
    const R = cy.renderer();
    const all = R && R.getCachedZSortedEles;
    if (typeof all !== 'function') return;
    const shown = (e) => e.pstyle('display').value !== 'none' &&
      (e.isNode() || (e.source().pstyle('display').value !== 'none' && e.target().pstyle('display').value !== 'none'));
    R.getCachedZSortedEles = function (force) {
      const eles = all.call(this, force);
      const out = eles.filter(shown);
      // the renderer keeps these lists on the cached array (updated when something is grabbed): filter them too
      ['interactive', 'drag', 'nondrag'].forEach((k) => { if (eles[k]) out[k] = eles[k].filter(shown); });
      return out;
    };
  }

  // put one network's elements on the canvas (around the origin) and lay it out in its own frame; placing it among
  // the other networks is placeNew's job, so a search, a refine and a restore share this (a restore brings its
  // own positions and box states: no layout, no theme-map default)
  async function mountCluster(C, g, { layout = true, restoring = false } = {}) {
    const cy = ensureCy();
    // hundreds of ayat (up to every match): open on the theme map, draw a cached image while panning / zooming
    const big = C.kind === 'search' && g.nodes.reduce((k, n) => k + (n.type === 'ayah'), 0) > BIG_GRAPH;
    C.big = big;
    S.clusters.set(C.id, C);
    const els = cy.add(elementsFor(C, g, C.params ? C.params.q : '', big));
    els.nodes('[kind="ayah"]').forEach(addCopy);
    frameOf(C).panify().unselectify();   // the frame is never dragged (that would move the network behind its own origin) nor selected; it pans
    syncBig();
    syncSolo();
    themesOf(C).forEach((th) => th.data('label', themeLabel(th.data())));
    frameOf(C).data('label', clusterTitle(C));
    recolor(C);
    applyEdgeVisibility();
    applyLabels(C);
    syncNoted(C);
    if (big && C.mode === 'organized' && !restoring) {
      C.themesOnly = true;
      themesOf(C).forEach((th) => setCollapsed(th, true, { shared: false }));
      syncCollapsedShared(C);
      toast(t('toast.bigMap', { ayat: t('cnt.ayat', { n: ayahNodesOf(C).length }), themes: t('cnt.themes', { n: themesOf(C).length }) }));
    }
    if (layout) await setMode(C.mode, { only: C, animate: false, doFit: false });
  }

  // a network's place on the canvas: beside the others in reading order, or branching from the node it was
  // searched from; `at` reuses the place of the network it replaces. Only new networks are ever placed
  function placeNew(C, { anchorNode = null, at = null } = {}) {
    const fb = footLocalOf(C);
    if (!fb) return;
    const o = at ? { ...at } : anchorNode && anchorNode.nonempty() ? placeAnchored(C, anchorNode, fb) : nextSlot(C, fb);
    if (o.x || o.y) shiftCluster(C, o);
    C.placed = true;   // from now on it takes part in overlap resolution (its own layout at the origin never pushed anyone)
    resolveOverlaps([C]);
  }

  /* ------------------------------------------------------------ layouts: each network in its own local frame */
  const isLeaf = (n) => n.data('kind') === 'ayah' || n.data('kind') === 'root' || n.data('kind') === 'query';
  const leavesOf = (C) => nodesOf(C).filter(isLeaf);
  const movableOf = (C) => nodesOf(C).filter((n) => isLeaf(n) || n.data('kind') === 'anchor');
  const allMovable = () => S.cy.nodes().filter((n) => isLeaf(n) || n.data('kind') === 'anchor');
  const themesSorted = () => (act() ? themesSortedOf(act()) : S.cy.collection());

  // run fn with the network's local origin at (0, 0): all the layout code below places a network around its ★,
  // and the frame is shifted back afterwards (a parent's position setter moves every descendant, hidden ones too)
  async function inFrame(C, fn) {
    const cy = S.cy, f = frameOf(C), d = { x: C.off.x, y: C.off.y };
    const moved = !!(d.x || d.y) && f.nonempty();
    if (moved) f.shift({ x: -d.x, y: -d.y });
    try { return await fn(C); } finally { if (moved && S.cy === cy && f.inside()) f.shift(d); }
  }

  // while fCoSE runs, every node reports a fixed size: roots and the ★ their nominal size (sizeLabels grows them
  // with the zoom), ayat with text labels their label footprint. So a layout never depends on the zoom it ran at
  function withLayoutDims(fn) {
    const proto = Object.getPrototypeOf(S.cy.collection()), orig = proto.layoutDimensions;
    proto.layoutDimensions = function (opts) {
      const d = this.length === 1 && this.isNode() ? this.data() : null;
      if (d && (d.kind === 'root' || d.kind === 'query' || d.kind === 'ayah') && this.takesUpSpace()) {
        const s = d.sz || 16;
        return (d.kind === 'ayah' && footprint(this)) || { w: s, h: s };
      }
      return orig.call(this, opts);
    };
    try { return fn(); } finally { proto.layoutDimensions = orig; }
  }

  function runFcose(eles, opts) {
    return new Promise((resolve) => {
      const orig = Math.random;
      Math.random = mulberry32(opts.seed || 11);   // fCoSE randomises; seeding keeps a query's layout stable
      const done = () => { Math.random = orig; resolve(); };
      try {
        withLayoutDims(() => {
          const l = eles.layout({ name: 'fcose', animate: false, fit: false, packComponents: false, ...opts });
          l.one('layoutstop', done);
          l.run();
        });
      } catch (err) { console.error(err); done(); }
    });
  }

  function attachToThemes(C) {
    if (!C.detached) return;
    S.cy.batch(() => {
      leavesOf(C).forEach((n) => { if (n.data('home')) n.move({ parent: n.data('home') }); });
    });
    C.detached = false;
  }

  function detachFromThemes(C) {
    if (C.detached) return;
    S.cy.batch(() => {
      leavesOf(C).forEach((n) => {
        const p = n.parent();
        if (p.nonempty() && p.data('kind') !== 'cluster') { n.data('home', p.id()); n.move({ parent: C.id }); }
      });
    });
    C.detached = true;
  }

  async function layoutThemesInside(C, themes, { fresh = false } = {}) {
    // fCoSE on a skeleton: no cross-theme links, so every theme packs into its own compact box
    // (`fresh`: themes of a large graph laid out for the first time, from no positions). The frame is never
    // passed in, so the theme boxes stay the roots of what fCoSE sees
    const inside = (themes ? themes.union(themes.descendants()) : nodesOf(C).filter((n) => n.data('kind') !== 'query' && !n.data('bridge')))
      .filter((n) => n.data('kind') !== 'anchor');
    const skel = inside.union(inside.edgesWith(inside).filter((e) => e.data('type') !== 'tlink' && !e.data('cross')));
    await runFcose(skel, {
      quality: themes && !fresh ? 'proof' : 'default', randomize: !themes || fresh, nodeDimensionsIncludeLabels: false,
      idealEdgeLength: (e) => (e.data('type') === 'root' ? 62 : e.data('type') === 'cooc' ? 70 : 42),
      edgeElasticity: () => 0.45, nestingFactor: 0.1, gravity: 0.3, gravityCompound: 1.6, gravityRangeCompound: 1.4,
      nodeRepulsion: () => 4200, numIter: 2500, tile: true, tilingPaddingVertical: 14, tilingPaddingHorizontal: 14,
    });
    (themes || themesOf(C)).forEach((t) => {
      const subs = t.children('[kind="sub"]');
      (subs.length ? subs : t).forEach((box) => columnize(C, box));
      separateSubs(t);
    });
  }

  // the list layout of one box: its ayat under each other in Mushaf order, each snippet on the right of its node;
  // the box's roots in a column on the left, so their links never cross the text; the box keeps room for the labels
  // (`mw`: its min-width, biased to the label side). Without snippet labels the box is left as fCoSE packed it
  const LIST_ROW = 26;
  function columnize(C, box) {
    const kids = box.children().filter((n) => n.data('kind') === 'ayah' || n.data('kind') === 'root');
    const ayat = kids.filter('[kind="ayah"]').sort((a, b) => ayahIdx(a.id()) - ayahIdx(b.id())), roots = kids.filter('[kind="root"]');
    if (!listMode(C) || !ayat.length) { box.removeData('mw bl br'); return; }
    const b = kids.boundingBox({ includeLabels: false }), cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    let lw = 0;
    ayat.forEach((n) => { const fp = footprint(n); if (fp) lw = Math.max(lw, fp.w - (n.data('sz') || 16)); });
    const rw = roots.length ? Math.max(...roots.map((r) => r.data('sz') || 16)) + 40 : 0;   // (room for a root's name under it)
    const h = Math.max(ayat.length, roots.length) * LIST_ROW;
    const nx = cx - (lw - rw) / 2;   // the ayah column: the roots left of it, the labels running right
    ayat.forEach((n, k) => n.position({ x: nx, y: cy - h / 2 + LIST_ROW / 2 + k * LIST_ROW }));
    const rh = roots.length * LIST_ROW;
    roots.forEach((n, k) => n.position({ x: nx - (rw / 2 + 4), y: cy - rh / 2 + LIST_ROW / 2 + k * LIST_ROW }));
    const pad = parseFloat(box.style('padding')) || 0, sz = Math.max(...ayat.map((n) => n.data('sz') || 16));
    box.data({ mw: sz + lw + rw + 2 * pad + 12, bl: 0, br: 100 });
  }

  // a sub box with room for its name on top, at a fixed model size: labels are sized by zoom, layouts must not be
  const subBox = (n) => { const b = n.boundingBox({ includeLabels: false }); return { ...b, y1: b.y1 - 18 }; };
  function separateSubs(theme) {
    // fCoSE ignores sub-box labels and padding, so sibling sub-themes can overlap: push them apart
    const subs = theme.children('[kind="sub"]');
    if (subs.length < 2) return;
    const gap = 18;
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let i = 0; i < subs.length; i++) {
        for (let j = i + 1; j < subs.length; j++) {
          const a = subBox(subs[i]), b = subBox(subs[j]);
          const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + gap, oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + gap;
          if (ox <= 0 || oy <= 0) continue;
          const dx = (b.x1 + b.x2 - a.x1 - a.x2) / 2, dy = (b.y1 + b.y2 - a.y1 - a.y2) / 2;
          const mv = ox < oy ? { x: (dx >= 0 ? 1 : -1) * ox / 2, y: 0 } : { x: 0, y: (dy >= 0 ? 1 : -1) * oy / 2 };
          subs[j].descendants().filter(isLeaf).shift(mv);
          subs[i].descendants().filter(isLeaf).shift({ x: -mv.x, y: -mv.y });
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // the box a group of leaves takes: with text labels on the ayat, each node's label footprint counts
  function leafBounds(nodes) {
    if (S.labelMode === 'ref' || S.labelMode === 'none') return nodes.boundingBox({ includeLabels: false });
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    nodes.forEach((n) => {
      const p = n.position(), fp = (n.data('kind') === 'ayah' && footprint(n)) || { w: n.data('sz') || 16, h: n.data('sz') || 16 };
      const cx = p.x + (fp.dx || 0);
      x1 = Math.min(x1, cx - fp.w / 2); x2 = Math.max(x2, cx + fp.w / 2); y1 = Math.min(y1, p.y - fp.h / 2); y2 = Math.max(y2, p.y + fp.h / 2);
    });
    return x1 === Infinity ? { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 } : { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
  }

  function ringPlace(C) {
    const cy = S.cy;
    const th = themesSortedOf(C);
    const info = th.map((t) => {
      const kids = t.descendants().filter((n) => isLeaf(n) || n.data('kind') === 'anchor');
      const bb = t.hasClass('collapsed') ? t.boundingBox() : leafBounds(kids.filter(isLeaf));
      if (t.hasClass('collapsed')) {
        // a closed box only needs room for itself, so the theme map stays compact
        const w = parseFloat(t.style('min-width')) || 240, h = parseFloat(t.style('min-height')) || 84;
        return { t, kids, bb, d: Math.hypot(w + 40, h + 40) / 2 };
      }
      // padding + the two-line label on top; a long name widens the slot so neighbours never collide
      const chars = Math.max(...String(t.data('label') || '').split('\n').map((l) => l.length), 8);
      const w = Math.max((bb.w || 40) + 70, chars * LABEL_MAX * 0.56 + 30), h = (bb.h || 40) + 120;
      return { t, kids, bb, d: Math.hypot(w, h) / 2 };
    });
    const q = qOf(C);
    if (!info.length) { if (q.nonempty()) q.position({ x: 0, y: 0 }); return; }
    const shiftTo = (x, cx, cyy) => {
      const ox = (x.bb.x1 + x.bb.x2) / 2, oy = (x.bb.y1 + x.bb.y2) / 2;
      x.kids.shift({ x: cx - ox, y: cyy - oy });
    };
    if (isGridMap(C)) { gridPlace(C, info, shiftTo, q); return; }
    if (info.length === 1) {
      shiftTo(info[0], 0, 0);
      if (q.nonempty()) q.position({ x: 0, y: -(info[0].bb.h / 2 + 130) });
      return;
    }
    const closed = C.themesOnly;
    const gap = closed ? 24 : 46;
    const ring = info.filter((x) => !x.t.data('pinnedBox'));
    const circ = ring.reduce((s, x) => s + 2 * x.d + gap, 0);
    const R = Math.max(circ / (2 * Math.PI), Math.max(1, ...ring.map((x) => x.d)) + (closed ? 70 : 150));
    let ang = -Math.PI / 2;
    info.filter((x) => x.t.data('pinnedBox')).forEach((x) => shiftTo(x, x.t.data('boxPos').x, x.t.data('boxPos').y));
    ring.forEach((x) => {
      const a = ang + (x.d + gap / 2) / R;
      ang += (2 * x.d + gap) / R;
      shiftTo(x, R * Math.cos(a), R * Math.sin(a));
    });
    if (q.nonempty()) q.position({ x: 0, y: 0 });
  }

  // the theme map of a large graph: a ring of a dozen closed boxes is so wide that their names become
  // unreadable once fitted, so they are packed in rows (in ring order, snaking, starting on the reading side)
  const isGridMap = (C) => {
    if (!C) return false;
    const th = themesOf(C);
    return C.big && C.mode === 'organized' && th.length > 4 && th.every((t) => t.hasClass('collapsed'));
  };
  function gridPlace(C, info, shiftTo, q) {
    const free = info.filter((x) => !x.t.data('pinnedBox'));
    info.filter((x) => x.t.data('pinnedBox')).forEach((x) => shiftTo(x, x.t.data('boxPos').x, x.t.data('boxPos').y));
    const size = (x) => ({ w: parseFloat(x.t.style('min-width')) || 240, h: parseFloat(x.t.style('min-height')) || 84 });
    const gx = 70, gy = 64, colW = Math.max(...free.map((x) => size(x).w)) + gx;
    const rowsOf = (c) => { const r = []; free.forEach((x, i) => { (r[Math.floor(i / c)] ||= []).push(x); }); return r; };
    const heights = (r) => r.map((row) => Math.max(...row.map((x) => size(x).h)) + gy);
    // as many columns as give the largest fitted zoom in this window (the names must stay readable)
    const W = S.cy.width() || 800, H = S.cy.height() || 600;
    const fitOf = (c) => Math.min(W / (c * colW), H / (heights(rowsOf(c)).reduce((a, b) => a + b, 0) + 120));
    let cols = 2;
    for (let c = 3; c <= Math.min(6, free.length); c++) if (fitOf(c) > fitOf(cols)) cols = c;
    const rows = rowsOf(cols), rowH = heights(rows);
    const dir = L() === 'ar' ? -1 : 1;
    let y = -rowH.reduce((a, b) => a + b, 0) / 2;
    rows.forEach((r, k) => {
      const line = k % 2 ? [...r].reverse() : r;
      const x0 = -((cols - 1) * colW) / 2;
      line.forEach((x, j) => shiftTo(x, dir * (x0 + (k % 2 ? cols - line.length + j : j) * colW), y + rowH[k] / 2));
      y += rowH[k];
    });
    if (q.nonempty()) q.position({ x: 0, y: -rowH.reduce((a, b) => a + b, 0) / 2 - 40 });
  }

  function placeBridges(C) {
    const cy = S.cy;
    const br = nodesOf(C).filter('[kind="root"][?bridge]').filter((n) => !pinOf(n));
    if (br.empty()) return;
    // (the name above an open box counted at the fixed LABEL_MAX size, whatever the zoom)
    const boxes = themesSortedOf(C).map((t) => {
      const b = t.boundingBox({ includeLabels: false });
      const lines = t.hasClass('collapsed') ? 0 : String(t.data('label') || '').split('\n').length;
      return { ...b, y1: b.y1 - lines * LABEL_MAX * 1.25 };
    });
    const inBox = (p) => boxes.some((b) => p.x > b.x1 - 24 && p.x < b.x2 + 24 && p.y > b.y1 - 40 && p.y < b.y2 + 24);
    const P = new Map();
    br.forEach((r) => {
      const nb = r.neighborhood('node[kind="ayah"]');
      let sx = 0, sy = 0;
      nb.forEach((n) => { const p = n.position(); sx += p.x; sy += p.y; });
      const k = nb.length || 1;
      P.set(r.id(), { x: (sx / k) * 0.42, y: (sy / k) * 0.42 });
    });
    const ids = [...P.keys()];
    const fixedQ = { x: 0, y: 0 }, hasQ = qOf(C).nonempty();
    for (let it = 0; it < 120; it++) {
      for (let i = 0; i < ids.length; i++) {
        const a = P.get(ids[i]);
        for (let j = i + 1; j < ids.length; j++) {
          const b = P.get(ids[j]);
          let dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01;
          if (d < 92) { const f = (92 - d) / 2 / d; a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f; }
        }
        const dq = Math.hypot(a.x - fixedQ.x, a.y - fixedQ.y) || 0.01;
        if (hasQ && dq < 115) { a.x *= 115 / dq; a.y *= 115 / dq; }
        for (let g = 0; g < 12 && inBox(a); g++) { a.x *= 0.9; a.y *= 0.9; }
      }
    }
    cy.batch(() => br.forEach((r) => r.position(P.get(r.id()))));
  }

  // pins are kept per layout and in the network's local frame: a spot chosen in the radial view means nothing
  // in the organised one, and moving the whole network keeps its pins where they are inside it
  const pinOf = (n, mode) => (n.data('pins') || {})[mode || (clOf(n) || S).mode];
  function restorePins(C) {
    S.cy.batch(() => leavesOf(C).forEach((n) => { const p = pinOf(n); if (p) n.position(p); }));
    syncPinClasses(C);
  }
  function syncPinClasses(C) {
    if (!S.cy) return;
    S.cy.batch(() => (C ? leavesOf(C) : S.cy.nodes().filter(isLeaf)).forEach((n) => n.toggleClass('pinned', !!pinOf(n))));
  }

  // a large graph opens as the theme map: the inside of a theme is laid out only once it is open
  async function layoutPending(C) {
    const open = themesOf(C).filter((t) => !t.hasClass('collapsed') && !t.data('laid'));
    if (open.empty()) return;
    await layoutThemesInside(C, open, { fresh: true });
    open.data('laid', true);
  }

  async function computeOrganized(C, { keepInner = false } = {}) {
    attachToThemes(C);
    if (C.big) {
      if (!keepInner) { themesOf(C).data('laid', false); await layoutPending(C); }
      ringPlace(C);
      placeBridges(C);
      restorePins(C);
      return;
    }
    const hidden = nodesOf(C).union(nodesOf(C).connectedEdges()).filter('.hidden').filter((x) => x.data('kind') !== 'anchor');
    hidden.removeClass('hidden');   // collapsed themes still need real inner positions
    if (!keepInner) await layoutThemesInside(C, null);
    ringPlace(C);
    placeBridges(C);
    restorePins(C);
    hidden.addClass('hidden');
  }

  function computeRadial(C) {
    attachToThemes(C);
    const cy = S.cy;
    const slots = [];
    const sect = {};
    themesSortedOf(C).forEach((t) => {
      const subs = t.children('[kind="sub"]');
      const groups = subs.nonempty() ? subs.map((s) => s.children('[kind="ayah"]')) : [];
      groups.push(t.children('[kind="ayah"]'));
      const start = slots.length;
      groups.forEach((g) => {
        if (g.empty()) return;
        g.sort((a, b) => (a.data('rank') || 0) - (b.data('rank') || 0)).forEach((a) => slots.push(a));
        slots.push(null);
      });
      sect[t.id()] = [start, slots.length - 2];
      slots.push(null);
    });
    const n = Math.max(slots.length, 12);
    const R = Math.max(300, (n * 17) / (2 * Math.PI));
    const angOf = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
    const pos = new Map();
    slots.forEach((a, i) => { if (a) pos.set(a.id(), { x: R * Math.cos(angOf(i)), y: R * Math.sin(angOf(i)) }); });
    const sectAng = {};
    Object.entries(sect).forEach(([t, [a, b]]) => { sectAng[t] = [angOf(a) - Math.PI / n, angOf(Math.max(a, b)) + Math.PI / n]; });
    const rootsC = nodesOf(C).filter('[kind="root"]');
    rootsC.forEach((r) => {
      const nb = r.neighborhood('node[kind="ayah"]');
      let sx = 0, sy = 0, k = 0;
      nb.forEach((m) => { const p = pos.get(m.id()); if (p) { sx += p.x; sy += p.y; k++; } });
      if (!k) { pos.set(r.id(), { x: 0, y: 0 }); return; }
      const mx = sx / k, my = sy / k, m = Math.hypot(mx, my) || 1;
      const rr = r.data('bridge') ? R * (0.14 + 0.45 * (m / R)) : R * 0.76;
      pos.set(r.id(), { x: (mx / m) * rr, y: (my / m) * rr });
    });
    const roots = rootsC.map((r) => r.id());
    for (let it = 0; it < 80; it++) {
      for (let i = 0; i < roots.length; i++) {
        for (let j = i + 1; j < roots.length; j++) {
          const a = pos.get(roots[i]), b = pos.get(roots[j]);
          const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01;
          if (d < 46) { const f = (46 - d) / 2 / d; a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f; }
        }
      }
    }
    pos.set(qId(C.id), { x: 0, y: 0 });
    cy.batch(() => leavesOf(C).forEach((x) => { const p = pos.get(x.id()); if (p) x.position(p); }));
    restorePins(C);
    C.radial = { R, sect: sectAng };
  }

  async function computeFree(C) {
    // start from the organised picture and let every link pull freely: themes stay recognisable
    // instead of collapsing into one hairball, but nothing holds them in boxes any more. Each network relaxes
    // on its own (its leaves and inner links only): all networks at once would knit into one hairball
    await computeOrganized(C);
    detachFromThemes(C);
    const cy = S.cy;
    const L = leavesOf(C);
    const eles = L.union(L.edgesWith(L).filter((e) => e.data('type') !== 'tlink' && e.data('type') !== 'anchor'));
    await runFcose(eles, {
      // a large graph (thousands of nodes, ~22 ms an iteration) only relaxes from the organised picture: a low
      // starting temperature settles in about 2 s instead of minutes. It must stay above fCoSE's final temperature
      // (0.04): at or below it the cooling schedule takes the log of a negative number and every position is NaN
      quality: C.big ? 'default' : 'proof', randomize: false, nodeDimensionsIncludeLabels: false,
      ...(C.big ? { initialEnergyOnIncremental: 0.06 } : {}),
      idealEdgeLength: (e) => (e.data('cross') === 'theme' ? 170 : { phrase: 50, meaning: 60, root: 85, cooc: 80 }[e.data('type')] || 70),
      edgeElasticity: (e) => ({ bridge: 0.15, theme: 0.04 }[e.data('cross')] ?? 0.45),
      nodeRepulsion: () => 6500, gravity: 0.35, numIter: 2500, tile: true,
      fixedNodeConstraint: L.filter((n) => pinOf(n, 'free')).map((n) => ({ nodeId: n.id(), position: { ...pinOf(n, 'free') } })),
    });
    const q = qOf(C);
    if (q.nonempty() && !pinOf(q, 'free')) {
      const bb = L.not(q).boundingBox();
      q.position({ x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 });
    }
  }

  // one layout pass over some networks, animated as one move: positions before, the compute (each network in its
  // own frame), neighbours pushed apart, then the drawn nodes glide to their places while the camera fits the
  // networks that changed
  async function transition(Cs, compute, { animate = true, doFit = true } = {}) {
    const cy = S.cy;
    Cs = Cs.filter((C) => frameOf(C).nonempty());
    if (!Cs.length) return;
    const before = new Map();
    allMovable().forEach((n) => before.set(n.id(), { ...n.position() }));
    for (const C of Cs) await inFrame(C, () => compute(C));
    if (S.cy !== cy) return;
    const moved = resolveOverlaps(Cs);
    const touched = new Set([...Cs, ...moved]);
    const L2 = [...touched].reduce((c, C) => c.union(movableOf(C)), cy.collection());
    const after = new Map(L2.map((n) => [n.id(), { ...n.position() }]));
    updateBundles();
    syncCrossEdges();
    if (!animate) { S.layer && S.layer.update(); if (doFit) fitClusters(Cs, false); relabel(); return; }
    // layouts skip hidden nodes (children of closed boxes), so those jump straight to their place
    cy.batch(() => L2.forEach((n) => { const p = n.visible() ? before.get(n.id()) : null; if (p) n.position(p); }));
    const moving = L2.filter(':visible');
    await new Promise((resolve) => {
      const l = moving.layout({ name: 'preset', positions: (n) => after.get(n.id()), animate: true, animationDuration: 650,
        animationEasing: 'ease-in-out-cubic', fit: false });
      l.one('layoutstop', resolve);
      // a cleared workspace mid-animation: layoutstop then never fires
      cy.one('destroy', resolve);
      setTimeout(resolve, 650 + 500);
      l.run();
      // fit to the networks that changed (boxes included), not just the leaves the preset layout moves
      if (doFit) fitTo(after, cy, Cs, L2);
    });
    updateBundles();
    S.layer && S.layer.update();
    relabel();
  }

  // layout requests run one at a time; while one animates, only the newest waiting request from the user runs
  // next (pressing 3 2 1 quickly ends on a clean organised layout, never a blend of two). Requests for a named
  // network (`only`: a new search, a restore) always run
  function setMode(mode, opts = {}) {
    const tok = ++S.modeTok;
    S.modeChain = S.modeChain.then(() => (tok === S.modeTok || opts.only ? applyMode(mode, opts) : undefined))
      .catch((err) => console.error(err));
    return S.modeChain;
  }

  async function applyMode(mode, { animate = true, only = null, doFit = true, keepInner = false } = {}) {
    if (!S.cy) return;
    const C = only || act();
    if (!C || frameOf(C).empty() || C.folded) return;
    if (C.frozen) { toast(t('ws.frozenNo')); return; }
    if (mode !== 'organized') {
      // radial and free have no boxes to collapse into: open every collapsed theme first (in place: the
      // layout below places them; a transition of its own would race it)
      C.themesOnly = false;
      themesOf(C).filter('.collapsed').forEach((th) => setCollapsed(th, false, { shared: false }));
      syncCollapsedShared(C);
      updateThemeListState();
    }
    if (mode === 'organized' && C.big && C.mode !== 'organized') {
      // back from radial / free on a large graph: back to the theme map (opening it all is slow and unreadable)
      C.themesOnly = true; C.autoOpen = null;
      attachToThemes(C);   // free mode detached the leaves: a box only hides what is inside it
      themesOf(C).forEach((th) => setCollapsed(th, true, { shared: false }));
      syncCollapsedShared(C);
      updateThemeListState();
    }
    C.mode = mode;
    if (C === act()) { S.mode = mode; syncModeButtons(); }
    applyLabels(C);   // the labels follow the mode (radial: references; organised: snippets beside the ayat) before the layout measures them
    const boxes = nodesOf(C).filter('[kind="theme"],[kind="sub"]');
    if (mode !== 'organized') boxes.removeData('mw bl br');
    const compute = mode === 'radial' ? computeRadial : mode === 'free' ? computeFree : (X) => computeOrganized(X, { keepInner });
    await transition([C], async (X) => {
      await compute(X);
      boxes.toggleClass('ghost', mode !== 'organized');
    }, { animate, doFit });
    syncPinClasses(C);
    applyEdgeVisibility();
    refreshEmphasis();
    emit('change');
  }

  // the layout buttons and «themes only» show the active network's state
  function syncModeButtons() {
    const C = act();
    if (C) S.mode = C.mode;
    $$('#layoutSeg button').forEach((b) => { const on = b.dataset.l === S.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $('#btnThemesOnly').setAttribute('aria-pressed', String(!!(C && C.themesOnly)));
  }

  // the box some networks take on the canvas (their frames, titles included)
  function clustersBox(Cs) {
    let bb = null;
    Cs.forEach((C) => {
      const f = frameOf(C);
      if (f.empty()) return;
      const b = f.boundingBox({ includeLabels: true });
      bb = bb ? { x1: Math.min(bb.x1, b.x1), y1: Math.min(bb.y1, b.y1), x2: Math.max(bb.x2, b.x2), y2: Math.max(bb.y2, b.y2) } : { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
    });
    return bb ? { ...bb, w: bb.x2 - bb.x1, h: bb.y2 - bb.y1 } : { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 };
  }

  function fitTo(after, cy, Cs, L2) {
    // animate the camera to the final layout while the nodes move there
    const keep = new Map(L2.map((n) => [n.id(), { ...n.position() }]));
    cy.batch(() => L2.forEach((n) => { const p = after.get(n.id()); if (p) n.position(p); }));
    const bb = clustersBox(Cs);
    cy.batch(() => L2.forEach((n) => n.position(keep.get(n.id()))));
    cy.animate({ ...viewFor(bb, cy, Cs.length === 1 ? Cs[0] : null) }, { duration: 650, easing: 'ease-in-out-cubic', complete: onZoom });
  }

  // zoom + pan that fit a model bounding box inside the graph, with room on each side for what is drawn
  // outside the nodes' box (the radial theme labels on the overlay layer); zoom is capped at 1.5
  function viewFor(bb, cy = S.cy, C = act()) {
    const P = fitPads(C), w = Math.max(40, cy.width() - P.l - P.r), h = Math.max(40, cy.height() - P.t - P.b);
    const zoom = clamp(Math.min(w / (bb.w || 1), h / (bb.h || 1)), cy.minZoom(), 1.5);
    return { zoom, pan: { x: P.l + w / 2 - zoom * (bb.x1 + bb.w / 2), y: P.t + h / 2 - zoom * (bb.y1 + bb.h / 2) } };
  }
  function fitPads(C) {
    if (!C || C.mode !== 'radial' || !C.radial || !S.cy) return { l: 64, r: 64, t: 64, b: 64 };
    // a label beside the circle needs its own width on that side (+ its gap from the ring); one above or
    // below is centred on its sector and needs its lines' height
    const P = { l: 90, r: 90, t: 90, b: 90 }, ctx = measureCtx();
    themesOf(C).forEach((th) => {
      const sect = C.radial.sect[th.id()];
      if (!sect) return;
      const am = (sect[0] + sect[1]) / 2, c = Math.cos(am), lines = radialLines(th, ctx);
      const w = Math.max(...lines.map((x) => ctx.measureText(x).width)) + 44;
      if (c > 0.3) P.r = Math.max(P.r, w); else if (c < -0.3) P.l = Math.max(P.l, w);
      else { const k = Math.sin(am) < 0 ? 't' : 'b'; P[k] = Math.max(P[k], 50 + lines.length * 20); }
    });
    return P;
  }
  let mctx = null;
  function measureCtx() {
    mctx = mctx || document.createElement('canvas').getContext('2d');
    mctx.font = RADIAL_FONT(15);
    return mctx;
  }
  const RADIAL_FONT = (px) => `bold ${px}px NotoNaskh, Amiri, serif`;
  // a radial theme label: name · size, on two lines when the name (a Quranic formula) is long; ctx must carry
  // the 15px label font. Breaks only between words, near the middle of the name
  function radialLines(th, ctx) {
    const nm = themeNames(th.data()).main, tail = ` · ${th.data('size')}`;
    const one = `${cv(nm)}${tail}`;
    const ws = nm.split(' ');
    if (ctx.measureText(one).width <= 210 || ws.length < 2) return [one];
    let k = 1;
    for (let j = 1; j < ws.length; j++) if (Math.abs(ws.slice(0, j).join(' ').length * 2 - nm.length) < Math.abs(ws.slice(0, k).join(' ').length * 2 - nm.length)) k = j;
    return [cv(ws.slice(0, k).join(' ')), `${cv(ws.slice(k).join(' '))}${tail}`];
  }

  // the camera on some networks (the active one by default; `all`: the whole workspace)
  function fitClusters(Cs, animate = true) {
    const cy = S.cy;
    Cs = (Cs || []).filter((C) => C && frameOf(C).nonempty());
    if (!cy || !Cs.length) return;
    const C = Cs.length === 1 ? Cs[0] : null;
    if (animate) { cy.stop(); cy.animate(viewFor(clustersBox(Cs), cy, C), { duration: 450, easing: 'ease-in-out-cubic', complete: onZoom }); return; }
    // labels grow when zoomed out (sizeLabels), so fit, resize the labels, then fit again
    cy.viewport(viewFor(clustersBox(Cs), cy, C));
    sizeLabels(true);
    cy.viewport(viewFor(clustersBox(Cs), cy, C));
    relabel();
  }
  function fit(animate = true, { all = false } = {}) {
    fitClusters(all || !act() ? allC() : [act()], animate);
  }

  /* ------------------------------------------------------------ placing networks on the canvas */
  const GAP = 140;
  const grow = (b, g) => ({ x1: b.x1 - g, y1: b.y1 - g, x2: b.x2 + g, y2: b.y2 + g });
  const shiftBox = (b, o) => ({ x1: b.x1 + o.x, y1: b.y1 + o.y, x2: b.x2 + o.x, y2: b.y2 + o.y });
  const boxHit = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  const boxUnion = (bs) => bs.reduce((u, b) => (u ? { x1: Math.min(u.x1, b.x1), y1: Math.min(u.y1, b.y1), x2: Math.max(u.x2, b.x2), y2: Math.max(u.y2, b.y2) } : { ...b }), null);
  const fwd = () => (L() === 'ar' ? -1 : 1);   // the reading-forward direction across the canvas
  const placedC = (C) => allC().filter((R) => R !== C && frameOf(R).nonempty());

  // a network's footprint in its local frame: what is drawn (boxes, nodes), plus room for the names above the boxes
  // and the title, and the ring of names around a radial one. A folded network keeps the footprint it had
  function footLocalOf(C) {
    const f = frameOf(C);
    if (f.empty()) return null;
    if (C.folded && C.footLocal) return C.footLocal;
    const b = f.boundingBox({ includeLabels: false });
    const bb = { x1: b.x1 - C.off.x, y1: b.y1 - C.off.y, x2: b.x2 - C.off.x, y2: b.y2 - C.off.y };
    const radial = C.mode === 'radial';
    const top = (C.mode === 'organized' ? 2 * LABEL_MAX * 1.25 : radial ? 260 : 40) + 30, side = radial ? 260 : 20;
    return { x1: bb.x1 - side, y1: bb.y1 - top, x2: bb.x2 + side, y2: bb.y2 + (radial ? 260 : 20) };
  }
  const foot = (C) => { const b = footLocalOf(C); return b ? shiftBox(b, C.off) : null; };
  const feetOf = (Cs) => Cs.map(foot).filter(Boolean);

  // move a whole network (its frame moves every descendant, hidden ones too)
  function shiftCluster(C, d) {
    if (!d.x && !d.y) return;
    frameOf(C).shift(d);
    C.off = { x: C.off.x + d.x, y: C.off.y + d.y };
  }

  // the next free slot for a search not branched from a node: beside the workspace in reading order, three to a
  // row, then a new row below starting from the reading side (a language switch never moves what is placed)
  function nextSlot(C, fb) {
    const feet = feetOf(placedC(C));
    if (!feet.length) { S.row = { top: fb.y1, count: 1, x1: fb.x1, x2: fb.x2 }; return { x: 0, y: 0 }; }
    const all = boxUnion(feet), dir = fwd();
    let row = S.row;
    if (!row || row.count >= 3) row = S.row = { top: all.y2 + GAP, count: 0, x1: dir < 0 ? all.x2 : all.x1, x2: dir < 0 ? all.x2 : all.x1 };
    const o = { y: row.top - fb.y1, x: dir < 0 ? row.x1 - (row.count ? GAP : 0) - fb.x2 : row.x2 + (row.count ? GAP : 0) - fb.x1 };
    for (let k = 0; k < 80 && feet.some((f) => boxHit(grow(f, GAP / 2), grow(shiftBox(fb, o), GAP / 2))); k++) o.x += dir * GAP;
    const placed = shiftBox(fb, o);
    row.count++; row.x1 = Math.min(row.x1, placed.x1); row.x2 = Math.max(row.x2, placed.x2);
    return o;
  }

  // distance from p along v until it leaves box b (p inside b)
  function exitDist(p, v, b) {
    let d = Infinity;
    if (v.x > 1e-9) d = Math.min(d, (b.x2 - p.x) / v.x); else if (v.x < -1e-9) d = Math.min(d, (b.x1 - p.x) / v.x);
    if (v.y > 1e-9) d = Math.min(d, (b.y2 - p.y) / v.y); else if (v.y < -1e-9) d = Math.min(d, (b.y1 - p.y) / v.y);
    return isFinite(d) ? Math.max(0, d) : 0;
  }
  const FAN = [0, 20, -20, 40, -40, 60, -60, 90, -90, 135, -135, 180];

  // a network branched from a node: outward along the line from its parent's ★ through that node, the first
  // direction and distance where it overlaps nothing; else the next free slot
  function placeAnchored(C, src, fb) {
    const P = clOf(src);
    const fa = P && foot(P);
    if (!fa) return nextSlot(C, fb);
    const p = src.position(), mid = { x: (fa.x1 + fa.x2) / 2, y: (fa.y1 + fa.y2) / 2 };
    const len = Math.hypot(p.x - mid.x, p.y - mid.y);
    const u = len > 1 ? { x: (p.x - mid.x) / len, y: (p.y - mid.y) / len } : { x: fwd(), y: 0 };
    const feet = feetOf(placedC(C)), w = fb.x2 - fb.x1;
    for (const k of [0, 0.5, 1, 2]) {
      for (const deg of FAN) {
        const a = (deg * Math.PI) / 180, v = { x: u.x * Math.cos(a) - u.y * Math.sin(a), y: u.x * Math.sin(a) + u.y * Math.cos(a) };
        const d = exitDist(p, v, grow(fa, GAP)) + exitDist({ x: 0, y: 0 }, { x: -v.x, y: -v.y }, fb) + k * w;
        const o = { x: p.x + v.x * d, y: p.y + v.y * d };
        if (!feet.some((f) => boxHit(grow(f, GAP / 2), grow(shiftBox(fb, o), GAP / 2)))) return o;
      }
    }
    return nextSlot(C, fb);
  }

  // networks that grew push their neighbours apart along the axis of the smaller overlap (never a frozen one or
  // one the user placed); returns the networks that moved
  function resolveOverlaps(Cs) {
    const moved = new Set();
    const list = allC().filter((C) => C.placed && frameOf(C).nonempty());
    if (list.length < 2) return moved;
    const fixed = (C) => C.frozen || C.userPlaced;
    const feet = new Map(list.map((C) => [C, foot(C)]));
    for (let pass = 0; pass < 30; pass++) {
      let any = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j], a = grow(feet.get(A), GAP / 2), b = grow(feet.get(B), GAP / 2);
          const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
          if (ox <= 0 || oy <= 0) continue;
          const canA = !fixed(A), canB = !fixed(B);
          if (!canA && !canB) continue;
          const dx = (b.x1 + b.x2 - a.x1 - a.x2) / 2 >= 0 ? 1 : -1, dy = (b.y1 + b.y2 - a.y1 - a.y2) / 2 >= 0 ? 1 : -1;
          const mv = ox < oy ? { x: dx * ox, y: 0 } : { x: 0, y: dy * oy };   // B away from A
          const inA = Cs.includes(A), inB = Cs.includes(B);
          let sA = 0, sB = 0;
          if (canB && (!canA || (inA && !inB))) sB = 1; else if (canA && (!canB || (inB && !inA))) sA = -1; else { sA = -0.5; sB = 0.5; }
          if (sA) { shiftCluster(A, { x: mv.x * sA, y: mv.y * sA }); moved.add(A); feet.set(A, foot(A)); }
          if (sB) { shiftCluster(B, { x: mv.x * sB, y: mv.y * sB }); moved.add(B); feet.set(B, foot(B)); }
          any = true;
        }
      }
      if (!any) break;
    }
    return moved;
  }

  /* ------------------------------------------------------------ overlay layer: radial sectors, free hulls */
  function hull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  function drawLayer(ctx) {
    const cy = S.cy;
    if (!cy) return;
    const z = cy.zoom();
    allC().forEach((C) => {
      if (C.mode === 'organized' || C.folded) return;
      const o = C.off;
      themesSortedOf(C).forEach((t) => {
        const col = t.data('col');
        const dim = S.focusTheme && S.focusTheme !== t.id();
        ctx.globalAlpha = dim ? 0.25 : 1;
        const nm = themeNames(t.data()).main;
        const label = `${cv(nm)} · ${t.data('size')}`;
        const fpx = 15 / z;   // 15 px on screen at any zoom (fitPads measures the names at that size)
        ctx.font = RADIAL_FONT(fpx);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        if (C.mode === 'radial' && C.radial && C.radial.sect[t.id()]) {
          const { R } = C.radial;
          const [a0, a1] = C.radial.sect[t.id()];
          ctx.save();
          ctx.translate(o.x, o.y);   // the sectors are centred on the network's ★
          ctx.beginPath(); ctx.arc(0, 0, R + 34, a0, a1); ctx.arc(0, 0, R - 26, a1, a0, true); ctx.closePath();
          ctx.save(); ctx.globalAlpha *= 0.13; ctx.fill(); ctx.restore();
          ctx.lineWidth = 3; ctx.strokeStyle = col;
          ctx.beginPath(); ctx.arc(0, 0, R + 34, a0, a1); ctx.stroke();
          const am = (a0 + a1) / 2, lr = R + 34 + clamp(20 / z, 20, 60), c = Math.cos(am);
          ctx.textAlign = Math.abs(c) < 0.3 ? 'center' : c > 0 ? 'left' : 'right';
          // lines laid out at the 15px measuring size, drawn at the zoom-scaled one (same proportions)
          const lines = radialLines(t, measureCtx()), lh = fpx * 1.3, y0 = lr * Math.sin(am) + 5 - (lines.length - 1) * lh / 2;
          lines.forEach((ln, j) => ctx.fillText(ln, lr * c, y0 + j * lh));
          ctx.restore();
        } else if (C.mode === 'free') {
          const pts = cy.nodes(`[kind="ayah"][theme="${t.id()}"]`).filter(':visible').map((n) => n.position());
          if (!pts.length) return;
          const h = hull(pts);
          ctx.save();
          ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          ctx.beginPath();
          h.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.globalAlpha *= 0.1; ctx.strokeStyle = col; ctx.lineWidth = 46; ctx.stroke(); ctx.fillStyle = col; ctx.fill();
          ctx.restore();
          const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
          ctx.fillText(label, pts.reduce((s, p) => s + p.x, 0) / pts.length, top.y - 30);
        }
      });
    });
    ctx.globalAlpha = 1;
    drawTwins(ctx, z);
  }

  // the same ayah in several networks: dotted lines between its drawn copies, for the ayah pointed at (or
  // selected), and for every shared ayah when «shared ayat» is on
  function drawTwins(ctx, z) {
    const cy = S.cy;
    if (S.clusters.size < 2) return;
    const lit = S.hover || S.selected;
    const sets = [];
    if (S.showShared) S.copies.forEach((s) => { if (s.size > 1) sets.push(s); });
    else if (lit) { const i = ayahIdx(lit); if (i != null && copiesOf(i).size > 1) sets.push(copiesOf(i)); }
    if (!sets.length) return;
    ctx.save();
    ctx.strokeStyle = G.twin; ctx.lineWidth = 1.5 / z; ctx.setLineDash([4 / z, 5 / z]); ctx.globalAlpha = S.showShared ? 0.45 : 0.9;
    ctx.beginPath();
    sets.forEach((s) => {
      const pts = [];
      s.forEach((id) => { const n = cy.$id(id); if (n.nonempty() && drawn(n) && n.visible()) pts.push(n.position()); });
      for (let k = 1; k < pts.length; k++) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[k].x, pts[k].y); }
    });
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------ bundled cross-theme links (Holten-style) */
  function toCP(s, t, pts) {
    const vx = t.x - s.x, vy = t.y - s.y, L2 = vx * vx + vy * vy || 1, L = Math.sqrt(L2);
    const d = [], w = [];
    pts.forEach((p) => {
      const px = p.x - s.x, py = p.y - s.y;
      w.push(clamp((px * vx + py * vy) / L2, 0.02, 0.98));
      d.push((vx * py - vy * px) / L);
    });
    return { cpd: d, cpw: w };
  }
  function straighten(s, t, pts, beta = 0.82) {
    return pts.map((p, i) => {
      const f = (i + 1) / (pts.length + 1);
      return { x: beta * p.x + (1 - beta) * (s.x + (t.x - s.x) * f), y: beta * p.y + (1 - beta) * (s.y + (t.y - s.y) * f) };
    });
  }
  function anchor(tid) {
    const t = S.cy.$id(tid), C = cl(tid), o = C ? C.off : { x: 0, y: 0 };
    if (C && C.mode === 'radial' && C.radial && C.radial.sect[tid]) {
      const [a0, a1] = C.radial.sect[tid], am = (a0 + a1) / 2, r = C.radial.R * 0.55;
      return { x: o.x + r * Math.cos(am), y: o.y + r * Math.sin(am) };
    }
    const b = t.boundingBox(), c = { x: (b.x1 + b.x2) / 2 - o.x, y: (b.y1 + b.y2) / 2 - o.y };
    const r = Math.hypot(c.x, c.y) || 1, k = Math.max(0, (r - Math.min(b.w, b.h) / 2 - 20) / r);
    return { x: o.x + c.x * k, y: o.y + c.y * k };
  }
  function bundle(edges) {
    edges.forEach((e) => {
      const C = clOf(e), a = e.source().data('theme'), b = e.target().data('theme');
      // (links between networks, and an ayah's link to another form's box, are never bundled)
      if (!C || C.mode === 'free' || !a || !b || a === b || e.source().data('cid') !== e.target().data('cid')) { e.removeClass('bund'); return; }
      const s = e.source().position(), t = e.target().position();
      const via = C.mode === 'radial' ? [anchor(a), { x: C.off.x, y: C.off.y }, anchor(b)] : [anchor(a), anchor(b)];
      e.data(toCP(s, t, straighten(s, t, via)));
      e.addClass('bund');
    });
  }
  function updateBundles() { if (S.cy) bundle(S.cy.edges('.x.show')); }

  /* ------------------------------------------------------------ visibility and emphasis */
  function applyEdgeVisibility() {
    const cy = S.cy;
    if (!cy) return;
    cy.batch(() => {
      cy.edges().forEach((e) => {
        const ty = e.data('type');
        e.toggleClass('off', S.edgeOn[ty] === false);
        if (ty === 'tlink') { const C = clOf(e); e.toggleClass('tl-hide', !C || C.mode !== 'organized'); }
      });
      if (S.xMode === 'all') cy.edges('.x').addClass('show');
      else cy.edges('.x').removeClass('show');
    });
    if (S.xMode === 'all') updateBundles();
    refreshEmphasis();
  }

  const coll = (ids) => ids.reduce((c, id) => c.union(S.cy.$id(id)), S.cy.collection());
  // the drawn copies of an ayah in the other networks
  const twinsOf = (n) => { const i = ayahIdx(n.id()); return coll(i == null ? [] : [...copiesOf(i)].filter((x) => x !== n.id())); };
  const qFor = (ele) => { const C = clOf(ele); return C ? qOf(C) : S.cy.collection(); };

  function themeSet(tid) {
    const t = S.cy.$id(tid);
    const d = t.union(t.descendants()).union(S.cy.nodes(`[theme="${tid}"]`));
    // a closed box: only what is drawn decides (its hidden ayat link into nearly every other box)
    const ed = t.hasClass('collapsed') ? d.connectedEdges(':visible') : d.connectedEdges();
    const nb = ed.connectedNodes();
    return d.union(ed).union(nb).union(nb.ancestors()).union(qFor(t));
  }
  function hoverSet(n) {
    const k = n.data('kind'), C = clOf(n);
    // a network's ★ or frame lights the whole network
    if ((k === 'query' || k === 'cluster') && C) { const all = nodesOf(C); return all.union(all.connectedEdges()).union(S.cy.$id(C.id)); }
    if (k === 'theme' || k === 'sub') return themeSet(k === 'sub' ? n.data('theme') : n.id());
    const nb = n.closedNeighborhood();
    const keep = nb.union(nb.ancestors()).union(qFor(n));
    return k === 'ayah' ? keep.union(twinsOf(n)) : keep;
  }

  // what a selected root keeps lit in its network: itself, its ayat (and their boxes, closed ones too), its edges
  function rootKeep() {
    const sr = S.selRoot, cy = S.cy;
    if (!sr || sr.view !== 'search' || !cy) return null;
    const C = S.clusters.get(sr.cid);
    if (!C) return null;
    const n = sr.id ? cy.$id(sr.id) : cy.collection();
    const ay = coll(rootGraphIds(sr).map((i) => ayahId(C.id, i)));
    if (n.empty() && ay.empty()) return null;
    return n.union(ay).union(ay.ancestors()).union(n.edgesWith(ay).filter('[type="root"]')).union(qOf(C));
  }

  function refreshEmphasis() {
    const cy = S.cy;
    if (!cy) return;
    cy.batch(() => {
      // only what carries the classes / is drawn: a large graph keeps thousands of ayat hidden in closed boxes,
      // and restyling all of them made every hover stall (they are re-faded when their box opens)
      cy.$('.faded').removeClass('faded');
      cy.$('edge.hl').removeClass('hl');
      cy.$('node.twin').removeClass('twin');
      if (S.xMode === 'focus') cy.edges('.x.show').removeClass('show');
      let keep = null;
      const sel = S.selected ? cy.$id(S.selected) : cy.collection();
      // a clicked node keeps itself and its links lit until a click on empty space, another node or Esc
      const lit = sel.nonempty() && isLeaf(sel) && sel.visible() ? sel.id() : S.hover;
      const litN = lit ? cy.$id(lit) : cy.collection();
      const rk = rootKeep();
      if (rk) {
        // a selected root: it, its ayat and their boxes stay lit (an ayah opened from its list adds its own links)
        keep = rk;
        if (litN.nonempty() && lit !== (S.selRoot.id || '')) keep = keep.union(hoverSet(litN));
      } else if (litN.nonempty()) keep = hoverSet(litN);
      else if (S.focusTheme && cy.$id(S.focusTheme).nonempty()) keep = themeSet(S.focusTheme);
      else if (S.find.matches.length) {
        const m = coll(S.find.matches);
        keep = m.union(m.ancestors()).union(coll([...new Set(S.find.matches.map(cidOf))].map(qId)));
      }
      if (keep) {
        cy.elements(':visible').not(keep).not('[kind="cluster"]').addClass('faded');
        if (S.xMode === 'focus') keep.edges('.x').addClass('show');
        if (litN.nonempty()) litN.connectedEdges().addClass('hl');
        if (rk) rk.edges().addClass('hl');
      }
      if (litN.nonempty() && litN.data('kind') === 'ayah') twinsOf(litN).addClass('twin');
      // the grid theme map draws its links faint and unlabelled; a hovered / focused theme lights its own
      const grid = new Map(allC().map((C) => [C.id, isGridMap(C)]));
      cy.edges('[type="tlink"]').forEach((e) => e.toggleClass('quiet', !!grid.get(e.data('cid')) && !(keep && keep.has(e))));
    });
    updateBundles();
    S.layer && S.layer.update();
    scheduleDeclutter();   // what is pointed at always gets its label
  }

  function recolor(C) {
    const cy = S.cy;
    if (!cy) return;
    cy.batch(() => {
      (C ? ayahNodesOf(C) : cy.nodes('[kind="ayah"]')).forEach((n) => n.data('col', ayahColor(n.data())));
      (C ? [C] : allC()).forEach((X) => {
        if (X.kind === 'roots') nodesOf(X).filter('[kind="root"]').forEach((n) => n.data('col', cy.$id(n.data('theme')).data('col') || G.root));
      });
    });
    renderColorKey();
  }

  // light / dark: CSS follows the data-theme attribute; the graph canvas needs its colours re-applied
  function setTheme(t, save = true) {
    if (t !== 'light' && t !== 'dark') return;
    document.documentElement.setAttribute('data-theme', t);
    if (save) try { localStorage.setItem('qr-theme', t); } catch (_) { /* storage blocked */ }
    G = GRAPH[t];
    const b = $('#btnTheme');
    b.textContent = t === 'light' ? '☾' : '☀';
    b.dataset.i18nAria = t === 'light' ? 'theme.toDark' : 'theme.toLight';
    b.setAttribute('aria-label', I18N.t(b.dataset.i18nAria));
    const cy = S.cy;
    if (cy) {
      cy.batch(() => {
        cy.nodes('[kind="theme"]').forEach((n) => n.data('col', themeColor(n.data())));
        cy.nodes('[kind="query"]').data('col', G.query);
        allC().forEach((C) => { if (C.kind !== 'roots') nodesOf(C).filter('[kind="root"]').data('col', G.root); });
      });
      cy.style(buildStyle());
      recolor();
      relabel();
      S.layer && S.layer.update();
      S.badges && S.badges.update();
      $$('[data-t]').forEach((el) => {
        const sw = el.querySelector(':scope > .dot, :scope > .cdot, :scope > .comm-main > .dot'), n = cy.$id(el.dataset.t);
        if (sw && n.nonempty()) sw.style.background = n.data('col');
      });
    }
    const dist = $('#dist');
    if (dist && S.dist) drawDist(dist, ...S.dist);
  }

  /* ------------------------------------------------------------ zoom-aware labels */
  // every label keeps a readable on-screen size at any zoom: s(z) = clamp(T·z^0.25, min, max) screen px, drawn
  // at s/z model px, so zooming out never shrinks a word below its min and zooming in never balloons it.
  // Where labels would still crowd, declutter() hides the less important ones (class lz) until there is room
  const LBL = { query: [18, 15, 22], theme: [15, 13, 18], sub: [12, 11, 14], root: [12, 10.5, 15], bridge: [13, 11.5, 16],
    ayah: [10, 9, 12], seed: [11.5, 10.5, 13], snip: [12, 11, 14], full: [13, 12, 15], tl: [14, 13, 15], cluster: [16, 14, 20] };
  const lblPx = (c, z) => clamp(LBL[c][0] * Math.pow(z, 0.25), LBL[c][1], LBL[c][2]);
  const lblClass = (n) => {
    const k = n.data('kind');
    if (k === 'ayah') return n.hasClass('full') ? 'full' : n.hasClass('snip') ? 'snip' : n.data('role') === 'seed' ? 'seed' : 'ayah';
    if (k === 'root') return n.data('bridge') ? 'bridge' : 'root';
    return k;
  };
  let lblStep = null;
  // only drawn nodes are touched (a large graph keeps thousands hidden in closed boxes); width / height are set
  // on the few roots and the query only, since they make Cytoscape restyle far more than a font change does
  function sizeLabels(force = false) {
    const cy = S.cy;
    if (!cy) return;
    const z = cy.zoom();
    if (!force && lblStep && Math.abs(Math.log2(z / lblStep)) < 0.04) return;   // re-size after a ~3% zoom change
    lblStep = z;
    cy.batch(() => {
      const by = { query: [], theme: [], sub: [], root: [], bridge: [], ayah: [], seed: [], snip: [], full: [], cluster: [] };
      cy.nodes().not('.hidden').not('.ch').forEach((n) => { const c = lblClass(n); if (by[c]) by[c].push(n); });
      for (const c of ['query', 'sub', 'root', 'bridge', 'ayah', 'seed', 'snip', 'full', 'cluster']) {
        if (!by[c].length) continue;
        const s = lblPx(c, z), els = cy.collection(by[c]);
        const css = { 'font-size': s / z, 'min-zoomed-font-size': 0, 'text-outline-width': clamp(s * 0.17, 1.5, 2.5) / z,
          'text-margin-y': (c === 'query' ? 4 : c === 'cluster' ? -8 / z * z : 2.5) / z };
        if (c === 'sub') css['text-max-width'] = 18 * s / z;   // (capped at each box's width below)
        if (c === 'query') css.width = css.height = Math.max(38, 24 / z);
        if (c === 'full') { css['text-outline-width'] = 0; css['text-background-padding'] = 8 / z; css['text-border-width'] = 1 / z; }
        if (c === 'cluster') {
          // the title sits above the frame; zoomed out, the top theme box's two-line name grows past the frame's
          // fixed padding (56), so the title moves up by that overhang and never sits on a box name
          const overhang = Math.max(0, 2.6 * (lblPx('theme', z) / z) - 56 + 6);
          css['text-outline-width'] = 0; css['text-margin-y'] = -(8 / z + overhang);
        }
        els.style(css);
        if (c === 'ayah' || c === 'seed' || c === 'snip') { els.filter('.sl, .sr').style('text-margin-y', 0); els.filter('.su').style('text-margin-y', -2.5 / z); }
        if (c === 'root' || c === 'bridge') els.forEach((n) => { const w = Math.max(n.data('sz') || 10, 10 / z); n.style({ width: w, height: w }); });
        if (c === 'sub') els.forEach((n) => n.style('text-max-width', Math.max(40, Math.min(18 * s / z, n.boundingBox({ includeLabels: false }).w))));
      }
      const ts = lblPx('theme', z), th = cy.collection(by.theme);
      th.not('.collapsed').style({ 'font-size': ts / z, 'text-max-width': Math.min(260, 20 * ts) / z, 'text-outline-width': 2 / z });
      // a closed box is sized to its name: the name never outgrows it when zoomed out, and grows gently when zoomed in
      th.filter('.collapsed').style('font-size', 16 * Math.min(1, Math.pow(z, -0.75)));
      const ls = lblPx('tl', z);
      cy.edges('[type="tlink"]').not('.hidden').style({ 'font-size': ls / z, 'text-background-padding': 3 / z });
    });
  }

  // greedy screen-space declutter, by priority: what the user points at (selection, hover, find, the selected root
  // and its ayat), the query, bridge roots, roots by degree, seeds, then ayat by rank. Ayah references also need
  // room in their box (mean spacing of its drawn leaves); a sub-theme name hides when its box is too narrow for it
  const lctx = document.createElement('canvas').getContext('2d'), lwCache = new Map();
  // width of the widest line at a 1 px font, and the line count; `font`: 'ref' (system digits), 'ar' (Naskh), 'bold'
  const labelW = (txt, font) => {
    const key = font + txt;
    let w = lwCache.get(key);
    if (w == null) {
      lctx.font = font === 'ref' ? '100px -apple-system, BlinkMacSystemFont, sans-serif' : font === 'ar' ? `100px ${FONT}` : `bold 100px ${FONT}`;
      const lines = String(txt).split('\n');
      w = { w: Math.max(...lines.map((l) => lctx.measureText(l).width)) / 100, lines: lines.length };
      lwCache.set(key, w);
    }
    return w;
  };
  function declutter() {
    const cy = S.cy;
    if (!cy) return;
    placeLabelSides();
    const z = cy.zoom(), W = cy.width(), H = cy.height(), CELL = 40, grid = new Map();
    const cells = (b, f) => {
      for (let i = Math.floor(b.x1 / CELL); i <= Math.floor(b.x2 / CELL); i++)
        for (let j = Math.floor(b.y1 / CELL); j <= Math.floor(b.y2 / CELL); j++) f(i + ',' + j);
    };
    const hit = (b) => {
      let h = false;
      cells(b, (k) => {
        if (h) return;
        for (const o of grid.get(k) || []) if (o.x1 < b.x2 && b.x1 < o.x2 && o.y1 < b.y2 && b.y1 < o.y2) { h = true; return; }
      });
      return h;
    };
    const put = (b) => cells(b, (k) => { let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(b); });
    // the box names (and the networks' titles) are drawn first: other labels keep clear of them. A sub-theme box
    // narrower than a few letters on screen drops its name (it would spill over its neighbours)
    const organized = new Set(allC().filter((C) => C.mode === 'organized' && !C.folded).map((C) => C.id));
    cy.nodes('[kind="cluster"]').not('.solo').not('.cl-folded').forEach((n) => {
      const b = n.renderedBoundingBox({ includeNodes: false, includeEdges: false, includeLabels: true });
      if (b.w > 0) put(b);
    });
    const subPx = lblPx('sub', z), narrow = [], wide = [];
    cy.nodes('[kind="sub"]').not('.hidden').not('.ch').forEach((n) => { if (!organized.has(n.data('cid'))) return; (n.renderedWidth() < subPx * 4 ? narrow : wide).push(n); });
    cy.batch(() => { cy.collection(narrow).addClass('lz'); cy.collection(wide).removeClass('lz'); });
    cy.nodes('[kind="theme"]').not('.hidden').not('.ch').filter((n) => organized.has(n.data('cid'))).union(cy.collection(wide)).forEach((n) => {
      const b = n.renderedBoundingBox({ includeNodes: false, includeEdges: false, includeLabels: true });
      if (b.w > 0) put(b);
    });
    const must = new Set([S.selected, S.hover, ...S.find.matches].filter(Boolean));
    const srC = S.selRoot && S.clusters.get(S.selRoot.cid);
    const rootSide = new Set((srC ? rootGraphIds(S.selRoot).map((i) => ayahId(srC.id, i)) : []).concat(S.selRoot && S.selRoot.id ? [S.selRoot.id] : []));
    const PRI = { query: 1, bridge: 2, root: 3, seed: 4, ayah: 5, snip: 5, full: 0.2 };
    const spacing = new Map();
    const looseLeaves = (cid) => cy.nodes(`[kind="ayah"][cid="${cid}"],[kind="root"][cid="${cid}"]`).not('.hidden').not('.ch').filter((m) => m.parent().data('kind') === 'cluster');
    const roomOf = (n) => {
      const par = n.parent(), key = par.nonempty() ? par.id() : '_';
      if (!spacing.has(key)) {
        let v;
        if (par.nonempty() && par.data('kind') !== 'cluster') {
          const b = par.renderedBoundingBox({ includeLabels: false });
          v = Math.sqrt(b.w * b.h / (par.children().not('.hidden').length || 1));
        } else {
          const L = looseLeaves(n.data('cid')), b = L.renderedBoundingBox({ includeLabels: false });
          v = Math.sqrt(Math.max(1, b.w * b.h) / (L.length || 1));
        }
        spacing.set(key, v);
      }
      return spacing.get(key);
    };
    const hide = [], show = [], cand = [];
    cy.nodes('[kind="query"],[kind="root"],[kind="ayah"]').not('.hidden').not('.ch').forEach((n) => {
      const c = lblClass(n), p = n.renderedPosition(), id = n.id();
      if (p.x < -50 || p.y < -50 || p.x > W + 50 || p.y > H + 50) return;
      const pinned = must.has(id), side = rootSide.has(id);
      if (!pinned && !side) {
        const need = c === 'ayah' ? 26 : c === 'seed' ? 20 : c === 'snip' ? 40 : c === 'full' ? 60 : 0;
        if (roomOf(n) < need) { hide.push(n); return; }
      }
      const deg = c === 'root' || c === 'bridge' ? n.degree(false) : c === 'ayah' || c === 'seed' || c === 'snip' ? -(n.data('rank') || 0) : 0;
      cand.push({ n, c, p, pri: pinned ? 0 : side ? 0.5 : PRI[c], deg });
    });
    cand.sort((a, b) => a.pri - b.pri || b.deg - a.deg);
    for (const o of cand) {
      const s = lblPx(o.c, z), nh = o.n.renderedHeight(), ayah = o.c === 'ayah' || o.c === 'seed' || o.c === 'snip' || o.c === 'full';
      const m = labelW(o.n.data('label') || '', o.c === 'snip' || o.c === 'full' ? 'ar' : ayah ? 'ref' : 'bold');
      const w = m.w * s + 4 + (o.c === 'full' ? 16 : 0), y1 = o.p.y + nh / 2 + 2;
      const side = ayah && (o.n.hasClass('sl') ? -1 : o.n.hasClass('sr') ? 1 : 0), lh = s * 1.4 * m.lines;
      const b = side   // beside its node (see placeLabelSides), above it, else below it
        ? { x1: side < 0 ? o.p.x - nh / 2 - w : o.p.x + nh / 2, x2: side < 0 ? o.p.x - nh / 2 : o.p.x + nh / 2 + w, y1: o.p.y - lh / 2, y2: o.p.y + lh / 2 }
        : ayah && o.n.hasClass('su') ? { x1: o.p.x - w / 2, x2: o.p.x + w / 2, y1: o.p.y - nh / 2 - 2 - lh, y2: o.p.y - nh / 2 - 2 }
        : { x1: o.p.x - w / 2, x2: o.p.x + w / 2, y1, y2: y1 + lh + (o.c === 'full' ? 16 : 0) };
      if (o.pri === 0 || o.c === 'query' || o.c === 'full' || !hit(b)) { put(b); show.push(o.n); } else hide.push(o.n);   // (the selected root's ayat go first, still without overlapping)
      if (!ayah) put({ x1: o.p.x - nh / 2, x2: o.p.x + nh / 2, y1: o.p.y - nh / 2, y2: o.p.y + nh / 2 });   // its diamond / star
    }
    cy.batch(() => { cy.collection(hide).addClass('lz'); cy.collection(show).removeClass('lz'); });
    S.badges && S.badges.update();
  }

  // small graphs resize every animation frame of a zoom; a large one draws a cached picture while the camera
  // moves anyway, so it resizes once the zoom settles. Declutter always waits for the camera to settle
  let zoomRaf = 0, lblTimer = 0;
  function onZoom() {
    if (S.anyBig) { scheduleDeclutter(true); return; }
    if (!zoomRaf) zoomRaf = requestAnimationFrame(() => { zoomRaf = 0; onZoomNow(); });
    scheduleDeclutter();
  }
  function onZoomNow() { sizeLabels(); }
  function scheduleDeclutter(resize = false) {
    clearTimeout(lblTimer);
    lblTimer = setTimeout(() => { if (resize) sizeLabels(); declutter(); }, 120);
  }
  // nodes shown, added or restyled since the last pass (a box opened, a layout, an expansion, a theme switch)
  function relabel() {
    clearTimeout(lblTimer);
    lblTimer = setTimeout(() => { sizeLabels(true); declutter(); }, 30);
  }

  /* ------------------------------------------------------------ ayah labels: reference, snippet, full text */
  // Tanzil writes a pause mark as its own token after a space; inside a canvas label a no-break space keeps it
  // on its word's line (lines are built by hand, so Cytoscape never re-splits them)
  const nbspMarks = (tok) => String(tok).replace(/ ([ۖ-ۜ۩])/g, ' $1');
  // words as label lines: at most `maxLines` lines of about `chars` letters (diacritics and pause marks not
  // counted), broken only between words, each line in its own right-to-left isolate so the canvas lays it out as
  // Arabic whatever direction it thinks it has. A cut line ends in «…»
  const visLen = (w) => w.replace(TASHKEEL, '').length;
  function wrapWords(words, chars, maxLines) {
    const lines = [];
    let cur = '', len = 0;
    for (const w0 of words) {
      const w = nbspMarks(w0), wl = visLen(w);
      if (cur && len + 1 + wl > chars) {
        if (lines.length === maxLines - 1) { lines.push(`${cur}${ELL}`); return { lines, cut: true }; }
        lines.push(cur); cur = w; len = wl;
      } else { cur = cur ? `${cur} ${w}` : w; len += (cur === w ? 0 : 1) + wl; }
    }
    if (cur) lines.push(cur);
    return { lines, cut: false };
  }
  const rli = (s) => `⁧${s}⁩`;
  // «…» between right-to-left marks: a neutral at the edge of a line would otherwise sit on the side the canvas's
  // own base direction puts it (the left, in #graph), not where the reading was cut
  const ELL = `${RLM}…${RLM}`;
  // the matched word with up to two words on each side (a short ayah whole; an unmatched one from its start),
  // «…» only where the text was cut, then the reference on its own line
  function buildSnip(n) {
    const C = clOf(n), i = ayahIdx(n.id()), r = C && C.resultByI.get(i);
    if (!r || !r.words) return null;
    const W = r.words, N = W.length;
    let a = 0, b = N - 1;
    if (N > 5) {
      const marked = (r.hl && r.hl.length) ? r.hl : (r.rel && r.rel.length) ? r.rel : null;
      if (marked) { const j = Math.min(...marked); a = Math.max(0, j - 2); b = Math.min(N - 1, j + 2); } else { a = 0; b = 4; }
    }
    const toks = W.slice(a, b + 1).map(nbspMarks);
    if (a > 0) toks[0] = `${ELL}${toks[0]}`;
    if (b < N - 1) toks[toks.length - 1] += ELL;
    // one line: the words around the match, then the reference (its own left-to-right isolate inside the Arabic)
    const lab = rli(`${toks.join(' ')} \u2066${r.ref}\u2069`);
    n.data('lab_snip', lab);
    return lab;
  }
  // the whole ayah on up to eight lines (cut at a word), as a card beside the node
  function buildFull(n) {
    const C = clOf(n), i = ayahIdx(n.id()), r = C && C.resultByI.get(i);
    if (!r || !r.words) return null;
    const { lines } = wrapWords(r.words, 34, 8);
    const lab = [...lines.map(rli), isoLine(`${r.ref} · ${r.sname}`)].join('\n');
    n.data('lab_full', lab);
    return lab;
  }
  // what an ayah node shows: its full text (asked for that node), else the network's label mode
  const labelModeFor = (C) => (S.labelMode === 'none' ? 'none' : S.labelMode === 'snippet' && C.mode === 'radial' ? 'ref' : S.labelMode);
  // the list layout: snippet labels beside the ayat of an organised box, the ayat under each other
  const listMode = (C) => S.labelMode === 'snippet' && C.mode === 'organized';
  function setAyahLabel(n, mode) {
    const d = n.data();
    const full = !!d.full;
    let lab = full ? (d.lab_full || buildFull(n)) : mode === 'snippet' ? (d.lab_snip || buildSnip(n)) : null;
    if (!lab) lab = d.ref;
    n.toggleClass('nolabel', mode === 'none' && !full);
    n.toggleClass('snip', !full && mode === 'snippet' && lab !== d.ref);
    n.toggleClass('full', full && lab !== d.ref);
    const C = clOf(n);
    if (full || mode === 'none') n.removeClass('sl sr su');
    else if (C && listMode(C) && lab !== d.ref) n.removeClass('sl su').addClass('sr');
    if (d.label !== lab) n.data('label', lab);
  }
  // outside the list layout an ayah label goes where its node's links leave room, so text never sits on the lines:
  // away from the mean direction of its drawn links (in a radial picture also away from the ring's centre). A text
  // snippet goes left or right (right when nothing decides); a reference also above or below (below by default).
  // Runs before every declutter pass, on the nodes on screen
  function placeLabelSides() {
    const cy = S.cy, z = cy.zoom(), W = cy.width(), H = cy.height();
    cy.nodes('[kind="ayah"]').not('.hidden').not('.ch').not('.full').not('.nolabel').forEach((n) => {
      const r = n.renderedPosition();
      if (r.x < -50 || r.y < -50 || r.x > W + 50 || r.y > H + 50) return;
      const C = clOf(n);
      if (!C || (listMode(C) && n.hasClass('snip'))) return;
      const p = n.position();
      let vx = 0, vy = 0;
      const toward = (q, wt) => { const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy); if (l > 1) { vx += wt * dx / l; vy += wt * dy / l; } };
      n.connectedEdges().forEach((e) => { if (e.visible()) toward((e.source().same(n) ? e.target() : e.source()).position(), 1); });
      if (C.mode === 'radial') toward(C.off, 0.5);
      const snip = n.hasClass('snip'), l = Math.hypot(vx, vy);
      let cls = snip ? 'sr' : '';
      if (l > 0.05) {
        const ex = -vx / l, ey = -vy / l;   // the empty side
        if (!snip && Math.abs(ey) > Math.abs(ex)) cls = ey < 0 ? 'su' : '';
        else cls = ex < -0.2 ? 'sl' : 'sr';
      }
      const was = n.hasClass('sl') ? 'sl' : n.hasClass('sr') ? 'sr' : n.hasClass('su') ? 'su' : '';
      if (was === cls) return;
      n.removeClass('sl sr su');
      if (cls) n.addClass(cls);
      n.style('text-margin-y', cls === 'su' ? -2.5 / z : cls ? 0 : 2.5 / z);
    });
  }
  function applyLabels(C) {
    const cy = S.cy;
    if (!cy) return;
    cy.batch(() => (C ? [C] : allC()).forEach((X) => { const mode = labelModeFor(X); ayahNodesOf(X).forEach((n) => setAyahLabel(n, mode)); }));
    const b = $('#btnLabels');
    b.textContent = t(`lbl.${S.labelMode}`);
    b.title = t('tb.labelsT');
    b.setAttribute('aria-pressed', String(S.labelMode !== 'none'));
    scheduleDeclutter();
  }
  // the label mode as the toolbar button cycles it: reference → snippet → none
  function cycleLabels(mode) {
    const was = allC().map((C) => listMode(C));
    S.labelMode = mode || { ref: 'snippet', snippet: 'none', none: 'ref' }[S.labelMode] || 'snippet';
    applyLabels();
    allC().forEach((C, k) => { if (listMode(C) !== was[k] && !C.frozen && !C.folded && C.mode === 'organized') setMode('organized', { only: C, doFit: false }); });
    emit('change');
  }
  // the text cards invalidate when the ayah cards (words, marks) arrive or change
  function invalidateLabels(C) {
    ayahNodesOf(C).forEach((n) => { n.removeData('lab_snip lab_full'); });
    applyLabels(C);
  }
  // the space a labelled ayah takes in a layout (model px at zoom 1): the node plus its label, beside it (dx: where
  // its centre is) or doubled downwards so the node stays centred in it. Only text labels count; a reference is
  // small enough to ignore
  function footprint(n) {
    if (S.labelMode === 'ref' || S.labelMode === 'none') return null;
    const d = n.data(), lab = d.full ? d.lab_full : d.lab_snip;
    if (!lab || lab === d.ref || n.hasClass('nolabel')) return null;
    const m = labelW(lab, 'ar'), s = d.sz || 16;
    if (n.hasClass('sl') || n.hasClass('sr')) {   // beside the node
      const lw = m.w * LBL.snip[0] + 10;
      return { w: s + lw, h: Math.max(s, LIST_ROW), dx: (n.hasClass('sl') ? -1 : 1) * lw / 2 };
    }
    return { w: Math.max(s, m.w * 12 + 8), h: s + 2 * m.lines * 16 };
  }
  // show one ayah's whole text as a card beside its node (and hide it again)
  function toggleFullText(n, on = !n.data('full')) {
    const C = clOf(n);
    if (!C) return;
    n.data('full', on);
    setAyahLabel(n, labelModeFor(C));
    relabel();
    emit('change');
  }

  // the hover card goes back to the snippet
  function unhoverFull(n) {
    if (!n || n.empty() || !n.data('hovfull')) return;
    n.removeData('hovfull').removeClass('full');
    const C = clOf(n);
    if (C) setAyahLabel(n, labelModeFor(C));
  }

  /* ------------------------------------------------------------ notes badges */
  // a small ✎ at the top-end corner of every node that has a note, on a canvas layer above the nodes (never a
  // label suffix: declutter hides labels; never a background image: pinBackgrounding assumes there are none)
  function mountBadges(cy) {
    try {
      const layer = cy.layers().nodeLayer.insertAfter('canvas');
      cy.layers().renderPerNode(layer, (ctx, node, bb) => {
        if (!drawn(node) || node.hasClass('faded')) return;
        // (the context is translated to the node's top-left corner)
        const z = cy.zoom(), s = 11 / z, rtl = L() === 'ar';
        const x = rtl ? bb.w + s * 0.1 : -s * 0.1, y = -s * 0.2;
        ctx.font = `${s}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = rtl ? 'left' : 'right'; ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = s * 0.25; ctx.strokeStyle = G.bg; ctx.strokeText('✎', x, y);
        ctx.fillStyle = G.query; ctx.fillText('✎', x, y);
      }, { selector: 'node[?noted]', position: 'top-left', boundingBox: { includeLabels: false, includeOverlays: false }, queryEachTime: true });
      S.badges = layer;
    } catch (err) { console.warn('badges', err); S.badges = null; }
  }
  // the note key of a node (ayah / root / word box / network) and the flag the badge layer draws from
  function noteKeyFor(n) {
    const k = n.data('kind');
    if (k === 'ayah') return `ayah:${ayahIdx(n.id())}`;
    if (k === 'root') return `root:${n.data('root')}`;
    if (k === 'theme' && n.data('key')) return `word:${n.data('key')}`;
    if (k === 'query' || k === 'cluster') return `cluster:${n.data('cid')}`;
    return null;
  }
  function syncNoted(C) {
    const cy = S.cy, N = window.QR && window.QR.notes;
    if (!cy) return;
    const has = (n) => { const k = noteKeyFor(n); return !!(k && N && N.get(k)); };
    cy.batch(() => (C ? nodesOf(C).union(frameOf(C)) : cy.nodes()).forEach((n) => { const on = has(n); if (!!n.data('noted') !== on) n.data('noted', on); }));
    S.badges && S.badges.update();
  }

  /* ------------------------------------------------------------ graph events */
  function bindGraphEvents(cy) {
    const tt = $('#tooltip');
    cy.on('mouseover', 'node', (e) => {
      const n = e.target;
      if (n.hasClass('ghost')) return;
      if (n.data('kind') === 'cluster') { $('#graph').style.cursor = 'default'; return; }   // frames ignore hover
      S.hover = n.id();
      if (n.hasClass('snip') && !n.data('full')) { n.data('hovfull', true); n.addClass('full').removeClass('snip sl sr'); n.data('label', n.data('lab_full') || buildFull(n) || n.data('label')); }
      refreshEmphasis();
      showTooltip(n, e.renderedPosition);
      $('#graph').style.cursor = isLeaf(n) ? 'pointer' : 'move';
    });
    cy.on('mouseout', 'node', (e) => {
      if (e.target.data('kind') === 'cluster') return;
      S.hover = null; tt.hidden = true; S.tip = null; $('#graph').style.cursor = '';
      unhoverFull(e.target);
      refreshEmphasis();
    });
    cy.on('mousemove', (e) => { if (!tt.hidden) placeTooltip(e.renderedPosition); });
    // the pointer left the canvas in one move (onto the panel): Cytoscape sees no mouseout, so the hover is cleared here
    $('#graph').addEventListener('mouseleave', () => {
      if (S.hover != null) unhoverFull(cy.$id(S.hover));
      if (S.hover == null && tt.hidden) return;
      S.hover = null; tt.hidden = true; S.tip = null; $('#graph').style.cursor = '';
      refreshEmphasis();
    });
    cy.on('mouseover', 'edge', (e) => showEdgeTip(e.target, e.renderedPosition));
    cy.on('mouseout', 'edge', () => { if (!S.hover) { tt.hidden = true; S.tip = null; } });

    let boxTap = 0, relTap = 0;
    cy.on('tap', 'node', (e) => {
      const n = e.target, k = n.data('kind'), C = clOf(n);
      closeMenu();
      if (k === 'cluster') { if (C) activate(C.id); return; }
      // a node of another network makes that network the active one (the camera stays where it is)
      if (C && C.id !== S.active) activate(C.id);
      if (e.originalEvent && e.originalEvent.shiftKey && isLeaf(n) && k !== 'query') { togglePin(n); return; }
      if (k === 'query') { cy.$(':selected').unselect(); S.selected = null; refreshEmphasis(); return; }
      if (k === 'theme' || k === 'sub') {
        cy.$(':selected').unselect(); S.selected = null;
        // wait: a double-click on a box collapses it and must not also zoom into it
        clearTimeout(boxTap);
        boxTap = setTimeout(() => focusTheme(k === 'sub' ? n.data('theme') : n.id()), 260);
        return;
      }
      // a second click on the selected root releases it: its tab closes and the full results come back. It waits
      // out a double-click, which pulls in more of its ayat and keeps it selected
      if (k === 'root' && S.selRoot && S.selRoot.id === n.id() && S.pressedSel) {
        clearTimeout(relTap);
        relTap = setTimeout(() => {
          if (S.cy !== cy || !S.selRoot || S.selRoot.id !== n.id()) return;
          releaseRoot();
          n.unselect(); if (S.selected === n.id()) S.selected = null;
          refreshEmphasis();
        }, 300);
        return;
      }
      openNode(n);
      refreshEmphasis();
      if (LAYOUT.phone()) revealAboveSheet(n);
    });
    // (selection lands before 'tap': remember whether the node was already the selected one)
    cy.on('tapstart', 'node', (e) => { S.pressed = e.target.id(); S.pressedSel = S.selected === e.target.id(); });
    cy.on('tap', (e) => {
      if (e.target === cy) { if (LAYOUT.phone()) setSheet('peek'); closeMenu(); S.focusTheme = null; S.selected = null; S.find = { matches: [], i: -1 }; releaseRoot(); updateThemeListState(); refreshEmphasis(); }
    });
    cy.on('dbltap', 'node', (e) => {
      const n = e.target, k = n.data('kind'), C = clOf(n);
      clearTimeout(boxTap);
      clearTimeout(relTap);
      if (k === 'cluster') { if (C) fitClusters([C]); return; }
      if (k === 'query') { if (C) toggleFold(C); return; }
      if (k === 'theme') { if (C && C.frozen) { toast(t('ws.frozenNo')); return; } toggleCollapse(n.id()); }
      else if (k === 'ayah' || k === 'root') expandNode(n.id());
    });
    // the right button (or a long press) lists every action of what is under the pointer
    cy.on('cxttap', (e) => { openMenuFor(e.target === cy ? null : e.target, e.renderedPosition); });
    cy.on('taphold', 'node', (e) => { if (!(e.originalEvent && e.originalEvent.button === 2)) openMenuFor(e.target, e.renderedPosition); });
    // dragging a ★ moves its whole network: the drawn nodes follow the pointer, the hidden ones catch up on release
    let starDrag = null;
    cy.on('grab', 'node[kind="query"]', (e) => {
      const n = e.target, C = clOf(n);
      if (!C) return;
      starDrag = { C, last: { ...n.position() }, total: { x: 0, y: 0 }, others: movableOf(C).not(n).filter(drawn) };
      $('#tooltip').hidden = true;
    });
    cy.on('drag', 'node[kind="query"]', (e) => {
      if (!starDrag) return;
      const p = e.target.position(), d = { x: p.x - starDrag.last.x, y: p.y - starDrag.last.y };
      starDrag.last = { ...p }; starDrag.total.x += d.x; starDrag.total.y += d.y;
      starDrag.others.shift(d);
    });
    cy.on('free', 'node[kind="query"]', (e) => {
      if (!starDrag) return;
      const { C, total, others } = starDrag;
      starDrag = null;
      if (!total.x && !total.y) return;
      movableOf(C).not(e.target).not(others).shift(total);
      C.off = { x: C.off.x + total.x, y: C.off.y + total.y };
      C.userPlaced = true;
      updateBundles();
      S.layer && S.layer.update();
      emit('change');
    });
    cy.on('dragfree', 'node', (e) => {
      const n = e.target, pressed = cy.$id(S.pressed || ''), C = clOf(n);
      if (n.data('kind') === 'query') return;
      if (pressed.nonempty() && !isLeaf(pressed)) {
        // a whole box was dragged: remember the box (in the network's frame), and move existing pins inside it along with it
        if (n.id() === pressed.id() && n.data('kind') === 'theme' && C) {
          // (a closed box's ayat are hidden and have no bounds: use the box itself)
          const bb = n.hasClass('collapsed') ? n.boundingBox() : n.descendants().filter(isLeaf).boundingBox();
          n.data({ pinnedBox: true, boxPos: { x: (bb.x1 + bb.x2) / 2 - C.off.x, y: (bb.y1 + bb.y2) / 2 - C.off.y } });
          n.addClass('pinned-box');
        }
        if (isLeaf(n) && pinOf(n)) pin(n, true);
      } else if (isLeaf(n) && n.id() === S.pressed) pin(n, true);
      updateBundles();
      S.layer && S.layer.update();
      scheduleDeclutter();   // labels move to the sides their links now leave empty
      emit('change');
    });
    cy.on('zoom', onZoom);
    cy.on('pan', () => scheduleDeclutter());
    cy.on('zoom pan', scheduleCamera);
    cy.on('add', 'node', relabel);
    cy.on('select', 'node', (e) => { S.selected = e.target.id(); });
    relabel();
  }

  // pins live in the network's frame (its own ★ at the origin), so moving the network keeps them in place
  function pin(n, on) {
    const C = clOf(n), off = C ? C.off : { x: 0, y: 0 }, mode = C ? C.mode : S.mode;
    const pins = { ...(n.data('pins') || {}) };
    if (on) pins[mode] = { x: n.position().x - off.x, y: n.position().y - off.y }; else delete pins[mode];
    n.data('pins', pins);
    n.toggleClass('pinned', on);
  }
  function togglePin(n) { const on = !pinOf(n); pin(n, on); toast(t(on ? 'toast.pinned' : 'toast.unpinned')); emit('change'); }
  function unpinAll() {
    if (!S.cy) return;
    S.cy.nodes().forEach((n) => {
      if (n.data('pins')) { n.data('pins', {}); n.removeClass('pinned'); }
      if (n.data('pinnedBox')) { n.data('pinnedBox', false); n.removeClass('pinned-box'); }
    });
    toast(t('toast.allUnpinned'));
    emit('change');
  }

  function showEdgeTip(edge, rp) {
    const tt = $('#tooltip'), d = edge.data();
    let html = '';
    if (d.type === 'phrase') html = `<div class="t-ref">${t('tt.phrase')}${d.n ? ` (${t('cnt.words', { n: d.n })})` : ''}</div>${d.phrase ? `<div class="t-ar" lang="ar">${esc(d.phrase)}</div>` : ''}`;
    else if (d.type === 'meaning') html = `<div class="t-ref">${t('tt.meaning', { w: d.w ?? '' })}</div>`;
    else if (d.type === 'tlink') html = `<div class="t-ref">${t('tt.tlink')}</div><div class="t-en">${t('tt.tlinkInfo', { m: d.meaning, p: d.phrase, r: d.roots })}</div>`;
    else if (d.type === 'cooc') html = `<div class="t-ref">${t('tt.cooc', { w: d.w ?? '' })}</div>`;
    else return;
    S.tip = { id: edge.id(), edge: true, rp };
    tt.innerHTML = html; tt.hidden = false; placeTooltip(rp);
  }

  // an open tooltip is re-rendered in the new language when the UI language changes
  function refreshTooltip() {
    const tip = S.tip, el = tip && S.cy && S.cy.$id(tip.id);
    if (!el || el.empty() || $('#tooltip').hidden) return;
    if (tip.edge) showEdgeTip(el, tip.rp); else showTooltip(el, tip.rp);
  }

  // getBoundingClientRect in CSS px: the page is zoomed when Chrome's "Desktop site" is on (QR_LAYOUT)
  const pageZoom = () => parseFloat(document.documentElement.style.zoom) || 1;
  function cssRect(el) {
    const r = el.getBoundingClientRect(), z = pageZoom();
    return { left: r.left / z, top: r.top / z, width: r.width / z, height: r.height / z, bottom: r.bottom / z };
  }

  function placeTooltip(rp) {
    const tt = $('#tooltip');
    if (S.tip) S.tip.rp = rp;
    const g = cssRect($('#graph')), st = cssRect($('#stage'));
    let x = rp.x + (g.left - st.left) + 16, y = rp.y + (g.top - st.top) + 16;
    if (x + tt.offsetWidth > st.width - 8) x = x - tt.offsetWidth - 32;
    if (y + tt.offsetHeight > st.height - 8) y = st.height - tt.offsetHeight - 8;
    tt.style.left = `${Math.max(8, x)}px`; tt.style.top = `${Math.max(8, y)}px`;
  }

  // tooltip lines: .t-ref / .t-help are interface text; Quran text, names and the translation carry their own lang
  async function showTooltip(n, rp) {
    const tt = $('#tooltip');
    const d = n.data();
    S.tip = { id: n.id(), rp };
    const quran = (s) => `<div class="t-ar" lang="ar">${esc(trim(s, 170))}</div>`;
    const trans = (s) => `<div class="t-en" ${enAttr}>${esc(trim(s, 180))}</div>`;
    const C = clOf(n);
    let html = '';
    if (d.kind === 'ayah') {
      const r = C && C.resultByI.get(ayahIdx(d.id));
      const twins = twinsOf(n).length;
      const shared = twins ? `<div class="t-en">${t('ws.alsoIn', { n: twins })}</div>` : '';
      if (r) {
        html = `<div class="t-ref">${esc(d.ref)} · ${bdiAr(r.sname)}${pinOf(n) ? ' · 📌' : ''}</div>${quran(r.words.join(' '))}${trans(r.en)}${shared}`;
      } else {
        html = `<div class="t-ref">${esc(d.ref)}</div>`;
        tt.innerHTML = html; tt.hidden = false; placeTooltip(rp);
        try {
          const a = await getAyah(d.ref);
          if (S.hover !== d.id) return;
          html = `<div class="t-ref">${esc(d.ref)} · ${bdiAr(a.surah.name)}</div>${quran(a.text)}${trans(a.en)}${shared}`;
        } catch (_) { return; }
      }
    } else if (d.kind === 'root') {
      html = `<div class="t-ref">${t('tt.root', { occ: t('cnt.occ', { n: d.n }) })}${d.bridge ? t('tt.bridge') : ''}</div><div class="t-ar" lang="ar" style="font-family:Amiri;font-size:24px">${esc(d.label)}</div>${d.gloss ? `<div class="t-en" ${enAttr}>${esc(d.gloss)}</div>` : ''}<div class="t-en">${t(C && C.kind === 'search' ? 'tt.rootHelpSearch' : 'tt.rootHelp')}</div>`;
    } else if (d.kind === 'theme') {
      const lemma = d.tkind === 'lemma' || d.tkind === 'form';
      html = `<div class="t-ref">${t(lemma ? 'tt.form' : 'tt.theme', { size: countOf(d.size) })}</div><div class="t-name" style="font-size:20px">${nameHtml({ ...d, related: false })}</div>${d.roots && d.roots.length && !lemma ? `<div class="t-en">${t('tt.themeRoots', { r: bdiAr(d.roots.join(' · ')) })}</div>` : ''}<div class="t-en">${t('tt.themeHelp')}</div>`;
    } else if (d.kind === 'sub') {
      html = `<div class="t-ref">${t('tt.sub', { size: t('cnt.ayat', { n: d.size }) })}</div><div class="t-name" style="font-size:18px">${nameHtml(d.label_ar ? d : { label_ar: t('g.part', { k: d.k + 1 }) })}</div>`;
    } else if (d.kind === 'query') {
      html = `<div class="t-ref">${t('tt.query')}${C && C.frozen ? ` · ${t('ws.frozen')}` : ''}</div><div class="t-name">${bdiAuto(C ? (C.title || C.params.q) : d.label)}</div>${C ? `<div class="t-en">${provenance(C)}${provenance(C) ? ' · ' : ''}${t('tt.queryHelp')}</div>` : ''}`;
    }
    tt.innerHTML = html; tt.hidden = false; placeTooltip(rp);
  }

  /* ------------------------------------------------------------ themes: focus, collapse */
  function focusTheme(tid, { center = true } = {}) {
    if (!S.cy) return;
    const C = cl(tid);
    if (C && C.id !== S.active) activate(C.id);
    if (S.selRoot && S.selRoot.view === 'search') releaseRoot();   // a theme focus replaces the root's emphasis
    S.focusTheme = S.focusTheme === tid && center ? null : tid;
    updateThemeListState();
    refreshEmphasis();
    if (S.focusTheme && center) {
      const t = S.cy.$id(tid);
      const eles = !C || C.mode === 'organized' ? t : S.cy.nodes(`[theme="${tid}"]`);
      // a closed box is only centred: fitting it would zoom one small box up to fill the screen
      if (t.hasClass('collapsed')) S.cy.animate({ center: { eles: t } }, { duration: 450 });
      else S.cy.animate({ fit: { eles, padding: 60 } }, { duration: 450 });
      const el = $(`#tab-results .tgroup[data-t="${CSS.escape(tid)}"]`);
      if (el && S.sortBy === 'theme') { showTab('results'); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
  }

  function setCollapsed(t, on, { shared = true } = {}) {
    const cy = S.cy, C = clOf(t);
    const anchor = cy.$id(`${t.id()}:a`);
    if (on && anchor.nonempty()) {
      const bb = t.descendants().filter(isLeaf).boundingBox();
      anchor.position({ x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 });
    }
    cy.batch(() => {
      t.descendants().toggleClass('hidden', on);
      cy.nodes(`[kind="ayah"][theme="${t.id()}"]`).toggleClass('hidden', on);
      anchor.toggleClass('hidden', !on);
      t.toggleClass('collapsed', on);
      t.data('label', themeLabel(t.data(), on));
      if (on) sizeClosedBox(t);
      else t.removeStyle('min-width min-height font-size text-max-width text-wrap');
    });
    if (shared && C) syncCollapsedShared(C);
    relabel();
  }

  // a closed box is sized to its name, wrapped onto a few lines (a name can be a whole Quranic phrase)
  function sizeClosedBox(t) {
    const lines = t.data('label').split('\n');
    const W = clamp(Math.max(...lines.map((l) => l.length)) * 9.3 / 3 + 34, 150, 230);
    const rows = lines.reduce((n, l) => n + Math.ceil((l.length * 9.3) / (W - 28)), 0);
    t.style({ 'min-width': W, 'min-height': rows * 21 + 34, 'font-size': 16, 'text-max-width': W - 28, 'text-wrap': 'wrap' });
  }

  // what depends on every box at once: bridge roots and theme-link counts (once per batch of boxes)
  function syncCollapsedShared(C) {
    const cy = S.cy;
    if (!C) return;
    cy.batch(() => {
      nodesOf(C).filter('[kind="root"][?bridge]').forEach((r) => {
        // a bridge root whose ayat are all collapsed is noise in the theme map
        r.toggleClass('hidden', r.neighborhood('node[kind="ayah"]').filter((m) => !m.hasClass('hidden')).empty());
      });
      // theme↔theme links show their counts once boxes are closed
      cy.edges(`[type="tlink"][cid="${C.id}"]`).forEach((e) => {
        const closed = e.source().hasClass('collapsed') && e.target().hasClass('collapsed');
        e.data('tl', closed ? String(e.data('n')) : '');
      });
    });
    syncCrossEdges();
  }

  // the ring of one network re-spaced after a box changed size (inside its frame, neighbours pushed if needed)
  const respace = (C, opts = {}) => transition([C], async (X) => { if (X.big) await layoutPending(X); ringPlace(X); placeBridges(X); restorePins(X); }, { doFit: false, ...opts });

  async function toggleCollapse(tid, force, { auto = false, recenter = true } = {}) {
    if (!S.cy) return;
    const C = cl(tid);
    if (!C || C.folded) return;
    if (C.frozen && !auto) { toast(t('ws.frozenNo')); return; }
    // decided before the mode switch: on a large graph, going back to organised closes every box first
    const want = force ?? !S.cy.$id(tid).hasClass('collapsed');
    if (C.mode !== 'organized') await setMode('organized', { only: C });
    const cy = S.cy, t = cy.$id(tid);
    if (!cy || t.empty()) return;
    if (!auto && C.autoOpen === tid) C.autoOpen = null;   // the user took this box over: never auto-close it
    if (!auto && S.selRoot) S.selRoot.opened = S.selRoot.opened.filter((x) => x !== tid);   // (nor on root release)
    setCollapsed(t, want);
    updateThemeListState();
    refreshEmphasis();
    // a box changed size: re-space the ring so boxes don't overlap
    await respace(C);
    if (S.cy !== cy || t.removed()) return;
    const bb = t.renderedBoundingBox(), W = S.cy.width(), H = S.cy.height();
    if (recenter && (bb.x1 < 0 || bb.y1 < 0 || bb.x2 > W || bb.y2 > H)) S.cy.animate({ center: { eles: t } }, { duration: 350 });
    emit('change');
  }

  function setThemesOnly(on, C = act()) {
    if (!S.cy || !C || C.folded) return;
    if (C.frozen) { toast(t('ws.frozenNo')); return; }
    C.themesOnly = on;
    C.autoOpen = null;
    if (C === act()) $('#btnThemesOnly').setAttribute('aria-pressed', String(on));
    themesOf(C).forEach((th) => setCollapsed(th, on, { shared: false }));
    syncCollapsedShared(C);
    updateThemeListState();
    refreshEmphasis();
    emit('change');
    // re-space the ring for the closed (small) or reopened (large) boxes
    return respace(C, { doFit: true });
  }

  function updateThemeListState() {
    $$('#communities .comm').forEach((el) => {
      const t = S.cy && S.cy.$id(el.dataset.t);
      el.classList.toggle('on', el.dataset.t === S.focusTheme);
      const m = $('.comm-main', el);
      if (m) m.setAttribute('aria-pressed', String(el.dataset.t === S.focusTheme));
      const col = !!(t && t.nonempty() && t.hasClass('collapsed'));
      el.classList.toggle('collapsed', col);
      const b = $('.cbtn.col', el);
      if (b) {
        b.textContent = col ? '⊞' : '⊟';
        b.setAttribute('aria-label', I18N.t(col ? 'comm.expA' : 'comm.colA', { t: t && t.nonempty() ? themeNames(t.data()).main : '' }));
      }
    });
  }

  /* ------------------------------------------------------------ expand (double-click) */
  async function expandNode(id) {
    const cy = S.cy;
    if (!cy) return;
    const n = cy.$id(id), C = clOf(n);
    if (n.empty() || !C) return;
    // a frozen network never changes: the related ayat open as a network branched from this node
    if (C.kind === 'roots' || C.frozen) {
      if (C.frozen) toast(t('ws.frozenBranch'));
      branchFrom(n, n.data('kind') === 'root' ? 'root' : 'ayah');
      return;
    }
    if (C.expanding) { toast(t('toast.stillExpanding')); return; }
    C.expanding = true;
    setBusy(1);
    try {
      const res = await api('/api/expand', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: localOf(id), exclude: nodesOf(C).map((x) => localOf(x.id())), n: 10,
          q: C.data ? C.data.query.q : null, mode: C.data ? C.data._mode || 'auto' : 'auto', ...precisionArgs(C) }),
      });
      if (S.cy !== cy || !S.clusters.has(C.id) || n.removed()) return;   // the network went meanwhile
      if (!res.nodes.length) { toast(t('toast.nothingNew')); return; }
      let tid = n.data('theme');
      if (!tid) tid = addExpansionTheme(C, n);
      const base = n.position(), p = (x) => mk(C.id, x);
      res.results.forEach((r) => C.resultByI.set(r.i, r));
      cy.batch(() => {
        res.nodes.forEach((m, k) => {
          if (cy.$id(p(m.id)).nonempty()) return;
          const ang = (k / res.nodes.length) * Math.PI * 2;
          const d = { id: p(m.id), cid: C.id, kind: 'ayah', label: m.ref, ref: m.ref, role: 'expanded', s: m.s, stype: m.stype,
            lexical: false, rank: 1, sz: 10, theme: tid, col: cy.$id(tid).data('col') || G.misc, added: true };
          if (!C.detached) d.parent = tid; else { d.home = tid; d.parent = C.id; }
          const added = cy.add({ group: 'nodes', data: d, position: { x: base.x + Math.cos(ang) * 40, y: base.y + Math.sin(ang) * 40 } });
          addCopy(added);
          C.order.push(p(m.id));
        });
        res.edges.forEach((e, k) => {
          const s = cy.$id(p(e.s)), tg = cy.$id(p(e.t));
          if (s.empty() || tg.empty()) return;
          if (s.edgesWith(tg).filter((x) => x.data('type') === e.type).nonempty()) return;
          const a = s.data('theme'), b = tg.data('theme');
          const cross = a && b && a !== b ? 'theme' : '';
          cy.add({ group: 'edges', classes: cross ? 'x' : '', data: { id: p(`x${Date.now()}_${k}`), cid: C.id, source: s.id(), target: tg.id(), type: e.type, cross, w: e.w, added: true } });
        });
      });
      const th = cy.$id(tid);
      if (th.hasClass('collapsed')) setCollapsed(th, true);
      th.data('size', cy.nodes(`[kind="ayah"][theme="${tid}"]`).length);
      th.data('label', themeLabel(th.data(), th.hasClass('collapsed')));
      frameOf(C).data('label', clusterTitle(C));
      recolor(C);
      applyLabels(C);
      applyEdgeVisibility();
      if (C.mode === 'organized') {
        await transition([C], async (X) => {
          // a closed box of a large graph is laid out (afresh) when it opens; an open one now, and stays laid
          if (X.big && th.hasClass('collapsed')) th.data('laid', false);
          else { await layoutThemesInside(X, th); th.data('laid', true); }
          await computeOrganized(X, { keepInner: true });
        }, { doFit: false });
      } else await setMode(C.mode, { only: C });
      if (C === act()) {
        if (C.data) renderResults(C.data);
        if (S.selRoot) { renderNodeTab({ keep: true }); loadRootMarks(); }
        renderThemeList();
      }
      updateSwitcher();
      toast(t('toast.added', { ayat: t('cnt.ayat', { n: res.nodes.length }), t: themeNames(th.data()).main }));
      emit('change');
    } catch (err) {
      toast(t('toast.expandFail', { e: err.message }), true);
    } finally { C.expanding = false; setBusy(-1); }
  }

  function addExpansionTheme(C, n) {
    const cy = S.cy;
    const c = themesOf(C).length + C.extraThemes++;
    const id = mk(C.id, `tx${c}`);
    const order = Math.max(0, ...themesOf(C).map((t) => t.data('order') + 1));
    cy.add({ group: 'nodes', data: { id, kind: 'theme', cid: C.id, parent: C.id, c, misc: false, size: 0, order, col: G.pal[c % G.pal.length],
      label_ar: `+ ${n.data('label')}`, label_en: '', pulled: true, added: true, roots: [], label: '' }, classes: C.mode !== 'organized' ? 'ghost' : '' });
    cy.add(anchorEl(C.id, id));
    return id;
  }

  /* ------------------------------------------------------------ find in graph */
  function runFind(q) {
    const cy = S.cy;
    if (!cy) return;
    const raw = toLatinDigits(q.trim()), nq = normAr(raw), nqs = nospace(nq), fullRef = /^\d+:\d+$/.test(raw);
    let matches = [];
    if (raw) {
      // every network counts, the active one first, then the others by last use; ayat in closed theme boxes and
      // folded networks count too: stepping to one opens its box (selectNode). So do bridge roots hidden with
      // their closed boxes: picking one opens a box of its ayat (revealRoot)
      const order = [...new Set([S.active, ...S.mru, ...allC().map((C) => C.id)].filter(Boolean))];
      order.forEach((cid) => {
        const C = S.clusters.get(cid);
        if (!C) return;
        const mine = [];
        leavesOf(C).filter((n) => n.visible() || closedBoxOf(n) || C.folded || (n.data('kind') === 'root' && n.hasClass('hidden'))).forEach((n) => {
          const d = n.data();
          if (d.kind === 'ayah') {
            // a complete reference matches only itself (3:7 is not 3:78); a partial one ("3:" or "3") lists the surah
            if (/^\d/.test(raw)) { if (fullRef ? d.ref === raw : d.ref.startsWith(raw.includes(':') ? raw : raw + ':')) mine.push(n.id()); return; }
            const r = C.resultByI.get(ayahIdx(d.id));
            if (r && nq.length >= 2 && normAr(r.words.join(' ')).includes(nq)) mine.push(n.id());
            else if (r && raw.length >= 3 && /[a-z]/i.test(raw) && r.en.toLowerCase().includes(raw.toLowerCase())) mine.push(n.id());
          } else if (d.kind === 'root' && nqs.length >= 2 && nospace(normAr(d.label)).startsWith(nqs)) mine.push(n.id());
        });
        const refKey = (id) => cy.$id(id).data('ref') ? cy.$id(id).data('ref').split(':').map(Number) : [999, 0];
        mine.sort((a, b) => { const x = refKey(a), y = refKey(b); return x[0] - y[0] || x[1] - y[1]; });
        matches = matches.concat(mine);
      });
    }
    cy.nodes('.match').removeClass('match');
    S.find = { matches, i: -1 };
    coll(matches).addClass('match');
    const fc = $('#findCount');
    const nets = new Set(matches.map(cidOf)).size;
    fc.textContent = !raw ? '' : matches.length ? (nets > 1 ? t('find.count', { n: matches.length, nets }) : `${matches.length}`) : (fullRef ? t('find.notIn') : '0');
    if (raw && !matches.length && fullRef) fc.dataset.i18n = 'find.notIn'; else delete fc.dataset.i18n;
    if (raw) { cy.$(':selected').unselect(); S.selected = null; }   // typing a find shows all its matches
    refreshEmphasis();
  }
  function findNext(step = 1) {
    const m = S.find.matches;
    if (!m.length) return;
    S.find.i = (S.find.i + step + m.length) % m.length;
    $('#findCount').textContent = `${S.find.i + 1}/${m.length}`;
    delete $('#findCount').dataset.i18n;
    selectNode(m[S.find.i], { center: true });
  }

  /* ------------------------------------------------------------ selection + keyboard navigation */
  // the closed theme box an ayah / root is hidden in (organised layout), if any
  function closedBoxOf(n) {
    const C = clOf(n), t = n.data('theme') ? S.cy.$id(n.data('theme')) : null;
    return C && C.mode === 'organized' && t && t.nonempty() && t.hasClass('collapsed') && n.hasClass('hidden') ? t : null;
  }

  function selectNode(id, { center = false, open = true } = {}) {
    const cy = S.cy;
    if (!cy) return;
    const n = cy.$id(id), C = clOf(n);
    if (n.empty() || !C) return;
    if (C.id !== S.active) activate(C.id);
    if (C.folded) toggleFold(C, false);   // a node inside a folded network: open the network first
    cy.$(':selected').unselect();
    n.select();
    S.selected = id;
    const box = closedBoxOf(n);
    const focus = () => cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 350 });
    if (box) {
      // an ayah inside a closed theme: open the theme, then bring the ayah into view. Boxes open one at a
      // time (stepping through the list quickly), and on a large graph the box opened for the previous
      // selection closes again, so walking the list never ends up drawing every theme at once
      S.boxChain = S.boxChain.then(async () => {
        if (S.cy !== cy || S.selected !== id) return;   // stepped on meanwhile: only the latest box opens
        if (C.mode !== 'organized') return;   // the user left organised meanwhile: don't force it back
        const prev = C.big && C.autoOpen && C.autoOpen !== box.id() ? cy.$id(C.autoOpen) : null;
        if (prev && prev.nonempty() && !prev.hasClass('collapsed')) setCollapsed(prev, true);
        C.autoOpen = box.id();
        await toggleCollapse(box.id(), false, { auto: true, recenter: !center });   // one camera move, not two
        if (S.cy === cy && S.selected === id) { if (center) focus(); refreshEmphasis(); }
      }).catch((err) => console.error(err));
    } else if (center) focus();
    if (open) openNode(n);
    refreshEmphasis();
  }

  function openNode(n) {
    const d = n.data();
    S.selected = n.id();
    if (d.kind === 'ayah') showAyah(d.ref);
    else if (d.kind === 'root') pickRoot(n);
  }

  function navAyah(step) {
    const cy = S.cy, C = act();
    if (!cy || !C) return;
    let ids = C.order.filter((id) => { const n = cy.$id(id); return n.nonempty() && n.visible(); });
    if (S.focusTheme) ids = ids.filter((id) => cy.$id(id).data('theme') === S.focusTheme);
    if (S.selRoot && S.selRoot.view === 'search' && S.selRoot.cid === C.id) {   // a selected root: walk its ayat only
      const mine = new Set(rootGraphIds(S.selRoot).map((i) => ayahId(C.id, i)));
      ids = ids.filter((id) => mine.has(id));
    }
    if (!ids.length) return;
    const k = ids.indexOf(S.selected);
    const next = ids[k < 0 ? (step > 0 ? 0 : ids.length - 1) : (k + step + ids.length) % ids.length];
    selectNode(next, { center: true });
  }

  function navTheme(step) {
    if (!S.cy) return;
    const ids = themesSorted().map((t) => t.id());
    if (!ids.length) return;
    const k = ids.indexOf(S.focusTheme);
    focusTheme(ids[(k + step + ids.length) % ids.length], { center: true });
  }

  // { and } step through the networks (by canvas order), fitting the camera to each
  function navCluster(step) {
    const ids = allC().map((C) => C.id);
    if (!ids.length) return;
    const k = ids.indexOf(S.active);
    activate(ids[(k + step + ids.length) % ids.length], { camera: true });
  }

  /* ------------------------------------------------------------ export */
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportName(ext) {
    const C = act();
    const base = S.clusters.size > 1 ? 'workspace' : C && C.kind === 'roots' ? 'root-network' : (C ? C.params.q : 'graph');
    return `quran-${base.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${S.mode}.${ext}`;
  }

  /* ------------------------------------------------------------ search */
  function readHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return null;
    const p = new URLSearchParams(h);
    return p.get('q') ? { q: p.get('q'), mode: p.get('mode'), scope: p.get('scope'), n: p.get('n') } : null;
  }

  // the parameters as the engine takes them; a network is identified by them (the same search again goes to it)
  const PARAM_KEYS = ['q', 'mode', 'scope', 'n', 'precision', 'group', 'meaning', 'match'];
  const paramsKey = (p) => PARAM_KEYS.map((k) => p[k] || '').join('\u0001');
  const cleanParams = (p) => { const o = {}; PARAM_KEYS.forEach((k) => { if (p[k] != null && p[k] !== '') o[k] = String(p[k]); }); return o; };
  // the marking parameters of a network's search, for cards / passages / expansions marked like its results
  const precisionArgs = (C) => { const o = {}; ['precision', 'match'].forEach((k) => { if (C && C.params && C.params[k]) o[k] = C.params[k]; }); return o; };

  function newCluster(kind, params, data, { anchor = null } = {}) {
    const id = `c${++S.cseq}`;
    return { id, n: S.cseq, kind, params, key: kind === 'search' ? paramsKey(params) : 'roots', data, resultByI: new Map(), order: [],
      big: false, themesOnly: false, detached: false, radial: null, extraThemes: 0, expanding: false, off: { x: 0, y: 0 }, userPlaced: false,
      mode: S.mode, frozen: false, folded: false, anchor, title: null, scroll: null, autoOpen: null, footLocal: null, created: Date.now(), placed: false };
  }

  // the search bar and every chip come here. Enter adds a network; Shift (`replace`) puts it in the active one's
  // place unless that one is frozen; `anchor` branches it from a node of another network
  async function runSearch(q, { replace = false, anchor = null, params = null } = {}) {
    q = (q ?? $('#q').value).trim();
    if (!q) { $('#q').focus(); return null; }
    if (!params) $('#q').value = q;
    closeSuggest();
    if (S.view !== 'search') switchView('search', { silent: true });
    const P = params || { q, mode: $('#mode').value, scope: $('#scope').value, n: $('#n').value };
    return addCluster(cleanParams(P), { replace, anchor });
  }

  // one more network on the canvas (or, `refine`, that network searched again with other settings, in place)
  async function addCluster(P, { replace = false, anchor = null, refine = null } = {}) {
    const key = paramsKey(P);
    const dup = allC().find((C) => C.kind === 'search' && C.key === key && C !== refine);
    if (dup && !refine) { activate(dup.id, { camera: true }); toast(t('ws.dup')); return dup; }
    let target = null;
    if (!refine && replace) {
      const A = act();
      if (A && A.kind === 'search') { if (A.frozen) toast(t('ws.frozenAdd')); else target = A; }
    }
    setBusy(1);
    try {
      const data = await api(`/api/search?${new URLSearchParams(P)}`);
      if (data.error) { toast(t('toast.noAyah', { e: I18N.note(data.error) }), true); return null; }
      data._mode = P.mode;   // cards / passages for this search are marked with the same q + mode
      const cy = ensureCy();
      let C;
      if (refine && S.clusters.has(refine.id)) {
        // the same network with other settings: its elements are replaced where it stands (undoable)
        C = refine;
        const old = detachCluster(C);
        S.undo.push({ type: 'refine', C, removed: old.removed, state: old.state, ts: Date.now() });
        resetCluster(C, P, data);
      } else {
        C = newCluster('search', P, data, { anchor });
      }
      indexResults(C);
      $('#welcome').hidden = true;
      showChrome(true);
      await mountCluster(C, data.graph);
      if (S.cy !== cy || !S.clusters.has(C.id)) return null;
      if (refine) resolveOverlaps([C]);
      else {
        let at = null;
        if (target && S.clusters.has(target.id)) { at = { ...target.off }; removeCluster(target, { undo: true, quiet: true }); }
        placeNew(C, { anchorNode: anchor ? cy.$id(anchor.from) : null, at });
      }
      syncCrossEdges();
      syncSolo();
      activate(C.id, { camera: true, force: true });
      showTab('results');
      // a new list starts at its top (counts, banners), not at the previous list's scroll position
      S.tabScroll = { results: 0, node: 0, detail: 0, notes: 0 };
      const sb = $('.side-body');
      if (getComputedStyle(sb).overflowY === 'auto') sb.scrollTop = 0;
      else if (sb.getBoundingClientRect().top < 0) window.scrollBy(0, sb.getBoundingClientRect().top);
      if (data.seeds.length) showAyah(data.seeds[0].ref, { switchTab: false });
      if (refine && !C.frozen) toast(t('ws.refined'), false, { label: t('ws.undo'), fn: undoLast });
      emit(refine ? 'cluster:refine' : 'cluster:add', { cid: C.id, params: C.params });
      emit('change');
      return C;
    } catch (err) {
      toast(t('toast.err', { e: err.message }), true);
      return null;
    } finally { setBusy(-1); }
  }

  // search a network again with some settings changed (precision, scope, size, grouping): in place, undoable;
  // a frozen network opens the result as a network branched from its ★ instead
  function refineCluster(C, patch) {
    if (!C || C.kind !== 'search') return null;
    const P = cleanParams({ ...C.params, ...patch });
    if (C.frozen) { toast(t('ws.frozenBranch')); return addCluster(P, { anchor: anchorFrom(qOf(C), 'refine') }); }
    return addCluster(P, { refine: C });
  }

  function indexResults(C) {
    const data = C.data;
    if (C.kind === 'roots') { C.resultByI = new Map(); C.order = data.nodes.map((n) => mk(C.id, n.id)); return; }
    C.resultByI = new Map([...data.results, ...data.seeds].map((r) => [r.i, r]));
    if (data._rest) data._rest.cards.forEach((r) => { if (!C.resultByI.has(r.i)) C.resultByI.set(r.i, r); });
    C.order = [...data.seeds, ...data.results].map((r) => ayahId(C.id, r.i));
  }

  // take a network's elements off the canvas (kept for undo) and remember the state they belong to
  function detachCluster(C) {
    const cy = S.cy, f = frameOf(C);
    const eles = f.union(f.descendants()).union(cy.edges(`[dst="${C.id}"]`));
    eles.nodes('[kind="ayah"]').forEach(dropCopy);
    const state = {};
    ['params', 'key', 'data', 'resultByI', 'order', 'big', 'themesOnly', 'detached', 'radial', 'extraThemes', 'autoOpen', 'footLocal', 'folded'].forEach((k) => { state[k] = C[k]; });
    return { removed: eles.remove(), state };
  }
  function resetCluster(C, P, data) {
    Object.assign(C, { params: P, key: paramsKey(P), data, resultByI: new Map(), order: [], big: false, themesOnly: false, detached: false,
      radial: null, extraThemes: 0, expanding: false, autoOpen: null, footLocal: null, folded: false });
  }

  function showChrome(on) {
    $('#legend').hidden = !on; $('#toolbar').hidden = !on; $('#hint').hidden = !on;
    const wasLegend = $('#stage').classList.contains('with-legend');
    $('#stage').classList.toggle('with-legend', on && !$('#legend').classList.contains('closed'));
    if (S.cy && wasLegend !== $('#stage').classList.contains('with-legend')) S.cy.resize();   // the canvas changed width with the legend
    const roots = S.kind === 'roots';
    $('#nodeKey').hidden = roots;
    $('#colorSec').hidden = roots;
    $$('#edgeToggles label').forEach((l) => { const ty = $('input', l).dataset.edge; l.hidden = roots && ty !== 'tlink' && ty !== 'anchor'; });
  }

  /* ------------------------------------------------------------ the workspace: networks side by side */
  const circled = (n) => (n >= 1 && n <= 20 ? String.fromCodePoint(0x245F + n) : `(${n})`);
  const queryOf = (C) => C.title || (C.kind === 'roots' ? t('view.roots') : C.params.q);
  const shortQ = (C) => { const q = queryOf(C); return q.length > 28 ? q.slice(0, 26) + '…' : q; };
  function countsOf(C) {
    if (C.kind === 'roots') return t('cnt.roots', { n: nodesOf(C).filter('[kind="root"]').length });
    return t('cnt.ayat', { n: ayahNodesOf(C).length });
  }
  // the title above a network's frame: its number, query, size and lock
  const clusterTitle = (C) => isoLine(`${circled(C.n)} ${cv(shortQ(C))} · ${countsOf(C)}${C.frozen ? ' 🔒' : ''}`);
  // where a branched network came from, as text («from 2:153 in الصبر»)
  const provenance = (C) => (C && C.anchor && C.anchor.label ? t('ws.from', { src: bdiAuto(C.anchor.label), net: bdiAuto(C.anchor.net || '') }) : '');
  // the record a branched search keeps about its source node (the link is drawn from it while it exists)
  function anchorFrom(n, via) {
    if (!n || n.empty()) return null;
    const d = n.data(), C = clOf(n);
    const label = d.kind === 'ayah' ? d.ref : d.kind === 'root' ? d.root : d.kind === 'theme' ? themeNames(d).main : d.kind === 'query' ? (C ? shortQ(C) : d.q) : d.label;
    return { from: n.id(), via, label, net: C ? shortQ(C) : '' };
  }
  function syncSolo() { if (S.cy) S.cy.nodes('[kind="cluster"]').toggleClass('solo', S.clusters.size < 2); }

  // the branch links: from the node a network was searched from to that network's ★; when the node is not drawn
  // (closed box, folded network), from its stand-in; gone when the source network was removed
  function syncCrossEdges() {
    const cy = S.cy;
    if (!cy) return;
    allC().forEach((C) => {
      if (!C.anchor || !C.anchor.from) return;
      const id = `X:anc:${C.id}`, tgt = qOf(C);
      const e = cy.$id(id);
      if (tgt.empty()) { e.remove(); return; }
      const src = cy.$id(C.anchor.from), P = cl(C.anchor.from);
      let srcId = null;
      if (src.nonempty() && P && S.clusters.has(P.id)) {
        if (P.folded) srcId = qId(P.id);
        else if (drawn(src) && !src.hasClass('hidden')) srcId = src.id();
        else { const box = closedBoxOf(src); srcId = box ? box.id() : qId(P.id); }
      } else if (P && S.clusters.has(P.id) && qOf(P).nonempty()) srcId = qId(P.id);
      if (!srcId || srcId === tgt.id()) { e.remove(); return; }
      if (e.empty()) cy.add({ group: 'edges', data: { id, cid: 'X', source: srcId, target: tgt.id(), type: 'anchor', cross: '', dst: C.id } });
      else if (e.data('source') !== srcId) e.move({ source: srcId });
    });
  }

  function activate(cid, { camera = false, force = false } = {}) {
    const C = S.clusters.get(cid);
    if (!C || !S.cy) return;
    if (cid === S.active && !force) { if (camera) fitClusters([C]); return; }
    const prev = act();
    if (prev && prev !== C) {
      prev.scroll = { ...S.tabScroll };
      if (S.selRoot && S.selRoot.cid !== cid) releaseRoot();
      S.focusTheme = null;
    }
    S.active = cid;
    S.mru = [cid, ...S.mru.filter((x) => x !== cid)];
    S.tabScroll = C.scroll || { results: 0, node: 0, detail: 0, notes: 0 };
    S.cy.nodes('[kind="cluster"].cl-active').removeClass('cl-active');
    frameOf(C).addClass('cl-active');
    syncModeButtons();
    showChrome(true);
    renderThemeList();
    if (C.kind === 'roots') renderRootList(C.data); else if (C.data) renderResults(C.data);
    updateSwitcher();
    updateThemeListState();
    if (camera) fitClusters([C]);
    emit('cluster:activate', { cid });
  }

  // a frozen network keeps its layout: its nodes and boxes pan instead of dragging, and every action that would
  // change it is refused (or opens a linked network instead); the ★ still moves the whole network
  function setFrozen(C, on = !C.frozen, { quiet = false } = {}) {
    if (!C || !S.cy || frameOf(C).empty()) return;
    C.frozen = on;
    const f = frameOf(C), nodes = nodesOf(C).not(qOf(C));
    f.toggleClass('cl-frozen', on);
    if (on) nodes.panify(); else nodes.unpanify();
    f.data('label', clusterTitle(C));
    if (C === act()) { syncModeButtons(); renderThemeList(); if (C.data) renderResults(C.data); }
    updateSwitcher();
    if (quiet) return;
    toast(t(on ? 'ws.frozenOn' : 'ws.frozenOff', { q: shortQ(C) }));
    emit('cluster:freeze', { cid: C.id, frozen: on });
    emit('change');
  }

  // fold a network to its ★ (everything else hidden; the ★ says what it holds) and open it again
  function toggleFold(C, on = !C.folded, { quiet = false } = {}) {
    const cy = S.cy;
    if (!C || !cy || frameOf(C).empty() || on === C.folded) return;
    const f = frameOf(C), star = qOf(C);
    if (on) C.footLocal = footLocalOf(C);
    C.folded = on;
    cy.batch(() => {
      f.descendants().not(star).toggleClass('ch', on);
      f.toggleClass('cl-folded', on);
      star.toggleClass('folded', on);
      star.data('label', on ? `${isoAuto(shortQ(C))}\n${isoLine(`${countsOf(C)} · ${t('cnt.themes', { n: themesOf(C).length })}  ⊞`)}` : isoAuto(shortQ(C)));
    });
    if (!on) C.footLocal = null;
    if (on && S.selected && cidOf(S.selected) === C.id) { cy.$(':selected').unselect(); S.selected = null; }
    if (on && S.selRoot && S.selRoot.cid === C.id) releaseRoot();
    syncCrossEdges();
    refreshEmphasis();
    relabel();
    updateSwitcher();
    updateThemeListState();
    if (on && !quiet && star.nonempty()) cy.animate({ center: { eles: star } }, { duration: 300 });
    emit('change');
  }
  function foldOthers(C) { allC().forEach((X) => { if (X !== C) toggleFold(X, true, { quiet: true }); }); fitClusters([C]); }
  function foldAll(on = !allC().every((X) => X.folded)) { allC().forEach((X) => toggleFold(X, on, { quiet: true })); fit(true, { all: true }); }

  // a network leaves the canvas (its elements kept 10 s for «undo», also ⌘Z); networks branched from it stay
  function removeCluster(C, { undo = true, quiet = false } = {}) {
    const cy = S.cy;
    if (!cy || !S.clusters.has(C.id)) return;
    if (C.frozen && undo) { toast(t('ws.frozenNo')); return; }
    closeMenu();
    if (S.selRoot && S.selRoot.cid === C.id) releaseRoot({ graph: false });
    const { removed } = detachCluster(C);
    S.clusters.delete(C.id);
    S.mru = S.mru.filter((x) => x !== C.id);
    if (S.selected && cidOf(S.selected) === C.id) S.selected = null;
    if (S.focusTheme && cidOf(S.focusTheme) === C.id) S.focusTheme = null;
    if (S.hover && cidOf(S.hover) === C.id) S.hover = null;
    S.find.matches = S.find.matches.filter((id) => cidOf(id) !== C.id);
    if (undo) { S.undo.push({ type: 'remove', C, removed, ts: Date.now() }); S.undo = S.undo.slice(-20); }
    syncBig(); syncCrossEdges(); syncSolo();
    if (S.active === C.id) {
      S.active = null;
      const next = S.mru[0] || (allC()[0] || {}).id;
      if (next) activate(next); else emptyPanel();
    }
    updateSwitcher();
    updateBundles();
    S.layer && S.layer.update();
    if (undo && !quiet) toast(t('ws.removed', { q: shortQ(C) }), false, { label: t('ws.undo'), fn: undoLast });
    emit('cluster:remove', { cid: C.id });
    emit('change');
  }
  function removeUnfrozen() { allC().filter((C) => !C.frozen).forEach((C) => removeCluster(C, { undo: true, quiet: true })); }
  function emptyPanel() {
    $('#welcome').hidden = false;
    showChrome(false);
    $('#tab-results').innerHTML = `<div class="empty" data-i18n="empty.start">${t('empty.start')}</div>`;
    renderThemeList();
    updateSwitcher();
  }

  function undoLast() {
    const u = S.undo.pop();
    if (!u || !S.cy) return;
    const C = u.C;
    if (u.type === 'remove') {
      if (S.clusters.has(C.id)) return;
      u.removed.restore();
      S.clusters.set(C.id, C);
      u.removed.nodes('[kind="ayah"]').forEach(addCopy);
    } else if (u.type === 'refine') {
      if (!S.clusters.has(C.id)) return;
      const f = frameOf(C), cur = f.union(f.descendants()).union(S.cy.edges(`[dst="${C.id}"]`));
      cur.nodes('[kind="ayah"]').forEach(dropCopy);
      cur.remove();
      u.removed.restore();
      u.removed.nodes('[kind="ayah"]').forEach(addCopy);
      Object.assign(C, u.state);
    }
    syncBig(); syncCrossEdges(); syncSolo();
    resolveOverlaps([C]);
    updateBundles();
    S.layer && S.layer.update();
    $('#welcome').hidden = true;
    activate(C.id, { camera: true, force: true });
    relabel();
    emit('change');
  }

  // a search branched from a node (↗): this root / this word / ayat like this ayah / this text by meaning
  function branchFrom(n, via, { replace = false } = {}) {
    const C = clOf(n), d = n.data();
    let q, mode = 'auto', precision = '';
    if (via === 'root') q = `جذر:${d.root}`;
    else if (via === 'ayah') { q = d.ref; mode = 'ayah'; }
    else if (via === 'word') {
      // a lemma box searches its lemma (every inflection); a form box searches that exact spelling
      mode = 'word';
      if (d.tkind === 'form') { q = d.label_ar || themeNames(d).main; precision = 'form'; } else q = d.key || themeNames(d).main;
    } else if (via === 'topic') { q = C ? C.params.q : d.q; mode = 'topic'; }
    else return null;
    const scope = C && C.params ? C.params.scope || 'all' : 'all';
    return addCluster(cleanParams({ q, mode, scope, n: $('#n').value, precision }), { replace, anchor: anchorFrom(n, via) });
  }
  // a chip in the panel (a sibling word, a lemma, «similar ayat»): branched from the active network's node when
  // it has one, else from its ★
  function branchFromChip(P, { from = null, via = 'word', replace = false } = {}) {
    const C = act();
    const n = from && S.cy ? S.cy.$id(from) : null;
    const src = n && n.nonempty() ? n : C ? qOf(C) : null;
    return addCluster(cleanParams({ scope: C && C.params ? C.params.scope || 'all' : 'all', n: $('#n').value, ...P }), { replace, anchor: anchorFrom(src, via) });
  }

  /* ------------------------------------------------------------ the switcher row above the side tabs */
  const depthOf = (C, seen = new Set()) => { if (!C || !C.anchor || seen.has(C.id)) return 0; seen.add(C.id); const P = cl(C.anchor.from); return P && S.clusters.has(P.id) ? 1 + depthOf(P, seen) : 0; };
  // the notes a network carries: its own note plus the notes on the ayat, roots and word boxes drawn in it
  const noteCount = (C) => {
    const N = window.QR && window.QR.notes;
    if (!N || !N.has || !S.cy) return 0;
    let n = N.has(`cluster:${C.id}`) ? 1 : 0;
    nodesOf(C).forEach((x) => { const k = noteKeyFor(x); if (k && !k.startsWith('cluster:') && N.has(k)) n++; });
    return n;
  };
  function clusterLine(C, { full = false } = {}) {
    const kind = C.kind === 'roots' ? t('kind.roots') : C.data && C.data.query ? kindLabel(C.data.query.kind) : '';
    const notes = noteCount(C);
    return `<span class="sw-n">${circled(C.n)}</span> <bdi class="sw-q">${esc(queryOf(C))}</bdi> <small>${kind ? `${kind} · ` : ''}${esc(countsOf(C))}${C.frozen ? ' 🔒' : ''}${notes ? ` ✎ ${notes}` : ''}</small>${full && provenance(C) ? `<small class="sw-from">${provenance(C)}</small>` : ''}`;
  }
  function updateSwitcher() {
    const el = $('#switcher');
    if (!el) return;
    const C = act();
    el.hidden = !C;
    if (!C) { el.innerHTML = ''; return; }
    const open = el.classList.contains('open');
    el.innerHTML = `<div class="sw-row">
        <button class="sw-cur" type="button" aria-haspopup="listbox" aria-expanded="${open}" title="${t('sw.title')}">★ ${clusterLine(C)} <span class="sw-caret">▾</span></button>
        <button class="sw-menu" type="button" title="${t('sw.menu')}" aria-label="${t('sw.menu')}">⋯</button>
      </div>
      <div class="sw-list" role="listbox" aria-label="${t('ws.networks')}"${open ? '' : ' hidden'}>${allC().map((X) => `
        <div class="sw-item${X === C ? ' on' : ''}${X.folded ? ' folded' : ''}" role="option" aria-selected="${X === C}" data-cid="${X.id}" style="--d:${depthOf(X)}">
          <button class="sw-pick" type="button">${clusterLine(X, { full: true })}</button>
          <button class="sw-act" type="button" data-act="fold" title="${t(X.folded ? 'ws.unfold' : 'ws.fold')}">${X.folded ? '⊞' : '⊟'}</button>
          <button class="sw-act" type="button" data-act="remove" title="${t('ws.remove')}"${X.frozen ? ' disabled' : ''}>✕</button>
        </div>`).join('')}</div>`;
    $('.sw-cur', el).addEventListener('click', () => { el.classList.toggle('open'); $('.sw-list', el).hidden = !el.classList.contains('open'); $('.sw-cur', el).setAttribute('aria-expanded', String(el.classList.contains('open'))); });
    $('.sw-menu', el).addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(networkMenu(C), { x: r.left, y: r.bottom }, { page: true }); });
    $$('.sw-item', el).forEach((row) => {
      const X = S.clusters.get(row.dataset.cid);
      if (!X) return;
      $('.sw-pick', row).addEventListener('click', () => { el.classList.remove('open'); $('.sw-list', el).hidden = true; activate(X.id, { camera: true }); showTab('results'); });
      $$('.sw-act', row).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); if (b.dataset.act === 'fold') toggleFold(X); else removeCluster(X); }));
    });
  }
  function closeSwitcher() { const el = $('#switcher'); if (el && el.classList.contains('open')) { el.classList.remove('open'); const l = $('.sw-list', el); if (l) l.hidden = true; } }

  // rename a network in place (its title replaces the query in the frame, the switcher and the list)
  function renameCluster(C) {
    const el = $('#switcher .sw-cur');
    if (!C || !el) return;
    const inp = document.createElement('input');
    inp.className = 'rename'; inp.dir = 'auto'; inp.value = queryOf(C); inp.setAttribute('aria-label', t('ws.renameT'));
    el.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (save && v && v !== queryOf(C)) { C.title = v === C.params.q ? null : v; frameOf(C).data('label', clusterTitle(C)); if (!C.folded) qOf(C).data('label', isoAuto(shortQ(C))); emit('cluster:rename', { cid: C.id, title: C.title }); emit('change'); }
      updateSwitcher();
      relabel();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }

  /* ------------------------------------------------------------ the context menu: every action of what is under the pointer */
  function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; } }
  // items: {label (trusted markup), key, fn, disabled, title} or {sep: true}; rp: graph-relative, or page coords
  function openMenu(items, rp, { page = false } = {}) {
    closeMenu();
    items = items.filter(Boolean);
    if (!items.length) return;
    const m = document.createElement('div');
    m.className = 'ctx'; m.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it.sep) { m.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.disabled = !!it.disabled;
      if (it.title) b.title = it.title;
      b.innerHTML = `<span>${it.label}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}`;
      b.addEventListener('click', (e) => { closeMenu(); it.fn(e); });
      m.appendChild(b);
    });
    const st = $('#stage'), sb = cssRect(st);
    st.appendChild(m);
    let x, y;
    if (page) { x = rp.x / pageZoom() - sb.left; y = rp.y / pageZoom() - sb.top; } else { const g = cssRect($('#graph')); x = rp.x + (g.left - sb.left); y = rp.y + (g.top - sb.top); }
    if (x + m.offsetWidth > sb.width - 8) x = Math.max(8, sb.width - m.offsetWidth - 8);
    if (y + m.offsetHeight > sb.height - 8) y = Math.max(8, sb.height - m.offsetHeight - 8);
    m.style.left = `${x}px`; m.style.top = `${y}px`;
    S.menu = m;
    const first = $('button:not(:disabled)', m);
    if (first) first.focus();
    m.addEventListener('keydown', (e) => {
      const bs = $$('button:not(:disabled)', m), i = bs.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); $('#graph').focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus(); }
    });
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (S.menu && !S.menu.contains(e.target)) closeMenu(); }, { once: true }), 0);
  }
  const frozenT = (C) => (C && C.frozen ? t('ws.frozenT') : '');
  function networkMenu(C) {
    if (!C) return [];
    const fr = frozenT(C), many = S.clusters.size > 1;
    return [
      { label: t('m.fit'), key: 'F', fn: () => fitClusters([C]) },
      many ? { label: t('m.fitAll'), key: 'Shift+F', fn: () => fit(true, { all: true }) } : null,
      { sep: true },
      { label: t(C.folded ? 'ws.unfold' : 'ws.fold'), fn: () => toggleFold(C) },
      many ? { label: t('ws.foldOthers'), fn: () => foldOthers(C) } : null,
      many ? { label: t('ws.foldAll'), key: 'Shift+T', fn: () => foldAll(true) } : null,
      { sep: true },
      { label: t(C.frozen ? 'ws.unfreeze' : 'ws.freeze'), fn: () => setFrozen(C) },
      { label: t('ws.rename'), fn: () => renameCluster(C), disabled: !!fr, title: fr },
      { label: t('btn.reorg'), key: 'R', fn: () => setMode(C.mode, { only: C }), disabled: !!fr || C.folded, title: fr },
      { label: t('m.note'), key: 'N', fn: () => noteOn(frameOf(C)) },
      C.kind === 'search' ? { label: t('m.copyLink'), fn: () => copyLink(C) } : null,
      { sep: true },
      { label: t('ws.remove'), key: 'Delete', fn: () => removeCluster(C), disabled: !!fr, title: fr },
    ];
  }
  function openMenuFor(ele, rp) {
    const C = ele ? clOf(ele) : act();
    const d = ele ? ele.data() : null, k = d ? d.kind : null, fr = frozenT(C);
    let items = [];
    if (k === 'ayah') {
      items = [
        { label: t('m.details'), key: 'Enter', fn: () => { selectNode(ele.id(), { open: true }); } },
        { label: t('m.pull'), key: t('m.dbl'), fn: () => expandNode(ele.id()), disabled: !!fr, title: fr },
        { label: t('m.similar'), fn: (e) => branchFrom(ele, 'ayah', { replace: e.shiftKey }) },
        { sep: true },
        { label: t('m.note'), key: 'N', fn: () => noteOn(ele) },
        { label: t(d.full ? 'm.hideText' : 'm.fullText'), fn: () => toggleFullText(ele) },
        { label: t('m.pin'), key: 'P', fn: () => togglePin(ele), disabled: !!fr, title: fr },
        { label: t('m.copy'), fn: () => copyAyah(ele) },
      ];
    } else if (k === 'root') {
      items = [
        { label: t('m.rootHere'), key: t('m.click'), fn: () => { selectNode(ele.id(), { open: true }); } },
        { label: t('m.pullRoot'), key: t('m.dbl'), fn: () => expandNode(ele.id()), disabled: !!fr, title: fr },
        { label: t('m.searchRoot'), fn: (e) => branchFrom(ele, 'root', { replace: e.shiftKey }) },
        { label: t('node.details'), fn: () => { S.listSrc = 'results'; showRoot(d.root); } },
        { sep: true },
        { label: t('m.note'), key: 'N', fn: () => noteOn(ele) },
        { label: t('m.pin'), key: 'P', fn: () => togglePin(ele), disabled: !!fr, title: fr },
      ];
    } else if (k === 'theme' || k === 'sub') {
      const tid = k === 'sub' ? d.theme : d.id, th = S.cy.$id(tid), lemma = th.data('tkind') === 'lemma' || th.data('tkind') === 'form';
      items = [
        { label: t('m.focus'), key: t('m.click'), fn: () => focusTheme(tid, { center: true }) },
        { label: t(th.hasClass('collapsed') ? 'comm.expA' : 'comm.colA', { t: themeNames(th.data()).main }), key: t('m.dbl'), fn: () => toggleCollapse(tid), disabled: !!fr, title: fr },
        lemma && th.data('key') ? { label: t('m.searchWord'), fn: (e) => branchFrom(th, 'word', { replace: e.shiftKey }) } : null,
        { sep: true },
        lemma ? { label: t('m.note'), key: 'N', fn: () => noteOn(th) } : { label: t('comm.renameT'), fn: () => { const row = $(`#communities .comm[data-t="${CSS.escape(tid)}"]`); if (row) renameTheme(row); }, disabled: !!fr, title: fr },
      ];
    } else if (k === 'query' || k === 'cluster' || !ele) {
      items = networkMenu(C);
      if (!ele && S.clusters.size > 1) items.push({ sep: true }, { label: t('ws.foldAllToggle'), fn: () => foldAll() });
    } else return;
    if (C && C.id !== S.active && ele) activate(C.id);
    openMenu(items, rp);
  }
  // N / «ملاحظة»: the note editor of a node (ayah, root, word box, a network's ★ or frame). An ayah or root
  // opens in Details first (its note sits under the translation); the notes module then focuses the editor
  async function noteOn(ele) {
    const key = ele && ele.nonempty && ele.nonempty() ? noteKeyFor(ele) : null;
    const N = window.QR && window.QR.notes;
    if (!N || !N.quickNote) { toast(t('notes.unavailable')); return; }
    if (!key) return;
    const k = ele.data('kind');
    if (k === 'ayah') await showAyah(ele.data('ref'));
    else if (k === 'root') await showRoot(ele.data('root'));
    N.quickNote(key);
  }
  function copyText(s, msg) { (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(() => toast(msg), () => toast(t('toast.copyFail'), true)); }
  function copyAyah(n) {
    const C = clOf(n), r = C && C.resultByI.get(ayahIdx(n.id()));
    if (!r) return;
    copyText(`${r.words.join(' ')} ﴿${r.ref}﴾ ${r.sname}`, t('m.copied'));
  }
  function copyLink(C) {
    const p = new URLSearchParams(cleanParams(C.params));
    copyText(`${location.origin}${location.pathname}#${p}`, t('m.copied'));
  }

  /* ------------------------------------------------------------ events for the other scripts (projects, notes) */
  const handlers = new Map();
  function on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); }
  // (while a project is being restored nothing is a change worth saving: those events stay quiet)
  function emit(ev, payload) {
    if (S.hydrating && (ev === 'change' || ev === 'camera' || ev.startsWith('cluster:'))) return;
    const hs = handlers.get(ev);
    if (hs) hs.forEach((fn) => { try { fn(payload); } catch (err) { console.error(err); } });
  }
  let camTimer = 0;
  function scheduleCamera() { clearTimeout(camTimer); camTimer = setTimeout(() => emit('camera'), 400); }
  // a note was written or erased (the notes module): badges, the ✎ counts and the cards follow
  on('notes:change', () => { syncNoted(); updateSwitcher(); $$('#tab-results .res, #tab-node .res').forEach((c) => { const m = $('.noted-mark', c); const has = window.QR.notes.has(`ayah:${c.dataset.i}`); if (has && !m) $('.res-head > span:last-child', c).insertAdjacentHTML('afterbegin', '<span class="noted-mark">✎</span> '); else if (!has && m) m.remove(); }); });

  /* ------------------------------------------------------------ the workspace as JSON: what a project saves and brings back
   * Structure (the server's graph), results as ayah ids, what was pulled in, positions local to each network's ★,
   * box states, pins, flags and the camera. Never Quran text: on restore the cards (words, marks, translation) are
   * rebuilt from the corpus through /api/cards, and no layout runs (every node lands where it was). */
  const WS_UI = { mode: ['organized', 'radial', 'free'], colorBy: ['theme', 'place', 'surah'], xMode: ['focus', 'all', 'none'], labelMode: ['ref', 'snippet', 'none'], sortBy: ['theme', 'rank'] };
  const r1 = (v) => Math.round((+v || 0) * 100) / 100;

  function serializeCluster(C) {
    const cy = S.cy, off = C.off, data = C.data || {}, p = (id) => localOf(id);
    const pos = {};
    movableOf(C).forEach((n) => { const q = n.position(); pos[p(n.id())] = [r1(q.x - off.x), r1(q.y - off.y)]; });
    const boxes = {};
    nodesOf(C).filter('[kind="theme"],[kind="sub"]').forEach((b) => {
      const d = b.data(), o = {};
      if (b.hasClass('collapsed')) o.collapsed = true;
      if (d.pinnedBox && d.boxPos) { o.pinnedBox = true; o.boxPos = { x: r1(d.boxPos.x), y: r1(d.boxPos.y) }; }
      if (d.laid) o.laid = true;
      if (d.mw != null) { o.mw = d.mw; o.bl = d.bl; o.br = d.br; }   // the list layout's reserved label width
      if (d.renamed) { o.label_ar = d.label_ar; o.label_en = d.label_en || ''; }
      if (Object.keys(o).length) boxes[p(b.id())] = o;
    });
    const pins = {};
    leavesOf(C).forEach((n) => { const x = n.data('pins'); if (x && Object.keys(x).length) pins[p(n.id())] = x; });
    const full = ayahNodesOf(C).filter('[?full]').map((n) => p(n.id()));
    // what expansions pulled in: their themes, ayat and links live beside the server's graph
    const added = { nodes: [], edges: [], themes: [] };
    nodesOf(C).filter('[?added]').forEach((n) => {
      const d = n.data();
      if (d.kind === 'theme') added.themes.push({ id: p(d.id), c: d.c, order: d.order, size: d.size, label_ar: d.label_ar, label_en: d.label_en || '', pulled: true, misc: false, roots: [] });
      else if (d.kind === 'ayah') added.nodes.push({ id: p(d.id), type: 'ayah', label: d.ref, ref: d.ref, role: 'expanded', s: d.s, stype: d.stype, lexical: false, rank: 1, sz: d.sz,
        theme: d.theme ? p(d.theme) : null, parent: d.theme ? p(d.theme) : null });
    });
    cy.edges(`[cid="${C.id}"][?added]`).forEach((e) => { const d = e.data(); added.edges.push({ s: p(d.source), t: p(d.target), type: d.type, w: d.w, cross: d.cross || '' }); });
    return {
      id: C.id, n: C.n, params: C.params, structure: data.graph, query: data.query, total: data.total ?? null, weak: !!data.weak, semantic: data.semantic !== false,
      ids: { seeds: (data.seeds || []).map((r) => r.i), results: (data.results || []).map((r) => r.i), rest: data.rest || [] },
      added, off: { x: r1(off.x), y: r1(off.y) }, userPlaced: !!C.userPlaced, mode: C.mode, frozen: !!C.frozen, folded: !!C.folded, themesOnly: !!C.themesOnly,
      detached: !!C.detached, anchor: C.anchor, title: C.title, pos, radial: C.radial, pins, boxes, full, extraThemes: C.extraThemes, scroll: C.scroll,
    };
  }
  function serializeWorkspace() {
    const cy = S.cy;
    return { v: 1,
      ui: { mode: S.mode, colorBy: S.colorBy, edgeOn: { ...S.edgeOn }, xMode: S.xMode, labelMode: S.labelMode, sortBy: S.sortBy, showShared: !!S.showShared,
        camera: cy ? { zoom: cy.zoom(), pan: { ...cy.pan() }, w: cy.width(), h: cy.height() } : null, active: S.active, mru: S.mru.slice(), lang: L() },
      clusters: cy ? allC().filter((C) => C.kind === 'search' && C.data && frameOf(C).nonempty()).map(serializeCluster) : [] };
  }

  // a saved network as a cluster object plus the graph to mount (the server's structure with what was pulled in)
  function clusterFromJSON(c) {
    const P = cleanParams(c.params || {});
    const C = { id: c.id, n: Math.max(1, +c.n || 1), kind: 'search', params: P, key: paramsKey(P), data: null, resultByI: new Map(), order: [],
      big: false, themesOnly: !!c.themesOnly, detached: false, radial: c.radial && typeof c.radial === 'object' ? c.radial : null, extraThemes: +c.extraThemes || 0,
      expanding: false, off: { x: 0, y: 0 }, userPlaced: !!c.userPlaced, mode: WS_UI.mode.includes(c.mode) ? c.mode : 'organized', frozen: false, folded: false,
      anchor: c.anchor && typeof c.anchor === 'object' && c.anchor.from ? c.anchor : null, title: typeof c.title === 'string' && c.title ? c.title : null,
      scroll: c.scroll && typeof c.scroll === 'object' ? c.scroll : null, autoOpen: null, footLocal: null, created: Date.now(), placed: true };
    const g = c.structure, a = c.added && typeof c.added === 'object' ? c.added : {};
    const list = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
    C.graph = { ...g, nodes: [...list(g.nodes), ...list(a.nodes).map((n) => ({ ...n, added: true }))], edges: [...list(g.edges), ...list(a.edges).map((e) => ({ ...e, added: true }))],
      themes: [...list(g.themes), ...list(a.themes).map((x) => ({ ...x, added: true }))], subthemes: list(g.subthemes), theme_links: list(g.theme_links) };
    const q = c.query && typeof c.query === 'object' ? c.query : {};
    C.data = { query: { kind: 'word', roots: [], lemmas: [], seeds: [], q: P.q || '', ...q }, total: Number.isFinite(c.total) ? c.total : null, weak: !!c.weak,
      semantic: c.semantic !== false, rest: list(c.ids && c.ids.rest ? c.ids.rest.map((i) => ({ i })) : []).map((x) => x.i).filter(Number.isInteger),
      seeds: [], results: [], graph: g, _mode: P.mode || 'auto', _pending: true };
    const ids = (k) => (c.ids && Array.isArray(c.ids[k]) ? c.ids[k].filter(Number.isInteger) : []);
    C.order = [...ids('seeds'), ...ids('results')].map((i) => ayahId(C.id, i)).concat(list(a.nodes).map((n) => mk(C.id, n.id)));
    return C;
  }
  // the toolbar / legend controls show the restored settings
  function syncUiControls() {
    $$('#colorBy button').forEach((b) => { const on = b.dataset.c === S.colorBy; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $$('#edgeToggles input[data-edge]').forEach((c) => { c.checked = S.edgeOn[c.dataset.edge] !== false; });
    $('#xMode').value = S.xMode;
    $('#sharedToggle').checked = !!S.showShared;
    renderColorKey();
    syncModeButtons();
  }
  const validCluster = (c) => c && typeof c === 'object' && /^c\d+$/.test(String(c.id)) && c.structure && typeof c.structure === 'object' && Array.isArray(c.structure.nodes) && c.params && typeof c.params.q === 'string';

  async function restoreWorkspace(ws, { progress = null } = {}) {
    S.hydrating++;
    try {
      clearWorkspace();
      const ui = ws && ws.ui && typeof ws.ui === 'object' ? ws.ui : {};
      const seen = new Set();
      const list = (ws && Array.isArray(ws.clusters) ? ws.clusters : []).filter((c) => validCluster(c) && !seen.has(c.id) && seen.add(c.id));
      Object.entries(WS_UI).forEach(([k, vals]) => { if (vals.includes(ui[k])) S[k] = ui[k]; });
      if (ui.edgeOn && typeof ui.edgeOn === 'object') Object.keys(S.edgeOn).forEach((k) => { if (typeof ui.edgeOn[k] === 'boolean') S.edgeOn[k] = ui.edgeOn[k]; });
      S.showShared = !!ui.showShared;
      syncUiControls();
      applyLabels();
      if (!list.length) { emptyPanel(); return; }
      const cy = ensureCy();
      $('#welcome').hidden = true;
      showChrome(true);
      let k = 0;
      for (const c of list) {
        if (progress) progress({ step: ++k, of: list.length });
        S.cseq = Math.max(S.cseq, +String(c.id).slice(1) || 0);
        const C = clusterFromJSON(c);
        await mountCluster(C, C.graph, { layout: false, restoring: true });
        if (S.cy !== cy || !S.clusters.has(C.id)) return;
        const off = { x: +(c.off && c.off.x) || 0, y: +(c.off && c.off.y) || 0 };
        cy.batch(() => {
          movableOf(C).forEach((n) => { const p = c.pos && c.pos[localOf(n.id())]; if (Array.isArray(p)) n.position({ x: (+p[0] || 0) + off.x, y: (+p[1] || 0) + off.y }); });
          Object.entries(c.pins && typeof c.pins === 'object' ? c.pins : {}).forEach(([l, p]) => { const n = cy.$id(mk(C.id, l)); if (n.nonempty() && p && typeof p === 'object') n.data('pins', p); });
          Object.entries(c.boxes && typeof c.boxes === 'object' ? c.boxes : {}).forEach(([l, b]) => {
            const box = cy.$id(mk(C.id, l));
            if (box.empty() || !b || typeof b !== 'object') return;
            if (typeof b.label_ar === 'string' && b.label_ar) {
              box.data({ label_ar: b.label_ar, label_en: typeof b.label_en === 'string' ? b.label_en : '', renamed: true });
              box.data('label', box.data('kind') === 'sub' ? subLabel(box.data()) : themeLabel(box.data()));
            }
            if (b.pinnedBox && b.boxPos && typeof b.boxPos === 'object') { box.data({ pinnedBox: true, boxPos: { x: +b.boxPos.x || 0, y: +b.boxPos.y || 0 } }); box.addClass('pinned-box'); }
            if (b.laid) box.data('laid', true);
            if (Number.isFinite(+b.mw) && +b.mw > 0) box.data({ mw: +b.mw, bl: +b.bl || 0, br: +b.br || 0 });
          });
          (Array.isArray(c.full) ? c.full : []).forEach((l) => { const n = cy.$id(mk(C.id, l)); if (n.nonempty()) n.data('full', true); });
          // a theme's count includes what expansions pulled in
          themesOf(C).forEach((th) => { const n = cy.nodes(`[kind="ayah"][theme="${th.id()}"]`).length; if (n !== th.data('size')) { th.data('size', n); th.data('label', themeLabel(th.data())); } });
        });
        C.off = off;
        Object.entries(c.boxes && typeof c.boxes === 'object' ? c.boxes : {}).forEach(([l, b]) => {
          const box = cy.$id(mk(C.id, l));
          if (b && b.collapsed && box.nonempty() && box.data('kind') === 'theme') setCollapsed(box, true, { shared: false });
        });
        syncCollapsedShared(C);
        if (C.mode !== 'organized') nodesOf(C).filter('[kind="theme"],[kind="sub"]').addClass('ghost');
        if (c.detached) detachFromThemes(C);
        syncPinClasses(C);
        applyLabels(C);
        if (c.frozen) setFrozen(C, true, { quiet: true });
        if (c.folded) toggleFold(C, true, { quiet: true });
        frameOf(C).data('label', clusterTitle(C));
      }
      syncSolo(); syncBig(); syncCrossEdges(); updateBundles(); applyEdgeVisibility();
      // the camera where it was: the same part of the network in view whatever this canvas's size (a project
      // saved on a computer, or on the 980px page of Chrome's "Desktop site", opens on a phone), so the zoom
      // scales with the canvas. Nothing of it in view (an odd saved camera): the whole workspace instead
      const cam = ui.camera;
      if (cam && typeof cam === 'object' && +cam.zoom > 0 && cam.pan && typeof cam.pan === 'object') {
        const w0 = +cam.w || cy.width(), h0 = +cam.h || cy.height(), z0 = +cam.zoom;
        const mx = (w0 / 2 - (+cam.pan.x || 0)) / z0, my = (h0 / 2 - (+cam.pan.y || 0)) / z0;
        const z = clamp(z0 * Math.min(cy.width() / w0, cy.height() / h0), cy.minZoom(), cy.maxZoom());
        cy.viewport({ zoom: z, pan: { x: cy.width() / 2 - mx * z, y: cy.height() / 2 - my * z } });
        const ext = cy.extent();
        const seen = cy.nodes('[kind="ayah"],[kind="query"],[kind="theme"]').some((n) => {
          const q = n.position();
          return n.visible() && q.x > ext.x1 && q.x < ext.x2 && q.y > ext.y1 && q.y < ext.y2;
        });
        if (seen) sizeLabels(true); else fit(false, { all: true });
      } else fit(false, { all: true });
      S.mru = (Array.isArray(ui.mru) ? ui.mru : []).filter((id) => S.clusters.has(id));
      const last = allC()[allC().length - 1];
      activate(S.clusters.has(ui.active) ? ui.active : S.mru[0] || last.id, { force: true });
      S.layer && S.layer.update();
      relabel();
      // the cards come back from the corpus; labels and lists fill in as they land (the graph is already usable)
      await Promise.all(list.map((c) => (S.clusters.has(c.id) ? hydrateCluster(S.clusters.get(c.id), c).catch((err) => console.error(err)) : null)));
    } finally { S.hydrating--; }
  }
  async function hydrateCluster(C, c) {
    const data = C.data, idsOf = (k) => (c.ids && Array.isArray(c.ids[k]) ? c.ids[k].filter(Number.isInteger) : []);
    const pulled = (c.added && Array.isArray(c.added.nodes) ? c.added.nodes : []).map((n) => n && ayahIdx(n.id)).filter((i) => i != null);
    const ids = [...new Set([...idsOf('seeds'), ...idsOf('results'), ...pulled])].filter((i) => i >= 0);
    const got = new Map();
    for (let k = 0; k < ids.length; k += 200) {
      const res = await api('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(k, k + 200), q: C.params.q || '', mode: data._mode || 'auto', ...precisionArgs(C) }) });
      if (!S.clusters.has(C.id) || C.data !== data) return;
      res.results.forEach((r) => got.set(r.i, r));
    }
    data.seeds = idsOf('seeds').map((i) => got.get(i)).filter(Boolean);
    data.results = idsOf('results').map((i) => got.get(i)).filter(Boolean);
    got.forEach((r, i) => C.resultByI.set(i, r));
    data._pending = false;
    invalidateLabels(C);
    if (C === act()) { renderResults(data); if (S.selRoot) renderNodeTab({ keep: true }); }
    updateSwitcher();
  }
  function thumbnail() {
    const cy = S.cy;
    if (!cy || !cy.nodes().length) return null;
    try { return cy.png({ full: true, maxWidth: 240, maxHeight: 150, bg: G.bg, output: 'base64uri' }); } catch (_) { return null; }
  }
  function summary() {
    const N = window.QR && window.QR.notes;
    return { clusters: allC().filter((C) => C.kind === 'search').length, notes: N && N.count ? N.count() : 0, title: act() ? queryOf(act()) : '' };
  }
  // the contract the projects module (static/projects.js, loaded after this file) builds on
  const QR = (window.QR = window.QR || {});
  QR.on = on; QR.emit = emit;
  QR.ws = { serialize: serializeWorkspace, restore: restoreWorkspace, clear: clearWorkspace, thumbnail, summary,
    activate: (cid) => activate(cid, { camera: true }), remove: (cid) => { const C = S.clusters.get(cid); if (C) removeCluster(C); } };

  const kindLabel = (k) => (['ayah', 'root', 'word', 'topic'].includes(k) ? t(`kind.${k}`) : esc(k));

  function themeOfAyah(i) {
    const C = act(), n = C && S.cy ? S.cy.$id(ayahId(C.id, i)) : null;
    return n && n.nonempty() ? n.data('theme') : null;
  }

  // the header of a network's results: what was matched, at which level, the forms found, the other words of the
  // root (each a search of its own ↗), the refiners that search this network again, and what else to try
  function resultsHeader(C, data) {
    const q = data.query, P = C.params || {}, fr = C.frozen;
    const rows = [];
    const sel = (name, opts, cur) => `<select class="refine" data-ref="${name}" aria-label="${t(`ref.${name}`)}"${fr ? ' disabled' : ''}>${opts.map(([v, lab]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${lab}</option>`).join('')}</select>`;
    // the ladder: the same text at each level of exactness (only what the engine counted)
    if (q.levels && (q.kind === 'word' || q.kind === 'phrase' || q.kind === 'root')) {
      const cur = q.kind === 'root' ? 'root' : (q.precision === 'form' ? 'form' : 'lemma');
      const lv = [['form', 'lad.form'], ['lemma', 'lad.lemma'], ['root', 'lad.root']].filter(([k]) => q.levels[k] != null);
      rows.push(`<div class="hrow lad" role="radiogroup" aria-label="${t('lad.title')}"><span class="hlab">${t('lad.title')}</span>${lv.map(([k, key]) =>
        `<button type="button" class="lad-btn${k === cur ? ' on' : ''}" role="radio" aria-checked="${k === cur}" data-level="${k}"${fr && k !== cur ? ` disabled title="${t('ws.frozenT')}"` : ''}>${t(key)} <b>${q.levels[k]}</b></button>`).join('')}</div>`);
    }
    // the forms (spellings) the matches came in: a filter that lights those ayat
    if (q.forms && q.forms.length) {
      rows.push(`<div class="hrow"><span class="hlab">${t('hdr.forms')}</span>${q.forms.map((f) => `<button type="button" class="chip sm form${f.sel ? ' typed' : ''}" data-form-ids="${esc((f.ids || []).join(','))}" title="${t('hdr.formT')}">${bdiAr(f.t)} <small>${f.na != null ? f.na : f.n}</small></button>`).join('')}${q.forms_more ? `<small class="hmore">+${q.forms_more}</small>` : ''}</div>`);
    }
    // the other words of the root: each opens as a linked network (Shift-click replaces this one)
    if (q.siblings && q.siblings.length) {
      rows.push(`<div class="hrow"><span class="hlab">${t('hdr.siblings')}</span>${q.siblings.map((l) => `<button type="button" class="chip sm sib" data-q="${esc(l.l)}" title="${t('chip.branchT')}">${bdiAr(l.t)} <small ${enAttr}>${esc(l.g || '')}${l.g ? ' · ' : ''}${l.na}</small> ↗</button>`).join('')}</div>`);
    }
    // what to try when the text matched nothing (never a silent fall-back to meaning)
    if (q.suggest && q.suggest.length) {
      rows.push(`<div class="hrow"><span class="hlab">${t('hdr.suggest')}</span>${q.suggest.map((s) => `<button type="button" class="chip sm sug" data-sug="${esc(s.value)}">${bdiAuto(s.label)}${s.n ? ` <small>${s.n}</small>` : ''}</button>`).join('')}</div>`);
    }
    // shared ayat with the other networks
    const shared = allC().filter((X) => X !== C && X.kind === 'search').map((X) => {
      const mine = new Set(ayahNodesOf(C).map((n) => ayahIdx(n.id())));
      const both = ayahNodesOf(X).map((n) => ayahIdx(n.id())).filter((i) => mine.has(i));
      return both.length ? { X, both } : null;
    }).filter(Boolean);
    if (shared.length) {
      rows.push(`<div class="hrow"><span class="hlab">${t('ws.sharedLab')}</span>${shared.map(({ X, both }) => `<button type="button" class="chip sm shared" data-shared="${X.id}" data-ids="${both.join(',')}" title="${t('ws.sharedT')}">${circled(X.n)} ${bdiAuto(shortQ(X))} <small>${both.length}</small></button>`).join('')}</div>`);
    }
    // the refiners: scope, graph size, grouping (this network searched again, undoable; frozen: a linked network)
    if (C.kind === 'search') {
      const nOpts = [['auto', t('n.auto')], ['40', t('n.opt', { n: 40 })], ['60', t('n.opt', { n: 60 })], ['100', t('n.opt', { n: 100 })], ['150', t('n.opt', { n: 150 })], ['300', t('n.opt', { n: 300 })], ['all', t('n.all')]];
      const lexical = q.kind === 'word' || q.kind === 'root' || q.kind === 'phrase';
      rows.push(`<div class="hrow refiners">${sel('scope', [['all', t('scope.all')], ['meccan', t('scope.meccan')], ['medinan', t('scope.medinan')]], P.scope || 'all')}${sel('n', nOpts, P.n || '60')}${lexical && (q.group || q.levels) ? sel('group', [['auto', t('grp.auto')], ['form', t('grp.form')], ['theme', t('grp.theme')]], P.group || 'auto') : ''}${lexical ? `<button type="button" class="chip sm meaning" data-meaning="1" title="${t('chip.branchT')}">${t('hdr.meaning')} ↗</button>` : ''}</div>`);
    }
    return rows.join('');
  }

  function renderResults(data) {
    const C = act();
    if (!C || C.data !== data || C.kind !== 'search') return;   // (a stale render, or not a search)
    const q = data.query;
    const lex = data.results.filter((r) => r.lexical).length;
    const relN = data.results.filter((r) => !r.lexical && r.rel && r.rel.length).length;
    const meaningOnly = data.results.length - lex - relN;
    const scopeTxt = { meccan: t('scope.inMeccan'), medinan: t('scope.inMedinan') }[C.params.scope] || '';
    const restN = restIds(data).length;
    // chip text is data (Arabic words, refs); the counts and the English glosses keep their own language
    const chips = [
      ...q.roots.map((r) => `<button class="chip root sm" data-root="${esc(r.r)}">${bdiAr(r.sp)} <small>${t('chip.root', { c: times(r.n), ayat: t('cnt.ayat', { n: r.na }) })}</small></button>`),
      ...q.lemmas.map((l) => `<button class="chip sm" data-q="${esc(l.l)}" data-via="word">${bdiAr(l.t || l.l)} <small ${enAttr}>${esc(l.g)}</small></button>`),
      ...q.seeds.map((s) => `<button class="chip sm" data-ref="${esc(s)}">${esc(s)}</button>`),
      ...(q.also || []).map((l) => `<button class="chip sm" data-or="${esc(l.l)}" title="${t('chip.orT')}">${t('chip.or')} ${bdiAr(l.t)} <small ${enAttr}>${esc(l.g)}${l.n ? ` · ${l.n}` : ''}</small></button>`),
    ].join('');
    let counts = '';
    if (data.total != null) {
      // the list holds every match: the graph's ayat first, then the rest (graph size caps the network only)
      // a topic of several words counts the ayat with any of them (the same words the cards mark)
      const terms = q.lemmas.length + q.roots.filter((r) => !q.lemmas.some((l) => l.r === r.r)).length;
      const what = q.kind === 'root' ? 'what.root' : q.kind === 'phrase' ? 'what.phrase' : q.kind === 'topic' && terms > 1 ? 'what.words' : 'what.word';
      counts = [t('counts.total', { n: data.total, what: t(what), scope: scopeTxt }),
        t('counts.drawn', { n: lex }), restN ? t('counts.after', { n: restN }) : '',
        relN ? t('counts.rel', { n: relN }) : '', meaningOnly ? t('counts.meaning', { n: meaningOnly }) : ''].filter(Boolean).join(' · ');
    } else {
      counts = t('counts.simple', { n: data.results.length }) + (lex ? ` · ${t('counts.withWords', { n: lex })}` : '') + scopeTxt;
    }
    const nThemes = S.cy ? themesOf(C).length : 0;
    const prov = provenance(C);
    let html = `<div class="rlist"><div class="qinfo"><span class="kind">${kindLabel(q.kind)}</span>${t('cnt.themes', { n: nThemes })}${C.frozen ? ` · <span class="frozen-tag">🔒 ${t('ws.frozen')}</span>` : ''}${data.semantic ? '' : ` · <i>${t('res.semOff')}</i>`}
      ${prov ? `<div class="prov">${prov}</div>` : ''}
      <div class="counts">${counts}</div>${chips ? `<div class="chips">${chips}</div>` : ''}${resultsHeader(C, data)}</div>`;
    if (data._pending) html += `<div class="banner info">${t('ws.hydrating')}</div>`;
    if (data.weak) html += `<div class="banner warn">${t('banner.weak')}</div>`;
    if (q.note) html += `<div class="banner info">ⓘ ${esc(I18N.note(q.note))}</div>`;
    if (restN) {
      html += `<div class="banner info">${t('banner.rest', { lex, total: data.total,
        jump: `<button class="linkbtn" data-jump="rest">${t('banner.jump', { n: restN })}</button>` })}</div>`;
    }
    html += `<div class="sortbar" role="radiogroup" aria-label="${t('sort.aria')}">${t('sort.label')}
      <button data-sort="theme" class="${S.sortBy === 'theme' ? 'on' : ''}" role="radio" aria-checked="${S.sortBy === 'theme'}">${t('sort.theme')}</button>
      <button data-sort="rank" class="${S.sortBy === 'rank' ? 'on' : ''}" role="radio" aria-checked="${S.sortBy === 'rank'}">${t('sort.rank')}</button></div>`;
    html += data.seeds.map((r) => resultCard(r, true)).join('');
    const rows = [...data.results];
    C.order.forEach((id) => { const i = ayahIdx(id); if (!rows.some((r) => r.i === i) && !data.seeds.some((r) => r.i === i) && C.resultByI.has(i)) rows.push({ ...C.resultByI.get(i), expanded: true }); });
    if (S.sortBy === 'theme' && S.cy) {
      themesSortedOf(C).forEach((th) => {
        const mine = rows.filter((r) => themeOfAyah(r.i) === th.id());
        if (!mine.length) return;
        html += `<div class="tgroup" data-t="${esc(th.id())}"><button class="thead" data-t="${esc(th.id())}"><i class="cdot" style="background:${th.data('col')}"></i>
          <span>${nameHtml({ ...th.data(), related: false })}</span><span class="t-n">${mine.length}</span></button>
          ${mine.map((r) => resultCard(r)).join('')}</div>`;
      });
    } else html += rows.map((r) => resultCard(r)).join('');
    if (restN) {
      const R = restOf(data);
      html += `<section class="rest-group" id="restGroup" aria-label="${t('rest.aria')}">
        <div class="rest-head"><span class="t-ar">${t('rest.title')}</span> <span class="t-en">${t('rest.sub')}</span><span class="t-n">${restN}</span></div>
        <div class="rest-list">${R.cards.filter((r) => !inGraph(r.i)).map((r) => resultCard(r)).join('')}</div>
        <button class="rest-more" type="button"></button><div class="rest-end" hidden>${t('rest.end')}</div></section>`;
    }
    html += '</div>';
    const el = $('#tab-results');
    el.innerHTML = html;
    bindChips(el);
    bindHeader(el, C);
    $$('.sortbar button', el).forEach((b) => b.addEventListener('click', () => { S.sortBy = b.dataset.sort; renderResults(S.data); emit('change'); }));
    $$('.thead', el).forEach((b) => b.addEventListener('click', () => focusTheme(b.dataset.t, { center: true })));
    const jump = $('[data-jump]', el);
    if (jump) {
      jump.addEventListener('click', async () => {
        // an empty group can't scroll to the top of the panel: load its first page first
        if (!$('#restGroup .rest-list .res')) await loadRestPage();
        const g = $('#restGroup');
        if (!g) return;
        g.scrollIntoView({ block: 'start', behavior: 'smooth' });
        const head = $('.rest-head', g);
        head.tabIndex = -1;
        head.focus({ preventScroll: true });   // Tab goes on into the group's cards
      });
    }
    bindCards(el);
    const more = $('.rest-more', el);
    if (more) more.addEventListener('click', () => loadRestPage());
    observeRest();
    markSelectedCard();
    updateDetailBar();
  }

  /* ------------------------------------------------------------ the full list: graph ayat, then every other match */
  const REST_PAGE = 50;
  const restOf = (data) => data._rest || (data._rest = { cards: [], busy: null, failed: false });
  const inGraphOf = (C, i) => !!(C && S.cy && S.cy.$id(ayahId(C.id, i)).nonempty());
  const inGraph = (i) => inGraphOf(act(), i);
  // an ayah pulled into the graph by expansion is listed with the graph's ayat, not twice
  const restIds = (data) => (data.rest || []).filter((i) => !inGraph(i));

  // the header's controls: the ladder and the refiners search this network again; the form chips light ayat;
  // the sibling / meaning chips open linked networks; the «or» chips correct the reading in place
  function bindHeader(el, C) {
    $$('.lad-btn', el).forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.level, q = C.data.query;
      if (b.classList.contains('on')) return;
      if (k === 'root') { const r = q.root ? q.root.r : (q.roots[0] && q.roots[0].r); if (r) refineCluster(C, { q: `جذر:${r}`, mode: 'root', precision: '' }); }
      else refineCluster(C, { q: q.q, mode: 'word', precision: k });
    }));
    $$('.chip.form', el).forEach((b) => b.addEventListener('click', () => {
      const ids = b.dataset.formIds ? b.dataset.formIds.split(',').filter(Boolean).map((x) => ayahId(C.id, +x)) : [];
      const on = b.classList.contains('on');
      $$('.chip.form.on', el).forEach((x) => x.classList.remove('on'));
      if (on || !ids.length) { S.find = { matches: [], i: -1 }; refreshEmphasis(); return; }
      b.classList.add('on');
      if (S.cy) { S.cy.$(':selected').unselect(); S.selected = null; }
      S.find = { matches: ids.filter((id) => S.cy && S.cy.$id(id).nonempty()), i: -1 };
      refreshEmphasis();
    }));
    $$('.chip.sib', el).forEach((b) => b.addEventListener('click', (e) => branchFromChip({ q: b.dataset.q, mode: 'word' }, { via: 'word', replace: e.shiftKey })));
    $$('.chip.meaning', el).forEach((b) => b.addEventListener('click', (e) => branchFromChip({ q: C.params.q, mode: 'topic' }, { via: 'topic', replace: e.shiftKey })));
    $$('.chip.sug', el).forEach((b) => b.addEventListener('click', () => addCluster(cleanParams({ ...C.params, q: b.dataset.sug, mode: 'auto', precision: '' }), { refine: C })));
    $$('.chip[data-or]', el).forEach((b) => b.addEventListener('click', () => refineCluster(C, { q: b.dataset.or, mode: 'word' })));
    $$('.chip.shared', el).forEach((b) => b.addEventListener('click', () => {
      const X = S.clusters.get(b.dataset.shared), ids = b.dataset.ids.split(',').filter(Boolean).map(Number);
      if (!X) return;
      S.find = { matches: ids.flatMap((i) => [ayahId(C.id, i), ayahId(X.id, i)]).filter((id) => S.cy.$id(id).nonempty()), i: -1 };
      if (S.cy) { S.cy.$(':selected').unselect(); S.selected = null; }
      refreshEmphasis();
      fitClusters([C, X]);
    }));
    $$('select.refine', el).forEach((s) => s.addEventListener('change', () => refineCluster(C, { [s.dataset.ref]: s.value === 'auto' && s.dataset.ref !== 'n' ? '' : s.value })));
  }

  // fetch the next page of not-in-graph matches as full cards (same highlighting as search); resolves true if it added any
  function loadRestPage() {
    const data = S.data;
    if (!data || !data.rest || S.view !== 'search') return Promise.resolve(false);
    const R = restOf(data);
    if (R.busy) return R.busy;
    const ids = data.rest.slice(R.cards.length, R.cards.length + REST_PAGE);
    if (!ids.length) return Promise.resolve(false);
    R.failed = false;
    R.busy = api('/api/cards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, q: data.query.q, mode: data._mode || 'auto' }),
    }).then((res) => {
      R.busy = null;   // on every path: a page that stayed busy would block the list for good
      if (S.data !== data) return false;   // a newer search replaced this list
      res.results.forEach((r) => { R.cards.push(r); if (!S.resultByI.has(r.i)) S.resultByI.set(r.i, r); });
      appendRestCards(res.results);   // no-op while the list isn't mounted; renderResults shows R.cards later
      return true;
    }).catch((err) => {
      R.failed = true; R.busy = null;
      if (S.data === data) { toast(t('toast.restFail', { e: err.message }), true); updateRestMore(); }
      return false;
    });
    updateRestMore();
    return R.busy;
  }

  // the side panel scrolls on wide screens, the page itself on narrow ones: the observer's root follows
  // the layout (a stale root that no longer clips would see the sentinel always on screen and load everything)
  const restRoot = () => { const sb = $('.side-body'); return getComputedStyle(sb).overflowY === 'auto' ? sb : null; };
  function observeRest() {
    if (S.restIO) { S.restIO.disconnect(); S.restIO = null; }
    if (!$('#tab-results .rest-more')) return;
    S.restIO = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) loadRestPage(); },
      { root: restRoot(), rootMargin: '700px 0px' });
    updateRestMore();
  }

  function appendRestCards(cards) {
    const box = $('#tab-results .rest-list');
    if (!box) return;
    box.insertAdjacentHTML('beforeend', cards.filter((r) => !inGraph(r.i)).map((r) => resultCard(r)).join(''));
    bindCards(box);
    markSelectedCard();
    updateRestMore();
  }

  function updateRestMore() {
    const more = $('#tab-results .rest-more');
    if (!more || !S.data) return;
    const R = restOf(S.data), left = S.data.rest.length - R.cards.length;
    more.hidden = left <= 0;
    $('#tab-results .rest-end').hidden = left > 0;
    more.disabled = !!R.busy;
    more.textContent = R.busy ? t('rest.loading') : R.failed ? t('rest.retry') : t('rest.more', { n: left });
    // re-observing reports the current state at once, so a sentinel still on screen keeps the pages coming
    if (S.restIO) { S.restIO.unobserve(more); if (left > 0 && !R.busy && !R.failed) S.restIO.observe(more); }
  }

  /* ------------------------------------------------------------ selected root: only its ayat */
  // choosing a root (its graph node, a root chip in the results header / word table / root details, or find)
  // lists only the ayat that contain it in its own tab, root words underlined: first the graph's, then the
  // search's other matches with it. The graph lights that root, its ayat and their boxes, opens the closed
  // boxes they sit in (a few at most on a large graph) and moves the camera to them. In the roots network a
  // root lists all its ayat in the Quran. Releasing it (a click on empty space or on the root again, ✕, Esc,
  // a theme focus, a new search) closes what it opened, puts the camera back and shows the full results
  const rootAyat = (n) => n.connectedEdges('[type="root"]').connectedNodes('[kind="ayah"]')
    .map((a) => +a.id().slice(2)).sort((a, b) => a - b);
  // the graph ayat that contain the selected root: its edges when it is a node, else what /api/rootmarks found
  const rootGraphIds = (sr) => {
    if (!sr || sr.view !== 'search' || !S.cy) return [];
    const C = S.clusters.get(sr.cid);
    const n = sr.id ? S.cy.$id(sr.id) : null;
    if (!n || n.empty()) return sr.gids || [];
    // its edges, plus graph ayat pulled in since (by expanding another node) that contain it too
    const ids = new Set(rootAyat(n));
    sr.marks.forEach((js, i) => { if (js.size && !ids.has(i) && inGraphOf(C, i)) ids.add(i); });
    return [...ids].sort((a, b) => a - b);
  };
  const rootOutIds = (sr) => (sr && sr.out ? sr.out.filter((i) => !inGraphOf(S.clusters.get(sr.cid), i)) : []);
  // the ayah open in Details came from the selected root's list (↑/↓ and ← step through that list)
  const fromNode = () => S.listSrc === 'node' && !!S.selRoot && !!$('#tab-node .rlist');
  const ROOT_OPEN_MAX = 3, ROOT_OPEN_AYAT = 150;   // a large graph opens at most this many boxes / hidden ayat

  // a root chosen anywhere: its graph node when it has one
  function selectRoot(r) {
    const cy = S.cy, C = act();
    if (!cy || !r || !C) { showRoot(r); return; }
    const n = cy.$id(rootId(C.id, r));
    if (n.nonempty()) {
      cy.$(':selected').unselect();
      n.select();
      S.selected = n.id();
      pickRoot(n);
    } else if (C.kind === 'search') pickRoot(null, r);
    else { showRoot(r); return; }
    refreshEmphasis();
  }

  function pickRoot(n, r = n && n.data('root')) {
    const cy = S.cy;
    if (!cy || !r) return;
    const C = (n && clOf(n)) || act();
    if (!C) return;
    if (C.id !== S.active) activate(C.id);
    const prev = S.selRoot, same = prev && prev.root === r && prev.cid === C.id;
    if (prev && !same) closeRootBoxes(prev);
    $('#tooltip').hidden = true; S.tip = null;
    if (same) prev.id = n ? n.id() : null;
    else {
      S.selRoot = { root: r, cid: C.id, id: n ? n.id() : null, view: C.kind === 'roots' ? 'roots' : 'search', marks: new Map(),
        gids: null, out: null, cards: [], busy: null, failed: false, all: null, opened: [], closedLeft: [],
        vp: prev ? prev.vp : { zoom: cy.zoom(), pan: { ...cy.pan() } }, vpAfter: null };
      S.tabScroll.node = 0;
    }
    const sr = S.selRoot;
    $('#tabbtn-node').hidden = false;
    renderNodeTab({ keep: same });
    showTab('node');
    updateRootPill();
    if (sr.view === 'roots') { loadRootAll(sr); if (!same) revealRoot(sr); return; }
    // a node knows its graph ayat at once; a root without one waits for /api/rootmarks
    loadRootMarks().then(() => { if (!same && S.selRoot === sr) revealRoot(sr); });
  }

  function releaseRoot({ graph = true } = {}) {
    const sr = S.selRoot;
    if (!sr) return;
    S.selRoot = null;
    if (S.listSrc === 'node') S.listSrc = 'results';
    if (S.rootIO) { S.rootIO.disconnect(); S.rootIO = null; }
    const cy = S.cy;
    if (cy && sr.id && S.selected === sr.id) { cy.$id(sr.id).unselect(); S.selected = null; }
    if (graph && cy) {
      closeRootBoxes(sr);
      // the camera goes back to where it was, unless the user moved it since
      const a = sr.vpAfter, now = cy.pan();
      if (a && sr.vp && Math.abs(cy.zoom() - a.zoom) < 1e-3 && Math.abs(now.x - a.pan.x) < 1 && Math.abs(now.y - a.pan.y) < 1)
        cy.animate({ zoom: sr.vp.zoom, pan: sr.vp.pan }, { duration: 400, complete: onZoom });
    }
    const on = $('#tab-node').classList.contains('on');
    $('#tabbtn-node').hidden = true;
    $('#tab-node').innerHTML = '';
    S.tabScroll.node = 0;
    updateRootPill();
    if (on) showTab('results');
    const bar = $('#tab-detail .d-bar');
    if (bar) {   // an ayah opened from the root's list now steps through the full results
      const b = $('.d-back', bar);
      b.textContent = t('bar.back'); b.title = t('bar.backT');
      updateDetailBar();
    }
  }

  // the boxes a root selection opened and the user left alone close again
  function closeRootBoxes(sr) {
    const cy = S.cy, C = S.clusters.get(sr.cid);
    const ids = sr.opened.filter((tid) => cy && cy.$id(tid).nonempty() && !cy.$id(tid).hasClass('collapsed'));
    sr.opened = [];
    if (!ids.length || !C || C.mode !== 'organized') return;
    S.boxChain = S.boxChain.then(async () => {
      if (S.cy !== cy || C.mode !== 'organized' || !S.clusters.has(C.id)) return;
      ids.forEach((tid) => setCollapsed(cy.$id(tid), true, { shared: false }));
      syncCollapsedShared(C);
      updateThemeListState();
      refreshEmphasis();
      await respace(C);
    }).catch((err) => console.error(err));
  }

  // open the closed boxes holding the root's ayat, then bring the root and its ayat into view
  async function revealRoot(sr, { all = false } = {}) {
    const cy = S.cy, C = S.clusters.get(sr.cid);
    if (!cy || !C || S.selRoot !== sr) return;
    const node = sr.id ? cy.$id(sr.id) : cy.collection();
    if (sr.view === 'search' && C.mode === 'organized') {
      const per = new Map();
      rootGraphIds(sr).forEach((i) => {
        const b = closedBoxOf(cy.$id(ayahId(C.id, i)));
        if (b) per.set(b.id(), (per.get(b.id()) || 0) + 1);
      });
      let open = [...per.keys()];
      const hidden = open.reduce((s, tid) => s + cy.nodes(`[kind="ayah"][theme="${tid}"]`).length, 0);
      if (C.big && !all && (open.length > ROOT_OPEN_MAX || hidden > ROOT_OPEN_AYAT)) {
        // too many to draw at once: they stay closed (lit, and counted in the list header), except the box
        // with most of its ayat when the root itself is hidden (a bridge root whose boxes are all closed)
        open = node.nonempty() && node.hasClass('hidden') ? [[...per].sort((a, b) => b[1] - a[1])[0][0]] : [];
      }
      sr.closedLeft = [...per.keys()].filter((tid) => !open.includes(tid));
      if (open.length) {
        await (S.boxChain = S.boxChain.then(async () => {
          if (S.cy !== cy || S.selRoot !== sr || C.mode !== 'organized') return;
          open.forEach((tid) => { if (C.autoOpen === tid) C.autoOpen = null; setCollapsed(cy.$id(tid), false, { shared: false }); });
          syncCollapsedShared(C);
          sr.opened.push(...open);
          updateThemeListState();
          refreshEmphasis();
          await respace(C);
        }).catch((err) => console.error(err)));
      }
      if (S.selRoot === sr) renderNodeTab({ keep: true });
    }
    if (S.cy !== cy || S.selRoot !== sr) return;
    refreshEmphasis();
    let eles = sr.view === 'roots' ? node.closedNeighborhood('node')
      : coll(rootGraphIds(sr).map((i) => ayahId(C.id, i))).union(node);
    eles = eles.filter(':visible');
    if (eles.empty()) return;
    let v = viewFor(eles.boundingBox({ includeLabels: false }), cy, C);
    if (C.big && v.zoom < 0.5 && sr.view === 'search' && node.nonempty()) {
      // spread over the whole map: show the box holding most of its ayat (with the root) instead
      const by = new Map();
      eles.forEach((e) => { const tid = e.data('theme'); if (tid && e.data('kind') === 'ayah') by.set(tid, (by.get(tid) || 0) + 1); });
      const best = [...by].sort((a, b) => b[1] - a[1])[0];
      if (best) v = viewFor(eles.filter((e) => e.data('theme') === best[0]).union(node.filter(':visible')).boundingBox({ includeLabels: false }), cy, C);
    }
    cy.stop();
    cy.animate(v, { duration: 450, easing: 'ease-in-out-cubic', complete: () => {
      if (S.selRoot === sr && S.cy === cy) sr.vpAfter = { zoom: cy.zoom(), pan: { ...cy.pan() } };
      onZoom();
    } });
  }

  // which ayat contain the root, and where its words are: the graph's (fetched once per ayah; an expansion
  // adds more) and, the first time, the search's matches outside the graph
  async function loadRootMarks() {
    const sr = S.selRoot, cy = S.cy, C = sr && S.clusters.get(sr.cid), data = C && C.data;
    if (!sr || !cy || !C || !data || sr.view !== 'search') return;
    const n = sr.id ? cy.$id(sr.id) : null;
    const graph = ayahNodesOf(C).map((a) => ayahIdx(a.id()));
    const ids = graph.filter((i) => !sr.marks.has(i));
    const rest = sr.out ? [] : (data.rest || []).filter((i) => !inGraphOf(C, i));
    ids.push(...rest);
    if (!ids.length) return;
    try {
      for (let k = 0; k < ids.length; k += 3000) {
        const res = await api('/api/rootmarks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: sr.root, ids: ids.slice(k, k + 3000) }),
        });
        Object.entries(res.marks).forEach(([i, js]) => sr.marks.set(+i, new Set(js)));
      }
    } catch (_) { /* the list stays without underlines */ }
    if (S.selRoot !== sr || S.cy !== cy) return;
    const has = (i) => sr.marks.has(i) && sr.marks.get(i).size > 0;
    if (!n || n.empty()) sr.gids = graph.filter(has).sort((a, b) => a - b);
    if (!sr.out) sr.out = rest.filter(has);
    renderNodeTab({ keep: true });
    refreshEmphasis();
    if (rootOutIds(sr).length && !sr.cards.length) loadRootPage();
  }

  // roots network: every ayah of the root in the Quran
  async function loadRootAll(sr) {
    if (sr.all) return;
    try {
      if (!S.rootCache.has(sr.root)) S.rootCache.set(sr.root, await api(`/api/root/${encodeURIComponent(sr.root)}`));
    } catch (err) { toast(t('toast.rootFail', { e: err.message }), true); return; }
    if (S.selRoot !== sr) return;
    sr.all = S.rootCache.get(sr.root).ids || [];
    renderNodeTab({ keep: true });
    loadRootPage();
  }

  // the next 50 cards of the list's second part (the search's matches outside the graph, or the whole Quran in
  // the roots network), marked like the search; the root's words come with them
  function loadRootPage() {
    const sr = S.selRoot;
    if (!sr) return Promise.resolve(false);
    if (sr.busy) return sr.busy;
    const pool = sr.view === 'roots' ? sr.all || [] : rootOutIds(sr);
    const have = new Set(sr.cards.map((r) => r.i));
    const ids = pool.filter((i) => !have.has(i)).slice(0, REST_PAGE);
    if (!ids.length) return Promise.resolve(false);
    const C = S.clusters.get(sr.cid), data = C && C.data, q = sr.view === 'search' && data ? data.query.q : '', mode = sr.view === 'search' && data ? data._mode || 'auto' : 'auto';
    sr.failed = false;
    sr.busy = (async () => {
      const [cards, marks] = await Promise.all([
        api('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, q, mode, ...precisionArgs(C) }) }),
        sr.view === 'roots' ? api('/api/rootmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: sr.root, ids }) }) : Promise.resolve(null),
      ]);
      return { cards, marks };
    })().then(({ cards, marks }) => {
      sr.busy = null;
      if (S.selRoot !== sr) return false;
      if (marks) Object.entries(marks.marks).forEach(([i, js]) => sr.marks.set(+i, new Set(js)));
      sr.cards.push(...cards.results);
      const box = $('#tab-node .root-list');
      if (box) {
        box.insertAdjacentHTML('beforeend', cards.results.map((r) => resultCard(r, false, sr.marks.get(r.i))).join(''));
        bindCards(box);
        markSelectedCard();
      }
      updateRootMore();
      if (fromNode()) updateDetailBar();
      return true;
    }).catch((err) => {
      sr.busy = null; sr.failed = true;
      if (S.selRoot === sr) { toast(t('toast.restFail', { e: err.message }), true); updateRootMore(); }
      return false;
    });
    updateRootMore();
    return sr.busy;
  }

  function updateRootMore() {
    const sr = S.selRoot, more = $('#tab-node .rest-more');
    if (!sr || !more) return;
    const pool = sr.view === 'roots' ? sr.all || [] : rootOutIds(sr);
    const have = new Set(sr.cards.map((r) => r.i)), left = pool.filter((i) => !have.has(i)).length;
    more.hidden = left <= 0;
    $('#tab-node .rest-end').hidden = left > 0 || !pool.length;
    more.disabled = !!sr.busy;
    more.textContent = sr.busy ? t('rest.loading') : sr.failed ? t('rest.retry') : t('rest.more', { n: left });
    if (S.rootIO) { S.rootIO.unobserve(more); if (left > 0 && !sr.busy && !sr.failed) S.rootIO.observe(more); }
  }

  function renderNodeTab({ keep = false } = {}) {
    const sr = S.selRoot, el = $('#tab-node');
    const cy = S.cy, n = sr && sr.id && cy ? cy.$id(sr.id) : null;
    const C = sr && S.clusters.get(sr.cid);
    if (!sr || !cy || !C || (sr.id && n.empty()) || (sr.view === 'search' && !C.data)) { releaseRoot(); return; }
    const sb = $('.side-body'), top = sb.scrollTop, on = el.classList.contains('on');
    const d = n ? n.data() : { label: sr.root, n: null };
    const tb = $('#tabbtn-node');
    tb.removeAttribute('data-i18n');
    tb.innerHTML = t('tab.root', { r: bdiAr(d.label) });
    let head, body;
    const mk = (r, seed = false) => resultCard(r, seed, sr.marks.get(r.i));
    if (sr.view === 'roots') {
      const all = sr.all;
      head = `<div class="counts">${all ? t('node.all', { n: `<b>${t('cnt.ayat', { n: all.length })}</b>` }) : t('rest.loading')}</div>`;
      body = `<div class="root-list">${sr.cards.map((r) => mk(r)).join('')}</div>`;
    } else {
      const data = C.data;
      const own = new Set([...data.results, ...data.seeds].map((r) => r.i));
      const seeds = new Set(data.seeds.map((r) => r.i));
      const rows = rootGraphIds(sr).map((i) => C.resultByI.get(i)).filter(Boolean);
      const out = rootOutIds(sr), outSet = new Set(out);
      const closed = sr.closedLeft.filter((tid) => cy.$id(tid).hasClass('collapsed'));
      const inClosed = closed.length ? rows.filter((r) => closed.includes(cy.$id(ayahId(C.id, r.i)).data('theme'))).length : 0;
      const waiting = !n && !sr.gids;
      head = `<div class="counts">${waiting ? t('rest.loading') : t('node.ayat', { n: `<b>${t('cnt.ayat', { n: rows.length })}</b>` })}${d.n ? ` · ${t('tt.root', { occ: t('cnt.occ', { n: d.n }) })}` : ''}${sr.marks.size ? ` · ${t('node.mark')}` : ''}</div>
        ${out.length ? `<div class="counts">${t('node.out', { n: t('cnt.ayat', { n: out.length }) })}</div>` : ''}
        ${inClosed ? `<div class="counts node-closed">${t('node.closed', { n: t('cnt.ayat', { n: inClosed }), t: closed.length })} <button class="btn sm" type="button" data-node="openall">${t('node.openAll')}</button></div>` : ''}`;
      body = rows.map((r) => resultCard(own.has(r.i) ? r : { ...r, expanded: true }, seeds.has(r.i), sr.marks.get(r.i))).join('')
        + (out.length ? `<section class="rest-group" aria-label="${t('node.outHead')}">
          <div class="rest-head"><span class="t-ar">${t('node.outHead')}</span> <span class="t-en">${t('rest.sub')}</span><span class="t-n">${out.length}</span></div>
          <div class="root-list">${sr.cards.filter((r) => outSet.has(r.i)).map((r) => mk(r)).join('')}</div>` : '');
    }
    const tail = `<button class="rest-more" type="button" hidden></button><div class="rest-end" hidden>${t('rest.end')}</div>`;
    el.innerHTML = `<div class="rlist" role="region" aria-label="${t('node.aria')}">
      <div class="qinfo node-head">
        <div class="node-top"><div><span class="kind">${t('kind.root')}</span>
          <span class="node-root" lang="ar" dir="rtl">${esc(d.label)}</span>${d.gloss ? ` <small ${enAttr}>${esc(d.gloss)}</small>` : ''}</div>
          <div class="node-btns"><button class="btn" type="button" data-node="details">${t('node.details')}</button>
          ${sr.view === 'search' && !(C.data && C.data.query.kind === 'root' && C.data.query.roots && C.data.query.roots.some((x) => x.r === sr.root))
            ? `<button class="btn" type="button" data-node="search" title="${t('chip.branchT')}">${t('node.search')} ↗</button>` : ''}
          <button class="btn" type="button" data-node="release" title="${t('node.releaseT')}">${t('node.release')}</button></div></div>
        ${head}
      </div>
      ${body}${sr.view === 'roots' || rootOutIds(sr).length ? tail : ''}${sr.view === 'search' && rootOutIds(sr).length ? '</section>' : ''}
    </div>`;
    $('[data-node="details"]', el).addEventListener('click', () => { S.listSrc = 'node'; showRoot(sr.root); });
    $('[data-node="release"]', el).addEventListener('click', () => { releaseRoot(); refreshEmphasis(); });
    const sx = $('[data-node="search"]', el);
    if (sx) sx.addEventListener('click', (e) => branchFromChip({ q: `جذر:${sr.root}`, mode: 'root' }, { from: sr.id || rootId(C.id, sr.root), via: 'root', replace: e.shiftKey }));
    const oa = $('[data-node="openall"]', el);
    if (oa) oa.addEventListener('click', () => revealRoot(sr, { all: true }));
    const more = $('.rest-more', el);
    if (more) more.addEventListener('click', () => loadRootPage());
    if (S.rootIO) { S.rootIO.disconnect(); S.rootIO = null; }
    if (more) S.rootIO = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) loadRootPage(); },
      { root: restRoot(), rootMargin: '700px 0px' });
    bindCards(el);
    markSelectedCard();
    updateRootMore();
    if (keep && on) sb.scrollTop = top;
    else if (on) sb.scrollTop = 0;
    if (fromNode()) updateDetailBar();
    updateRootPill();
  }

  // narrow screens stack the list under the graph: a pill on the graph says what was picked and leads to it
  function updateRootPill() {
    const p = $('#rootPill'), sr = S.selRoot;
    if (!p) return;
    p.hidden = !sr;
    if (!sr) return;
    const n = sr.view === 'roots' ? (sr.all ? sr.all.length : null) : rootGraphIds(sr).length + rootOutIds(sr).length;
    p.innerHTML = `${bdiAr(sr.root)}${n != null ? ` · ${t('cnt.ayat', { n })}` : ''} <span aria-hidden="true">↓</span>`;
  }

  function bindCards(root) {
    $$('.res:not([data-b])', root).forEach((c) => {
      c.dataset.b = '1';
      clickable(c, () => openFromList(+c.dataset.i, c.dataset.ref, c.closest('#tab-node') ? 'node' : 'results'));
    });
  }

  // open an ayah chosen from the list: select its graph node when it has one, then show its details
  function openFromList(i, ref, src = 'results') {
    S.listSrc = src;
    S.selI = i;
    markSelectedCard();
    const id = S.active ? ayahId(S.active, i) : null;
    if (id && S.cy && S.cy.$id(id).nonempty()) selectNode(id, { center: true, open: false });
    else syncSelection(ref);
    showAyah(ref);
  }

  function markSelectedCard() {
    $$('#tab-results .res, #tab-node .res').forEach((c) => {
      const on = S.selI != null && +c.dataset.i === S.selI;
      c.classList.toggle('sel', on);
      if (on) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
    });
  }

  // the list in its displayed order (both sort modes), with the not-yet-loaded rest at the end
  function listOrder() {
    if (fromNode()) {
      const seen = new Set($$('#tab-node .res').map((c) => +c.dataset.i)), sr = S.selRoot;
      const pool = sr.view === 'roots' ? sr.all || [] : rootOutIds(sr);
      return [...seen, ...pool.filter((i) => !seen.has(i))];
    }
    if (!$('#tab-results .rlist') || !S.data) return [];
    const seen = new Set(), out = [];
    const add = (i) => { if (!seen.has(i)) { seen.add(i); out.push(i); } };
    $$('#tab-results .res').forEach((c) => add(+c.dataset.i));
    restIds(S.data).forEach(add);
    return out;
  }

  async function stepResult(step) {
    const order = listOrder();
    if (!order.length) return;
    const k = order.indexOf(S.selI);
    // from an ayah outside the list (a neighbour, a similar ayah) step relative to where the list was left
    const j = k >= 0 ? k + step : step > 0 ? S.listPos + 1 : S.listPos;
    if (j < 0 || j >= order.length) return;
    const i = order[j], data = S.data, src = fromNode() ? 'node' : 'results';
    let card = $(`#tab-${src} .res[data-i="${i}"]`);
    const sr = S.selRoot;
    while (!card && S.data === data && (src === 'results' || S.selRoot === sr)) {
      if (!(await (src === 'results' ? loadRestPage() : loadRootPage()))) break;
      card = $(`#tab-${src} .res[data-i="${i}"]`);
    }
    if (card && S.data === data) openFromList(i, card.dataset.ref, src);
  }

  const detailBar = () => `<div class="d-bar" role="navigation" aria-label="${t('bar.aria')}">
      ${fromNode() ? `<button class="d-back" type="button" title="${t('bar.backNodeT')}">${t('bar.backNode')}</button>`
        : `<button class="d-back" type="button" title="${t('bar.backT')}">${t('bar.back')}</button>`}
      <span class="d-pos"></span>
      <div class="d-step"><button type="button" data-step="-1" title="${t('bar.prevT')}" aria-label="${t('bar.prevA')}">↑</button><button type="button" data-step="1" title="${t('bar.nextT')}" aria-label="${t('bar.nextA')}">↓</button></div>
    </div>`;

  function bindDetailBar(el) {
    $('.d-back', el).addEventListener('click', () => {
      const tab = fromNode() ? 'node' : 'results';
      showTab(tab);
      const c = $(`#tab-${tab} .res.sel`);
      if (c) c.focus({ preventScroll: true });
    });
    $$('.d-step button', el).forEach((b) => b.addEventListener('click', () => stepResult(+b.dataset.step)));
    updateDetailBar();
  }

  function updateDetailBar() {
    const bar = $('#tab-detail .d-bar');
    if (!bar) return;
    const isAyah = bar.dataset.kind === 'ayah';
    const order = isAyah ? listOrder() : [];
    const k = order.indexOf(S.selI);
    if (k >= 0) S.listPos = k;
    const pos = $('.d-pos', bar);
    const own = S.data && !(fromNode() && S.selRoot.view === 'roots')
      ? new Set([...S.data.results, ...S.data.seeds].map((r) => r.i).concat(S.data.rest || [])) : new Set(order);
    const pulled = order.filter((i) => !own.has(i)).length;
    pos.innerHTML = !order.length ? '' : `${k >= 0 ? `<b>${k + 1}</b>` : '—'} / ${order.length}${pulled ? ` <small>${t('bar.pulled', { n: pulled })}</small>` : ''}`;
    pos.title = !order.length ? '' : k >= 0 ? t('bar.posT') : t('bar.outT');
    $('.d-step', bar).hidden = !order.length;
    const [prev, next] = $$('.d-step button', bar);
    prev.disabled = k >= 0 ? k === 0 : S.listPos < 0;
    next.disabled = k >= 0 ? k === order.length - 1 : S.listPos >= order.length - 1;
  }

  // rk: word positions of the selected root (underlined in its list), on top of the search's own marks
  function resultCard(r, seed = false, rk = null) {
    const hl = new Set(r.hl), rel = new Set(r.rel || []);
    const words = r.words.map((w, j) => {
      const x = rk && rk.has(j) ? `<u class="rk">${esc(w)}</u>` : esc(w);
      return hl.has(j) ? `<mark>${x}</mark>` : rel.has(j) ? `<mark class="rm">${x}</mark>` : x;
    }).join(' ');
    const node = S.cy && S.active ? S.cy.$id(ayahId(S.active, r.i)) : null;
    const dot = node && node.nonempty() ? `<i class="cdot" style="background:${node.data('col')}"></i>` : '';
    const N = window.QR && window.QR.notes, noted = N && N.get && N.get(`ayah:${r.i}`) ? '<span class="noted-mark" title="">✎</span> ' : '';
    const place = r.stype === 'Meccan' ? `<span class="tag mk">${t('place.mk')}</span>` : `<span class="tag md">${t('place.md')}</span>`;
    const why = seed ? `<span class="tag" style="color:var(--gold)">${t('tag.source')}</span>`
      : r.expanded ? `<span class="tag">${t('tag.pulled')}</span>` : esc(r.why.map(whyText).join(' · '));
    return `<div class="res${!seed && !r.lexical && !(r.rel && r.rel.length) ? ' meaning-only' : ''}" data-i="${r.i}" data-ref="${r.ref}" tabindex="0" role="button" aria-label="${t('card.aria', { ref: r.ref, s: esc(r.sname) })}">
      <div class="res-head"><span>${dot}<span class="ref">${r.ref}</span> · <bdi class="sname" lang="ar" dir="rtl">${esc(r.sname)}</bdi> ${place}</span>
      <span>${noted}${why}</span></div>
      <div class="res-ar" lang="ar">${words}</div><div class="res-en" ${enAttr}>${esc(r.en)}</div></div>`;
  }

  // why a result is listed (server tags: 'lexical', 'same root', 'meaning 0.87')
  function whyText(w) {
    const m = /^meaning ([\d.]+)$/.exec(w);
    return m ? t('why.meaning', { v: m[1] }) : w === 'lexical' ? t('why.lexical') : w === 'same root' ? t('why.root') : w;
  }

  /* make a non-button element behave like one (click + Enter/Space) */
  function clickable(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;   // let inner buttons (⊟) handle their own keys
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
    });
  }

  function renderThemeList() {
    const el = $('#communities');
    if (!S.cy) { el.innerHTML = ''; return; }
    const th = themesSorted();
    if (th.empty()) { el.innerHTML = '<div class="lg-row"><small>·</small></div>'; return; }
    el.innerHTML = th.map((tn) => {
      const d = tn.data(), nm = themeNames(d), nmE = esc(nm.main);
      // sub-theme names follow the same language rule (the main name only, to keep the row short)
      const subs = S.cy.nodes(`[kind="sub"][theme="${tn.id()}"]`).map((s) => (s.data('label_ar') ? themeNames(s.data()).main : '')).filter(Boolean);
      // Meccan / Medinan make-up of the theme, to compare themes at a glance
      const ay = S.cy.nodes(`[kind="ayah"][theme="${tn.id()}"]`);
      const mk = ay.filter('[stype="Meccan"]').length, pct = ay.length ? Math.round((100 * mk) / ay.length) : 0;
      const bar = S.view === 'search' && ay.length
        ? `<div class="mkbar" title="${t('comm.mkbar', { mk, md: ay.length - mk })}"><i style="width:${pct}%"></i></div>` : '';
      const second = [nm.sub ? bdiAr(nm.sub) : '', d.related ? t('g.byMeaning') : ''].filter(Boolean).join(' · ');
      return `<div class="comm" data-t="${tn.id()}">
        <button class="comm-main" type="button" aria-label="${t('comm.focusA', { t: nmE, n: d.size })}">
        <i class="dot" style="background:${d.col}"></i>
        <div><div class="c-ar">${nameHtml(d, false)}</div>${second ? `<div class="c-en">${second}</div>` : ''}
        ${subs.length ? `<div class="sub-list">↳ ${subs.map(bdiAuto).join(' · ')}</div>` : ''}${bar}</div>
        <span class="c-n">${d.size}</span></button>
        <button class="cbtn rn" title="${t('comm.renameT')}" aria-label="${t('comm.renameA', { t: nmE })}">✎</button>
        ${S.view === 'search' ? `<button class="cbtn col" title="${t('comm.colT')}" aria-label="${t('comm.colA', { t: nmE })}">⊟</button>` : ''}</div>`;
    }).join('');
    $$('.comm', el).forEach((d) => {
      // the whole row is clickable with the mouse; keyboard users get the row's main button
      d.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.cbtn, input')) return;
        focusTheme(d.dataset.t, { center: true });
      });
      const b = $('.cbtn.col', d);
      if (b) b.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(d.dataset.t); });
      $('.cbtn.rn', d).addEventListener('click', (e) => { e.stopPropagation(); renameTheme(d); });
    });
    updateThemeListState();
  }

  function renameTheme(row) {
    // the researcher's own name for a theme (kept for this graph only)
    const t = S.cy.$id(row.dataset.t), box = $('.c-ar', row);
    const inp = document.createElement('input');
    inp.className = 'rename'; inp.dir = 'auto'; inp.value = themeNames(t.data()).main; inp.setAttribute('aria-label', I18N.t('comm.newName'));
    box.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (save && v) {
        // the researcher's name replaces both server names, so it shows in either language (and it is saved)
        t.data({ label_ar: v, label_en: '', renamed: true });
        t.data('label', themeLabel(t.data(), t.hasClass('collapsed')));
        if (S.data && S.view === 'search') renderResults(S.data);
        emit('change');
      }
      renderThemeList();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }

  function renderColorKey() {
    const el = $('#colorKey');
    if (S.colorBy === 'place') el.innerHTML = `<span><i class="dot" style="background:var(--meccan)"></i>${t('place.mk')}</span><span><i class="dot" style="background:var(--medinan)"></i>${t('place.md')}</span>`;
    else if (S.colorBy === 'surah') el.innerHTML = `<span>${t('ckey.surah')}</span>`;
    else el.innerHTML = `<span>${t('ckey.theme')}</span>`;
  }

  /* ------------------------------------------------------------ details */
  async function getAyah(ref) {
    if (!S.ayahCache.has(ref)) S.ayahCache.set(ref, await api(`/api/ayah/${ref}`));
    return S.ayahCache.get(ref);
  }

  const phraseKeys = (t) => (t ? t.split(/\s+/).map((w) => nospace(normAr(w))).filter(Boolean) : null);

  // keep the graph selection on the ayah the details panel shows (or on nothing if it isn't in the graph)
  function syncSelection(ref) {
    if (!S.cy || !S.active) return;
    const n = S.cy.nodes(`[kind="ayah"][ref="${ref}"][cid="${S.active}"]`);
    S.cy.$(':selected').unselect();
    if (n.nonempty()) { n.select(); S.selected = n.id(); } else S.selected = null;
    refreshEmphasis();
  }

  // the note of the item Details shows, under its translation: the editor when a note exists, else «+ note»
  function mountNoteSlot(el) {
    const N = window.QR && window.QR.notes;
    $$('.note-slot', el).forEach((slot) => {
      const key = slot.dataset.key, add = $('.note-add', el);
      if (!N || !N.mountEditor || !key) { if (add) add.hidden = true; return; }
      if (N.get(key)) { N.mountEditor(slot, key); if (add) add.hidden = true; return; }
      if (!add) return;
      add.hidden = false;
      add.addEventListener('click', () => { add.hidden = true; N.mountEditor(slot, key, { autofocus: true }); }, { once: true });
    });
  }

  // relang: the same ayah re-rendered in the new UI language; the reader element (its loaded ayat and
  // scroll position), the page's scroll, the open similar-ayat tab and the tafsir fold are all kept
  async function showAyah(ref, { switchTab = true, phrase = null, relang = false } = {}) {
    const seq = S.detailBusy = ++S.seq.detail;
    const q = S.data && S.view === 'search' ? S.data.query : null;
    const qm = q ? { q: q.q, mode: S.data._mode || 'auto' } : null;
    // the neighbouring ayat load alongside the ayah itself, so the reader opens complete and in place
    const [s0, a0] = String(ref).split(':').map(Number);
    const ctx = s0 && a0 ? passageRange(s0, a0 - CTX, a0 + CTX, qm).catch(() => null) : Promise.resolve(null);
    let d;
    try { d = await getAyah(ref); } catch (err) { detailFailed(seq, t('toast.ayahFail', { e: err.message })); return; }
    const P = await ctx;
    if (seq !== S.seq.detail) return;   // the user already asked for another ayah
    S.detailBusy = 0;
    S.detail = { kind: 'ayah', ref, phrase, lang: L() };
    const fk = !relang && focusKey(switchTab);   // before the old panel (or the card's) focus is lost
    S.selI = d.i;
    markSelectedCard();
    if (switchTab) showTab('detail');
    const roots = new Set(q ? q.roots.map((r) => r.r) : []);
    const lemmas = new Set(q ? q.lemmas.map((l) => l.l) : []);
    // same rule as the server: a searched word marks that word; other words of its root get the lighter
    // mark; a root searched as a root (no lemma of it in the query) marks the whole root
    const lemmaRoots = new Set(q ? q.lemmas.map((l) => l.r).filter(Boolean) : []);
    const hit = d.words.map((w) => lemmas.has(w.l) || (roots.has(w.r) && !lemmaRoots.has(w.r)));
    const rel = d.words.map((w, j) => !hit[j] && roots.has(w.r) && lemmaRoots.has(w.r));
    // a query that resolved to no word (الم، a particle) is marked by its letters, which only the server knows
    const known = q && !roots.size && !lemmas.size ? S.resultByI.get(d.i) : null;
    if (known) known.hl.forEach((j) => { hit[j] = true; });
    // the server's marks for this ayah (from the passage) agree with the cards; take them too
    const px = P && P.ayat.get(d.a);
    if (px && px.ref === d.ref && px.words.length === d.words.length) {
      px.hl.forEach((j) => { hit[j] = true; rel[j] = false; });
      px.rel.forEach((j) => { if (!hit[j]) rel[j] = true; });
    }
    const ph = phraseKeys(phrase);
    if (ph) {
      const keys = d.words.map((w) => nospace(normAr(w.f)));
      for (let p = 0; p + ph.length <= keys.length; p++) {
        if (ph.every((k, j) => keys[p + j] === k)) ph.forEach((_, j) => { hit[p + j] = true; rel[p + j] = false; });
      }
    }
    const text = d.words.map((w, j) => (hit[j] ? `<mark>${esc(w.f)}</mark>` : rel[j] ? `<mark class="rm">${esc(w.f)}</mark>` : esc(w.f))).join(' ');
    const words = d.words.map((w, j) => `<div class="w${hit[j] ? ' hit' : rel[j] ? ' rel' : ''}">
        <div class="wf" lang="ar">${esc(w.f)}</div>
        ${w.r ? `<button class="wr" lang="ar" data-root="${esc(w.r)}" title="${t('w.rootT', { r: esc(w.rs) })}">${esc(w.rs)}</button>` : '<div class="wr none">·</div>'}
        ${w.r || w.l ? `<button class="wx" type="button" data-l="${esc(w.l || '')}" data-r="${esc(w.r || '')}" title="${t('w.branchT')}" aria-label="${t('w.branchT')}">↗</button>` : ''}
        <div class="wg" lang="en">${esc(w.g)}</div></div>`).join('');
    const sim = d.similar;
    const el = $('#tab-detail');
    const keep = relang && S.reader && S.reader.el.isConnected && S.reader.ref === d.ref ? S.reader : null;
    const keepTop = keep ? keep.el.scrollTop : 0;   // a detached element loses its scroll position
    const sb = $('.side-body'), top = sb.scrollTop, simOn = keep && ($('.sim-tabs button.on', el) || {}).dataset;
    const tafOpen = !!(keep && ($('details.tafsir', el) || {}).open);
    const place = t(d.surah.type === 'Meccan' ? 'place.mk' : 'place.md');
    // previous ayah first: it sits on the reading-start side (right in Arabic, left in English)
    const [gPrev, gNext] = L() === 'ar' ? ['›', '‹'] : ['‹', '›'];
    el.innerHTML = `${detailBar()}
      <div class="d-head">
        <div><div class="d-title">${t('d.title', { name: esc(d.surah.name), tname: esc(d.surah.tname), ref: d.ref })}</div>
        <div class="d-sub">${t('d.sub', { place, order: d.surah.order, ename: `<span ${enAttr}>${esc(d.surah.ename)}</span>`, name: bdiAr(d.surah.name) })}</div></div>
        <div class="navbtns">${d.prev ? `<button data-ref="${d.prev}" data-nav="prev" title="${t('d.prevT', { ref: d.prev })}" aria-label="${t('d.prevA')}">${gPrev}</button>` : ''}${d.next ? `<button data-ref="${d.next}" data-nav="next" title="${t('d.nextT', { ref: d.next })}" aria-label="${t('d.nextA')}">${gNext}</button>` : ''}</div>
      </div>
      <div class="ayah-text reader" lang="ar" tabindex="0" role="region"
        aria-label="${t('reader.aria', { ref: d.ref })}"><div class="r-flow"><span class="ra cur" data-a="${d.a}">${text} <span class="ra-n">﴿${arNum(d.a)}﴾</span></span></div></div>
      <div class="ayah-en" ${enAttr}>${esc(d.en)}</div><div class="ayah-src">${t('d.trans')}</div>
      <div class="note-slot" data-key="ayah:${d.i}"></div>
      <div class="d-actions"><button class="btn primary" data-search="${d.ref}" title="${t('chip.branchT')}">${t('d.similarBtn')} ↗</button><button class="btn note-add" type="button" hidden>${t('nt.add')}</button>${twinsHtml(d.i)}</div>
      <details class="tafsir"${tafOpen ? ' open' : ''}><summary>${t('d.tafsir')}</summary><p lang="ar">${esc(d.tafsir)}</p></details>
      <h4>${t('h.wbw')}</h4>
      <div class="wbw">${words}</div>
      ${d.topics.length ? `<h4>${t('h.topics')}</h4><div class="chips">${d.topics.map((x) => `<button class="chip sm" data-q="${esc(x)}">${bdiAuto(x)}</button>`).join('')}</div>` : ''}
      <h4>${t('h.similar')}</h4>
      <div class="sim-tabs" role="tablist" aria-label="${t('sim.aria')}">
        <button data-s="meaning" class="on" role="tab" id="simTab-meaning" aria-controls="simList">${t('sim.meaning')}</button>
        <button data-s="roots" role="tab" id="simTab-roots" aria-controls="simList">${t('sim.roots')}</button>
        <button data-s="phrase" role="tab" id="simTab-phrase" aria-controls="simList">${t('sim.phrase', { n: sim.phrase.length })}</button>
      </div>
      <div id="simList" role="tabpanel"></div>`;
    const lists = {
      meaning: sim.meaning.map((x) => `<div class="sim" data-ref="${x.ref}" tabindex="0" role="button"><div class="s-top"><b>${x.ref}</b><span>${x.score}</span></div>
          <div class="s-ar" lang="ar">${esc(trim(x.text, 150))}</div><div class="meter"><i style="width:${clamp((x.score - 0.8) * 500, 4, 100)}%"></i></div></div>`).join(''),
      roots: sim.roots.map((x) => `<div class="sim" data-ref="${x.ref}" tabindex="0" role="button"><div class="s-top"><b>${x.ref}</b><span lang="ar" style="color:var(--root)">${x.shared.map(esc).join(' · ')}</span></div>
          <div class="s-ar" lang="ar">${esc(trim(x.text, 150))}</div></div>`).join(''),
      phrase: sim.phrase.length ? sim.phrase.map((x) => `<div class="sim" data-ref="${x.ref}" data-ph="${esc(x.phrase)}" tabindex="0" role="button"><div class="s-top"><b>${x.ref}</b><span>${x.n ? t('cnt.words', { n: x.n }) : ''}${x.curated ? t('sim.curated') : ''}</span></div>
          ${x.phrase ? `<div class="s-ph" lang="ar">«${esc(x.phrase)}»</div>` : ''}<div class="s-ar" lang="ar">${esc(trim(x.text, 150))}</div></div>`).join('')
        : `<div class="empty" style="padding:16px">${t('sim.none')}</div>`,
    };
    const setSim = (k) => {
      $$('.sim-tabs button', el).forEach((b) => {
        const on = b.dataset.s === k;
        b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
      });
      $('#simList').setAttribute('aria-labelledby', `simTab-${k}`);
      $('#simList').innerHTML = lists[k];
      $$('#simList .sim').forEach((s) => clickable(s, () => {
        syncSelection(s.dataset.ref);
        if (S.selected) selectNode(S.selected, { center: true, open: false });
        showAyah(s.dataset.ref, { phrase: s.dataset.ph || null });
      }));
    };
    $$('.sim-tabs button', el).forEach((b) => b.addEventListener('click', () => setSim(b.dataset.s)));
    setSim(simOn && lists[simOn.s] != null ? simOn.s : 'meaning');
    $$('.navbtns button', el).forEach((b) => b.addEventListener('click', () => { syncSelection(b.dataset.ref); showAyah(b.dataset.ref); }));
    $('[data-search]', el).addEventListener('click', (e) => branchFromChip({ q: d.ref, mode: 'ayah' }, { from: S.active ? ayahId(S.active, d.i) : null, via: 'ayah', replace: e.shiftKey }));
    // ↗ beside a word: search that word, or its root, as a network branched from this ayah
    $$('.wx', el).forEach((b) => b.addEventListener('click', (e) => {
      const from = S.active ? ayahId(S.active, d.i) : null, r = e.currentTarget.getBoundingClientRect();
      openMenu([
        b.dataset.l ? { label: t('m.searchWord'), fn: (ev) => branchFromChip({ q: b.dataset.l, mode: 'word' }, { from, via: 'word', replace: ev.shiftKey }) } : null,
        b.dataset.r ? { label: t('m.searchRoot'), fn: (ev) => branchFromChip({ q: `جذر:${b.dataset.r}`, mode: 'root' }, { from, via: 'root', replace: ev.shiftKey }) } : null,
      ], { x: r.left, y: r.bottom }, { page: true });
    }));
    $$('.twin-link', el).forEach((b) => b.addEventListener('click', () => { const n = S.cy.$id(b.dataset.id); if (n.nonempty()) selectNode(n.id(), { center: true, open: false }); }));
    bindChips(el);
    mountNoteSlot(el);
    $('.d-bar', el).dataset.kind = 'ayah';
    bindDetailBar(el);
    if (fk) restoreFocus(el, fk);
    if (keep) {
      // same ayah, new language: put the live reader back and relabel it
      $('.reader', el).replaceWith(keep.el);
      keep.el.scrollTop = keepTop;
      keep.seq = seq;
      relabelReader(keep);
      if (el.classList.contains('on')) sb.scrollTop = top;
    } else {
      resetDetailScroll();
      mountReader($('.reader', el), d, P, qm, seq);
    }
  }

  // a detail load that failed: when it was the newest, say so, and bring the page still shown into the
  // current language (a switch made while it loaded skipped it, see setLang)
  function detailFailed(seq, msg) {
    if (seq !== S.seq.detail) return;
    S.detailBusy = 0;
    toast(msg, true);
    if (S.detail && S.detail.lang !== L()) relangDetail();
  }

  // Details is rebuilt on every open / step, which drops keyboard focus to <body> (where arrow keys walk
  // the graph). focusKey names the control to focus in the new page: the same bar / nav button that was
  // used, else the reader when the open came from inside Details or from a list card. null leaves focus be
  function focusKey(switchTab) {
    const a = document.activeElement, el = $('#tab-detail');
    if (!a || a === document.body) return null;
    if (el.contains(a)) {
      if (a.matches('.d-step button')) return `.d-step [data-step="${a.dataset.step}"]`;
      if (a.matches('.navbtns [data-nav]')) return `.navbtns [data-nav="${a.dataset.nav}"]`;
      if (a.matches('.d-back')) return '.d-back';
      return '.reader';
    }
    return switchTab && a.closest('#tab-results .res') ? '.reader' : null;
  }
  function restoreFocus(el, key) {
    // a step button that is now disabled (end of the list) or a missing ‹/› (surah edge) falls back
    const b = [key, '.reader', '.d-back'].map((k) => $(k, el)).find((x) => x && !x.disabled && !x.closest('[hidden]'));
    if (b) b.focus({ preventScroll: true });
  }

  // a new detail page starts at its top; the Results tab keeps its own place
  function resetDetailScroll() {
    S.tabScroll.detail = 0;
    if ($('#tab-detail').classList.contains('on')) $('.side-body').scrollTop = 0;
  }

  /* ------------------------------------------------------------ context reader: the surah scrolls inside the ayah box */
  const CTX = 6;          // ayat loaded on each side when an ayah opens
  const CTX_MORE = 20;    // ayat added per step when the reader scrolls near an edge
  const arNum = (n) => n.toLocaleString('ar-EG');

  // passages are cached per surah and per search (the marks depend on q + mode); fetches only what is missing
  async function passageRange(s, from, to, qm) {
    const key = `${s}|${qm ? `${qm.mode}|${qm.q}` : ''}`;
    let P = S.passCache.get(key);
    if (!P) {
      P = { s, ayas: null, sname: '', ayat: new Map() };
      S.passCache.set(key, P);
      if (S.passCache.size > 40) S.passCache.delete(S.passCache.keys().next().value);
    }
    from = Math.max(1, from);
    if (P.ayas) to = Math.min(P.ayas, to);
    let lo = from;
    while (lo <= to && P.ayat.has(lo)) lo++;
    let hi = to;
    while (hi >= lo && P.ayat.has(hi)) hi--;
    if (lo <= hi) {
      const p = new URLSearchParams({ from: lo, to: Math.min(hi, lo + 39) });
      if (qm && qm.q) { p.set('q', qm.q); p.set('mode', qm.mode); }
      const r = await api(`/api/passage/${s}?${p}`);
      P.ayas = r.ayas; P.sname = r.sname;
      r.ayat.forEach((x) => P.ayat.set(x.a, x));
    }
    return P;
  }

  function readerAyah(x) {
    const hl = new Set(x.hl), rel = new Set(x.rel);
    const txt = x.words.map((w, j) => (hl.has(j) ? `<mark>${esc(w)}</mark>` : rel.has(j) ? `<mark class="rm">${esc(w)}</mark>` : esc(w))).join(' ');
    return `<span class="ra" data-a="${x.a}">${txt} <button type="button" class="ra-n" data-ref="${x.ref}" title="${t('reader.openT', { ref: x.ref })}" aria-label="${t('reader.openA', { ref: x.ref })}">﴿${arNum(x.a)}﴾</button></span>`;
  }
  const readerRange = (P, from, to) => {
    const out = [];
    for (let a = from; a <= to; a++) if (P.ayat.has(a)) out.push(readerAyah(P.ayat.get(a)));
    return out.join(' ');
  };

  function mountReader(box, d, P, qm, seq) {
    const R = { el: box, s: d.surah.n, a: d.a, ref: d.ref, lo: d.a, hi: d.a, P, qm, seq, busy: false, needScroll: true };
    S.reader = R;
    if (P && P.ayas) {
      // only what is contiguous with the opened ayah (a failed fetch leaves gaps)
      while (R.lo > 1 && P.ayat.has(R.lo - 1) && R.lo > d.a - CTX) R.lo--;
      while (R.hi < P.ayas && P.ayat.has(R.hi + 1) && R.hi < d.a + CTX) R.hi++;
      const flow = $('.r-flow', box);
      if (R.lo < d.a) flow.insertAdjacentHTML('afterbegin', readerRange(P, R.lo, d.a - 1) + ' ');
      if (R.hi > d.a) flow.insertAdjacentHTML('beforeend', ' ' + readerRange(P, d.a + 1, R.hi));
    }
    readerEdges(R);
    box.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button.ra-n');
      if (!b) return;
      syncSelection(b.dataset.ref);
      if (S.selected) selectNode(S.selected, { center: true, open: false });
      showAyah(b.dataset.ref);
    });
    box.addEventListener('scroll', () => readerMore(R), { passive: true });
    scrollReaderToCur(R);
  }

  // surah start / end markers, so the reader shows where the surah's text begins and ends; they are
  // interface text inside the Arabic box, so they carry the UI's lang + dir
  const edgeHtml = (P, end) => t(end ? 'reader.end' : 'reader.start', { s: bdiAr(P.sname), n: P.ayas });
  function readerEdges(R) {
    const P = R.P, box = R.el;
    const top = $(':scope > .r-edge.start', box), bot = $(':scope > .r-edge.end', box);
    const attrs = `lang="${L()}" dir="${L() === 'ar' ? 'rtl' : 'ltr'}"`;
    if (P && P.ayas && R.lo === 1 && !top) box.insertAdjacentHTML('afterbegin', `<div class="r-edge start" ${attrs}>${edgeHtml(P, false)}</div>`);
    if (P && P.ayas && R.hi === P.ayas && !bot) box.insertAdjacentHTML('beforeend', `<div class="r-edge end" ${attrs}>${edgeHtml(P, true)}</div>`);
  }

  // the UI language changed: the reader's own labels follow, its text and scroll position stay
  function relabelReader(R) {
    const box = R.el;
    box.setAttribute('aria-label', t('reader.aria', { ref: R.ref }));
    $$('button.ra-n', box).forEach((b) => { b.title = t('reader.openT', { ref: b.dataset.ref }); b.setAttribute('aria-label', t('reader.openA', { ref: b.dataset.ref })); });
    $$(':scope > .r-edge', box).forEach((e) => {
      e.lang = L(); e.dir = L() === 'ar' ? 'rtl' : 'ltr';
      e.innerHTML = edgeHtml(R.P, e.classList.contains('end'));
    });
  }

  // put the opened ayah near the top of the box, one line of what comes before it showing above
  function scrollReaderToCur(R) {
    const box = R.el, cur = $('.ra.cur', box);
    if (!cur || !box.isConnected || !box.clientHeight) return;   // hidden tab: done when Details shows
    R.needScroll = false;
    const line = parseFloat(getComputedStyle(box).lineHeight) || 60;
    box.scrollTop = Math.max(0, cur.offsetTop - line * 0.85);
    readerMore(R);
  }

  function readerMore(R) {
    if (S.reader !== R || R.busy || !R.P || !R.P.ayas || R.needScroll) return;
    const box = R.el, edge = 140;
    if (box.scrollTop < edge && R.lo > 1) extendReader(R, -1);
    else if (box.scrollHeight - box.scrollTop - box.clientHeight < edge && R.hi < R.P.ayas) extendReader(R, 1);
  }

  async function extendReader(R, dir) {
    R.busy = true;
    const from = dir < 0 ? Math.max(1, R.lo - CTX_MORE) : R.hi + 1;
    const to = dir < 0 ? R.lo - 1 : Math.min(R.P.ayas, R.hi + CTX_MORE);
    try { await passageRange(R.s, from, to, R.qm); } catch (err) {
      if (S.reader === R) toast(t('toast.ctxFail', { e: err.message }), true);
      return;   // stays busy: no retry loop on every scroll event; reopening the ayah tries again
    }
    if (S.reader !== R || R.seq !== S.seq.detail || !R.el.isConnected) return;
    const box = R.el, flow = $('.r-flow', box);
    if (dir < 0) {
      // prepend without moving what the reader is looking at
      const anchor = $('.ra', flow), before = anchor.offsetTop;
      flow.insertAdjacentHTML('afterbegin', readerRange(R.P, from, to) + ' ');
      R.lo = from;
      readerEdges(R);
      box.scrollTop += anchor.offsetTop - before;
    } else {
      flow.insertAdjacentHTML('beforeend', ' ' + readerRange(R.P, from, to));
      R.hi = to;
      readerEdges(R);
    }
    R.busy = false;
    readerMore(R);
  }

  // shorten at the last space before n: Quran text is never cut inside a word (or between a letter and its
  // marks), and a pause mark stays with its word or goes with it
  const trim = (s, n) => {
    if (s.length <= n) return s;
    const cut = s.lastIndexOf(' ', n);
    return `${cut > 0 ? s.slice(0, cut) : s.split(' ')[0]} …`;
  };

  async function showRoot(r, { relang = false } = {}) {
    const seq = S.detailBusy = ++S.seq.detail;
    let d;
    try {
      if (!S.rootCache.has(r)) S.rootCache.set(r, await api(`/api/root/${encodeURIComponent(r)}`));
      d = S.rootCache.get(r);
    } catch (err) { detailFailed(seq, t('toast.rootFail', { e: err.message })); return; }
    if (seq !== S.seq.detail) return;
    S.detailBusy = 0;
    S.detail = { kind: 'root', r, lang: L() };
    const fk = !relang && focusKey(true);
    const sb = $('.side-body'), top = sb.scrollTop;
    if (!relang) showTab('detail');
    const el = $('#tab-detail');
    S.reader = null;
    const mkPct = Math.round(d.share_mk * 100), basePct = Math.round(d.base_mk * 100);
    const lean = mkPct - basePct;
    const leanTxt = Math.abs(lean) < 6 ? t('lean.even') : lean > 0 ? t('lean.mk', { n: lean }) : t('lean.md', { n: -lean });
    const C = act(), rid = C ? rootId(C.id, d.root) : null;
    const inGraph = !!(C && C.kind === 'search' && S.cy && S.cy.$id(rid).nonempty());
    el.innerHTML = `${detailBar()}
      <div class="d-head"><div><div class="d-sub">${t('r.label')}</div><div class="root-big" lang="ar">${esc(d.sp)}</div></div>
        <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          <button class="btn primary" data-rootsearch="${esc(d.root)}" title="${t('chip.branchT')}">${t('r.search')} ↗</button>
          ${inGraph ? `<button class="btn" data-expand="${esc(rid)}"${C.frozen ? ` disabled title="${t('ws.frozenT')}"` : ''}>${t('r.expand')}</button>` : ''}
          <button class="btn note-add" type="button" hidden>${t('nt.add')}</button>
        </div></div>
      <div class="note-slot" data-key="root:${esc(d.root)}"></div>
      <div class="stats">
        <div class="stat"><b>${d.n}</b><span>${t('r.occ')}</span></div>
        <div class="stat"><b>${d.na}</b><span>${t('r.ayat')}</span></div>
        <div class="stat"><b>${d.per_surah.filter((x) => x).length}</b><span>${t('r.surahs')}</span></div>
      </div>
      <h4>${t('r.mkmd')} <small>${leanTxt}</small></h4>
      <div class="split"><i style="width:${mkPct}%;background:var(--meccan)"></i><i style="width:${100 - mkPct}%;background:var(--medinan)"></i></div>
      <div class="split-legend"><span>${t('split.mk', { p: mkPct })}</span><span>${t('split.base', { p: basePct })}</span><span>${t('split.md', { p: 100 - mkPct })}</span></div>
      <h4>${t('r.dist')}</h4>
      <canvas class="dist" id="dist" role="img" aria-label="${t('r.distA')}"></canvas>
      <h4>${t('r.lemmas')}</h4>
      <div class="lemmas">${d.lemmas.map((l) => `<button class="lem" data-q="${esc(l.l)}"><span class="lf" lang="ar">${esc(l.t || l.l)}</span><span class="lg"><span ${enAttr}>${esc(l.g)}</span> · ${times(l.n)}</span></button>`).join('')}</div>
      <h4>${t('r.cooc')}</h4>
      <div class="chips">${d.cooc.map((c) => `<button class="chip root sm" data-root="${esc(c.r)}">${bdiAr(c.sp)} <small>${c.c}</small></button>`).join('')}</div>`;
    S.dist = [d.per_surah, d.surah_types];
    drawDist($('#dist'), ...S.dist);
    bindChips(el);
    mountNoteSlot(el);
    const b = $('[data-rootsearch]', el);
    b.addEventListener('click', (e) => branchFromChip({ q: `جذر:${b.dataset.rootsearch}`, mode: 'root' }, { from: rid, via: 'root', replace: e.shiftKey }));
    const x = $('[data-expand]', el);
    if (x) x.addEventListener('click', () => expandNode(x.dataset.expand));
    $$('.lem', el).forEach((l) => l.addEventListener('click', (e) => branchFromChip({ q: l.dataset.q, mode: 'word' }, { from: rid, via: 'word', replace: e.shiftKey })));
    $('.d-bar', el).dataset.kind = 'root';
    bindDetailBar(el);
    if (fk) restoreFocus(el, fk);
    if (relang) { if (el.classList.contains('on')) sb.scrollTop = top; } else resetDetailScroll();
  }

  function drawDist(cv, vals, types) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const max = Math.max(...vals, 1), left = 6, right = 16, top = 18, bottom = 14;
    const bw = (w - left - right) / 114;
    vals.forEach((v, k) => {
      const bh = v ? Math.max(2, (v / max) * (h - top - bottom)) : 0;
      ctx.fillStyle = types[k] === 'Meccan' ? G.meccan : G.medinan;
      ctx.globalAlpha = v ? 0.95 : 0.15;
      ctx.fillRect(left + k * bw, h - bottom - bh, Math.max(1, bw - 1), bh || 1);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = G.distText; ctx.font = '10px -apple-system, sans-serif';
    [1, 20, 40, 60, 80, 100, 114].forEach((s) => {
      ctx.textAlign = s === 114 ? 'right' : 'left';
      ctx.fillText(s, s === 114 ? w - 2 : left + (s - 1) * bw, h - 3);
    });
    ctx.textAlign = 'left';
    const topS = vals.map((v, k) => [v, k + 1]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter((t) => t[0]);
    ctx.fillStyle = G.distTitle;
    // the title is interface text: drawn right-aligned from the right edge in the Arabic UI
    const rtl = L() === 'ar';
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    ctx.fillText(t('dist.top', { list: topS.map((x) => `${x[1]} (${x[0]})`).join(rtl ? '، ' : ', ') }), rtl ? w - 4 : left + 2, 11);
  }

  function bindChips(el) {
    // a root lists its ayat (selectRoot); outside a graph it opens its details
    $$('[data-root]', el).forEach((c) => c.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.cy && act()) selectRoot(c.dataset.root); else showRoot(c.dataset.root);
    }));
    // a word / topic chip opens its search as a network branched from the ayah (or ★) it was found on;
    // Shift-click replaces the active network; on the welcome screen it is simply a search
    $$('.chip[data-q]', el).forEach((c) => c.addEventListener('click', (e) => {
      if (!act()) { runSearch(c.dataset.q); return; }
      const from = S.detail && S.detail.kind === 'ayah' && S.selI != null && S.active ? ayahId(S.active, S.selI) : null;
      branchFromChip({ q: c.dataset.q, mode: c.dataset.via || 'auto' }, { from, via: c.dataset.via || 'topic', replace: e.shiftKey });
    }));
    $$('.chip[data-ref]', el).forEach((c) => c.addEventListener('click', () => showAyah(c.dataset.ref)));
  }
  // the same ayah in the other networks (Details lists them; a click selects that copy)
  function twinsHtml(i) {
    if (!S.cy || !S.active) return '';
    const ids = [...copiesOf(i)].filter((id) => cidOf(id) !== S.active);
    if (!ids.length) return '';
    return `<span class="twins"><small>${t('ws.alsoInLab')}</small> ${ids.map((id) => { const X = cl(id); return X ? `<button type="button" class="chip sm twin-link" data-id="${esc(id)}">${circled(X.n)} ${bdiAuto(shortQ(X))}</button>` : ''; }).join('')}</span>`;
  }

  /* ------------------------------------------------------------ root network view */
  // the root network (the corpus-wide co-occurrence map) is a network like any other on the canvas: added once,
  // beside the searches, and the «root network» view just brings it back into view
  async function showRootNetwork() {
    const existing = allC().find((C) => C.kind === 'roots');
    if (existing) { activate(existing.id, { camera: true }); showTab('results'); return existing; }
    setBusy(1);
    try {
      if (!S.rootNet) S.rootNet = await api('/api/network/roots?top=240');
      const data = S.rootNet, cy = ensureCy();
      const C = newCluster('roots', { q: 'roots' }, data);
      C.mode = 'organized';
      indexResults(C);
      $('#welcome').hidden = true;
      showChrome(true);
      await mountCluster(C, data);
      if (S.cy !== cy || !S.clusters.has(C.id)) return null;
      placeNew(C, {});
      syncSolo();
      activate(C.id, { camera: true, force: true });
      showTab('results');
      emit('cluster:add', { cid: C.id, params: C.params });
      emit('change');
      return C;
    } catch (err) {
      toast(t('toast.netFail', { e: err.message }), true);
      if (!act()) { showChrome(false); $('#tab-results').innerHTML = `<div class="empty" data-i18n="empty.netFail">${t('empty.netFail')}</div>`; }
      return null;
    } finally { setBusy(-1); }
  }

  function renderRootList(data) {
    const byT = new Map();
    data.nodes.forEach((n) => { if (!byT.has(n.theme)) byT.set(n.theme, []); byT.get(n.theme).push(n); });
    $('#tab-results').innerHTML = `<div class="qinfo"><span class="kind">${t('kind.roots')}</span>
      ${t('net.desc', { n: data.nodes.length, t: data.themes.length })}</div>` +
      themesSorted().map((th) => `<div class="tgroup" data-t="${th.id()}"><button class="thead" data-t="${th.id()}"><i class="cdot" style="background:${th.data('col')}"></i>
        <span>${nameHtml(th.data())}</span><span class="t-n">${th.data('size')}</span></button>
        <div class="chips">${(byT.get(th.id()) || []).sort((a, b) => b.na - a.na).map((n) => `<button class="chip root sm" data-root="${esc(n.root)}">${bdiAr(n.label)} <small>${n.na}</small></button>`).join('')}</div></div>`).join('');
    $$('#tab-results .thead').forEach((b) => b.addEventListener('click', () => focusTheme(b.dataset.t, { center: true })));
    bindChips($('#tab-results'));
  }

  /* ------------------------------------------------------------ phrases view */
  let phraseTimer = null, phraseSeq = 0;
  async function loadPhrases(q = '') {
    const seq = ++phraseSeq;
    let list;
    try { list = await api(`/api/phrases?q=${encodeURIComponent(q)}`); } catch (err) { toast(t('toast.err', { e: err.message }), true); return; }
    if (seq !== phraseSeq) return;
    S.phrases = list;
    renderPhrases(list);
  }

  function renderPhrases(list) {
    $('#phraseList').innerHTML = list.length ? list.map((p) => `<div class="ph">
        <div class="ph-text" lang="ar">${esc(p.text)}</div>
        <div class="ph-meta"><span>${t('cnt.words', { n: p.n })}</span><span>${t('cnt.ayat', { n: p.count }).replace(/\d+/, (x) => `<b>${x}</b>`)}</span></div>
        <div class="ph-refs">${p.refs.map((r) => `<button data-ref="${r}" data-ph="${esc(p.text)}">${r}</button>`).join('')}${p.count > p.refs.length ? '<span>…</span>' : ''}</div>
        <div class="ph-actions"><button class="btn" data-graph="${esc(p.text)}">${t('ph.graph')}</button></div></div>`).join('')
      : `<div class="empty">${t('ph.none')}</div>`;
    $$('#phraseList [data-ref]').forEach((s) => s.addEventListener('click', () => showAyah(s.dataset.ref, { phrase: s.dataset.ph })));
    $$('#phraseList [data-graph]').forEach((b) => b.addEventListener('click', (e) => runSearch(b.dataset.graph, { replace: e.shiftKey, params: { q: b.dataset.graph, mode: 'topic', scope: $('#scope').value, n: $('#n').value } })));
  }

  /* ------------------------------------------------------------ views, tabs, misc */
  // the views: «search» is the workspace, «root network» adds / shows that network on it, «phrases» is a list
  // drawn over the (untouched) workspace. Nothing is re-laid out by switching
  function switchView(v, { silent = false } = {}) {
    const was = S.view;
    S.view = v === 'roots' ? 'search' : v;
    $$('#views button').forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $('#phraseView').hidden = v !== 'phrases';
    $('#graph').hidden = v === 'phrases';
    $('#tooltip').hidden = true;
    closeMenu();
    if (v === 'phrases') {
      showChrome(false);
      $('#welcome').hidden = true;
      $('#switcher').hidden = true;
      $('#tab-results').innerHTML = `<div class="empty" data-i18n="ph.pick">${t('ph.pick')}</div>`;
      loadPhrases($('#phraseFilter').value);
      return;
    }
    if (was === 'phrases' && S.cy) S.cy.resize();
    if (v === 'roots') { if (!silent) showRootNetwork(); return; }
    if (silent) return;
    const C = act();
    if (C) { showChrome(true); activate(C.id, { force: true }); }
    else emptyPanel();
  }

  // the two tabs share one scroller: each keeps its own scroll position, and coming back to Results
  // brings the card of the ayah open in Details into view
  function showTab(t) {
    const sb = $('.side-body'), cur = $('.tab.on'), was = cur ? cur.id.slice(4) : null;
    if (was && was !== t) S.tabScroll[was] = sb.scrollTop;
    $$('.side-tabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${t}`));
    if (was === t) return;
    sb.scrollTop = S.tabScroll[t] || 0;
    if (t === 'results' || t === 'node') revealSelectedCard(t);
    if (t === 'detail' && S.reader && S.reader.needScroll) scrollReaderToCur(S.reader);
  }

  function revealSelectedCard(tab = 'results') {
    const c = $(`#tab-${tab} .res.sel`);
    if (!c) return;
    const sb = $('.side-body'), scrolls = getComputedStyle(sb).overflowY === 'auto';
    const box = scrolls ? sb.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const r = c.getBoundingClientRect();
    if (r.top < box.top + 8 || r.bottom > box.bottom - 8) c.scrollIntoView({ block: 'center' });
    c.classList.remove('flash');
    void c.offsetWidth;   // restart the animation
    c.classList.add('flash');
  }

  function setBusy(delta) {
    S.busy = Math.max(0, S.busy + delta);
    $('#busy').hidden = S.busy === 0;
  }

  // action: {label, fn} adds a button (undo) and keeps the toast for 10 s; the action runs once and closes it
  function toast(msg, isErr = false, action = null) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '') + (action ? ' action' : '');
    el.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'linkbtn'; b.textContent = action.label;
      b.addEventListener('click', () => { el.remove(); try { action.fn(); } catch (err) { console.error(err); } });
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), action ? 10000 : isErr ? 5000 : 2600);
  }

  /* suggestions */
  let sugTimer = null, sugIdx = -1, sugSeq = 0;
  function closeSuggest() { clearTimeout(sugTimer); sugSeq++; $('#suggest').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); sugIdx = -1; }
  $('#q').addEventListener('input', () => {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      const q = $('#q').value.trim();
      const box = $('#suggest');
      if (q.length < 2 || /^\d/.test(q)) { closeSuggest(); return; }
      const seq = ++sugSeq;
      let items = [];
      try { items = await api(`/api/suggest?q=${encodeURIComponent(q)}`); } catch (_) { return; }
      if (seq !== sugSeq || $('#q').value.trim() !== q) return;
      if (!items.length) { closeSuggest(); return; }
      sugIdx = -1;
      box.innerHTML = items.map((it, k) => `<div role="option" id="sug${k}" aria-selected="false" data-v="${esc(it.value)}"><span>${bdiAuto(it.label)}${it.g ? ` <small ${enAttr}>${esc(it.g)}</small>` : ''}</span><small>${t(`sug.${it.kind}`)}${it.n ? ' · ' + it.n : ''}</small></div>`).join('');
      box.hidden = false;
      $('#q').setAttribute('aria-expanded', 'true');
      $$('div', box).forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); runSearch(d.dataset.v, { replace: e.shiftKey }); }));
    }, 140);
  });
  $('#q').addEventListener('keydown', (e) => {
    const box = $('#suggest');
    const items = $$('div', box);
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((d, k) => { d.classList.toggle('act', k === sugIdx); d.setAttribute('aria-selected', k === sugIdx); });
      $('#q').setAttribute('aria-activedescendant', `sug${sugIdx}`);
    } else if (e.key === 'Enter' && sugIdx >= 0) {
      e.preventDefault(); runSearch(items[sugIdx].dataset.v, { replace: e.shiftKey });
    } else if (e.key === 'Escape') closeSuggest();
  });
  $('#q').addEventListener('blur', () => setTimeout(closeSuggest, 150));

  /* controls */
  // Enter adds a network; Shift+Enter (and a shift-click on the button or a suggestion) replaces the active one.
  // The mode / scope / size selects only set the next search: each network re-runs itself from its own header
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(null, { replace: !!S.shiftGo }); S.shiftGo = false; });
  $('.go').addEventListener('click', (e) => { S.shiftGo = e.shiftKey; });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey && $('#suggest').hidden) { e.preventDefault(); runSearch(null, { replace: true }); } });
  $$('#views button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  // tab lists: one tab stop each, arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern)
  function syncTabStops(list) { $$('[role="tab"]', list).forEach((t) => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; }); }
  $$('[role="tablist"]').forEach(syncTabStops);
  // delegated, so tab lists rendered later (the similar-ayat tabs in Details) work the same way
  document.addEventListener('keydown', (e) => {
    const list = e.target.closest && e.target.closest('[role="tablist"]');
    if (!list) return;
    const tabs = $$('[role="tab"]', list).filter((b) => !b.hidden), i = tabs.indexOf(e.target);
    if (i < 0) return;
    // the page is right-to-left: ArrowLeft goes to the next tab
    const rtl = getComputedStyle(list).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    const j = step ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); e.stopImmediatePropagation();
    tabs[j].focus(); tabs[j].click();
  });
  // phone layout: a tab opens the sheet; the open tab again lowers it
  $$('.side-tabs button').forEach((b) => b.addEventListener('click', () => {
    if (LAYOUT.phone() && sheet.state !== 'peek' && b.classList.contains('on')) { setSheet('peek'); return; }
    showTab(b.dataset.tab);
    raiseSheet();
  }));
  $$('#layoutSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.l)));
  $('#btnThemesOnly').addEventListener('click', () => {
    const on = !S.themesOnly;
    if (S.mode !== 'organized') setMode('organized').then(() => setThemesOnly(on)); else setThemesOnly(on);
  });
  $('#btnReorg').addEventListener('click', () => setMode(S.mode));
  $$('#edgeToggles input').forEach((c) => c.addEventListener('change', () => { S.edgeOn[c.dataset.edge] = c.checked; applyEdgeVisibility(); }));
  $('#xMode').addEventListener('change', (e) => { S.xMode = e.target.value; applyEdgeVisibility(); });
  $$('#colorBy button').forEach((b) => b.addEventListener('click', () => {
    S.colorBy = b.dataset.c;
    $$('#colorBy button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    recolor();
    if (S.data && S.view === 'search') { renderResults(S.data); if (S.selRoot) renderNodeTab({ keep: true }); }
  }));
  $('#lgToggle').addEventListener('click', () => {
    const closed = $('#legend').classList.toggle('closed');
    $('#lgToggle').setAttribute('aria-expanded', String(!closed));
    $('#stage').classList.toggle('with-legend', !closed);
    if (S.cy) S.cy.resize();
  });
  $('#btnFit').addEventListener('click', () => fit());
  $('#btnZoomIn').addEventListener('click', () => zoomBy(1.3));
  $('#btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.3));
  $('#btnLabels').addEventListener('click', () => cycleLabels());
  $('#sharedToggle').addEventListener('change', (e) => { S.showShared = e.target.checked; S.layer && S.layer.update(); emit('change'); });
  $('#rootPill').addEventListener('click', () => { if (!S.selRoot) return; showTab('node'); raiseSheet(); $('.side').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  $('#btnUnpin').addEventListener('click', unpinAll);
  $('#btnPng').addEventListener('click', () => {
    if (!S.cy) return;
    download(exportName('png'), S.cy.png({ full: true, scale: 2, bg: G.bg, output: 'blob', maxWidth: 8000, maxHeight: 8000 }));
  });
  $('#btnSvg').addEventListener('click', () => {
    if (!S.cy) return;
    const cy = S.cy, roots = cy.nodes('[kind="root"]'), all = cy.nodes();
    try {
      cy.batch(() => { roots.style('shape', 'diamond'); all.style('text-outline-width', 0); });
      download(exportName('svg'), new Blob([cy.svg({ full: true, bg: G.bg })], { type: 'image/svg+xml' }));
      if (S.mode !== 'organized') toast(t('toast.svgNote'));
    } catch (err) { toast(t('toast.svgFail', { e: err.message }), true); } finally {
      cy.batch(() => { roots.removeStyle('shape'); all.removeStyle('text-outline-width'); });
    }
  });
  $('#btnTheme').addEventListener('click', () => setTheme(themeName() === 'light' ? 'dark' : 'light'));
  $('#btnLang').addEventListener('click', () => setLang(L() === 'ar' ? 'en' : 'ar'));
  function toggleHelp(show = $('#help').hidden) {
    $('#help').hidden = !show;
    if (show) $('#helpClose').focus(); else $('#btnHelp').focus();
  }
  $('#btnHelp').addEventListener('click', () => toggleHelp());
  $('#helpClose').addEventListener('click', () => toggleHelp(false));

  /* ------------------------------------------------------------ phone layout */
  // html.phone (QR_LAYOUT in index.html, static/phone.css): the side panel is a bottom sheet over the canvas.
  // 'peek' shows its tabs, 'half' and 'full' the open tab. Opening a tab raises it, a tap on the empty
  // canvas lowers it; the handle drags it (and a tap on the handle opens / lowers it)
  const LAYOUT = window.QR_LAYOUT || { apply: () => false, phone: () => false };
  const sheet = { state: 'peek' };
  function sheetSizes() {
    const H = $('main').clientHeight, peek = $('.side-body').offsetTop;
    return { peek, half: Math.round(Math.max(peek + 140, H * 0.5)), full: H };
  }
  function setSheet(state = sheet.state) {
    const side = $('#side'), main = $('main');
    sheet.state = state;
    if (!LAYOUT.phone()) { side.style.height = ''; main.style.removeProperty('--peek'); return; }
    const z = sheetSizes(), was = main.style.getPropertyValue('--peek');
    main.style.setProperty('--peek', z.peek + 'px');
    side.style.height = z[state] + 'px';
    if (was !== z.peek + 'px' && S.cy) S.cy.resize();   // the canvas ends where the sheet's tabs begin
  }
  function raiseSheet() { if (LAYOUT.phone() && sheet.state === 'peek') setSheet('half'); }
  // a tapped node opens the sheet; if the sheet then covers it, the canvas slides it up into view
  function revealAboveSheet(n) {
    raiseSheet();
    setTimeout(() => {
      const cy = S.cy;
      if (!cy || n.removed() || !LAYOUT.phone()) return;
      const z = sheetSizes(), seen = $('#graph').clientHeight - ($('#side').offsetHeight - z.peek), y = n.renderedPosition().y;
      if (y > seen - 30 || y < 30) cy.animate({ panBy: { x: 0, y: Math.round(seen / 2 - y) } }, { duration: 260 });
    }, 240);
  }
  (() => {
    const h = $('#sheetHandle'), side = $('#side');
    let y0 = null, h0 = 0, moved = false;
    h.addEventListener('pointerdown', (e) => {
      y0 = e.clientY; h0 = side.offsetHeight; moved = false;
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = (e.clientY - y0) / pageZoom();
      if (!moved && Math.abs(dy) < 6) return;
      moved = true;
      const z = sheetSizes();
      side.classList.add('dragging');
      side.style.height = Math.min(z.full, Math.max(z.peek, h0 - dy)) + 'px';
    });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      side.classList.remove('dragging');
      if (!moved) { setSheet(sheet.state === 'peek' ? 'half' : 'peek'); return; }
      const z = sheetSizes(), now = side.offsetHeight;
      setSheet(['peek', 'half', 'full'].reduce((a, k) => (Math.abs(z[k] - now) < Math.abs(z[a] - now) ? k : a), 'peek'));
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheet.state === 'peek' ? 'half' : 'peek'); }
    });
  })();
  $('#btnOpts').addEventListener('click', () => {
    const open = $('#searchForm').classList.toggle('opts-open');
    $('#btnOpts').setAttribute('aria-expanded', String(open));
  });
  // small touch screens: the button switches between the phone layout and the full one (saved)
  const ICON_FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/></svg>';
  const ICON_PHONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>';
  function syncLayoutButton() {
    const b = $('#btnLayout'), phone = LAYOUT.phone();
    b.innerHTML = phone ? ICON_FULL : ICON_PHONE;
    b.title = t(phone ? 'layout.toFull' : 'layout.toPhone');
    b.setAttribute('aria-label', b.title);
  }
  function relayout() {
    LAYOUT.apply();
    setSheet();
    syncLayoutButton();
    if (S.cy) S.cy.resize();
  }
  $('#btnLayout').addEventListener('click', () => {
    try { localStorage.setItem('qr-layout', LAYOUT.phone() ? 'full' : 'phone'); } catch (_) { /* storage blocked */ }
    relayout();
  });
  syncLayoutButton();
  setSheet('peek');
  // the sheet's low height is its handle, the network switcher and the tabs: follow them when they change
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (!$('#side').classList.contains('dragging')) setSheet(); });
    ro.observe($('#switcher')); ro.observe($('.side-tabs'));
  }

  // install as an app (browser build): Chrome, Edge and Android have their own prompt
  // (beforeinstallprompt); Safari and every iPhone/iPad browser have none, so there the button shows the steps
  function installHelp(show) {
    $('#installHelp').hidden = !show;
    if (show) $('#installClose').focus(); else $('#btnInstall').focus();
  }
  if (WEB) {
    const b = $('#btnInstall'), ua = navigator.userAgent;
    const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox/.test(ua);
    let offer = null;
    // an installed app keeps its storage: ask the browser not to evict the ~130 MB of engine and model
    if (installed()) { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } else if (ios || macSafari) b.hidden = false;
    $('#installIos').hidden = !ios;
    $('#installMac').hidden = ios;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e; b.hidden = false; });
    window.addEventListener('appinstalled', () => { offer = null; b.hidden = true; installHelp(false); toast(t('install.done')); });
    b.addEventListener('click', async () => {
      if (!offer) { installHelp($('#installHelp').hidden); return; }
      const e = offer; offer = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome !== 'accepted') offer = null;
      b.hidden = true;
    });
    $('#installClose').addEventListener('click', () => installHelp(false));
  }
  $('#find').addEventListener('input', (e) => runFind(e.target.value));
  $('#find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.target.value = ''; runFind(''); $('#graph').focus(); }
  });
  $('#phraseFilter').addEventListener('input', (e) => {
    clearTimeout(phraseTimer);
    phraseTimer = setTimeout(() => loadPhrases(e.target.value.trim()), 200);
  });
  window.addEventListener('resize', () => {
    relayout();
    if (S.restIO && S.restIO.root !== restRoot()) observeRest();
  });
  // shrinking the window below the side-by-side width folds the legend away, as on a narrow first load
  matchMedia('(max-width: 1299px)').addEventListener('change', (e) => {
    if (e.matches && !$('#legend').classList.contains('closed')) $('#lgToggle').click();
  });
  // the URL hash belongs to the projects module (#p=…) when it is loaded; a bare #q=… link is a search only
  // without it (the module adds such a link's search to the open project itself)
  const projectsLoaded = () => !!(window.QR && window.QR.projects);
  window.addEventListener('popstate', () => {
    const h = readHash();
    if (!h || projectsLoaded()) return;
    applyParams(h);
    runSearch(h.q);
  });

  /* ------------------------------------------------------------ interface language */
  // the button names the language it switches to, in that language (EN / ع)
  function syncLangButton() {
    const b = $('#btnLang'), to = L() === 'ar' ? 'en' : 'ar';
    b.textContent = t('lang.btn'); b.lang = to;
    b.setAttribute('aria-label', t('lang.aria')); b.title = t('lang.aria');
    syncLayoutButton();
  }

  // switch the UI language in place: no reload, no new search. Static text comes from data-i18n
  // attributes; everything app.js renders is re-rendered keeping scroll positions, the selection,
  // the reader's place and the graph as laid out (only its labels change)
  function setLang(l) {
    if (l === L() || (l !== 'ar' && l !== 'en')) return;
    const sb = $('.side-body'), resOn = $('#tab-results').classList.contains('on');
    const anchor = resOn ? listAnchor() : null;
    I18N.setLang(l);
    syncLangButton();
    closeSuggest();
    renderExamples();
    renderColorKey();
    const cy = S.cy;
    if (cy) {
      cy.batch(() => {
        cy.nodes('[kind="theme"]').forEach((n) => n.data('label', themeLabel(n.data(), n.hasClass('collapsed'))));
        cy.nodes('[kind="sub"]').forEach((n) => n.data('label', subLabel(n.data())));
        cy.nodes('[kind="theme"].collapsed').forEach(sizeClosedBox);   // the names changed length
      });
      relabel();
      // closed boxes changed size, and a theme map's rows start on the reading side: re-place those networks
      // inside their own frames (nothing moves between networks; checked again when it runs, since a layout
      // queued before it may have left organised)
      const withClosed = () => allC().filter((C) => C.mode === 'organized' && !C.folded && !C.frozen && themesOf(C).filter('.collapsed').nonempty());
      if (withClosed().length) {
        S.modeChain = S.modeChain.then(() => {
          if (S.cy !== cy) return undefined;
          const Cs = withClosed();
          return Cs.length ? transition(Cs, async (X) => { ringPlace(X); placeBridges(X); restorePins(X); }, { doFit: false }) : undefined;
        }).catch((err) => console.error(err));
      }
      S.layer && S.layer.update();
      renderThemeList();
      refreshTooltip();
    }
    if (S.view === 'search' && S.data && cy) { renderResults(S.data); if (S.selRoot) renderNodeTab({ keep: true }); }
    else if (S.view === 'roots' && S.rootNet && cy) { renderRootList(S.rootNet); if (S.selRoot) renderNodeTab({ keep: true }); }
    if (S.view === 'phrases' && S.phrases) renderPhrases(S.phrases);
    if (anchor) restoreListAnchor(anchor); else if (resOn) sb.scrollTop = S.tabScroll.results || sb.scrollTop;
    // a detail page still loading renders in the new language when it lands; re-rendering the old one
    // now would cancel it (its sequence number) and leave Details on the previous ayah
    if (!S.detailBusy) relangDetail();
    const dist = $('#dist');
    if (dist && S.dist) drawDist(dist, ...S.dist);
  }

  function relangDetail() {
    const det = S.detail;
    if (!det || !$('#tab-detail .d-bar')) return;
    if (det.kind === 'ayah') showAyah(det.ref, { switchTab: false, phrase: det.phrase, relang: true });
    else showRoot(det.r, { relang: true });
  }

  // the first card visible in the results list and its offset, so a re-render can put it back in place
  function listAnchor() {
    const sb = $('.side-body'), scrolls = getComputedStyle(sb).overflowY === 'auto';
    const top = scrolls ? sb.getBoundingClientRect().top : 0;
    const c = $$('#tab-results .res').find((x) => x.getBoundingClientRect().bottom > top + 4);
    return c ? { i: c.dataset.i, off: c.getBoundingClientRect().top - top, scrolls } : { i: null, y: scrolls ? sb.scrollTop : window.scrollY, scrolls };
  }
  function restoreListAnchor(a) {
    const sb = $('.side-body');
    const c = a.i != null ? $(`#tab-results .res[data-i="${a.i}"]`) : null;
    if (!c) { if (a.y != null) { if (a.scrolls) sb.scrollTop = a.y; else window.scrollTo(0, a.y); } return; }
    const top = a.scrolls ? sb.getBoundingClientRect().top : 0;
    const d = (c.getBoundingClientRect().top - top - a.off) / pageZoom();
    if (a.scrolls) sb.scrollTop += d; else window.scrollBy(0, d);
  }

  let zoomGoal = null;
  function zoomBy(f) {
    if (!S.cy) return;
    const c = S.cy;
    zoomGoal = clamp((zoomGoal ?? c.zoom()) * f, c.minZoom(), c.maxZoom());   // repeated clicks add up
    c.stop();
    c.animate({ zoom: { level: zoomGoal, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } } },
      { duration: 200, complete: () => { zoomGoal = null; } });
  }

  /* keyboard shortcuts (ignored while typing). Letters are matched on the physical key (e.code), so the same keys
   * work on an Arabic layout; Shift gives the whole-workspace variant (fit all, fold all, re-organise all, { }) */
  function reorganiseAll() { allC().filter((C) => !C.frozen && !C.folded).forEach((C) => setMode(C.mode, { only: C })); }
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    const onControl = e.target.closest && e.target.closest('button, a, [role="button"], [role="tab"], [role="radio"], summary');
    const code = e.code || '', key = e.key, sh = e.shiftKey;
    if (key === 'Escape') {
      if (S.menu) { closeMenu(); return; }
      if (!$('#help').hidden) { toggleHelp(false); return; }
      if (!$('#installHelp').hidden) { installHelp(false); return; }
      if (typing) return;
      closeSwitcher();
      S.focusTheme = null; S.find = { matches: [], i: -1 }; $('#find').value = ''; $('#findCount').textContent = '';
      delete $('#findCount').dataset.i18n;
      $$('#tab-results .chip.form.on').forEach((x) => x.classList.remove('on'));
      if (S.cy) { S.cy.nodes('.match').removeClass('match'); S.cy.$(':selected').unselect(); }
      S.selected = null;
      releaseRoot();
      updateThemeListState(); refreshEmphasis();
      return;
    }
    if (!$('#help').hidden && key === '?' && !typing) { e.preventDefault(); toggleHelp(false); return; }
    if (typing || e.altKey || !S.cy || S.view === 'phrases' || !$('#help').hidden) return;
    // ⌘Z / Ctrl+Z: the last removal or refine comes back
    if ((e.metaKey || e.ctrlKey) && code === 'KeyZ' && !sh) { if (S.undo.length) { e.preventDefault(); undoLast(); } return; }
    if (e.metaKey || e.ctrlKey) return;
    // arrow keys scroll lists and panels; they walk the ayat only from the graph or the page itself
    if (key.startsWith('Arrow') && e.target !== document.body && !(e.target.closest && e.target.closest('#stage'))) return;
    if (onControl && (key === 'Enter' || key === ' ')) return;
    const sel = S.selected && S.cy.$id(S.selected), C = act();
    const byCode = {
      Digit1: () => !sh && setMode('organized'), Digit2: () => !sh && setMode('radial'), Digit3: () => !sh && setMode('free'),
      KeyF: () => (sh ? fit(true, { all: true }) : fit()),
      KeyL: () => !sh && cycleLabels(),
      KeyR: () => (sh ? reorganiseAll() : setMode(S.mode)),
      KeyT: () => (sh ? foldAll(true) : $('#btnThemesOnly').click()),
      KeyU: () => !sh && unpinAll(),
      KeyP: () => !sh && sel && sel.nonempty() && isLeaf(sel) && togglePin(sel),
      KeyC: () => !sh && S.focusTheme && toggleCollapse(S.focusTheme),
      KeyN: () => !sh && noteOn(sel && sel.nonempty() ? sel : C ? frameOf(C) : null),
      BracketRight: () => (sh ? navCluster(1) : navTheme(1)), BracketLeft: () => (sh ? navCluster(-1) : navTheme(-1)),
      Equal: () => zoomBy(1.3), NumpadAdd: () => zoomBy(1.3), Minus: () => zoomBy(1 / 1.3), NumpadSubtract: () => zoomBy(1 / 1.3),
      Slash: () => (sh ? toggleHelp() : $('#find').focus()),
      Delete: () => C && removeCluster(C), Backspace: () => C && removeCluster(C),
    };
    const byKey = {
      ArrowRight: () => navAyah(L() === 'ar' ? -1 : 1), ArrowLeft: () => navAyah(L() === 'ar' ? 1 : -1),
      ArrowDown: () => navAyah(1), ArrowUp: () => navAyah(-1),
      Enter: () => sel && sel.nonempty() && openNode(sel),
      '+': () => zoomBy(1.3), '-': () => zoomBy(1 / 1.3), '?': () => toggleHelp(), '/': () => $('#find').focus(),
      '{': () => navCluster(-1), '}': () => navCluster(1),
    };
    const fn = byCode[code] || byKey[key];
    if (fn) { e.preventDefault(); fn(); }
  });

  function applyParams(p) {
    // hash values are untrusted: compare with the option list instead of building selectors from them
    const pick = (sel, v) => { if (v && [...$(sel).options].some((o) => o.value === v)) $(sel).value = v; };
    pick('#mode', p.mode); pick('#scope', p.scope); pick('#n', p.n);
    $('#q').value = p.q || '';
  }

  if (window.innerWidth < 1300) {
    $('#legend').classList.add('closed');
    $('#lgToggle').setAttribute('aria-expanded', 'false');
  }
  function renderExamples() {
    // an English topic needs no English hint; in Arabic it says what it is
    $('#examples').innerHTML = EXAMPLES.map(([q, h]) => {
      const hint = h === 'ex.topicEn' && L() === 'en' ? '' : t(h);
      return `<button class="chip" data-q="${esc(q)}">${bdiAuto(q)}${hint ? ` <small>${hint}</small>` : ''}</button>`;
    }).join('');
    bindChips($('#examples'));
  }
  renderExamples();
  renderColorKey();
  setTheme(themeName(), false);
  syncLangButton();
  // with no saved choice, follow the system setting as it changes
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem('qr-theme'); } catch (_) { /* storage blocked */ }
      if (!saved) setTheme(e.matches ? 'light' : 'dark', false);
    });
  }

  // ★-relative positions of one network's leaves (and theme membership) under their local ids, for layout
  // regression checks against the single-graph app's dumps (the active network by default)
  function dump(cid = S.active) {
    const cy = S.cy, C = cid && S.clusters.get(cid);
    if (!cy || !C) return null;
    const q = qOf(C), o = q.nonempty() ? q.position() : { x: 0, y: 0 };
    const loc = (id) => (id ? localOf(id) : '');
    const rows = leavesOf(C).map((n) => {
      const p = n.position();
      return [loc(n.id()), Math.round(p.x - o.x), Math.round(p.y - o.y), loc(n.data('theme')), n.parent().nonempty() && n.parent().data('kind') !== 'cluster' ? loc(n.parent().id()) : ''];
    });
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { mode: C.mode, n: rows.length, themes: themesOf(C).length, rows };
  }
  window.__qr = { S, api, runSearch, addCluster, expandNode, setMode, focusTheme, toggleCollapse, runFind, selectNode, setTheme, setLang, declutter,
    selectRoot, showAyah, showRoot, activate, toggleFold, setFrozen, removeCluster, undoLast, cycleLabels, toggleFullText, branchFrom, refineCluster,
    fit, fitClusters, dump, act, allC, cl, ayahId, rootId, qId };  // console debugging + the test harness

  /* boot: wait for fonts so canvas labels shape Arabic with the right face */
  (async () => {
    try { await Promise.all([document.fonts.load('16px NotoNaskh', 'ص ب ر'), document.fonts.load('20px AmiriQuran', 'بِسْمِ')]); } catch (_) { /* fall back */ }
    const h = readHash();
    if (h && !projectsLoaded()) { applyParams(h); runSearch(h.q); }
  })();
})();

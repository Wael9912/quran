/* Quran Researcher — projects and notes (loaded after app.js; no build step)
 *
 * A project is everything on screen: the workspace (networks, positions, camera, settings; app.js owns it
 * and hands it over as JSON through window.QR.ws) plus the notes. Projects live in IndexedDB `qr-projects`
 * (store `projects`: meta + thumbnail; store `state`: the workspace JSON, gzipped when the browser can) and
 * save themselves 2 s after any change. Quran text is never stored: notes keep ayah indices, and the texts
 * shown here are fetched from the app's own corpus (/api/ayah).
 *
 * Contract with app.js (window.QR):
 *   QR.ws.serialize() → workspace JSON        QR.ws.restore(ws, {progress}) → Promise
 *   QR.ws.clear()                             QR.ws.thumbnail() → data URL (≤ 240 px)
 *   QR.ws.summary() → {clusters, notes, title}
 *   QR.on(event, fn) / QR.emit(event, …): events `change`, `camera`, `cluster:add|remove|rename|freeze`
 *   (payload {cid, params}), `notes:change` ({key, text}).
 * This file provides QR.notes (the notes model, B5) and QR.projects, and falls back to a «legacy adapter»
 * when app.js has no QR.ws yet (one search = one network; the current search is what a project remembers).
 * window.QR_MOCK = true (tests only) wraps that adapter in a mock QR.ws so the workspace-mode paths run.
 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { t } = window.I18N;
  const L = () => window.I18N.lang;
  const isAr = (s) => /[؀-ۿ]/.test(String(s || ''));
  const bdi = (s) => (isAr(s) ? `<bdi lang="ar" dir="rtl">${esc(s)}</bdi>` : `<bdi lang="en" dir="ltr">${esc(s)}</bdi>`);
  const qr = () => window.__qr || null;
  const state = () => (qr() ? qr().S : null);

  /* ------------------------------------------------------------ event bus (shared with app.js when it has one) */
  const QR = (window.QR = window.QR || {});
  const subs = new Map();
  const busOn = (ev, fn) => {
    if (!subs.has(ev)) subs.set(ev, []);
    subs.get(ev).push(fn);
    return () => { const l = subs.get(ev) || []; const k = l.indexOf(fn); if (k >= 0) l.splice(k, 1); };
  };
  const busEmit = (ev, ...a) => { (subs.get(ev) || []).slice().forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); };
  if (typeof QR.on !== 'function') QR.on = busOn;
  if (typeof QR.emit !== 'function') QR.emit = busEmit;
  // our own events reach both registries (app.js's and ours); workspace events are subscribed through QR.on
  const emit = (ev, ...a) => { if (QR.emit !== busEmit) { try { QR.emit(ev, ...a); } catch (e) { console.error(e); } } busEmit(ev, ...a); };

  /* ------------------------------------------------------------ ayah index ↔ reference (Mushaf order, 6236) */
  const AYAS = [7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
    34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
    28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6];
  const START = [];
  { let s = 0; AYAS.forEach((n, k) => { START[k] = s; s += n; }); }
  const N_AYAT = 6236;
  const refOf = (i) => {
    i = +i;
    if (!(i >= 0 && i < N_AYAT)) return null;
    let s = 0;
    while (s < 113 && START[s + 1] <= i) s++;
    return `${s + 1}:${i - START[s] + 1}`;
  };
  const idxOf = (ref) => {
    const m = /^(\d{1,3}):(\d{1,3})$/.exec(String(ref || '').trim());
    if (!m) return null;
    const s = +m[1], a = +m[2];
    return s >= 1 && s <= 114 && a >= 1 && a <= AYAS[s - 1] ? START[s - 1] + a - 1 : null;
  };
  // node ids: 'a:120' (one graph) or 'c3:a:120' (workspace); roots 'r:صبر' / 'c3:r:صبر'; the ★ 'q' / 'c3:q'
  const ayahIdx = (id) => { const m = /(?:^|:)a:(\d+)$/.exec(String(id || '')); return m ? +m[1] : null; };
  const cidOf = (id) => { const m = /^(c\d+)(?::|$)/.exec(String(id || '')); return m ? m[1] : null; };

  /* ------------------------------------------------------------ small UI helpers */
  function toast(msg, isErr = false) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 5000 : 2600);
  }
  // a toast with one action (undo); the action runs once, then the toast goes
  function actionToast(msg, label, fn, ms = 8000) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.pointerEvents = 'auto';
    el.innerHTML = `${esc(msg)} <button type="button" class="linkbtn">${esc(label)}</button>`;
    $('button', el).addEventListener('click', () => { el.remove(); try { fn(); } catch (e) { console.error(e); } });
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const fileName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'project';
  const trim = (s, n) => {
    s = String(s || '');
    if (s.length <= n) return s;
    const cut = s.lastIndexOf(' ', n);
    return `${cut > 0 ? s.slice(0, cut) : s.split(' ')[0]} …`;
  };
  function relDate(ts) {
    const d = (ts - Date.now()) / 1000, abs = Math.abs(d);
    const rtf = new Intl.RelativeTimeFormat(L() === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
    if (abs < 60) return rtf.format(Math.round(d), 'second');
    if (abs < 3600) return rtf.format(Math.round(d / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(d / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(d / 86400), 'day');
    return new Date(ts).toLocaleDateString(L() === 'ar' ? 'ar-EG' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  // the ayah's details from the app's cache or its API (text, translation, surah name)
  const ayahCache = new Map();
  async function getAyah(ref) {
    const S = state();
    if (S && S.ayahCache && S.ayahCache.has(ref)) return S.ayahCache.get(ref);
    if (ayahCache.has(ref)) return ayahCache.get(ref);
    const d = await qr().api(`/api/ayah/${ref}`);
    ayahCache.set(ref, d);
    if (S && S.ayahCache) S.ayahCache.set(ref, d);
    return d;
  }

  /* ------------------------------------------------------------ notes model (QR.notes) */
  // one note per item; ayah / root / word notes belong to the project (the same note in every network)
  const KINDS = ['ayah', 'root', 'word', 'cluster'];
  const blankNotes = () => ({ project: '', ayah: {}, root: {}, word: {}, cluster: {} });
  const ND = { d: blankNotes() };
  const NOTE_MAX = 20000;
  const parseKey = (key) => {
    if (key === 'project') return { kind: 'project', id: '' };
    const m = /^(ayah|root|word|cluster):(.+)$/.exec(String(key || ''));
    return m ? { kind: m[1], id: m[2] } : null;
  };
  const cleanNotes = (obj) => {
    const out = blankNotes();
    if (!obj || typeof obj !== 'object') return out;
    if (typeof obj.project === 'string') out.project = obj.project.slice(0, NOTE_MAX);
    for (const k of KINDS) {
      const src = obj[k];
      if (!src || typeof src !== 'object') continue;
      for (const [id, text] of Object.entries(src)) {
        if (typeof text === 'string' && text.trim() && id.length <= 200) out[k][id] = text.slice(0, NOTE_MAX);
      }
    }
    return out;
  };
  const notes = {
    get(key) {
      const k = parseKey(key);
      if (!k) return '';
      return k.kind === 'project' ? ND.d.project || '' : ND.d[k.kind][k.id] || '';
    },
    has(key) { return !!notes.get(key).trim(); },
    set(key, text) {
      const k = parseKey(key);
      if (!k) return false;
      text = String(text ?? '').replace(/\r\n?/g, '\n').slice(0, NOTE_MAX);
      const keep = text.trim() ? text : '';
      if (k.kind === 'project') { if ((ND.d.project || '') === keep) return true; ND.d.project = keep; }
      else if (keep) { if (ND.d[k.kind][k.id] === keep) return true; ND.d[k.kind][k.id] = keep; }
      else { if (!(k.id in ND.d[k.kind])) return true; delete ND.d[k.kind][k.id]; }
      noteChanged(key, keep);
      return true;
    },
    all() {
      const out = [];
      if (ND.d.project) out.push({ key: 'project', kind: 'project', id: '', text: ND.d.project });
      for (const k of KINDS) for (const [id, text] of Object.entries(ND.d[k])) out.push({ key: `${k}:${id}`, kind: k, id, text });
      return out;
    },
    count() { return KINDS.reduce((n, k) => n + Object.keys(ND.d[k]).length, 0) + (ND.d.project ? 1 : 0); },
    // the note key of a graph node's data (ayah / root / lemma box / the ★ or frame of a network)
    keyFor(d) {
      if (!d) return null;
      if (d.kind === 'ayah') { const i = ayahIdx(d.id) ?? (d.ref ? idxOf(d.ref) : null); return i != null ? `ayah:${i}` : null; }
      if (d.kind === 'root') return d.root ? `root:${d.root}` : null;
      if (d.lemma) return `word:${d.lemma}`;
      if (d.kind === 'query' || d.kind === 'cluster') return `cluster:${d.cid || cidOf(d.id) || 'q'}`;
      return null;
    },
    onChange: (fn) => busOn('notes:change', fn),
    load(obj) { ND.d = cleanNotes(obj); refreshNotesUI(); syncNoted(); },
    dump() { return JSON.parse(JSON.stringify(ND.d)); },
    parseKey, refOf, idxOf, ayahIdx,
    titleFor, mountEditor, quickNote, syncNoted,
    exportMarkdown: exportNotesMarkdown,
  };
  QR.notes = notes;

  function noteChanged(key, text) {
    emit('notes:change', { key, text });
    syncNoted(key);
    refreshNotesUI();
    scheduleSave();
  }

  // `noted` on the graph nodes of an item, so app.js can draw its ✎ badge (node[?noted]); results cards get .noted
  function syncNoted(onlyKey = null) {
    const S = state();
    const cy = S && S.cy;
    if (cy) {
      try {
        cy.batch(() => {
          cy.nodes().forEach((n) => {
            const key = notes.keyFor(n.data());
            if (!key || (onlyKey && key !== onlyKey)) return;
            const on = notes.has(key);
            if (!!n.data('noted') !== on) n.data('noted', on);
          });
        });
      } catch (e) { console.error(e); }
    }
    $$('.side-body .res[data-i]').forEach((c) => c.classList.toggle('noted', notes.has(`ayah:${c.dataset.i}`)));
  }
  // cards rendered later (new searches, pages) get their mark too
  const cardObserver = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      const cards = n.matches && n.matches('.res[data-i]') ? [n] : $$('.res[data-i]', n);
      cards.forEach((c) => c.classList.toggle('noted', notes.has(`ayah:${c.dataset.i}`)));
    });
  });

  function titleFor(key) {
    const k = parseKey(key);
    if (!k) return '';
    if (k.kind === 'project') return t('nt.project');
    if (k.kind === 'ayah') return t('nt.onAyah', { ref: refOf(k.id) || k.id });
    if (k.kind === 'root') return t('nt.onRoot', { r: bdi(k.id) });
    if (k.kind === 'word') return t('nt.onWord', { w: bdi(k.id.split('|')[0]) });
    return t('nt.onNet', { q: bdi(clusterQuery(k.id)) });
  }
  function clusterQuery(cid) {
    const S = state();
    if (!S) return cid;
    const C = S.clusters && S.clusters.get ? S.clusters.get(cid) : null;
    if (C) return (C.title || (C.params && C.params.q) || (C.data && C.data.query && C.data.query.q) || cid);
    return S.data && S.data.query ? S.data.query.q : cid;
  }

  /* ------------------------------------------------------------ note editor (Details, Notes tab, quick note) */
  const REF_RE = /\b(\d{1,3}):(\d{1,3})\b/g;
  function renderRefs(ed, text) {
    const box = $('.note-refs', ed);
    const refs = [...new Set((String(text).match(REF_RE) || []).filter((r) => idxOf(r) != null))];
    box.hidden = !refs.length;
    box.innerHTML = refs.length ? `<span>${t('nt.refs')}</span>${refs.map((r) => `<button type="button" data-ref="${r}">${r}</button>`).join('')}<span class="note-esc">${t('nt.esc')}</span>` : '';
    $$('button[data-ref]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openAyah(idxOf(b.dataset.ref), b.dataset.ref); }));
  }
  function flash(el, txt) {
    el.textContent = txt;
    el.classList.remove('fade');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('fade'), 1200);
  }
  // mountEditor(container, key, {title, autofocus}) → the editor element; app.js calls it under the translation
  function mountEditor(container, key, { title = '', autofocus = false } = {}) {
    const k = parseKey(key);
    if (!container || !k) return null;
    const label = title || (k.kind === 'project' ? t('nt.project') : t('nt.label'));
    const ed = document.createElement('section');
    ed.className = 'note-ed';
    ed.dataset.key = key;
    ed.innerHTML = `<div class="note-head"><span class="note-label">${esc(label)}</span><span class="note-status" aria-live="polite"></span>
        <button type="button" class="note-del" hidden>${t('nt.delete')}</button></div>
      <textarea class="note-ta" dir="auto" rows="2" placeholder="${esc(k.kind === 'project' ? t('nt.projectPh') : t('nt.ph'))}" aria-label="${esc(label)}"></textarea>
      <div class="note-refs" hidden></div>`;
    const ta = $('.note-ta', ed), del = $('.note-del', ed), st = $('.note-status', ed);
    ta.value = notes.get(key);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(320, ta.scrollHeight + 2)}px`; };
    let timer = 0, last = ta.value;
    const commit = () => {
      if (ta.value === last) return;
      last = ta.value;
      notes.set(key, ta.value);
      flash(st, t('nt.saved'));
      renderRefs(ed, ta.value);
      del.hidden = !ta.value.trim();
    };
    ta.addEventListener('input', () => { grow(); clearTimeout(timer); timer = setTimeout(commit, 400); });
    ta.addEventListener('blur', () => { clearTimeout(timer); commit(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();   // the app's shortcuts (N, arrows, 1/2/3…) never fire while writing a note
      if (e.key === 'Escape') { e.preventDefault(); clearTimeout(timer); commit(); ta.blur(); const g = $('#graph'); if (g) g.focus(); }
    });
    del.addEventListener('click', () => { ta.value = ''; commit(); grow(); ta.focus(); });
    renderRefs(ed, ta.value);
    del.hidden = !ta.value.trim();
    container.appendChild(ed);
    grow();
    if (autofocus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return ed;
  }
  // N / «ملاحظة»: the editor of that item in Details (its own when Details shows it, else a card on top)
  function quickNote(key) {
    const k = parseKey(key);
    if (!k) return null;
    const tab = $('#tabbtn-detail');
    if (tab) tab.click();
    const det = $('#tab-detail');
    if (!det) return null;
    let ed = $$('.note-ed', det).find((e) => e.dataset.key === key);
    if (!ed) {
      $$('.nt-quick', det).forEach((q) => q.remove());
      const card = document.createElement('div');
      card.className = 'nt-quick';
      card.innerHTML = `<div class="nt-quick-head">${titleFor(key)}</div>`;
      const bar = $('.d-bar', det);
      if (bar) bar.after(card); else det.prepend(card);
      ed = mountEditor(card, key, { autofocus: true });
    } else $('.note-ta', ed).focus();
    return ed;
  }

  /* ------------------------------------------------------------ opening items from notes */
  function openAyah(i, ref) {
    const S = state(), q = qr();
    if (!q) return;
    ref = ref || refOf(i);
    if (S && S.cy) {
      const act = S.active || null;
      const nodes = S.cy.nodes('[kind="ayah"]').filter((n) => ayahIdx(n.id()) === i);
      const n = (act ? nodes.filter((x) => x.data('cid') === act) : nodes)[0] || nodes[0];
      if (n) { q.selectNode(n.id(), { center: true }); return; }
    }
    if (typeof q.showAyah === 'function') q.showAyah(ref);
    else quickNote(`ayah:${i}`);
  }
  function openRoot(r) {
    const q = qr();
    if (!q) return;
    if (typeof q.selectRoot === 'function') q.selectRoot(r); else quickNote(`root:${r}`);
  }
  function openWord(l) {
    const S = state(), q = qr();
    if (S && S.cy && q) {
      const box = S.cy.nodes().filter((n) => n.data('lemma') === l)[0];
      if (box && typeof q.focusTheme === 'function') { q.focusTheme(box.id(), { center: true }); return; }
    }
    quickNote(`word:${l}`);
  }
  function openCluster(cid) {
    const S = state(), q = qr();
    if (QR.ws && typeof QR.ws.activate === 'function') { QR.ws.activate(cid); return; }
    if (S && S.cy && q) {
      const star = S.cy.nodes('[kind="query"]').filter((n) => (n.data('cid') || cidOf(n.id()) || 'q') === cid)[0];
      if (star) { q.selectNode(star.id(), { center: true, open: false }); return; }
    }
    quickNote(`cluster:${cid}`);
  }

  /* ------------------------------------------------------------ notes tab */
  let ntFilter = 'all';
  const ntVisible = () => { const el = $('#tab-notes'); return !!el && el.classList.contains('on'); };
  function refreshNotesUI() {
    const badge = $('#tabbtn-notes .nt-badge');
    if (badge) { const n = notes.count(); badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
    if (ntVisible()) renderNotesTab();
    renderChip();
  }
  // what the active network holds, for the «هذه الشبكة» filter
  function activeScope() {
    const S = state();
    if (!S || !S.cy) return null;
    const cid = S.active || null;
    const nodes = cid ? S.cy.nodes().filter((n) => n.data('cid') === cid) : S.cy.nodes();
    const ayat = new Set(), roots = new Set(), words = new Set();
    nodes.forEach((n) => {
      const d = n.data();
      if (d.kind === 'ayah') { const i = ayahIdx(n.id()); if (i != null) ayat.add(i); }
      else if (d.kind === 'root' && d.root) roots.add(d.root);
      else if (d.lemma) words.add(d.lemma);
    });
    return { cid: cid || 'q', ayat, roots, words };
  }
  function renderNotesTab() {
    const el = $('#tab-notes');
    if (!el) return;
    const sb = $('.side-body'), top = sb ? sb.scrollTop : 0;
    // the project note's editor survives a re-render (its own typing triggers one): keep the element,
    // and put the caret back where it was
    const keepEd = $('#ntProject .note-ed', el);
    const keepTa = keepEd && $('.note-ta', keepEd);
    const hadFocus = !!keepTa && document.activeElement === keepTa;
    const sel = hadFocus ? [keepTa.selectionStart, keepTa.selectionEnd] : null;
    const all = notes.all().filter((n) => n.kind !== 'project');
    const scope = ntFilter === 'net' ? activeScope() : null;
    const inScope = (n) => !scope || (n.kind === 'ayah' ? scope.ayat.has(+n.id) : n.kind === 'root' ? scope.roots.has(n.id)
      : n.kind === 'word' ? scope.words.has(n.id) : n.id === scope.cid);
    const shown = all.filter(inScope);
    const by = (k) => shown.filter((n) => n.kind === k);
    const ayat = by('ayah').sort((a, b) => +a.id - +b.id);
    const sec = (title, items, row) => (items.length ? `<section class="nt-sec"><h4>${title} <small>${items.length}</small></h4>${items.map(row).join('')}</section>` : '');
    const item = (n, body, what) => `<div class="nt-item" role="button" tabindex="0" data-key="${esc(n.key)}" title="${esc(t('nt.openT', { what }))}">${body}
        <button type="button" class="nt-edit" data-key="${esc(n.key)}" title="${esc(t('nt.label'))}" aria-label="${esc(t('nt.label'))}">✎</button>
        <div class="nt-text">${esc(n.text)}</div></div>`;
    el.innerHTML = `<div class="nt-wrap">
      <div class="nt-project" id="ntProject"></div>
      <div class="nt-top"><div class="seg" role="radiogroup" aria-label="${esc(t('nt.filterAria'))}">
        <button type="button" data-f="net" class="${ntFilter === 'net' ? 'on' : ''}" role="radio" aria-checked="${ntFilter === 'net'}">${t('nt.thisNet')}</button>
        <button type="button" data-f="all" class="${ntFilter === 'all' ? 'on' : ''}" role="radio" aria-checked="${ntFilter === 'all'}">${t('nt.whole')}</button></div>
        <button type="button" class="btn nt-export"${notes.count() ? '' : ' disabled'}>${t('nt.export')}</button></div>
      ${sec(t('nt.ayat'), ayat, (n) => item(n, `<div class="nt-ref" data-ref="${refOf(n.id) || ''}">${esc(refOf(n.id) || n.id)}</div><div class="nt-ar" lang="ar"></div>`, refOf(n.id) || ''))}
      ${sec(t('nt.roots'), by('root'), (n) => item(n, `<div class="nt-word" lang="ar">${esc(n.id)}</div>`, n.id))}
      ${sec(t('nt.words'), by('word'), (n) => item(n, `<div class="nt-word" lang="ar">${esc(n.id.split('|')[0])}</div>`, n.id.split('|')[0]))}
      ${sec(t('nt.nets'), by('cluster'), (n) => item(n, `<div class="nt-net">★ ${bdi(clusterQuery(n.id))}</div>`, clusterQuery(n.id)))}
      ${!shown.length ? `<div class="nt-empty">${all.length ? t('nt.emptyNet') : t('nt.empty')}</div>` : ''}
    </div>`;
    if (keepEd) {
      $('#ntProject', el).appendChild(keepEd);
      if (hadFocus) { keepTa.focus({ preventScroll: true }); keepTa.setSelectionRange(sel[0], sel[1]); }
    } else mountEditor($('#ntProject', el), 'project');
    $$('.seg button', el).forEach((b) => b.addEventListener('click', () => { ntFilter = b.dataset.f; renderNotesTab(); }));
    $('.nt-export', el).addEventListener('click', () => exportNotesMarkdown().catch((e) => toast(t('toast.err', { e: e.message }), true)));
    $$('.nt-item', el).forEach((it) => {
      const open = () => {
        const k = parseKey(it.dataset.key);
        if (k.kind === 'ayah') openAyah(+k.id); else if (k.kind === 'root') openRoot(k.id); else if (k.kind === 'word') openWord(k.id); else openCluster(k.id);
      };
      it.addEventListener('click', (e) => { if (e.target.closest('.nt-edit')) return; open(); });
      it.addEventListener('keydown', (e) => { if (e.target === it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
    });
    $$('.nt-edit', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); quickNote(b.dataset.key); }));
    // the ayah texts come from the corpus, never from the note
    ayat.forEach(async (n) => {
      const ref = refOf(n.id);
      if (!ref) return;
      try {
        const d = await getAyah(ref);
        const row = $(`.nt-item[data-key="ayah:${n.id}"]`, el);
        if (!row) return;
        $('.nt-ar', row).textContent = trim(d.text, 120);
        $('.nt-ref', row).innerHTML = `${esc(ref)} · <span class="sname">${esc(d.surah.name)}</span>`;
      } catch (_) { /* stays without its text */ }
    });
    if (sb && ntVisible()) sb.scrollTop = top;
  }
  async function exportNotesMarkdown() {
    const all = notes.all();
    const name = (P.cur && P.cur.name) || t('pj.untitled');
    const lines = [`# ${t('nt.mdTitle', { name })}`, '', `_${t('nt.mdSrc')}_`, ''];
    if (ND.d.project) lines.push(`## ${t('nt.project')}`, '', ND.d.project, '');
    const ayat = all.filter((n) => n.kind === 'ayah').sort((a, b) => +a.id - +b.id);
    if (ayat.length) {
      lines.push(`## ${t('nt.ayat')}`, '');
      for (const n of ayat) {
        const ref = refOf(n.id);
        let d = null;
        try { d = await getAyah(ref); } catch (_) { /* no text */ }
        lines.push(`### ${ref}${d ? ` · ${d.surah.name}` : ''}`, '');
        if (d) lines.push(`> ${d.text}`, '', `> ${d.en}`, '');
        lines.push(n.text, '');
      }
    }
    const simple = (kind, title, show) => {
      const items = all.filter((n) => n.kind === kind);
      if (!items.length) return;
      lines.push(`## ${title}`, '');
      items.forEach((n) => lines.push(`### ${show(n.id)}`, '', n.text, ''));
    };
    simple('root', t('nt.roots'), (id) => id);
    simple('word', t('nt.words'), (id) => id.split('|')[0]);
    simple('cluster', t('nt.nets'), (id) => clusterQuery(id));
    download(`quran-notes-${fileName(name)}.md`, new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  }

  /* ------------------------------------------------------------ IndexedDB */
  const DB_NAME = 'qr-projects', DB_VER = 1;
  let dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(DB_NAME, DB_VER); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'id' });
      };
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
      r.onerror = () => rej(r.error || new Error('indexedDB'));
      r.onblocked = () => rej(new Error('indexedDB blocked'));
    });
    dbP.catch(() => { dbP = null; });
    return dbP;
  }
  const dbOp = (store, mode, fn) => db().then((d) => new Promise((res, rej) => {
    const x = d.transaction(store, mode);
    const req = fn(x.objectStore(store));
    x.oncomplete = () => res(req ? req.result : undefined);
    x.onerror = () => rej(x.error || new Error('transaction'));
    x.onabort = () => rej(x.error || new Error('aborted'));
  }));
  const dbGet = (store, id) => dbOp(store, 'readonly', (s) => s.get(id));
  const dbAll = (store) => dbOp(store, 'readonly', (s) => s.getAll());
  const dbPut = (store, obj) => dbOp(store, 'readwrite', (s) => s.put(obj));
  const dbDel = (store, id) => dbOp(store, 'readwrite', (s) => s.delete(id));

  // the workspace JSON is stored gzipped when the browser can (a graph of every match is a few MB as text)
  async function pack(str) {
    if (typeof CompressionStream === 'function') {
      try {
        const buf = await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        return { gz: true, buf };
      } catch (_) { /* store plain */ }
    }
    return { gz: false, str };
  }
  async function unpack(rec) {
    if (!rec) return null;
    if (rec.gz && rec.buf) return new Response(new Blob([rec.buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return rec.str ?? null;
  }

  /* ------------------------------------------------------------ projects */
  const P = { cur: null, status: 'saved', timer: 0, saving: null, pending: false, thumbAt: 0, dirty: false,
    tab: Math.random().toString(36).slice(2), booted: false, lastHello: 0 };
  const LAST_KEY = 'qr-project-last';
  const wsMode = () => !!(QR.ws && typeof QR.ws.serialize === 'function');
  const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  let bc = null;
  try { bc = new BroadcastChannel('qr-projects'); } catch (_) { bc = null; }

  function legacySnapshot() {
    const S = state();
    const d = S && S.data;
    return { v: 1, ui: {}, clusters: [],
      legacy: d && d.query ? { q: d.query.q, mode: d._mode || 'auto', scope: ($('#scope') || {}).value || 'all', n: ($('#n') || {}).value || '60' } : null };
  }
  function legacyParams(lg) {
    const pick = (sel, v) => { const el = $(sel); if (el && v && [...el.options].some((o) => o.value === v)) el.value = v; };
    pick('#mode', lg.mode); pick('#scope', lg.scope); pick('#n', lg.n);
  }
  function legacyClear() {
    const S = state();
    if (!S) return;
    // app.js clears its graph on a popstate without a query (readHash → null)
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* no history */ }
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  async function legacyRestore(ws) {
    const lg = ws && ws.legacy;
    const q = qr();
    if (!q) return;
    if (lg && lg.q) { legacyParams(lg); await q.runSearch(lg.q, { push: false }); } else legacyClear();
  }
  function snapshot() {
    let ws = null;
    try { ws = wsMode() ? QR.ws.serialize() : legacySnapshot(); } catch (e) { console.error('serialize', e); }
    if (!ws || typeof ws !== 'object') ws = { v: 1 };
    ws.v = ws.v || 1;
    ws.notes = notes.dump();
    return ws;
  }
  function summaryOf(ws) {
    let s = null;
    if (wsMode() && typeof QR.ws.summary === 'function') { try { s = QR.ws.summary(); } catch (_) { s = null; } }
    const clusters = s && Number.isFinite(s.clusters) ? s.clusters : (ws.clusters && ws.clusters.length) || (ws.legacy ? 1 : 0);
    return { clusters, notes: notes.count() };
  }
  function thumbnail() {
    try {
      if (wsMode() && typeof QR.ws.thumbnail === 'function') return QR.ws.thumbnail() || null;
      const S = state(), cy = S && S.cy;
      if (!cy || !cy.nodes().length) return null;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#0f141c';
      return cy.png({ full: true, maxWidth: 240, maxHeight: 150, bg, output: 'base64uri' });
    } catch (_) { return null; }
  }
  async function applySnapshot(ws) {
    if (wsMode() && typeof QR.ws.restore === 'function') await QR.ws.restore(ws || { v: 1, clusters: [] }, { progress() {} });
    else await legacyRestore(ws);
  }
  function clearWorkspace() {
    try {
      if (QR.ws && typeof QR.ws.clear === 'function') QR.ws.clear(); else legacyClear();
    } catch (e) { console.error(e); }
  }

  const setStatus = (s) => { P.status = s; renderStatus(); };
  function scheduleSave() {
    P.dirty = true;
    if (!P.cur) { ensureProject().then(() => scheduleSave()).catch((e) => { console.error(e); setStatus('error'); }); return; }
    clearTimeout(P.timer);
    P.timer = setTimeout(() => saveNow(), 2000);
  }
  async function saveNow(opts = {}) {
    if (!P.cur) return null;
    if (P.saving) { P.pending = true; return P.saving; }
    clearTimeout(P.timer); P.timer = 0;
    const meta = P.cur;
    const edited = P.dirty;   // «عُدّل» moves only when something changed, not on a thumbnail refresh or a leave
    setStatus('saving');
    P.saving = (async () => {
      const ws = snapshot();
      const sum = summaryOf(ws);
      const now = Date.now();
      let thumb = meta.thumb || null;
      if (opts.thumb || now - P.thumbAt > 60000) { const th = thumbnail(); if (th) { thumb = th; P.thumbAt = now; } }
      const rec = await pack(JSON.stringify(ws));
      await dbPut('state', { id: meta.id, ...rec });
      Object.assign(meta, { updated: edited ? now : meta.updated || now, thumb, counts: sum });
      await dbPut('projects', { ...meta });
      P.dirty = false;
      if (bc) bc.postMessage({ type: 'list', tab: P.tab });
    })().then(() => { if (P.status !== 'other') setStatus('saved'); }, (e) => { console.error('save', e); setStatus('error'); })
      .finally(() => { P.saving = null; if (P.pending) { P.pending = false; scheduleSave(); } renderChip(); });
    return P.saving;
  }
  let creating = null;
  function ensureProject() {
    if (P.cur) return Promise.resolve(P.cur);
    if (creating) return creating;
    creating = (async () => {
      const meta = { id: newId(), name: '', created: Date.now(), updated: Date.now(), thumb: null, counts: { clusters: 0, notes: 0 } };
      P.cur = meta;
      P.thumbAt = 0;
      await dbPut('projects', { ...meta });
      remember(meta.id);
      setHash(meta.id, false);
      hello();
      renderChip();
      return meta;
    })().finally(() => { creating = null; });
    return creating;
  }
  function remember(id) { try { if (id) localStorage.setItem(LAST_KEY, id); else localStorage.removeItem(LAST_KEY); } catch (_) { /* blocked */ } }
  async function leaveCurrent() {
    if (!P.cur) return;
    clearTimeout(P.timer);
    try { await saveNow({ thumb: true }); } catch (_) { /* reported by the status */ }
  }
  async function newProject() {
    await leaveCurrent();
    clearWorkspace();
    notes.load(null);
    const meta = { id: newId(), name: '', created: Date.now(), updated: Date.now(), thumb: null, counts: { clusters: 0, notes: 0 } };
    P.cur = meta; P.thumbAt = 0; P.dirty = false;
    await dbPut('state', { id: meta.id, gz: false, str: JSON.stringify({ v: 1, ui: {}, clusters: [], notes: blankNotes() }) });
    await dbPut('projects', { ...meta });
    remember(meta.id);
    setHash(meta.id, true);
    hello();
    setStatus('saved');
    renderChip();
    refreshNotesUI();
    if (!document.documentElement.classList.contains('phone')) renameInline();
    return meta;
  }
  async function openProject(id, { push = true, restore = true } = {}) {
    if (P.cur && P.cur.id === id) return P.cur;
    const meta = await dbGet('projects', id);
    if (!meta) throw new Error(`no project ${id}`);
    await leaveCurrent();
    const txt = await unpack(await dbGet('state', id));
    let ws = null;
    try { ws = txt ? JSON.parse(txt) : null; } catch (_) { ws = null; }
    P.cur = meta; P.thumbAt = 0; P.dirty = false;
    notes.load(ws && ws.notes);
    remember(id);
    setStatus('saved');
    renderChip();
    setHash(id, push);
    hello();
    if (restore) {
      try { await applySnapshot(ws); } catch (e) { console.error(e); toast(t('pj.openFail', { e: e.message }), true); }
    }
    syncNoted();
    refreshNotesUI();
    return meta;
  }
  // a project nobody named takes the words of its first search; a name the user typed is never replaced
  const autoName = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function nameFromSearch(q) {
    const name = autoName(q);
    if (!name) return;
    ensureProject().then((meta) => { if (P.cur === meta && !meta.name) return renameProject(meta.id, name); }).catch((e) => console.error(e));
  }
  // projects saved untitled before that: named once from their first network
  async function nameUntitled() {
    let changed = false;
    for (const m of await listProjects()) {
      if (m.name) continue;
      try {
        const txt = await unpack(await dbGet('state', m.id));
        const ws = txt ? JSON.parse(txt) : null;
        const c = ws && Array.isArray(ws.clusters) ? ws.clusters.find((x) => x && x.params && x.params.q) : null;
        const name = autoName(c ? c.params.q : ws && ws.legacy && ws.legacy.q);
        if (!name) continue;
        const cur = P.cur && P.cur.id === m.id ? P.cur : null;
        if (cur && cur.name) continue;
        await dbPut('projects', { ...m, name });   // «edited» stays: naming is not an edit
        if (cur) cur.name = name;
        changed = true;
      } catch (e) { console.error(e); }
    }
    if (!changed) return;
    if (bc) bc.postMessage({ type: 'list', tab: P.tab });
    renderChip();
    renderPopover();
  }
  async function renameProject(id, name) {
    name = String(name || '').trim().slice(0, 120);
    const meta = P.cur && P.cur.id === id ? P.cur : await dbGet('projects', id);
    if (!meta) return;
    meta.name = name; meta.updated = Date.now();
    await dbPut('projects', { ...meta });
    if (bc) bc.postMessage({ type: 'list', tab: P.tab });
    renderChip();
  }
  async function duplicateProject(id) {
    const src = P.cur && P.cur.id === id ? P.cur : await dbGet('projects', id);
    if (!src) return null;
    if (P.cur && P.cur.id === id) await saveNow({ thumb: true });
    const st = await dbGet('state', id);
    const meta = { ...src, id: newId(), name: t('pj.copyName', { name: src.name || t('pj.untitled') }), created: Date.now(), updated: Date.now() };
    if (st) await dbPut('state', { ...st, id: meta.id });
    await dbPut('projects', meta);
    if (bc) bc.postMessage({ type: 'list', tab: P.tab });
    return meta;
  }
  async function removeProject(id) {
    const meta = await dbGet('projects', id);
    await dbDel('state', id);
    await dbDel('projects', id);
    if (P.cur && P.cur.id === id) {
      clearTimeout(P.timer);
      P.cur = null; P.dirty = false;
      remember(null);
      clearWorkspace();
      notes.load(null);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* no history */ }
      setStatus('saved');
      renderChip();
      refreshNotesUI();
    }
    if (bc) bc.postMessage({ type: 'list', tab: P.tab });
    if (meta) toast(t('pj.deleted', { name: meta.name || t('pj.untitled') }));
  }
  async function listProjects() {
    const all = await dbAll('projects');
    return all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  // export / import: one JSON file; an import is untrusted and always becomes a new project
  async function exportJSON(id) {
    let ws, meta;
    if (P.cur && P.cur.id === id) { ws = snapshot(); meta = P.cur; }
    else {
      meta = await dbGet('projects', id);
      const txt = await unpack(await dbGet('state', id));
      ws = txt ? JSON.parse(txt) : { v: 1, clusters: [] };
    }
    if (!meta) throw new Error('missing');
    return { app: 'quran-researcher', kind: 'project', v: 1, name: meta.name || '', created: meta.created, exported: new Date().toISOString(), ...ws };
  }
  async function exportProject(id) {
    const obj = await exportJSON(id);
    download(`quran-project-${fileName(obj.name || t('pj.untitled'))}.json`, new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  }
  const IMPORT_MAX = 50 * 1024 * 1024;
  function validateProject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(t('pj.badFile'));
    if (obj.v != null && obj.v !== 1) throw new Error(t('pj.badFile'));
    if (obj.clusters != null && !Array.isArray(obj.clusters)) throw new Error(t('pj.badFile'));
    if (obj.clusters && obj.clusters.some((c) => !c || typeof c !== 'object')) throw new Error(t('pj.badFile'));
    if (obj.ui != null && typeof obj.ui !== 'object') throw new Error(t('pj.badFile'));
    if (obj.legacy != null && typeof obj.legacy !== 'object') throw new Error(t('pj.badFile'));
    const ws = { v: 1, ui: obj.ui || {}, clusters: obj.clusters || [], notes: cleanNotes(obj.notes) };
    if (obj.legacy && typeof obj.legacy.q === 'string') ws.legacy = { q: obj.legacy.q.slice(0, 500), mode: String(obj.legacy.mode || 'auto'), scope: String(obj.legacy.scope || 'all'), n: String(obj.legacy.n || '60') };
    return ws;
  }
  async function importJSON(obj, name = '') {
    const ws = validateProject(obj);
    const nm = (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim().slice(0, 120) : String(name || '').replace(/\.json$/i, '').slice(0, 120);
    const meta = { id: newId(), name: nm, created: Date.now(), updated: Date.now(), thumb: null,
      counts: { clusters: ws.clusters.length || (ws.legacy ? 1 : 0), notes: Object.values(ws.notes).reduce((n, v) => n + (typeof v === 'string' ? (v ? 1 : 0) : Object.keys(v).length), 0) } };
    const rec = await pack(JSON.stringify(ws));
    await dbPut('state', { id: meta.id, ...rec });
    await dbPut('projects', meta);
    await openProject(meta.id, { push: true });
    toast(t('pj.imported', { name: meta.name || t('pj.untitled') }));
    return meta;
  }
  async function importFile(file) {
    if (!file) return null;
    if (file.size > IMPORT_MAX) throw new Error(t('pj.tooBig'));
    let obj;
    try { obj = JSON.parse(await file.text()); } catch (_) { throw new Error(t('pj.badFile')); }
    return importJSON(obj, file.name);
  }
  function pickImport() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (f) importFile(f).catch((e) => toast(t('pj.importFail', { e: e.message }), true));
    });
    inp.click();
  }

  /* ------------------------------------------------------------ the URL: #p=<id>, legacy #q=… */
  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return {};
    const p = new URLSearchParams(h), o = {};
    for (const k of ['p', 'q', 'mode', 'scope', 'n', 'precision', 'group', 'match', 'meaning']) if (p.get(k)) o[k] = p.get(k);
    return o;
  }
  function setHash(id, push) {
    if (!wsMode()) return;   // app.js still writes #q=… hashes in the single-graph app
    const h = `#p=${encodeURIComponent(id)}`;
    if (location.hash === h) return;
    try { if (push) history.pushState({ p: id }, '', h); else history.replaceState({ p: id }, '', h); } catch (_) { /* no history */ }
  }
  function searchLink(params = {}) {
    const p = new URLSearchParams();
    if (params.q) p.set('q', params.q);
    for (const k of ['mode', 'scope', 'n', 'precision', 'group', 'match', 'meaning']) {
      const v = params[k];
      if (v != null && v !== '' && v !== 'auto' && !(k === 'scope' && v === 'all')) p.set(k, v);
    }
    return `${location.origin}${location.pathname}#${p}`;
  }
  async function copySearchLink(params) {
    const url = searchLink(params);
    try { await navigator.clipboard.writeText(url); toast(t('pj.linkCopied')); } catch (_) { toast(t('pj.copyFail'), true); }
    return url;
  }
  // a shared / old #q= link: its search joins the current project, and the hash becomes #p=
  let lastAdded = null;
  async function importLegacyHash(h) {
    const q = qr();
    if (!q) return;
    await ensureProject();
    legacyParams({ mode: h.mode, scope: h.scope, n: h.n });
    lastAdded = null;
    await q.runSearch(h.q, { push: false });
    const cid = lastAdded;
    if (cid && QR.ws && typeof QR.ws.remove === 'function') actionToast(t('pj.legacyAdded', { q: h.q }), t('pj.undo'), () => QR.ws.remove(cid));
    else toast(t('pj.legacyAdded', { q: h.q }));
    setHash(P.cur.id, false);
  }

  /* ------------------------------------------------------------ other tabs */
  function hello() {
    if (!bc || !P.cur) return;
    P.lastHello = Date.now();
    bc.postMessage({ type: 'hello', id: P.cur.id, tab: P.tab });
  }
  if (bc) bc.onmessage = ({ data: m }) => {
    if (!m || m.tab === P.tab) return;
    if ((m.type === 'hello' || m.type === 'also') && P.cur && m.id === P.cur.id) {
      if (m.type === 'hello') bc.postMessage({ type: 'also', id: m.id, tab: P.tab });
      if (P.status !== 'other') { setStatus('other'); toast(t('pj.otherTab')); }
    }
    if (m.type === 'list' && $('#pjPop') && !$('#pjPop').hidden) renderPopover();
  };

  /* ------------------------------------------------------------ header chip + popover */
  function mountChip() {
    const host = $('#projectChip');
    if (!host) return;
    host.innerHTML = `<button type="button" class="pj-name" id="pjName" title="${esc(t('pj.renameT'))}" aria-label="${esc(t('pj.chipAria'))}">
        <span class="pj-icon" aria-hidden="true">▤</span><span class="pj-title"></span><small class="pj-hint"></small></button>
      <button type="button" class="pj-menu-btn" id="pjMenu" aria-haspopup="menu" aria-expanded="false" title="${esc(t('pj.menuT'))}" aria-label="${esc(t('pj.menuT'))}">▾</button>
      <span class="pj-status" id="pjStatus" aria-live="polite"></span>
      <div class="pj-pop" id="pjPop" role="menu" hidden></div>`;
    $('#pjName', host).addEventListener('click', () => renameInline());
    $('#pjMenu', host).addEventListener('click', () => togglePopover());
    document.addEventListener('mousedown', (e) => { if (!host.contains(e.target)) closePopover(); });
    host.addEventListener('keydown', (e) => {
      const pop = $('#pjPop', host);
      if (pop.hidden) return;
      const items = $$('[role="menuitem"]', pop).filter((x) => !x.hidden);
      const i = items.indexOf(document.activeElement.closest ? document.activeElement.closest('[role="menuitem"]') : null);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[j] && items[j].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0] && items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1] && items[items.length - 1].focus(); }
    });
    renderChip();
  }
  function renderChip() {
    const host = $('#projectChip');
    if (!host || !$('.pj-title', host)) return;
    const title = $('.pj-title', host), hint = $('.pj-hint', host);
    const name = P.cur && P.cur.name;
    title.textContent = name || t('pj.untitled');
    title.classList.toggle('untitled', !name);
    title.setAttribute('dir', 'auto');
    hint.textContent = P.cur && !name ? t('pj.nameIt') : '';
    $('#pjName', host).title = t('pj.renameT');
    renderStatus();
  }
  function renderStatus() {
    const el = $('#pjStatus');
    if (!el) return;
    const s = P.status;
    el.className = 'pj-status ' + s;
    el.textContent = !P.cur ? '' : s === 'saving' ? t('pj.saving') : s === 'error' ? t('pj.saveFail') : s === 'other' ? t('pj.otherTab') : t('pj.saved');
    clearTimeout(el._t);
    if (s === 'saved') el._t = setTimeout(() => el.classList.add('fade'), 1600);
  }
  function renameInline() {
    const host = $('#projectChip'), btn = $('#pjName', host), title = $('.pj-title', host);
    if (!btn || $('input', btn)) return;
    const run = async () => {
      await ensureProject();
      const inp = document.createElement('input');
      const before = P.cur.name || '';
      inp.value = before; inp.dir = 'auto'; inp.setAttribute('aria-label', t('pj.namePrompt')); inp.placeholder = t('pj.untitled');
      title.replaceWith(inp);
      $('.pj-hint', host).textContent = '';
      inp.focus(); inp.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        const span = document.createElement('span'); span.className = 'pj-title';
        inp.replaceWith(span);
        if (save && v !== before) renameProject(P.cur.id, v).catch((e) => console.error(e));
        renderChip();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); btn.focus(); } });
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('click', (e) => e.stopPropagation());
    };
    run().catch((e) => console.error(e));
  }
  function togglePopover() { const pop = $('#pjPop'); if (!pop) return; if (pop.hidden) openPopover(); else closePopover(true); }
  async function openPopover() {
    const pop = $('#pjPop'), btn = $('#pjMenu');
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    await renderPopover();
    const first = $('[role="menuitem"]', pop);
    if (first) first.focus();
  }
  function closePopover(focus = false) {
    const pop = $('#pjPop'), btn = $('#pjMenu');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  }
  async function renderPopover() {
    const pop = $('#pjPop');
    if (!pop || pop.hidden) return;
    let list = [];
    try { list = await listProjects(); } catch (e) { console.error(e); }
    const cur = P.cur && P.cur.id;
    const row = (m) => {
      const isCur = m.id === cur, nm = m.name || t('pj.untitled');
      const meta = isCur ? `<b>${t('pj.current')}</b> · ` : '';
      const counts = `${t('pj.nets', { n: (m.counts && m.counts.clusters) || 0 })} · ${t('pj.notes', { n: (m.counts && m.counts.notes) || 0 })}`;
      return `<div class="pj-row${isCur ? ' cur' : ''}" role="menuitem" tabindex="-1" data-id="${esc(m.id)}">
        ${m.thumb ? `<img class="pj-thumb" src="${esc(m.thumb)}" alt="${esc(t('pj.thumbAlt'))}">` : '<div class="pj-thumb none" aria-hidden="true">▤</div>'}
        <div class="pj-info"><div class="pj-rname${m.name ? '' : ' untitled'}" dir="auto">${esc(nm)}</div>
          <div class="pj-meta">${meta}${esc(t('pj.edited', { date: relDate(m.updated || m.created || Date.now()) }))} · ${counts}</div></div>
        <div class="pj-acts">${isCur ? '' : `<button type="button" data-act="open">${t('pj.open')}</button>`}
          <button type="button" data-act="rename">${t('pj.rename')}</button><button type="button" data-act="dup">${t('pj.dup')}</button>
          <button type="button" data-act="export">${t('pj.export')}</button><button type="button" class="danger" data-act="delete">${t('pj.delete')}</button></div></div>`;
    };
    pop.innerHTML = `<button type="button" class="pj-item" role="menuitem" tabindex="-1" data-act="new"><span class="pj-ic" aria-hidden="true">＋</span>${t('pj.new')}</button>
      <button type="button" class="pj-item" role="menuitem" tabindex="-1" data-act="import"><span class="pj-ic" aria-hidden="true">⇪</span>${t('pj.import')}</button>
      <button type="button" class="pj-item" role="menuitem" tabindex="-1" data-act="clear"${cur ? '' : ' disabled'}><span class="pj-ic" aria-hidden="true">⌫</span>${t('pj.clear')}</button>
      <div class="pj-sep"></div><div class="pj-head">${t('pj.list')}</div>
      ${list.length ? list.map(row).join('') : `<div class="pj-none">${t('pj.empty')}</div>`}`;
    $$('.pj-item', pop).forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      closePopover(true);
      if (act === 'new') newProject().catch((e) => toast(t('toast.err', { e: e.message }), true));
      else if (act === 'import') pickImport();
      else if (act === 'clear') { clearWorkspace(); scheduleSave(); }
    }));
    $$('.pj-row', pop).forEach((r) => {
      const id = r.dataset.id;
      const open = () => { closePopover(true); openProject(id, { push: true }).catch((e) => toast(t('pj.openFail', { e: e.message }), true)); };
      r.addEventListener('click', (e) => { if (e.target.closest('.pj-acts, .pj-confirm, input')) return; open(); });
      r.addEventListener('keydown', (e) => { if (e.target === r && e.key === 'Enter') { e.preventDefault(); open(); } });
      $$('.pj-acts button', r).forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'open') open();
        else if (act === 'rename') rowRename(r, id);
        else if (act === 'dup') duplicateProject(id).then(renderPopover).catch((e2) => toast(t('toast.err', { e: e2.message }), true));
        else if (act === 'export') exportProject(id).catch((e2) => toast(t('toast.err', { e: e2.message }), true));
        else if (act === 'delete') rowConfirmDelete(r, id);
      }));
    });
  }
  function rowRename(row, id) {
    const nameEl = $('.pj-rname', row);
    if (!nameEl || $('input', row)) return;
    const inp = document.createElement('input');
    inp.className = 'pj-rn'; inp.dir = 'auto'; inp.value = nameEl.classList.contains('untitled') ? '' : nameEl.textContent; inp.placeholder = t('pj.untitled'); inp.setAttribute('aria-label', t('pj.namePrompt'));
    nameEl.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      (save ? renameProject(id, v) : Promise.resolve()).catch((e) => console.error(e)).then(renderPopover);
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
  }
  function rowConfirmDelete(row, id) {
    if ($('.pj-confirm', row)) return;
    const box = document.createElement('div');
    box.className = 'pj-confirm';
    box.innerHTML = `<span>${t('pj.deleteConfirm')}</span><button type="button" class="danger" data-c="yes">${t('pj.delete')}</button><button type="button" data-c="no">${t('pj.cancel')}</button>`;
    row.appendChild(box);
    $('[data-c="yes"]', box).addEventListener('click', (e) => { e.stopPropagation(); removeProject(id).then(renderPopover).catch((e2) => toast(t('toast.err', { e: e2.message }), true)); });
    $('[data-c="no"]', box).addEventListener('click', (e) => { e.stopPropagation(); box.remove(); });
    $('[data-c="no"]', box).focus();
  }

  /* ------------------------------------------------------------ legacy adapter (app.js without QR.ws) and the test mock */
  function startLegacyAdapter() {
    let last = null, lastCy = null;
    setInterval(() => {
      const S = state();
      if (!S) return;
      if (S.cy !== lastCy) { lastCy = S.cy; syncNoted(); }
      if (S.data !== last) {
        last = S.data;
        if (S.data) { emit('cluster:add', { cid: 'q', params: { q: S.data.query && S.data.query.q } }); emit('change'); }
      }
    }, 700);
    // N on a selected node writes its note (the workspace app.js does this itself)
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyN' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      const S = state();
      if (!S || !S.cy) return;
      const sel = S.selected ? S.cy.$id(S.selected) : null;
      const key = sel && sel.nonempty() ? notes.keyFor(sel.data()) : (S.data ? 'cluster:q' : null);
      if (key) { e.preventDefault(); quickNote(key); }
    });
  }
  if (window.QR_MOCK && !QR.ws) {
    QR.ws = { __mock: true,
      serialize: () => legacySnapshot(),
      restore: (ws) => legacyRestore(ws),
      clear: () => legacyClear(),
      thumbnail: () => { const cy = state() && state().cy; if (!cy || !cy.nodes().length) return null; return cy.png({ full: true, maxWidth: 240, maxHeight: 150, bg: '#0f141c', output: 'base64uri' }); },
      summary: () => ({ clusters: state() && state().data ? 1 : 0, notes: notes.count(), title: '' }),
    };
  }

  /* ------------------------------------------------------------ boot */
  const waitFor = (fn, ms) => new Promise((res) => { const t0 = Date.now(); (function tick() { if (fn()) res(true); else if (Date.now() - t0 > ms) res(false); else setTimeout(tick, 60); })(); });
  async function boot() {
    await waitFor(() => window.__qr, 20000);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (_) { /* unsupported */ }
    mountChip();
    refreshNotesUI();
    const sb = $('.side-body');
    if (sb) cardObserver.observe(sb, { childList: true, subtree: true });
    const nb = $('#tabbtn-notes');
    if (nb) nb.addEventListener('click', () => renderNotesTab());
    // workspace events → autosave; the first network creates the project
    QR.on('cluster:add', (p) => {
      lastAdded = p && p.cid ? p.cid : lastAdded;
      ensureProject().catch((e) => console.error(e));
      if (!P.cur || !P.cur.name) nameFromSearch(p && p.params && p.params.q);
      syncNoted(); scheduleSave(); if (ntVisible()) renderNotesTab();
    });
    ['cluster:remove', 'cluster:rename', 'cluster:freeze', 'change', 'camera'].forEach((ev) => QR.on(ev, () => { if (P.cur) scheduleSave(); if (ev !== 'camera' && ntVisible()) renderNotesTab(); }));
    window.addEventListener('pagehide', () => { if (P.cur && (P.dirty || P.timer)) saveNow(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && P.cur && (P.dirty || P.timer)) saveNow(); });
    window.addEventListener('popstate', () => {
      if (!wsMode()) return;
      const h = parseHash();
      if (h.p && (!P.cur || P.cur.id !== h.p)) openProject(h.p, { push: false }).catch((e) => toast(t('pj.openFail', { e: e.message }), true));
    });
    // the interface language changed: everything rendered here is rebuilt in the new language
    new MutationObserver(() => { renderChip(); if (ntVisible()) renderNotesTab(); if ($('#pjPop') && !$('#pjPop').hidden) renderPopover(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    const h = parseHash();
    let lastId = null;
    try { lastId = localStorage.getItem(LAST_KEY); } catch (_) { /* blocked */ }
    if (wsMode()) {
      if (h.p) { try { await openProject(h.p, { push: false }); } catch (e) { console.error(e); try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* no history */ } } }
      else if (lastId && !h.q) { try { await openProject(lastId, { push: false }); } catch (_) { remember(null); } }
      if (h.q) await importLegacyHash(h).catch((e) => toast(t('toast.err', { e: e.message }), true));
      if (QR.ws.__mock) startLegacyAdapter();   // tests: the mock wraps the single-graph app, which emits nothing
    } else {
      // single-graph app.js: it runs the #q= search itself; the project (notes) comes back without a restore
      const id = h.p || lastId;
      if (id) { try { await openProject(id, { push: false, restore: !h.q && !!h.p }); } catch (_) { remember(null); } }
      startLegacyAdapter();
    }
    P.booted = true;
    nameUntitled().catch((e) => console.error(e));
  }

  QR.projects = {
    current: () => P.cur, status: () => P.status, dirty: () => P.dirty || !!P.timer || !!P.saving,
    list: listProjects, open: openProject, create: newProject, rename: renameProject, duplicate: duplicateProject,
    remove: removeProject, exportProject, exportJSON, importFile, importJSON, saveNow, scheduleSave, searchLink, copySearchLink,
    openPopover, closePopover, renderNotesTab, snapshot,
  };
  boot().catch((e) => console.error(e));
})();

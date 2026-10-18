"""Search + graph engine.

A query is classified as one of
  ayah   - a reference ("2:255", "2:255-257") or a pasted ayah text (a phrase that covers an ayah, or >=4
           Arabic words that locate one)
  root   - explicit root ("ص ب ر", "جذر:صبر", "root:صبر")
  word   - one Arabic word -> its lemma (every inflection) via the morphology, or, quoted / with
           precision=form, exactly that written form (proclitics optional); a particle or the opening letters
           (الم) are searched as a written form
  phrase - 2-8 Arabic words: the exact sequence of written forms, else every word (lemma, then root)
  topic  - anything else (English, or Arabic nothing above matched, in Topic mode) -> semantic search
Word, root and phrase searches answer with their hit set only (a concordance: Mushaf order inside lemma /
form / theme boxes, a fair prefix-stable sample when the graph is capped). Topic and ayah searches, and any
search with meaning=1, use Reciprocal Rank Fusion over lexical (root, lemma, English TF-IDF) and semantic
(e5 embeddings of Arabic, English, tafsir) rank lists.
"""
import collections
import functools
import json
import math
import re
import threading
from pathlib import Path

import networkx as nx
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize as l2

from .normalize import HAMZA, clean_query, fkey, fold_seats, is_arabic, key, lemma_text, normalize, root_key, skey

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / 'data' / 'index'
# "2:255", "2 255", "2/255", "(2:255)", "2:255-257", "2:255-2:257"; one separator, so no backtracking blow-up
REF_RE = re.compile(r'^[(\[﴿]?(\d{1,3})(?: ?[:：./] ?| )(\d{1,3})(?: ?[-–] ?(?:(\d{1,3}) ?[:：] ?)?(\d{1,3}))?[)\]﴾]?$')
MAX_SEEDS = 20
MAX_PASSAGE = 40   # ayat per /api/passage call
MAX_GRAPH = 3000   # largest graph; n=None (`all`) draws every match up to it, the rest is listed in `rest`
LARGE_GRAPH = 200  # above this many ayat a graph's themes come from its best-ranked core (see _themes)
CORE = 150         # ... that many results: the same map a 150-ayah graph draws
ATTACH = 0.3       # share of its nearest core ayat's vote a theme needs to take in another ayah
MAX_THEMES_LARGE = 14
AUTO_ALL = 200     # n=auto draws every hit of a word / root / phrase search up to this many, else AUTO_N
AUTO_N = 150
MAX_BOXES = 11     # lemma / form boxes of a concordance graph; the rest go to «صيغ أخرى»
SUB_FORMS_MIN = 14  # a lemma box with this many ayat is split into form sub-boxes
MAX_PHRASE = 8     # words
PRECISIONS = ('auto', 'form', 'lemma', 'stem')
MEANINGS = ('0', 'edges', '1')
GROUPS = ('auto', 'form', 'lemma', 'theme')
MATCHES = ('auto', 'phrase', 'all', 'any')
QUOTES = '«»"“”'


def lkey(w):
    # locating a pasted ayah: the rasm key without hamza too, since the Mushaf writes a bare ء where modern
    # spelling has a seat or nothing (فَلَنَسْـَٔلَنَّ / فلنسألن, أَءِذَا / أإذا)
    return key(w).replace('ء', '')
GLOSS_STOP = set('and so then the a an his her their its our your my is are was were will shall surely indeed '
                 'for of to in by with they we you he she it i them him us those these that this o '
                 'be would not do did has have had let any some'.split())
GLOSS_TAIL = set('them you it him her us me thereof therein his their its your our my to in with from on of'.split())
PAUSE_MARKS = set('ۖۗۘۙۚۛۜ۩')
# vocative/particles that occur only fused to the next word in the Mushaf, so no whole-word entry catches them
QUERY_PARTICLES = set('يا ايها يايها اي ال اللاتي اللائي اللذان اللتان اللذين اللتين'.split())
TRAILING_PARTICLES = set('ولكن لكن ولاكن لاكن ان وان فان ثم او قد لقد الذي الذين التي بل'.split())
# roots too light to name a theme (بعد عند بعض كل …): they are everywhere and say nothing about the topic
LIGHT_ROOTS = set('بعد عند بعض كلل تحت خلف نفس شيأ جعل جيأ رود عمل خير أنس نوس يوم قول كون أتي رأي أخذ كتب أمر '
                  'حسن أول'.split())
MAX_QUERY = 500
ROOT_RE = re.compile(r'^\s*(?:root|جذر)\s*[:：]\s*(.+)$', re.I)
SPACED_ROOT_RE = re.compile(r'^\s*([ء-ي])(\s+[ء-ي]){2,3}\s*$')


def rrf(lists, k=60):
    """lists: [(weight, [ayah ids ranked])] -> {ayah: score}"""
    s = collections.defaultdict(float)
    for w, ranked in lists:
        for r, a in enumerate(ranked):
            s[a] += w / (k + r + 1)
    return s


def top_k(M, k):
    """Column indices of each row's k largest values, largest first. Rows of up to LARGE_GRAPH (+ seeds) use a full
    sort, which breaks ties (repeated ayat give exactly equal similarities) like the per-row argsort graphs
    were always built with; larger matrices use argpartition (ties may then fall differently)."""
    k = min(k, M.shape[1])
    if M.shape[1] <= LARGE_GRAPH + MAX_SEEDS:
        return np.argsort(-M, axis=1)[:, :k]
    top = np.argpartition(-M, k - 1, axis=1)[:, :k]
    return np.take_along_axis(top, np.argsort(-np.take_along_axis(M, top, 1), axis=1, kind='stable'), 1)


def top_ids(scores, n, mask=None):
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    n = min(n, int(np.isfinite(scores).sum()))
    if n <= 0:
        return []
    idx = np.argpartition(-scores, n - 1)[:n]
    return idx[np.argsort(-scores[idx])].tolist()


class Engine:
    def __init__(self):
        c = json.load(open(IDX / 'corpus.json', encoding='utf8'))
        p = json.load(open(IDX / 'patterns.json', encoding='utf8'))
        self.ayat = c['ayat']
        self.N = len(self.ayat)
        self._wkeys = {}   # ayah -> its words' phrase keys (filled by _phrase_span)
        self._verb_word = {}   # verb lemma -> the Quranic word that shows it in a theme name (_verb_display)
        self.surahs = {s['n']: s for s in c['surahs']}
        self.roots = c['roots']
        self.lemmas = c['lemmas']
        self.surface = c['surface']
        self.lemma_of = c['lemma_of']
        self.surface_s = c['surface_s']
        self.lemma_of_s = c['lemma_of_s']
        self.lemma_disp = c['lemma_disp']
        self.whole_s = c['whole_s']
        self.whole_n = c['whole_n']
        self.whole_h = c.get('whole_h', {})
        self.lemma_pos = c['lemma_pos']
        self.ref = {(a['s'], a['a']): a['i'] for a in self.ayat}
        self.root_by_key = {}
        for r, st in self.roots.items():
            self.root_by_key.setdefault(st['k'], r)
        self.repeated = p['repeated']
        for ph in self.repeated:   # word forms for the filter box: dagger alef read as alef, and dropped
            ph['w1'] = ph['k'].split()
            ph['w2'] = normalize(ph['t'].replace('\u0670', '')).split()
        self.cooc = p['cooc']
        self.curated = {tuple(x) for x in p['curated']}
        self.phrase_nb = collections.defaultdict(list)
        for i, j, n, g in p['pairs']:
            self.phrase_nb[i].append((j, n, g))
            self.phrase_nb[j].append((i, n, g))
        self.meccan = np.array([self.surahs[a['s']]['type'] == 'Meccan' for a in self.ayat])
        # ayat under 4 words (الم، خلق الإنسان) match any query vaguely in embedding space: keep them out of
        # the meaning-only lists (they still come in through words, roots and phrases)
        self.short = np.array([len(a['w']) < 4 for a in self.ayat])
        self._lexical()
        self._forms()
        self._semantic()

    # ------------------------------------------------------------------ indexes
    def _lexical(self):
        ident = lambda x: x  # noqa: E731
        self.ayah_roots = [[w[1] for w in a['w'] if w[1]] for a in self.ayat]
        self.ayah_lemmas = [[w[2] for w in a['w'] if w[2] and w[3] in ('N', 'PN', 'V')] for a in self.ayat]
        self.tv_root = TfidfVectorizer(analyzer=ident, sublinear_tf=True)
        self.Xr = self.tv_root.fit_transform(self.ayah_roots).tocsc()
        self.tv_lem = TfidfVectorizer(analyzer=ident, sublinear_tf=True)
        self.Xl = self.tv_lem.fit_transform(self.ayah_lemmas).tocsc()
        self.root_col = self.tv_root.vocabulary_
        self.lem_col = self.tv_lem.vocabulary_
        self.root_idf = dict(zip(self.tv_root.get_feature_names_out(), self.tv_root.idf_))
        # combined lexical similarity space (roots 0.6, lemmas 0.4)
        self.Xlex = l2(sparse.hstack([self.Xr * 0.6, self.Xl * 0.4]).tocsr())
        # column -> root for the combined matrix, so theme affinity can ignore the searched/common roots
        self.lem_root = lem_root = {}
        for a in self.ayat:
            for w in a['w']:
                if w[2] and w[1]:
                    lem_root.setdefault(w[2], w[1])
        # queries arrive NFKC-normalised (which can reorder harakat), so ids are looked up the same way
        self.lemma_ids = {clean_query(l): l for l in lem_root if '|' in l}
        # searchable lemmas by their bare letters (hamza seats kept), for «or did you mean» on letters that
        # fit several words (عمرة: عُمْرَة umrah / عُمُرِهِ his life; علم: عِلْم / عَلِمَ / عَلَّمَ)
        self.lem_na = dict(zip(self.tv_lem.get_feature_names_out(), np.diff(self.Xl.indptr)))
        self.lem_by_letters = collections.defaultdict(list)
        self.lem_by_text = collections.defaultdict(list)   # vowelled lemma text as typed (عُمْرَة) -> lemmas
        self.searchable = set()
        for l in self.lem_col:
            if self.lemma_pos.get(l) in ('N', 'V', 'PN') and (l in lem_root or self.lemma_pos.get(l) == 'PN'
                                                               or self._is_searchable_rootless(l)):
                self.searchable.add(l)
                self.lem_by_letters[fkey(lemma_text(l))].append(l)
                self.lem_by_text[clean_query(lemma_text(l))].append(l)
        nr = self.Xr.shape[1]
        self.lex_col_root = [None] * self.Xlex.shape[1]
        for r, j in self.tv_root.vocabulary_.items():
            self.lex_col_root[j] = r
        for l, j in self.tv_lem.vocabulary_.items():
            self.lex_col_root[nr + j] = lem_root.get(l)
        self.lex_keep = np.array([0.0 if r and self.roots[r]['na'] > 450 else 1.0 for r in self.lex_col_root])
        self.tv_en = TfidfVectorizer(stop_words='english', sublinear_tf=True, ngram_range=(1, 2), min_df=1)
        self.Xen = self.tv_en.fit_transform([a['en'] for a in self.ayat])
        # strict keys of whole words -> ayat: the literal fallback for queries that resolve to no root or lemma
        # (له then marks لَهُ only; the loose rasm key would also mark ٱللَّه and إِلَٰه)
        self.word_keys = []
        self.surface_idx = collections.defaultdict(set)
        for a in self.ayat:
            ks = []
            for j, w in enumerate(a['w']):
                kw = {skey(w[0])} - {''}
                ks.append(kw)
                for k in kw:
                    self.surface_idx[k].add(a['i'])
            self.word_keys.append(ks)
        # the same with exact letters and hamza seats (الم the opening letters is not أَلَمْ)
        self.word_keys_h = [[normalize(w[0], keep_hamza=True).replace(' ', '') for w in a['w']] for a in self.ayat]
        self.surface_h = collections.defaultdict(set)
        for a, ks in zip(self.ayat, self.word_keys_h):
            for k in ks:
                if k:
                    self.surface_h[k].add(a['i'])
        # 3-grams over whole-word keys, for locating a pasted ayah
        self.tri = collections.defaultdict(set)
        for a in self.ayat:
            ws = [lkey(w[0]) for w in a['w']]
            for t in range(len(ws) - 2):
                self.tri[' '.join(ws[t:t + 3])].add(a['i'])

    def _forms(self):
        """The written-form index (build_index: token_views). Every token has a set of views: the whole word
        and the word minus its leading proclitics (وَبِٱلصَّبْرِ: وبالصبر، بالصبر، الصبر), so a typed form matches
        a token when it is one of its views. `form_idx` lists the ayat of each view; `form_lem` the lemmas
        written with it; `tok_views` is per token (highlights); `lemma_forms` the cores (proclitic-free
        spellings) of each lemma; `root_lemmas` the lemmas of each root with ayah counts. The folded indexes
        serve the query cascade: seats / ة / ى folded (form_n), medial alef dropped (form_s), loose (form_k)."""
        self.tok_views, self.tok_core = [], []
        self.form_idx = collections.defaultdict(set)
        self.form_lem = collections.defaultdict(collections.Counter)
        self.form_lem_det = collections.defaultdict(collections.Counter)   # views of article-carrying tokens
        self.core_n, self.core_na = collections.Counter(), collections.defaultdict(set)
        self.lemma_forms = collections.defaultdict(collections.Counter)
        self.core_disp, self.core_fallback = {}, {}     # (core, lemma) -> Tanzil token / (ayah, word) to strip
        self.root_lemmas = collections.defaultdict(collections.Counter)
        for a in self.ayat:
            i, dets = a['i'], set(a.get('dt', ()))
            tv, tc, seen = [], [], set()
            for j, (w, v) in enumerate(zip(a['w'], a.get('v') or [0] * len(a['w']))):
                full = fkey(w[0])
                vs = {full} | set(v) if v else {full}
                core = v[0] if v else full
                tv.append(vs)
                tc.append(core)
                lem = w[2] or ''
                for x in vs:
                    self.form_idx[x].add(i)
                    self.form_lem[x][lem] += 1
                    if j in dets:
                        self.form_lem_det[x][lem] += 1
                self.core_n[core] += 1
                self.core_na[core].add(i)
                if lem:
                    self.lemma_forms[lem][core] += 1
                if core == full:
                    self.core_disp.setdefault((core, lem), self._bare(a['d'][j]))
                    self.core_disp.setdefault((core, None), self._bare(a['d'][j]))
                else:
                    self.core_fallback.setdefault((core, lem), (i, j))
                    self.core_fallback.setdefault((core, None), (i, j))
                if w[1] and lem and (w[1], lem) not in seen:
                    seen.add((w[1], lem))
                    self.root_lemmas[w[1]][lem] += 1
            self.tok_views.append(tv)
            self.tok_core.append(tc)
        self.form_n, self.form_s, self.form_k = (collections.defaultdict(set) for _ in range(3))
        for x in self.form_idx:
            self.form_n[fold_seats(x)].add(x)
            self.form_s[skey(x)].add(x)
            self.form_k[key(x)].add(x)

    @staticmethod
    def _bare(tok):
        """A Tanzil token without the pause mark attached to it (display of a form)."""
        return ' '.join(x for x in tok.split(' ') if not set(x) <= PAUSE_MARKS)

    LETTER = re.compile('[\u0621-\u064A\u0671-\u0673\u06E5-\u06E7]')

    def form_display(self, core, lemma=None):
        """How a form is shown: the Tanzil spelling of a bare occurrence (ٱلصَّٰبِرِينَ), of this lemma when one is
        given (the bare صَبَرَ is not the spelling of فَصَبْرٌ's form), else the Tanzil token of an occurrence minus
        its proclitic letters (وَٱصْطَبِرْ -> ٱصْطَبِرْ, a verbatim substring), else the plain key (للصابرين has
        no bare spelling: الصابرين)."""
        # this lemma's own spellings come first (bare, else a token minus its proclitics), and only then any
        # lemma's: the core صبر of the noun فَصَبْرٌ must show as صَبْرٌ, not as the verb's bare صَبَرَ
        for key_ in ((core, lemma), (core, None)) if lemma else ((core, None),):
            t = self.core_disp.get(key_)
            if t:
                return t
            if key_ in self.core_fallback:
                i, j = self.core_fallback[key_]
                tok, full = self._bare(self.ayat[i]['d'][j]), fkey(self.ayat[i]['w'][j][0])
                drop = len(full) - len(core)
                if drop > 0 and full.endswith(core):
                    k, n = 0, 0
                    while k < len(tok) and n < drop:
                        if self.LETTER.match(tok[k]):
                            n += 1
                        k += 1
                    while k < len(tok) and not self.LETTER.match(tok[k]):   # the dropped letter's own marks
                        k += 1
                    if k < len(tok) and fkey(tok[k:]) == core:
                        return tok[k:]
        return core

    def _form_lookup(self, tok):
        """A typed word -> (the exact views of the Quran it names, how). Strict first: 1 the letters as typed
        (hamza seats, ة, ى kept; a final ه gives way to the far commoner ة word: رحمه -> رحمة); 2 seats, ة/ه
        and ى/ي folded (a typed hamza must still agree in seat, a bare ء matching any); 3 ئ -> يء / ء and
        وة -> اة (شئ, الصلوة); 4 medial alef dropped (الرحمن, هذا, لكن against the dagger alef); 5 the loose
        rasm key."""
        k = fkey(tok)
        if not k:
            return set(), None
        if k.endswith('ه') and len(k) > 2:
            # a final ه typed for ة (رحمه): the ة word when it is far more common than the ه one (رَحِمَهُ, once)
            kt = k[:-1] + 'ة'
            if kt in self.form_idx and len(self.form_idx[kt]) >= 2 * len(self.form_idx.get(k, ())):
                return {kt}, 'ta'
        if k in self.form_idx:
            return {k}, 'exact'
        typed = [c for c in k if c in HAMZA]

        def compat(v):
            vh = [c for c in v if c in HAMZA]
            return len(vh) == len(typed) and all(x == y or 'ء' in (x, y) for x, y in zip(vh, typed))
        cand = {v for v in self.form_n.get(fold_seats(k), ()) if not typed or compat(v)}
        if cand:
            return cand, 'seats'
        k4 = re.sub('(?<=ي)ئ', 'ء', k.replace('وة', 'اة')).replace('ئ', 'يء')
        if k4 != k:
            if k4 in self.form_idx:
                return {k4}, 'spelling'
            cand = {v for v in self.form_n.get(fold_seats(k4), ()) if compat(v)}
            if cand:
                return cand, 'spelling'
        cand = set(self.form_s.get(skey(k), ()))
        if cand:
            return cand, 'alef'
        cand = set(self.form_k.get(key(k), ()))
        return cand, ('loose' if cand else None)

    def _is_searchable_rootless(self, l):
        # rootless lemmas that build_index indexed as content words (وَيْل، سُندُس …) appear in whole_h analyses
        if not hasattr(self, '_rootless_ok'):
            self._rootless_ok = {x[1] for v in self.whole_h.values() for x in v if x[1] and not x[0]}
        return l in self._rootless_ok

    def _semantic(self):
        self.E = {}
        for name in ('ar', 'en', 'tf'):
            f = IDX / f'emb_{name}.npy'
            if f.exists():
                self.E[name] = np.load(f).astype(np.float32)
        self.model = None
        self._model_lock = threading.Lock()
        if self.E:
            fused = sum(self.E.values())
            self.Ef = fused / np.linalg.norm(fused, axis=1, keepdims=True)
            rng = np.random.default_rng(0)
            a, b = rng.integers(0, self.N, 40000), rng.integers(0, self.N, 40000)
            sims = (self.Ef[a] * self.Ef[b]).sum(1)
            self.sem_edge_thr = float(np.percentile(sims, 97))
        else:
            self.Ef = None
            self.sem_edge_thr = 1.0

    @property
    def semantic_ready(self):
        return bool(self.E)

    def load_model(self):
        with self._model_lock:
            if self.model is None and self.E:
                from .embed import load_model
                self.model = load_model('cpu')
        return self.model

    @functools.lru_cache(maxsize=512)
    def _qvec(self, q):
        m = self.load_model()
        return m.encode(['query: ' + q], normalize_embeddings=True)[0].astype(np.float32)

    # ------------------------------------------------------------------ query analysis
    # notes and errors stay English here; the Arabic UI translates them by pattern (NOTES in static/i18n.js),
    # so a new or reworded message needs an entry there too
    def parse_ref(self, q):
        """-> (ids, note) for an ayah reference, None if q is not one. ids is [] for a missing ayah."""
        m = REF_RE.match(q)
        if not m:
            return None
        s, a1 = int(m.group(1)), int(m.group(2))
        if m.group(3) and int(m.group(3)) != s:
            return [], 'ranges must stay within one surah'
        a2 = int(m.group(4)) if m.group(4) else a1
        if a1 == 0 or a2 == 0:
            return [], f'no ayah {q}'
        if a2 < a1:
            return [], f'range {s}:{a1}-{a2} ends before it starts'
        ids = [self.ref[(s, a)] for a in range(a1, a2 + 1) if (s, a) in self.ref]
        note = None
        if ids and len(ids) < a2 - a1 + 1:
            note = f'surah {s} has {self.surahs[s]["ayas"]} ayat' if s in self.surahs else None
        if len(ids) > MAX_SEEDS:
            ids = ids[:MAX_SEEDS]
            note = f'range trimmed to the first {MAX_SEEDS} ayat ({self.refstr(ids[0])}–{self.refstr(ids[-1])})'
        return ids, note

    def _lookup(self, k, kf, surface, lemma_of):
        """Roots/lemmas for key k; if none, retry with common clitics (و ف ب ل ك ال) stripped."""
        roots = [r for r, _ in surface.get(k, [])]
        lemmas = [l for l, _ in lemma_of.get(k, [])]
        if not roots and not lemmas:
            for pre in ('وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك'):
                kp = kf(pre)
                if k.startswith(kp) and len(k) - len(kp) >= 2:
                    rest = k[len(kp):]
                    # the strict key keeps the article's alef, so try بالصبر -> الصبر before صبر
                    tries = ['ال' + rest, rest] if kf is skey and pre in ('وال', 'فال', 'بال', 'كال', 'لل') else [rest]
                    for k2 in tries:
                        roots = [r for r, _ in surface.get(k2, [])]
                        lemmas = [l for l, _ in lemma_of.get(k2, [])]
                        if roots or lemmas:
                            break
                    if roots or lemmas:
                        break
        return roots, lemmas

    def resolve_word(self, tok):
        """Arabic token -> (roots, lemmas) through the written forms of the Quran: the lemma most often written
        with the typed letters, a lemma whose citation form has exactly these letters first (صابِر, رازِق,
        إِيمان over the oaths أَيْمان); then the same with the article added (قيامة -> القيامة, on tokens that
        carry the article); a particle or pronoun reading (له، في، ما، لكن) means «no word»: it is searched as
        a written form instead; last the loose stem keys."""
        k = fkey(tok)
        if len(k) < 2 or (normalize(tok) in QUERY_PARTICLES and not k.startswith('آ')):
            return [], []
        views, via = self._form_lookup(tok)
        cited = self._cited(k)
        pick = self._pick_lemma(views, self.form_lem, cited, via)
        if pick is None and not k.startswith('ال'):
            art, avia = self._form_lookup('ال' + k)
            if avia in ('exact', 'seats', 'ta'):
                pick = self._pick_lemma({v for v in art if v in self.form_lem_det}, self.form_lem_det, cited, avia)
        if pick is None and len(cited) == 1:
            pick = cited[0]
        if pick == '':
            return [], []
        if pick:
            r = self.lem_root.get(pick)
            return ([r] if r else []), [pick]
        roots, lemmas = self._lookup(skey(tok), skey, self.surface_s, self.lemma_of_s)
        if not roots and not lemmas:
            roots, lemmas = self._lookup(key(tok), key, self.surface, self.lemma_of)
        rk = root_key(tok)
        if rk in self.root_by_key and self.root_by_key[rk] not in roots and len(rk) in (3, 4):
            roots.append(self.root_by_key[rk])
        return roots[:2], lemmas[:2]

    def _cited(self, k):
        """Searchable lemmas whose citation form is written with exactly the letters k (seats folded when k has
        no hamza; the article stripped: العالم -> عالَم)."""
        out = list(self.lem_by_letters.get(k, ()))
        if not out and not any(c in HAMZA for c in k):
            fk = fold_seats(k)
            out = [l for kk, ls in self.lem_by_letters.items() if fold_seats(kk) == fk for l in ls]
        if not out and k.startswith('ال') and len(k) > 3:
            out = [l for l in self._cited(k[2:]) if self.lemma_pos.get(l) != 'V']
        return out

    def _pick_lemma(self, views, table, cited, via):
        """The lemma to search for the views a typed word named. '' = a particle / pronoun / function-word
        reading wins (search the written form); None = nothing. A citation form with these letters beats a
        count of other words' tokens, and beats any lenient (non-exact) surface match."""
        c = collections.Counter()
        for v in views:
            c.update(table.get(v, ()))
        content = {l: n for l, n in c.items() if l and l in self.searchable}
        other = sum(n for l, n in c.items() if not (l and l in self.searchable))
        cited_in = {l: n for l, n in content.items() if l in cited}
        if cited_in:
            return max(cited_in, key=lambda l: (cited_in[l], self.lem_na.get(l, 0), l))
        if cited and via != 'exact' and (views or len(cited) == 1):
            # the citation form beats a lenient surface match; two citation forms with no written evidence
            # (عَصا staff / disobeyed) are left to the stem index
            return max(cited, key=lambda l: (self.lem_na.get(l, 0), l))
        if content:
            best = max(content, key=lambda l: (content[l], self.lem_na.get(l, 0), l))
            return '' if other > content[best] and not cited else best
        return '' if other else None

    def locate_text(self, q):
        raw = []
        for w in normalize(q).split():
            # modern spelling writes the vocative يا apart; the Mushaf joins it to the next word (يَٰٓأَيُّهَا)
            if raw and raw[-1] == 'يا':
                raw[-1] += w
            else:
                raw.append(w)
        ws = [lkey(w) for w in raw]
        grams = {' '.join(ws[t:t + 3]) for t in range(len(ws) - 2)}
        if not grams:
            return []
        cnt = collections.Counter()
        for g in grams:
            for i in self.tri.get(g, ()):
                cnt[i] += 1
        if not cnt:
            return []
        best = max(cnt.values())
        # ties: prefer the ayah whose length is closest to the pasted text, then Mushaf order
        cand = [i for i, c in cnt.items() if c / len(grams) >= 0.5 and c >= 0.8 * best]
        # the loose key drops alef (الخاسرون = الأخسرون, اذهبا = اذهب): exact-letter word matches break ties
        exact_q = collections.Counter(normalize(w, keep_hamza=False) for w in raw)
        def exact(i):
            have = collections.Counter(normalize(w[0]).replace(' ', '') for w in self.ayat[i]['w'])
            return sum((exact_q & have).values())
        rank = {i: (-cnt[i], -exact(i), abs(len(self.ayat[i]['w']) - len(ws)), i) for i in cand}
        cand.sort(key=rank.get)
        # a refrain repeated word for word (26:8-9 ×8) comes back whole, otherwise the best three
        same = [i for i in cand if rank[i][:3] == rank[cand[0]][:3]]
        return cand[:max(3, min(len(same), MAX_SEEDS))]

    def analyze(self, q, mode='auto', precision='auto', match='auto'):
        q = re.sub(r'\s+', ' ', clean_query(q)).strip()
        note = f'query cut to its first {MAX_QUERY} characters' if len(q) > MAX_QUERY else None
        q = q[:MAX_QUERY]
        # «…» / "…" asks for the written form exactly as typed
        if len(q) > 2 and q[0] in QUOTES and q[-1] in QUOTES:
            q = q[1:-1].strip()
            if precision == 'auto':
                precision = 'form'
        if precision == 'stem':   # (deferred: form ± article ± possessive) is answered as form for now
            precision = 'form'
        info = dict(q=q, kind=None, roots=[], lemmas=[], seeds=[], note=note, lang='ar' if is_arabic(q) else 'en',
                    precision=None, match=None, fviews=None, form=None, qviews=None, hits=None, level=None)
        # a lemma id «text|root» (from a lemma button or suggestion) names exactly one word
        lid = self.lemma_ids.get(q) if '|' in q else None
        if lid and mode in ('auto', 'word'):
            info.update(kind='word', roots=[self.lem_root[lid]], lemmas=[lid], precision='lemma')
            self._typed_form(info, lemma_text(lid))
            return info
        # a fully vowelled word that is exactly a lemma (عُمْرَة) means that word, whatever its bare letters match
        exact = self.lem_by_text.get(q) if mode in ('auto', 'word') and re.search('[\u064B-\u0652]', q) else None
        if exact:
            l = max(exact, key=lambda x: self.lem_na.get(x, 0))
            info.update(kind='word', roots=[self.lem_root[l]] if self.lem_root.get(l) else [], lemmas=[l], precision='lemma')
            self._typed_form(info, q)
            return info
        if mode in ('auto', 'ayah'):
            ref = self.parse_ref(q)
            if ref is not None:
                ids, note = ref
                info.update(kind='ayah' if ids else 'none', seeds=ids, note=note)
                return info
        m = ROOT_RE.match(q)
        if mode == 'root' or m or (mode != 'topic' and SPACED_ROOT_RE.match(q)):
            rk = root_key(m.group(1) if m else q)
            r = self.root_by_key.get(rk)
            if not r and (mode == 'root' or m):
                rs, _ = self.resolve_word(m.group(1) if m else q)
                r = rs[0] if rs else None
            if r:
                info.update(kind='root', roots=[r], precision='root')
                return info
            if mode == 'root':
                info['note'] = 'not a known root, so this was searched as a topic'
        if info['lang'] == 'ar':
            toks = normalize(q, keep_hamza=True).split()   # hamza seats, ة and ى kept (fkey does the rest)
            if len(toks) == 1 and mode in ('auto', 'word'):
                self._analyze_word(info, toks[0], precision)
                return info   # a single Arabic word is never a topic: no hit means suggestions, not guesses
            if 2 <= len(toks) <= MAX_PHRASE and mode in ('auto', 'word') and self._analyze_phrase(info, toks, match, mode):
                return info
            if mode in ('auto', 'ayah') and len(toks) >= 4:
                seeds = self.locate_text(q)
                if seeds:
                    info.update(kind='ayah', seeds=seeds)
                    return info
            if mode == 'word' or (len(toks) <= MAX_PHRASE and match == 'any'):
                # any of the words (Word mode never searches by meaning)
                for t in toks:
                    rs, ls = self.resolve_word(t)
                    info['roots'] += [r for r in rs[:1] if r not in info['roots']]
                    info['lemmas'] += [l for l in ls[:1] if l not in info['lemmas']]
                info.update(kind='word', match='any', precision='lemma')
                if not info['roots'] and not info['lemmas']:
                    info['note'] = 'none of these words occurs in the Quran'
                return info
        info['kind'] = 'topic'
        if info['lang'] == 'ar':
            for t in normalize(q, keep_hamza=True).split():
                if len(key(t)) >= 2:
                    rs, ls = self.resolve_word(t)
                    info['roots'] += [r for r in rs[:1] if r not in info['roots']]
                    info['lemmas'] += [l for l in ls[:1] if l not in info['lemmas']]
            # function-like roots (بين، شيء، قول …) make short unrelated ayat win a topic's lexical list
            if len(info['roots']) > 1:
                rare = [r for r in info['roots'] if self.roots[r]['na'] <= 400]
                dropped = set(info['roots']) - set(rare) if rare else set()
                info['roots'] = rare or info['roots']
                info['lemmas'] = [l for l in info['lemmas'] if self.lem_root.get(l) not in dropped]
        return info

    def _typed_form(self, info, tok):
        """The written form the query names (for the «exact form» level and its count)."""
        views, via = self._form_lookup(tok)
        chosen = set(info['lemmas'])
        if chosen:
            # the typed letters may fit several words (عصا), or only another word leniently (قيامة -> قَيِّمَة):
            # keep the forms written for the chosen reading; a bare noun the Quran only writes with the article
            # takes that form (قيامة -> القيامة)
            views = {v for v in views if chosen & set(self.form_lem.get(v, ()))}
            if not views and not fkey(tok).startswith('ال'):
                art, avia = self._form_lookup('ال' + fkey(tok))
                views = {v for v in art if v in self.form_lem_det and chosen & set(self.form_lem_det.get(v, ()))}
                via = 'article' if views else via
        info['fviews'] = views
        l0 = info['lemmas'][0] if info['lemmas'] else None
        info['form'] = dict(k=fkey(tok), t=self.form_display(next(iter(sorted(views)), fkey(tok)), l0), via=via if views else None, n=len(views))

    def _analyze_word(self, info, tok, precision):
        """One Arabic word: its lemma (every inflection), or just its written form (quoted / precision=form,
        or a particle / the opening letters which have no lemma)."""
        rs, ls = self.resolve_word(tok)
        if ls or rs:
            info.update(kind='word', roots=rs[:1], lemmas=ls[:1], precision='lemma')
            self._typed_form(info, tok)
            if precision == 'form':
                if info['fviews']:
                    info['precision'] = 'form'
                else:
                    info['note'] = 'this exact form does not occur: showing the word with its inflections'
            return
        views, via = self._form_lookup(tok)
        info.update(kind='word', precision='form', fviews=views,
                    form=dict(k=fkey(tok), t=self.form_display(next(iter(sorted(views)), fkey(tok))), via=via, n=len(views)))
        if not views:
            info['note'] = f'no ayah contains {tok}'

    @staticmethod
    def _fuse_ya(toks):
        """The vocative يا is written as part of the next word in the Mushaf (يَٰٓأَيُّهَا، يَٰقَوْمِ)."""
        out = []
        for t in toks:
            if out and out[-1] == 'يا':
                out[-1] = 'يا' + t
            else:
                out.append(t)
        return out

    def _analyze_phrase(self, info, toks, match, mode):
        """2-8 Arabic words: the exact sequence of written forms (each word by _form_lookup); when it occurs
        nowhere, every word (lemma level, then root level). A sequence that covers an ayah is that ayah.
        -> True when the query is answered (also when the answer is empty: no silent fall-back to meaning)."""
        fused = self._fuse_ya(toks)
        if match in ('auto', 'phrase'):
            per = [self._form_lookup(t)[0] for t in fused]
            if all(per):
                hits, spans = self._phrase_hits(per)
                whole = sorted(i for i in hits if any(q - p >= 0.9 * len(self.ayat[i]['w']) for p, q in spans[i]))
                if whole and mode == 'auto':
                    info.update(kind='ayah', seeds=whole[:MAX_SEEDS])
                    return True
                if hits:
                    info.update(kind='phrase', match='phrase', precision='form', qviews=per, hits=sorted(hits))
                    return True
            if match == 'phrase':
                info.update(kind='phrase', match='phrase', precision='form', qviews=per, hits=[], note='this phrase does not occur')
                return True
        if match in ('auto', 'all'):
            res = [self.resolve_word(t) for t in toks]
            content = [(rs, ls) for rs, ls in res if rs or ls]
            if content:
                if all(ls for _, ls in content):
                    lemmas = []
                    for _, ls in content:
                        if ls[0] not in lemmas:
                            lemmas.append(ls[0])
                    cols = [self.lem_col[l] for l in lemmas if l in self.lem_col]
                    hit = np.asarray((self.Xl[:, cols] > 0).sum(1)).ravel() == len(cols) if cols else np.zeros(self.N, bool)
                    if hit.any():
                        roots = [self.lem_root[l] for l in lemmas if self.lem_root.get(l)]
                        info.update(kind='phrase', match='all', precision='lemma', level='lemma', lemmas=lemmas,
                                    roots=list(dict.fromkeys(roots)), hits=np.flatnonzero(hit).tolist())
                        return True
                roots = []
                for rs, _ in content:
                    if rs and rs[0] not in roots:
                        roots.append(rs[0])
                cols = [self.root_col[r] for r in roots if r in self.root_col]
                if cols and len(cols) == len(content):
                    hit = np.asarray((self.Xr[:, cols] > 0).sum(1)).ravel() == len(cols)
                    if hit.any():
                        info.update(kind='phrase', match='all', precision='root', level='root', roots=roots,
                                    hits=np.flatnonzero(hit).tolist())
                        return True
            if match == 'all' or mode == 'word':
                info.update(kind='phrase', match='all', precision='lemma', hits=[], note='no ayah contains all of these words')
                return True
        return False

    def _phrase_hits(self, per):
        """Ayat where the words occur in sequence (per = a set of views for each query word) -> (ids, spans)."""
        sets = [set().union(*(self.form_idx.get(v, ()) for v in vs)) for vs in per]
        cand = set.intersection(*sets) if sets else set()
        spans = {}
        for i in cand:
            sp = self._phrase_spans(i, per)
            if sp:
                spans[i] = sp
        return set(spans), spans

    def _phrase_spans(self, i, per):
        tv = self.tok_views[i]
        n = len(per)
        return [(p, p + n) for p in range(len(tv) - n + 1) if all(tv[p + t] & per[t] for t in range(n))]

    # ------------------------------------------------------------------ ranking
    def _col_scores(self, X, cols, idf):
        """Sum of TF-IDF weights, boosted by how many (and how rare) of the query terms an ayah contains."""
        if not cols:
            return None
        sub = X[:, cols]
        cover = np.asarray((sub > 0).astype(np.float64) @ idf[cols]).ravel() / max(idf[cols])
        # ayat with more of the query's terms come first; TF-IDF (which favours short ayat) only breaks ties
        return np.where(cover > 0, cover * 10.0 + np.asarray(sub.sum(1)).ravel(), 0.0)

    def _mask(self, scope):
        return self.meccan if scope == 'meccan' else (~self.meccan if scope == 'medinan' else None)

    def search(self, q, mode='auto', n=60, scope='all', precision='auto', meaning=None, group='auto', match='auto'):
        """n: an int (graph cap), None (every match) or 'auto' (every hit of a word / root / phrase search up to
        AUTO_ALL, else AUTO_N; 60 for topics and ayat). meaning: '0' (no meaning anywhere), 'edges' (meaning
        links between the hits only; the default of word / root / phrase searches) or '1' (meaning-ranked
        results too; the default of topic / ayah searches)."""
        info = self.analyze(q, mode, precision=precision, match=match)
        q = info['q']   # cleaned (NFKC, no zero-width marks, whitespace collapsed, length-capped)
        if info['kind'] == 'none':
            return dict(error=info['note'] or f'no ayah {info["q"]}', query=self._public_info(info), seeds=[],
                        results=[], rest=[], total=0, weak=False, semantic=self.semantic_ready,
                        graph=dict(nodes=[], edges=[], themes=[], subthemes=[], theme_links=[]))
        mask = self._mask(scope)
        precise = info['kind'] in ('word', 'root', 'phrase')
        if meaning is None:
            meaning = 'edges' if precise else '1'
        if precise and meaning != '1':
            return self._search_precise(info, n, mask, scope, meaning, group)
        return self._search_fused(info, n, mask, meaning)

    def _n_eff(self, n, total):
        if n is None or n == 'all':
            return MAX_GRAPH
        if n == 'auto':
            return total if total is not None and total <= AUTO_ALL else AUTO_N
        return n

    def _hit_set(self, info, mask):
        """Every ayah the query names (bool array), by its kind / precision / match."""
        hit = np.zeros(self.N, bool)
        k = info['kind']
        if k == 'phrase':
            hit[info['hits'] or []] = True
        elif k == 'root':
            for r in info['roots']:
                if r in self.root_col:
                    hit |= np.asarray(self.Xr[:, self.root_col[r]].todense()).ravel() > 0
        elif k == 'word':
            if info['precision'] == 'form':
                for v in info['fviews'] or ():
                    hit[list(self.form_idx.get(v, ()))] = True
            else:
                lemma_roots = {self.lem_root.get(l) for l in info['lemmas']}
                cols = [self.lem_col[l] for l in info['lemmas'] if l in self.lem_col]
                if cols:
                    hit |= np.asarray((self.Xl[:, cols] > 0).sum(1)).ravel() > 0
                rc = [self.root_col[r] for r in info['roots'] if r not in lemma_roots and r in self.root_col]
                if rc:   # a word that resolved to a root alone counts the whole root
                    hit |= np.asarray((self.Xr[:, rc] > 0).sum(1)).ravel() > 0
        if mask is not None:
            hit &= mask
        return hit

    def _levels(self, info, mask):
        """Ayah counts of the query at each level, for the «match» ladder."""
        out = {}
        k = info['kind']
        count = lambda arr: int((arr & mask).sum() if mask is not None else arr.sum())   # noqa: E731
        if k == 'word':
            if info['fviews']:
                f = np.zeros(self.N, bool)
                for v in info['fviews']:
                    f[list(self.form_idx.get(v, ()))] = True
                out['form'] = count(f)
            cols = [self.lem_col[l] for l in info['lemmas'] if l in self.lem_col]
            if cols:
                out['lemma'] = count(np.asarray((self.Xl[:, cols] > 0).sum(1)).ravel() > 0)
            rc = [self.root_col[r] for r in info['roots'] if r in self.root_col]
            if rc:
                out['root'] = count(np.asarray((self.Xr[:, rc] > 0).sum(1)).ravel() > 0)
        elif k == 'root':
            out['root'] = count(self._hit_set(info, None))
        elif k == 'phrase':
            out[info['match'] or 'phrase'] = count(self._hit_set(info, None))
        return out

    def _search_precise(self, info, n, mask, scope, meaning, group):
        """Word / root / phrase: the hit set only. Boxes by lemma or form (a concordance) or by theme; the
        graph draws every hit up to the cap, else a fair sample whose prefixes are stable (_sample_order)."""
        hit = self._hit_set(info, mask)
        hit_ids = np.flatnonzero(hit).tolist()
        total = len(hit_ids)
        grouping = self._boxes(info, hit_ids, group)
        info['group'] = grouping['kind'] if grouping else 'theme'
        if grouping:
            order = self._sample_order(grouping['lists'])
        else:
            order = self._bitrev(hit_ids)
        ranked = order[:min(MAX_GRAPH, self._n_eff(n, total))]
        results = [self._result(i, 0.0, info, None) for i in ranked]
        graph = self.build_graph(info, [], results, grouping=grouping, meaning=meaning != '0', max_roots=8,
                                 min_root=max(3, math.ceil(0.1 * len(ranked))), flat=True)
        shown = set(ranked)
        rest = [i for i in hit_ids if i not in shown]
        extra = dict(levels=self._levels(info, mask), forms=self._forms_of(info, mask), siblings=self._siblings(info),
                     group=info['group'], suggest=self._suggest(info) if total == 0 or info['match'] == 'all' else [])
        if info['kind'] == 'word' and info['roots']:
            r = info['roots'][0]
            extra['root'] = dict(r=r, na=self.roots[r]['na'])
        return dict(query=self._public_info(info, extra), seeds=[], results=results, rest=rest, graph=graph,
                    total=total, weak=False, semantic=self.semantic_ready)

    @staticmethod
    def _bitrev(ids):
        """ids (Mushaf order) in bit-reversed order: ½, ¼, ¾ … so every prefix is spread over the whole list."""
        m = len(ids)
        if m < 2:
            return list(ids)
        bits = max(1, (m - 1).bit_length())
        out = []
        for x in range(1 << bits):
            r = int(f'{x:0{bits}b}'[::-1], 2)
            if r < m:
                out.append(ids[r])
        return out

    def _sample_order(self, lists):
        """A deterministic order over boxes (each a Mushaf-ordered list): one ayah from every box first, then
        Sainte-Laguë over box sizes, inside a box in bit-reversed order. Every n then draws a fair sample, and a
        larger n only adds to a smaller one."""
        queues = [self._bitrev(l) for l in lists if l]
        taken = [0] * len(queues)
        out = []
        for k, qq in enumerate(queues):
            out.append(qq[0])
            taken[k] = 1
        while True:
            best, score = -1, 0.0
            for k, qq in enumerate(queues):
                if taken[k] < len(qq):
                    sc = len(qq) / (2 * taken[k] + 1)
                    if sc > score:
                        best, score = k, sc
            if best < 0:
                return out
            out.append(queues[best][taken[best]])
            taken[best] += 1

    def _boxes(self, info, hit_ids, group):
        """Lemma / form boxes of a concordance search, computed on the whole hit set so every n agrees, or
        None for theme grouping. -> dict(kind, boxes=[{key, label_ar, label_en, kind, pos, n, misc}],
        box_of={ayah: box index}, also={ayah: [other box indices]}, subs={box index: [(label, [ids])]}, lists)."""
        k = info['kind']
        if group == 'auto':
            group = 'lemma' if k == 'root' else 'form' if k == 'word' else 'theme'
            if k == 'word' and info['precision'] == 'form' and len({l for v in info['fviews'] or () for l in self.form_lem.get(v, ()) if l}) > 1:
                group = 'lemma'
        elif group == 'form' and k not in ('word', 'root'):
            group = 'theme'
        elif group == 'lemma' and k not in ('word', 'root'):
            group = 'theme'
        if group == 'theme' or not hit_ids:
            return None
        members = collections.defaultdict(list)    # box key -> ayah ids (Mushaf order)
        per_ayah = {}                               # ayah -> keys in word order
        if group == 'lemma':
            roots = set(info['roots'])
            fv = info['fviews'] if k == 'word' and info['precision'] == 'form' else None
            for i in hit_ids:
                keys = []
                for j, w in enumerate(self.ayat[i]['w']):
                    ok = (fv is not None and self.tok_views[i][j] & fv) or (fv is None and w[1] in roots)
                    if ok and w[2] and w[2] not in keys:
                        keys.append(w[2])
                per_ayah[i] = keys
        else:   # form
            lemmas = set(info['lemmas'])
            fv = info['fviews'] if info['precision'] == 'form' else None
            for i in hit_ids:
                keys = []
                for j, w in enumerate(self.ayat[i]['w']):
                    ok = (fv is not None and self.tok_views[i][j] & fv) or (fv is None and w[2] in lemmas)
                    if ok and self.tok_core[i][j] not in keys:
                        keys.append(self.tok_core[i][j])
                per_ayah[i] = keys
        na = collections.Counter()
        for i, keys in per_ayah.items():
            for x in keys:
                na[x] += 1
        if group == 'form' and k == 'word':
            # form boxes only pay when the word is written in several ways
            big = [x for x in na if na[x] >= 3]
            if len(big) < 2 or max(na.values()) >= 0.9 * len(hit_ids):
                return None
        # an ayah with several lemmas / forms sits in its rarest one's box (no box is left empty for it)
        for i, keys in per_ayah.items():
            if not keys:
                keys = ['']
                per_ayah[i] = keys
            home = min(keys, key=lambda x: (na.get(x, 0), keys.index(x)))
            members[home].append(i)
        size = {x: len(v) for x, v in members.items()}
        keep = sorted(size, key=lambda x: (-size[x], x))[:MAX_BOXES] if len(size) > MAX_BOXES + 1 else list(size)
        if group == 'lemma':
            rank = {'V': 0, 'N': 1, 'PN': 2}
            keep.sort(key=lambda x: (rank.get(self.lemma_pos.get(x), 1), -size[x], x))
        else:
            keep.sort(key=lambda x: (-size[x], x))
        other = [x for x in size if x not in keep]
        boxes, box_of, index = [], {}, {}
        for x in keep:
            index[x] = len(boxes)
            if group == 'lemma':
                r = self.lem_root.get(x)
                boxes.append(dict(key=x, kind='lemma', pos=self.lemma_pos.get(x), n=na[x], misc=False,
                                  label_ar=self._display_lemma(x, r) if x else '·', label_en=self._gloss(x) if x else '',
                                  roots=[r] if r else []))
            else:
                lem = self.form_lem.get(x, collections.Counter()).most_common(1)
                boxes.append(dict(key=x, kind='form', pos=None, n=na[x], misc=False,
                                  label_ar=self.form_display(x, info['lemmas'][0] if info['lemmas'] else None) if x else '·',
                                  label_en=self._gloss(lem[0][0]) if lem and lem[0][0] else '', roots=[]))
        if other:
            index.update({x: len(boxes) for x in other})
            boxes.append(dict(key='', kind='misc', pos=None, n=sum(na[x] for x in other), misc=True,
                              label_ar='صيغ أخرى', label_en='other forms', roots=[]))
        for x, ids in members.items():
            for i in ids:
                box_of[i] = index[x]
        # (a form that is never an ayah's rarest one has no box: it is listed under the ayah's own box only)
        also = {i: sorted({index[x] for x in keys if x in index and index[x] != box_of[i]}) for i, keys in per_ayah.items() if len(keys) > 1}
        also = {i: v for i, v in also.items() if v}
        lists = [[] for _ in boxes]
        for i in hit_ids:
            lists[box_of[i]].append(i)
        # a big lemma box splits into form sub-boxes (its rarest form first for an ayah with two)
        subs = {}
        if group == 'lemma':
            for b, x in enumerate(keep):
                ids = lists[b]
                if len(ids) < SUB_FORMS_MIN:
                    continue
                fna, forms_of = collections.Counter(), {}
                for i in ids:
                    fs = []
                    for j, w in enumerate(self.ayat[i]['w']):
                        if w[2] == x and self.tok_core[i][j] not in fs:
                            fs.append(self.tok_core[i][j])
                    forms_of[i] = fs
                    for f in fs:
                        fna[f] += 1
                top = [f for f, c in fna.most_common(6) if c >= 3]
                if len(top) < 2:
                    continue
                parts = collections.defaultdict(list)
                for i in ids:
                    cand = [f for f in forms_of[i] if f in top]
                    if cand:
                        parts[min(cand, key=lambda f: (fna[f], cand.index(f)))].append(i)
                subs[b] = [(dict(key=f, kind='form', label_ar=self.form_display(f, x), label_en='', n=fna[f]), parts[f])
                           for f in top if parts[f]]
                if len(subs[b]) < 2:
                    del subs[b]
        return dict(kind=group, boxes=boxes, box_of=box_of, also=also, subs=subs, lists=lists)

    def _forms_of(self, info, mask):
        """The written forms of the searched word with counts (query.forms), the typed form first."""
        if info['kind'] != 'word':
            return []
        typed = set(info['fviews'] or ())
        cores = collections.Counter()
        if info['lemmas']:
            for l in info['lemmas']:
                cores.update(self.lemma_forms.get(l, ()))
        else:
            for v in typed:
                for i in self.form_idx.get(v, ()):
                    for j, vs in enumerate(self.tok_views[i]):
                        if v in vs:
                            cores[self.tok_core[i][j]] += 1
        tk = info['form']['k'] if info['form'] else ''
        rows = []
        for c, n in cores.most_common():
            ids = sorted(i for i in self.core_na.get(c, ()) if mask is None or mask[i])
            if not ids:
                continue
            rows.append(dict(k=c, t=self.form_display(c, info['lemmas'][0] if info['lemmas'] else None), n=n, na=len(ids), ids=ids,
                             sel=c == tk or c in typed))
        rows.sort(key=lambda x: (not x['sel'], -x['n'], x['k']))
        info['forms_more'] = max(0, len(rows) - 12)
        return rows[:12]

    def _siblings(self, info):
        """The other lemmas of the searched word's root (query.siblings), by ayah count."""
        if info['kind'] != 'word' or not info['roots']:
            return []
        r = info['roots'][0]
        tok = dict(self.roots[r]['lem'])
        out = []
        for l, na in self.root_lemmas.get(r, collections.Counter()).most_common():
            if l in info['lemmas'] or l not in self.searchable:
                continue
            out.append(dict(l=l, t=self._display_lemma(l, r), pos=self.lemma_pos.get(l), g=self._gloss(l), n=tok.get(l, 0), na=na))
        return out

    def _suggest(self, info):
        """What to offer when a word / phrase matched nothing, or a phrase was only found word by word
        (query.suggest, ≤5): the ه/ة and ى/ي spellings, one-edit forms, a word the Mushaf writes as two
        (إنشاء الله -> إن شاء الله), the root, and a meaning search. Never a silent fall-back."""
        toks = normalize(info['q'], keep_hamza=True).split()
        out, seen = [], set()
        if len(toks) > 1:
            self._suggest_splits(toks, out, seen)

        def add(kind, value, label, n):
            if value not in seen and len(out) < 5:
                seen.add(value)
                out.append(dict(kind=kind, value=value, label=label, n=n))
        if not toks:
            return out
        for t in toks:
            k = fkey(t)
            if not k or k in self.form_idx:
                continue
            cands = []
            if k.endswith('ه'):
                cands.append(k[:-1] + 'ة')
            if k.endswith('ة'):
                cands.append(k[:-1] + 'ه')
            if k.endswith('ى'):
                cands.append(k[:-1] + 'ي')
            if k.endswith('ي'):
                cands.append(k[:-1] + 'ى')
            letters = 'ابتثجحخدذرزسشصضطظعغفقكلمنهويةىءأإآؤئ'
            edits = set()
            for p in range(len(k) + 1):
                for c in letters:
                    edits.add(k[:p] + c + k[p:])
            for p in range(len(k)):
                edits.add(k[:p] + k[p + 1:])
                for c in letters:
                    edits.add(k[:p] + c + k[p + 1:])
                if p + 1 < len(k):
                    edits.add(k[:p] + k[p + 1] + k[p] + k[p + 2:])
            found = sorted((e for e in cands + sorted(edits) if e in self.form_idx and e not in cands), key=lambda e: -len(self.form_idx[e]))
            cands = [e for e in cands if e in self.form_idx] + found
            for e in cands[:2]:
                lem = self.form_lem[e].most_common(1)[0][0]
                add('form', f'«{self.form_display(e)}»' if '|' not in lem else lem, self.form_display(e), len(self.form_idx[e]))
            if len(toks) == 1:
                for p in range(2, len(k) - 1):   # a word typed as one that the Mushaf writes as two (إنشاء = إن شاء)
                    x, y = k[:p], k[p:]
                    if x in self.form_idx and y in self.form_idx and self._phrase_hits([{x}, {y}])[0]:
                        add('phrase', f'{x} {y}', f'{x} {y}', len(self._phrase_hits([{x}, {y}])[0]))
                        break
            rk = root_key(t)
            if rk in self.root_by_key:
                r = self.root_by_key[rk]
                add('root', f'جذر:{r}', r, self.roots[r]['na'])
        if self.semantic_ready or info['lang'] == 'en':
            add('topic', info['q'], info['q'], 0)
        return out

    def _suggest_splits(self, toks, out, seen):
        """A phrase in which one typed word is two words of the Mushaf (إنشاء الله -> إن شاء الله, 6 ayat)."""
        fused = self._fuse_ya(toks)
        for t0, t in enumerate(fused):
            k = fkey(t)
            for p in range(2, len(k) - 1):
                x, y = k[:p], k[p:]
                if x not in self.form_idx or y not in self.form_idx:
                    continue
                words = fused[:t0] + [x, y] + fused[t0 + 1:]
                per = [self._form_lookup(w)[0] for w in words]
                if all(per):
                    ids, _ = self._phrase_hits(per)
                    if ids:
                        value = ' '.join(words)
                        if value not in seen:
                            seen.add(value)
                            out.append(dict(kind='phrase', value=value, label=value, n=len(ids)))
                        return

    def _search_fused(self, info, n, mask, meaning):
        """Topic / ayah searches (and meaning=1): Reciprocal Rank Fusion of lexical and meaning rank lists."""
        q = info['q']
        if n == 'auto':
            n = 60
        lists = []
        sem = None
        weak = False   # no word of the query exists in the Quran / translation: meaning-only guesses
        total = None   # how many ayat match lexically (root / lemma / surface), before the n cap
        hit_ids = []   # ... and which: the ones past the n cap come back as `rest` (the list shows every match)
        if info['kind'] == 'ayah':
            seeds = info['seeds']
            lex = np.asarray((self.Xlex @ self.Xlex[seeds].T).sum(1)).ravel()
            lists.append((1.0, top_ids(lex, 200, mask)))
            sem = self._query_sem(info)
            if sem is not None:
                lists.append((1.2, top_ids(np.where(self.short, -np.inf, sem), 200, mask)))
            ph = sorted({j for s in seeds for j, nn, g in self.phrase_nb[s]},
                        key=lambda j: -max((nn for s in seeds for jj, nn, g in self.phrase_nb[s] if jj == j), default=0))
            lists.append((1.0, [j for j in ph if mask is None or mask[j]][:100]))
        else:
            rcols = [self.root_col[r] for r in info['roots'] if r in self.root_col]
            lcols = [self.lem_col[l] for l in info['lemmas'] if l in self.lem_col]
            ar_resolved = info['lang'] == 'ar' and bool(info['roots'])
            lexical_w = 2.0 if info['kind'] in ('root', 'word', 'phrase') else (1.6 if ar_resolved else 0.8)
            sr = self._col_scores(self.Xr, rcols, self.tv_root.idf_)
            if sr is not None:
                lists.append((lexical_w, top_ids(np.where(sr > 0, sr, -np.inf), 400, mask)))
            sl = self._col_scores(self.Xl, lcols, self.tv_lem.idf_)
            if sl is not None:
                # for a word query the word itself (lemma) leads; the rest of its root follows
                lw = lexical_w * (1.3 if info['kind'] == 'word' else 0.8)
                lists.append((lw, top_ids(np.where(sl > 0, sl, -np.inf), 400, mask)))
            if info['kind'] in ('root', 'word', 'phrase'):
                hit = self._hit_set(info, mask)
                total = int(hit.sum())
                hit_ids = np.flatnonzero(hit).tolist()
                if info['kind'] == 'phrase' or (info['kind'] == 'word' and info['precision'] == 'form'):
                    sc = np.full(self.N, -np.inf)
                    sc[hit_ids] = 1.0
                    lists.append((2.0, top_ids(sc, 400, mask)))
            elif info['lang'] == 'ar' and (info['roots'] or info['lemmas']):
                # an Arabic topic counts the ayat _result marks: any of its words (lemma), plus the whole root
                # for a root that came without a lemma; ranking still caps the graph, the rest is listed
                lemma_roots = {self.lem_root.get(l) for l in info['lemmas']}
                hit = sl > 0 if sl is not None else np.zeros(self.N, bool)
                rc = [self.root_col[r] for r in info['roots'] if r not in lemma_roots and r in self.root_col]
                if rc:
                    hit |= np.asarray(self.Xr[:, rc].sum(1)).ravel() > 0
                if mask is not None:
                    hit &= mask
                total = int(hit.sum())
                hit_ids = np.flatnonzero(hit).tolist()
            weak = info['kind'] == 'topic' and not info['roots'] and not info['lemmas']
            if info['lang'] == 'en':
                qe = self.tv_en.transform([q])
                weak = weak and not qe.nnz
                if qe.nnz:
                    se = np.asarray((self.Xen @ qe.T).todense()).ravel()
                    lists.append((0.8, top_ids(np.where(se > 0, se, -np.inf), 200, mask)))
            sem = self._query_sem(info) if meaning != '0' else None
            if sem is not None:
                sem_w = 1.0 if info['kind'] in ('word', 'phrase') else (1.2 if ar_resolved else 2.0)
                lists.append((sem_w, top_ids(np.where(self.short, -np.inf, sem), 200, mask)))
        fused = rrf(lists)
        for s in info['seeds']:
            fused.pop(s, None)
        ranked = sorted(fused, key=fused.get, reverse=True)
        # every ranked list stops at 200–400 ayat, so lexical matches beyond them follow in Mushaf order:
        # a large graph (or `all`) then holds every match, not just the ones the ranking reached
        seen = set(ranked) | set(info['seeds'])
        ranked += [i for i in hit_ids if i not in seen]
        ranked = ranked[:MAX_GRAPH if n is None else n]   # `all` still stops at MAX_GRAPH (memory: n² matrices)
        results = [self._result(i, fused.get(i, 0.0), info, sem) for i in ranked]
        seeds = [self._result(i, 1.0, info, None) for i in info['seeds']]
        graph = self.build_graph(info, seeds, results, meaning=meaning != '0')
        # n caps the graph only: every other lexical match, in Mushaf order (ayah index order), for the list
        shown = set(ranked) | set(info['seeds'])
        rest = [i for i in hit_ids if i not in shown]
        extra = dict(levels=self._levels(info, mask), forms=self._forms_of(info, mask), siblings=self._siblings(info), group='theme',
                     suggest=self._suggest(info) if info['kind'] in ('word', 'phrase') and total == 0 else [])
        if info['kind'] == 'word' and info['roots']:
            extra['root'] = dict(r=info['roots'][0], na=self.roots[info['roots'][0]]['na'])
        return dict(query=self._public_info(info, extra), seeds=seeds, results=results, rest=rest, graph=graph,
                    total=total, weak=weak, semantic=self.semantic_ready)

    def _query_sem(self, info):
        """Meaning score of every ayah for an analysed query, as search ranks it (None for root queries)."""
        if info['kind'] == 'ayah':
            return self.Ef @ self.Ef[info['seeds']].mean(0) if self.Ef is not None and info['seeds'] else None
        if not self.E or info['kind'] in ('root', 'none') or not info['q']:
            return None
        qv = self._qvec(info['q'])
        weights = {'en': 0.5, 'tf': 0.3, 'ar': 0.2} if info['lang'] == 'en' else {'tf': 0.45, 'ar': 0.35, 'en': 0.2}
        return sum(w * (self.E[k] @ qv) for k, w in weights.items() if k in self.E)

    def _hl_info(self, q, mode='auto', precision='auto', match='auto'):
        """Analysed query for marking ayat outside a search (expand, cards, passage): the same hl/rel the
        search gives, including the written-form marks of a form / phrase search."""
        info = dict(q='', kind=None, roots=[], lemmas=[], seeds=[], precision=None, match=None, fviews=None, qviews=None, hits=None)
        if q:
            info = self.analyze(q, mode, precision=precision, match=match)
            if info['kind'] in ('ayah', 'none'):
                info.update(roots=[], lemmas=[], fviews=None, qviews=None)
        return info

    def cards(self, ids, q, mode='auto', precision='auto', match='auto'):
        """Result cards for ayat named by id (the list's `rest`), highlighted for q exactly like search."""
        info = self._hl_info(q, mode, precision, match)
        sem = self._query_sem(info) if info['kind'] in ('topic', 'ayah') else None
        return [self._result(i, 0.0, info, sem) for i in ids]

    def root_marks(self, r, ids):
        """Word positions of root r in each ayah: the selected-node list underlines the clicked root's words."""
        return {i: [j for j, w in enumerate(self.ayat[i]['w']) if w[1] == r] for i in ids}

    def passage(self, s, a0, a1, q=None, mode='auto', precision='auto', match='auto'):
        """Ayat a0..a1 (inclusive, clamped to the surah, at most MAX_PASSAGE) of surah s, marked for q."""
        sur = self.surahs.get(s)
        if sur is None:
            return None
        a0 = max(1, min(sur['ayas'], a0))
        a1 = max(a0, min(sur['ayas'], a1, a0 + MAX_PASSAGE - 1))
        info = self._hl_info(q, mode, precision, match)
        ayat = []
        for a in range(a0, a1 + 1):
            r = self._result(self.ref[(s, a)], 0.0, info, None)
            ayat.append({k: r[k] for k in ('i', 'ref', 'a', 'words', 'hl', 'rel')})
        return dict(s=s, sname=sur['name'], tname=sur['tname'], ayas=sur['ayas'], ayat=ayat)

    def _public_info(self, info, extra=None):
        out = dict(info)
        out['roots'] = [dict(r=r, sp=r, n=self.roots[r]['n'], na=self.roots[r]['na']) for r in info['roots']]
        out['lemmas'] = [dict(l=l, t=lemma_text(l), g=self._gloss(l), r=self.lem_root.get(l), pos=self.lemma_pos.get(l))
                         for l in info['lemmas']]
        # other Quranic words written with these letters (عَصا: staff / disobeyed; علم: عِلْم / عَلِمَ / عَلَّمَ), each
        # offered as its own search with how often it is written so; the shown results stay the chosen reading
        also = collections.Counter()
        if info['kind'] == 'word' and info['lemmas']:
            l0 = info['lemmas'][0]
            tok = normalize(info['q'], keep_hamza=True).split()
            if len(tok) == 1:
                k = fkey(tok[0])
                views, via = self._form_lookup(tok[0])
                if via == 'ta':   # رحمه -> رحمة: the ه reading (رَحِمَهُ) is still offered
                    views = views | {k}
                for v in views:
                    also.update({x: n for x, n in self.form_lem.get(v, {}).items() if x and x != l0 and x in self.searchable})
                if k.startswith('ال') and len(k) > 3:   # the article: nouns only (not صَبَرَ for الصبر)
                    for v in self._form_lookup(k[2:])[0]:
                        also.update({x: n for x, n in self.form_lem.get(v, {}).items()
                                     if x and x != l0 and x in self.searchable and self.lemma_pos.get(x) != 'V'})
            for x in self.lemma_ids.values():   # the same lemma text under another root / as a proper noun
                if x != l0 and lemma_text(x) == lemma_text(l0) and x not in also:
                    also[x] = self.lem_na.get(x, 0)
            for x in self._cited(fkey(tok[0])) if len(tok) == 1 else ():   # a word whose citation form is exactly these letters (أَمْن for أمن)
                if x != l0 and x not in also:
                    also[x] = 0
        out['also'] = [dict(l=x, t=lemma_text(x), g=self._gloss(x), n=int(n), na=int(self.lem_na.get(x, 0)), pos=self.lemma_pos.get(x))
                       for x, n in sorted(also.items(), key=lambda kv: (-kv[1], -self.lem_na.get(kv[0], 0), kv[0]))[:3]]
        for k in ('fviews', 'qviews', 'hits', 'level'):
            out.pop(k, None)
        out['forms_more'] = info.get('forms_more', 0)
        out['seeds'] = [self.refstr(i) for i in info['seeds']]
        if extra:
            out.update(extra)
        return out

    def refstr(self, i):
        a = self.ayat[i]
        return f"{a['s']}:{a['a']}"

    def _result(self, i, score, info, sem):
        a = self.ayat[i]
        roots = set(info['roots'])
        lemmas = set(info['lemmas'])
        # a searched word marks that word (its lemma): searching الله must not mark إِلَٰه, and الجنة must not
        # mark ٱلْجَآنّ. Other words of the same root come back as `rel` (shown lighter). A root that was
        # searched as a root (no lemma of it in the query) marks the whole root. A written form (quoted, a
        # particle, the opening letters) marks the tokens written so, the rest of its lemma lighter; a phrase
        # marks its words in sequence.
        lemma_roots = {self.lem_root.get(l) for l in lemmas}
        if info.get('kind') == 'phrase' and info.get('match') == 'phrase':
            hl = sorted({j for p, q in self._phrase_spans(i, info['qviews']) for j in range(p, q)})
            rel = []
        elif info.get('precision') == 'form' and info.get('fviews') is not None:
            fv = info['fviews']
            hl = [j for j, vs in enumerate(self.tok_views[i]) if vs & fv]
            hs = set(hl)
            rel = [j for j, w in enumerate(a['w']) if j not in hs and w[2] and w[2] in lemmas]
        else:
            hl = [j for j, w in enumerate(a['w'])
                  if (w[2] and w[2] in lemmas) or (w[1] and w[1] in roots and w[1] not in lemma_roots)]
            rel = [j for j, w in enumerate(a['w']) if w[1] and w[1] in roots and w[1] in lemma_roots and j not in hl]
        why = []
        if hl:
            why.append('lexical')
        elif rel:
            why.append('same root')
        if sem is not None:
            why.append(f'meaning {float(sem[i]):.2f}')
        return dict(i=i, ref=self.refstr(i), s=a['s'], a=a['a'], score=round(score, 5),
                    sname=self.surahs[a['s']]['name'], stype=self.surahs[a['s']]['type'],
                    words=a['d'], hl=hl, rel=rel, en=a['en'], why=why, lexical=bool(hl))

    # ------------------------------------------------------------------ graph
    def build_graph(self, info, seeds, results, max_roots=22, k_sem=2, grouping=None, meaning=True, min_root=3, flat=False):
        """Hierarchical network: boxes -> sub-boxes -> ayat, with roots either inside the one box they belong
        to or between boxes as bridges. Boxes are themes (Louvain) or, for a concordance search (`grouping`
        from _boxes), the lemmas / written forms of the searched word. Layout happens in the browser.
        meaning=False draws no meaning links; flat: every ayah has the same rank (a concordance has no best hit)."""
        nodes, edges = {}, []
        ids = [r['i'] for r in seeds] + [r['i'] for r in results]
        idset = set(ids)
        rank = {r['i']: (0.35 if flat else n / max(1, len(results) - 1)) for n, r in enumerate(results)}
        lexical = {r['i'] for r in results if r.get('lexical') or r.get('rel')}

        for role, rows in (('seed', seeds), ('result', results)):
            for r in rows:
                i = r['i']
                a = self.ayat[i]
                nodes[f'a:{i}'] = dict(id=f'a:{i}', type='ayah', role=role, ref=self.refstr(i), label=self.refstr(i),
                                       s=a['s'], stype=self.surahs[a['s']]['type'], rank=round(rank.get(i, 0), 3),
                                       lexical=i in lexical or role == 'seed')

        # root hubs: roots shared by several result ayat, weighted by rarity
        cnt = collections.Counter()
        for i in ids:
            for r in set(self.ayah_roots[i]):
                cnt[r] += 1
        # roots in most results (the searched root, or e.g. غفر/رحم for "forgiveness") carry no structure,
        # and very common roots (in >450 ayat, e.g. أله قول كون ربب) link everything
        focus = set(info['roots']) | {r for r, c in cnt.items() if c > 0.5 * len(ids)}
        cand = [(c * self.root_idf.get(r, 1) ** 2, r) for r, c in cnt.items()
                if c >= min_root and r not in focus and self.roots[r]['na'] <= 450]
        cand.sort(reverse=True)
        chosen = [r for _, r in cand[:max_roots]]

        # ayah <-> ayah: meaning similarity (top-k above corpus percentile) + shared phrases
        sim = None
        aa = []
        if self.Ef is not None and len(ids) > 1 and meaning:
            V = self.Ef[ids]
            sim = V @ V.T
            np.fill_diagonal(sim, -1)
            seen = set()
            near = top_k(sim, k_sem)   # each ayah's k_sem nearest, nearest first (one pass, not a sort per row)
            for x in range(len(ids)):
                for y in near[x]:
                    if sim[x, y] < self.sem_edge_thr:
                        break
                    pr = tuple(sorted((ids[x], ids[y])))
                    if pr not in seen:
                        seen.add(pr)
                        aa.append(dict(s=f'a:{pr[0]}', t=f'a:{pr[1]}', type='meaning', w=round(float(sim[x, y]), 3)))
        seen_ph, per = set(), collections.Counter()
        for i in ids:
            for j, n, g in sorted(self.phrase_nb[i], key=lambda x: (-x[1], x[0])):
                pr = (min(i, j), max(i, j))
                if j not in idset or pr in seen_ph or per[i] >= 2 or per[j] >= 2:
                    continue
                seen_ph.add(pr)
                per[i] += 1
                per[j] += 1
                aa.append(dict(s=f'a:{pr[0]}', t=f'a:{pr[1]}', type='phrase', n=n, label=self.phrase_text(i, g)))

        lex = None if info['kind'] not in ('word', 'root', 'phrase') else {r['i'] for r in seeds} | lexical
        core = len(seeds) + CORE if len(results) > LARGE_GRAPH else None   # (seeds don't make a graph large)
        if grouping:
            themes, subthemes, theme_of, sub_of, also = self._group_boxes(grouping, ids)
        else:
            themes, subthemes, theme_of, sub_of = self._themes(ids, sim, set(info['roots']), lex, core=core)
            also = {}
        for i in ids:
            nd = nodes[f'a:{i}']
            nd['theme'] = theme_of[i]
            nd['parent'] = sub_of.get(i, theme_of[i])
            if i in also:   # an ayah with two forms of the root is listed under both; drawn in its rarer one
                nd['boxes'] = also[i]
                for tid in also[i]:
                    edges.append(dict(s=f'a:{i}', t=tid, type='form', cross='theme'))

        # a root lives inside a theme when most of its ayat are there; otherwise it bridges themes
        for r in chosen:
            mine = [i for i in ids if r in self.ayah_roots[i]]
            tc = collections.Counter(theme_of[i] for i in mine)
            home, top = tc.most_common(1)[0]
            home = home if top >= 0.65 * len(mine) else None
            nodes[f'r:{r}'] = dict(id=f'r:{r}', type='root', root=r, label=r, n=self.roots[r]['n'],
                                   na=len(mine), gloss=self._root_gloss(r), parent=home, theme=home,
                                   themes=sorted(tc))
            for i in sorted(set(mine)):
                cross = 'bridge' if home is None else (None if theme_of[i] == home else 'theme')
                edges.append(dict(s=f'a:{i}', t=f'r:{r}', type='root', cross=cross))
        for e in aa:
            x, y = int(e['s'][2:]), int(e['t'][2:])
            e['cross'] = ('theme' if theme_of[x] != theme_of[y]
                          else 'sub' if sub_of.get(x, theme_of[x]) != sub_of.get(y, theme_of[y]) else None)
            edges.append(e)

        # theme <-> theme links: cross-theme meaning/phrase edges and roots shared between themes
        tl = collections.defaultdict(lambda: dict(meaning=0, phrase=0, roots=0))
        for e in aa:
            if e['cross'] == 'theme':
                p = tuple(sorted((theme_of[int(e['s'][2:])], theme_of[int(e['t'][2:])])))
                tl[p][e['type']] += 1
        for r in chosen:
            ts = nodes[f'r:{r}']['themes']
            for x in range(len(ts)):
                for y in range(x + 1, len(ts)):
                    tl[(ts[x], ts[y])]['roots'] += 1
        both = collections.Counter()
        for i, tids in also.items():
            for tid in tids:
                both[tuple(sorted((theme_of[i], tid)))] += 1
        for pr in both:
            tl[pr]['roots'] += 0
        theme_links = [dict(s=p[0], t=p[1], n=v['meaning'] + v['phrase'] + v['roots'] + both.get(p, 0), both=both.get(p, 0), **v)
                       for p, v in sorted(tl.items())]
        self._order_themes(themes, theme_links)
        return dict(nodes=list(nodes.values()), edges=edges, themes=themes, subthemes=subthemes,
                    theme_links=theme_links)

    @staticmethod
    def _group_boxes(grouping, ids):
        """The concordance boxes (lemmas / written forms, from _boxes) restricted to the drawn ayat, in the
        same shape as _themes: -> themes, subthemes, {ayah: theme id}, {ayah: sub id}, {ayah: [other theme ids]}."""
        drawn = set(ids)
        themes, subthemes, theme_of, sub_of, also = [], [], {}, {}, {}
        tid_of = {}
        for b, box in enumerate(grouping['boxes']):
            members = [i for i in grouping['lists'][b] if i in drawn]
            if not members:
                continue
            tid = f't{len(themes)}'
            tid_of[b] = tid
            for i in members:
                theme_of[i] = tid
            themes.append(dict(id=tid, c=len(themes), size=len(members), misc=box['misc'], related=False,
                               label_ar=box['label_ar'], label_en=box['label_en'], roots=box['roots'], formula='',
                               kind=box['kind'], key=box['key'], n=box['n'], pos=box['pos']))
            parts = [(lab, [i for i in part if i in drawn]) for lab, part in grouping['subs'].get(b, [])]
            parts = [(lab, part) for lab, part in parts if part]
            if len(parts) >= 2:
                for j, (lab, part) in enumerate(parts):
                    sid = f'{tid}.{j}'
                    for i in part:
                        sub_of[i] = sid
                    subthemes.append(dict(id=sid, parent=tid, size=len(part), label_ar=lab['label_ar'], label_en=lab['label_en'],
                                          kind=lab['kind'], key=lab['key'], n=lab['n']))
        for i in ids:
            others = [tid_of[b] for b in grouping['also'].get(i, ()) if b in tid_of]
            if others:
                also[i] = others
        return themes, subthemes, theme_of, sub_of, also

    def _root_gloss(self, r):
        lem = self.roots[r]['lem']
        return self._gloss(lem[0][0]) if lem else ''

    @staticmethod
    def _order_themes(themes, links):
        """Greedy ring order: each next theme is the one most linked to the previous, so related
        themes sit side by side around the query."""
        if not themes:
            return
        w = collections.Counter()
        for l in links:
            w[(l['s'], l['t'])] = w[(l['t'], l['s'])] = l['n']
        left = [t['id'] for t in themes]
        order = [left.pop(0)]
        while left:
            nxt = max(left, key=lambda t: (w[(order[-1], t)], -left.index(t)))
            left.remove(nxt)
            order.append(nxt)
        pos = {t: n for n, t in enumerate(order)}
        for t in themes:
            t['order'] = pos[t['id']]

    def _affinity(self, ids, sim, focus=()):
        """Ayah-ayah affinity for theme detection: lexical cosine without the searched and very common
        roots (they add the same similarity to every pair), meaning similarity, and a bonus for ayat
        of the same passage (same surah, ≤3 ayat apart) so a story (qiṣṣa) is not torn apart."""
        keep = self.lex_keep.copy()
        for j, r in enumerate(self.lex_col_root):
            if r in focus:
                keep[j] = 0
        X = l2(self.Xlex[ids] @ sparse.diags(keep))
        lex = (X @ X.T).toarray()
        np.fill_diagonal(lex, 0)
        W = 0.5 * lex + (0.5 * np.clip(sim, 0, None) if sim is not None else 0)
        s = np.array([self.ayat[i]['s'] for i in ids], dtype=np.int16)
        a = np.array([self.ayat[i]['a'] for i in ids], dtype=np.int16)
        near = (s[:, None] == s[None, :]) & (np.abs(a[:, None] - a[None, :]) <= 3)
        np.fill_diagonal(near, False)
        return W + 0.3 * near

    @staticmethod
    def _louvain(W, idx, resolution, k=6):
        G = nx.Graph()
        G.add_nodes_from(idx)
        # k strongest neighbours per ayah, strongest first (one vectorised pass: a row-by-row argsort
        # dominated the build time for graphs of every match)
        sub = W[np.ix_(idx, idx)]
        top = top_k(sub, k)
        for xx, x in enumerate(idx):
            for yy in top[xx]:
                y = idx[yy]
                if sub[xx, yy] > 0 and x != y:
                    G.add_edge(x, y, weight=float(sub[xx, yy]))
        return sorted((sorted(p) for p in nx.community.louvain_communities(G, weight='weight', resolution=resolution, seed=0)),
                      key=lambda p: (-len(p), p[0]))

    def _themes(self, ids, sim, focus, lexical=None, max_themes=10, core=None):
        """-> themes, subthemes, {ayah: theme id}, {ayah: sub-theme id}.
        A group becomes a theme only if something names it: a Quranic formula shared by ≥30% of it, or a
        word found in ≥25% of its ayat. Unnamed groups (and, for word/root searches, groups that are mostly
        meaning-only matches) go to one «متفرقات · other» bucket instead of posing as themes.
        In a large graph (more than LARGE_GRAPH ayat) the themes come from the `core` (its best-ranked ayat,
        the map a 150-ayah graph draws); every other ayah joins the theme its nearest core ayat belong to,
        and what no theme claims is grouped again for themes of its own."""
        if not ids:
            return [], [], {}, {}
        n = len(ids)
        W = self._affinity(ids, sim, focus) if n > 1 else np.zeros((1, 1))
        large = core is not None
        nc = min(n, core) if large else n
        # over the core only: _wujuh's share threshold depends on the ayat counted, and a large graph's core
        # must split senses (نار / نور, مُلْك / مَلَك) exactly as the n=150 map does
        wujuh = self._wujuh(ids[:nc], focus)
        named, rest, parts = self._groups(W, ids, list(range(nc)), focus - wujuh, lexical, max_themes - 1, False)
        if not named and rest:   # nothing nameable: keep the plain grouping rather than one big bucket
            named, rest = [(p, None) for p in parts[:max_themes]], [x for p in parts[max_themes:] for x in p]
        if nc < n:
            named = [(list(p), lab) for p, lab in named]
            label = np.full(nc, -1)
            for k, (p, _) in enumerate(named):
                label[p] = k
            # weighted vote of the K nearest core ayat; a theme must hold ATTACH of the vote, so an ayah
            # between themes (or near the core's «متفرقات») stays unassigned rather than diluting one
            K = min(8, nc)
            A = W[nc:, :nc]
            top = np.argpartition(-A, K - 1, axis=1)[:, :K]
            left = list(rest)
            for xx in range(n - nc):
                votes = collections.defaultdict(float)
                for y in top[xx]:
                    votes[label[y]] += max(0.0, A[xx, y])
                best = max(votes, key=lambda k: (votes[k], -k))
                if best >= 0 and votes[best] >= ATTACH * max(1e-9, sum(votes.values())):
                    named[best][0].append(nc + xx)
                else:
                    left.append(nc + xx)
            for p, _ in named:
                p.sort()
            # regrouped against the whole graph (so their names differ from the core themes'), and a part of a
            # few dozen ayat may be a theme even in a leftover pool of a thousand
            slots = MAX_THEMES_LARGE - 1 - len(named)
            more, rest, _ = self._groups(W, ids, sorted(left), focus - wujuh, lexical, slots, True,
                                         min_size=max(10, n // 60), background=ids) if slots > 0 else ([], left, None)
            named += more
        themes, subthemes, theme_of, sub_of = [], [], {}, {}
        taken = set()
        groups = named + ([(sorted(rest), 'misc')] if rest else [])
        for k, (p, lab) in enumerate(groups):
            tid = f't{k}'
            members = [ids[x] for x in p]
            for i in members:
                theme_of[i] = tid
            misc = lab == 'misc'
            if lab is None or misc:
                lab = dict(ar='متفرقات' if misc else '·', en='other' if misc else '', alts=[], roots=[], root_ids=[],
                           formula='', related=False)
            self._pick_name(lab, taken)
            themes.append(dict(id=tid, c=k, size=len(members), misc=misc, related=lab['related'],
                               label_ar=lab['ar'], label_en=lab['en'], roots=lab['roots'], formula=lab['formula']))
            if misc or len(p) < 14:
                continue
            sub = self._louvain(W, p, 1.0)
            # a big theme (graphs of every match) splits into many small parts at 1.0: coarsen until it
            # gives a handful, and allow a few more parts than in a small theme
            most = 6 if large and len(p) >= 60 else 4
            for r in ((0.8, 0.6, 0.45, 0.3) if large and len(p) >= 60 else ()):
                if len(sub) <= most:
                    break
                sub = self._louvain(W, p, r)
            if not 2 <= len(sub) <= most or (min(map(len, sub)) < 4 and not large):
                continue
            labs = []
            for q in sub:
                sm = [ids[x] for x in q]
                sset = set(sm)
                labs.append(None if len(q) < 4 else
                            self._name_group(sm, [i for i in members if i not in sset], members, focus | set(lab['root_ids']) - wujuh,
                                             support=self._support(0.25 if large else 0.4, len(q), large), words=1))
            sub_taken = {lab['ar']}
            if large:
                # a big theme shows the parts that have a name of their own as sub-boxes; the rest of its ayat
                # stay loose in the theme. Worth it only when named parts hold at least half the theme
                pairs = [(q, sl) for q, sl in zip(sub, labs) if sl]
                pairs = [(q, sl) for q, sl in pairs if self._pick_name(sl, sub_taken)]
                if len(pairs) < 2 or sum(len(q) for q, _ in pairs) < len(p) / 2:
                    continue
                sub, labs = [q for q, _ in pairs], [sl for _, sl in pairs]
            else:
                if not all(labs):   # a split is only worth showing if every part has a name
                    continue
                if not all([self._pick_name(sl, sub_taken) for sl in labs]):
                    continue   # two parts that can only be told apart by a number are not worth splitting
            for j, (q, sl) in enumerate(zip(sub, labs)):
                sid = f'{tid}.{j}'
                for x in q:
                    sub_of[ids[x]] = sid
                subthemes.append(dict(id=sid, parent=tid, size=len(q), label_ar=sl['ar'], label_en=sl['en']))
        return themes, subthemes, theme_of, sub_of

    def _groups(self, W, ids, pool, exclude_roots, lexical, slots, large, min_size=None, background=None):
        """Louvain over the ayat `pool` (indices into ids) -> ([(part, label)] named, [index] unnamed, parts).
        At most `slots` groups are named, against `background` (default: the pool); `large` lowers the
        support a name needs for big groups (_support)."""
        m = len(pool)
        res = 0.9 if m < 30 else 1.1 if m < 90 else 1.3
        min_size = min_size or max(3, m // 20)
        parts = self._louvain(W, pool, res) if m >= 4 else [list(pool)]
        pool_ids = [ids[x] for x in pool] if background is None else background
        named, rest = [], []
        for p in parts:
            members = [ids[x] for x in p]
            if len(p) < min_size or len(named) >= slots:
                rest += p
                continue
            mset = set(members)
            others = [i for i in pool_ids if i not in mset]
            lab = self._name_group(members, others, pool_ids, exclude_roots, support=self._support(0.25, len(p), large))
            if not lab:
                rest += p
                continue
            # for word/root searches a group made mostly of meaning-only matches is shown as "related"
            lab['related'] = lexical is not None and sum(i in lexical for i in members) < len(members) / 2
            named.append((p, lab))
        return named, rest, parts

    @staticmethod
    def _support(base, size, large):
        """Share of a group's ayat a naming word must reach. A group of a hundred ayat or more (graphs of
        every match) rarely has one word in a quarter of them, so the bar falls with size; the score still
        demands the word be distinctive for the group."""
        return base if not large or size <= 40 else max(base * 0.4, base * (40 / size) ** 0.5)

    @staticmethod
    def _pick_name(lab, taken):
        """Give sibling groups different Arabic names: take the first alternative not used yet."""
        unique = True
        for ar, en in lab.get('alts') or []:
            if ar not in taken:
                lab['ar'], lab['en'] = ar, en
                break
        else:
            if lab['ar'] in taken and lab['ar'] not in ('متفرقات', '·'):
                lab['ar'] = f"{lab['ar']} ({len(taken) + 1})"
                unique = False
        taken.add(lab['ar'])
        return unique

    def _wujuh(self, ids, focus):
        """Roots of the query that split into several senses in these results (نور/نار, جَنَّة/جِنّ):
        their lemmas may name themes, because telling the senses apart is the point."""
        out = set()
        for r in focus:
            c = collections.Counter()
            for i in ids:
                c.update({w[2] for w in self.ayat[i]['w'] if w[1] == r and w[2]})
            if sum(1 for v in c.values() if v >= 0.15 * len(ids)) >= 2:
                out.add(r)
        return out

    def _lemma_support(self, group, exclude_roots):
        c, pos = collections.Counter(), {}
        for i in group:
            seen = set()
            for w in self.ayat[i]['w']:
                if not (w[2] and w[1] and w[3] in ('N', 'V')):
                    continue
                if w[1] in exclude_roots or w[1] in LIGHT_ROOTS or self.roots[w[1]]['na'] > 450:
                    continue
                seen.add((w[2], w[1]))
                pos[(w[2], w[1])] = w[3]
            c.update(seen)   # count ayat, not tokens: one long ayah can't name a theme
        return c, pos

    def _name_group(self, members, others, background, exclude_roots, support=0.25, words=2):
        """Name a group by a Quranic formula most of it shares, else by its most distinctive words.
        Returns None when nothing reaches the support threshold (an incoherent group)."""
        ng = len(members)
        minsup = max(2, math.ceil(support * ng))
        formula = self._formula(members, others) if ng >= 3 else ''
        cg, pos = self._lemma_support(members, exclude_roots)
        cb, _ = self._lemma_support(background, exclude_roots)
        nb = max(1, len(background))
        score = {}
        for k, v in cg.items():
            if v < minsup:
                continue
            pg, pb = v / ng, (cb[k] + 1) / (nb + 2)
            sc = pg * math.log(pg / pb) * (1.15 if pos[k] == 'N' else 1.0)
            if sc > 0:
                score[k] = sc
        ranked, seen = [], set()
        for l, r in sorted(score, key=lambda k: (-score[k], k)):
            if r not in seen:
                seen.add(r)
                ranked.append((l, r))
        if not ranked and not formula:
            return None
        def named(idx):
            pick = [ranked[k] for k in idx if k < len(ranked)]
            return (' · '.join(self._display_lemma(l, r) for l, r in pick), ', '.join(g for g in (self._gloss(l) for l, _ in pick) if g))
        combos = ([(0, 1), (0, 2), (1, 2), (0, 3), (1, 3), (2, 3)] if words == 2 else []) + [(0,), (1,), (2,), (3,)]
        # a formula's English is that phrase's own word glosses («We gave Moses the Book»), never the glosses
        # of the group's lemmas, which would name a different theme beside it
        formula, formula_en = formula or ('', '')
        alts = ([(f'«{formula}»', f'“{formula_en}”' if formula_en else '')] if formula else []) + \
            [named(c) for c in combos if all(k < len(ranked) for k in c)]
        ar, en = alts[0] if alts else ('', '')
        return dict(ar=ar, en=en, alts=alts, roots=[r for _, r in ranked[:3]],
                    root_ids=[r for _, r in ranked[:3]], formula=formula)

    def _formula(self, members, others):
        """A repeated phrase (4+ words) shared by ≥30% of the group (≥3 ayat) and clearly rarer outside it,
        as (Arabic text, English word-by-word gloss), or '' when there is none."""
        ms, os_ = set(members), set(others)
        cov = collections.defaultdict(set)
        for i in members:
            for j, n, g in self.phrase_nb[i]:
                if g and j in ms:
                    cov[g] |= {i, j}
        best = None
        for g in sorted(cov, key=lambda g: (-len(cov[g]), -len(g.split()), g)):
            share = len(cov[g]) / len(members)
            if len(cov[g]) < 3 or share < 0.3:
                break
            outside = sum(1 for i in os_ if any(gg == g for j, n, gg in self.phrase_nb[i]))
            if outside / max(1, len(os_)) < share / 2:
                best = g
                break
        if not best:
            return ''
        i = min(cov[best])
        span = self._phrase_span(i, best)
        if not span:
            return ''
        p, q = span
        # drop pause marks and trailing particles (…وَلَٰكِنَّ) so the label reads as a phrase; Tanzil tokens
        # carry their marks, so token k is still morphology word p+k (whose gloss names it in English)
        toks = [' '.join(w for w in t.split(' ') if not set(w) <= PAUSE_MARKS) for t in self.ayat[i]['d'][p:q]]
        while len(toks) > 3 and normalize(toks[-1]) in TRAILING_PARTICLES:
            toks.pop()
        gl = [re.sub(r'[\[\]()",.;:]', '', w[4]).strip() for w in self.ayat[i]['w'][p:p + len(toks)]]
        return ' '.join(toks), ' '.join(g for g in gl if g)

    def _verb_display(self, l):
        """A verb with no perfect form in the Quran, shown as a real Quranic word: its own lemma when those
        exact letters are written as a form of it (مَلَكَتْ، يَحْزُن), else its commonest written form without
        proclitics (ٱصْطَبِرْ for وَٱصْطَبِرْ, يَتَوَكَّلْ for فَلْيَتَوَكَّلِ, حَٰفِظُوا۟ for the clipped stem حافَظُ). Never a
        noun of its root, which can mean something else (صُرْ «incline» vs صُور «trumpet»)."""
        v = self._verb_word.get(l)
        if v is None:
            k = fkey(lemma_text(l))
            if l in self.form_lem.get(k, ()):
                v = self.form_display(k, l)
            else:
                forms = self.lemma_forms.get(l)
                v = self.form_display(forms.most_common(1)[0][0], l) if forms else lemma_text(l)
            self._verb_word[l] = v
        return v

    def _display_lemma(self, l, r):
        """Lemma as an Arabic reader expects it: verbs in the perfect (صَبَرَ, not «اصْبِرْ») when the Quran has
        that form, else as a Quranic word of that verb (_verb_display). The English beside it glosses the same lemma."""
        if self.lemma_pos.get(l) != 'V':
            return lemma_text(l)
        return self.lemma_disp[l] if l in self.lemma_disp else self._verb_display(l)

    def _gloss(self, lemma):
        """Most frequent in-context gloss of a lemma, without leading particles or trailing pronouns."""
        c = collections.Counter()
        for g, n in (self.lemmas.get(lemma) or [])[:12]:
            ws = re.sub(r'[\[\]()"]', '', g.lower()).split()
            while len(ws) > 1 and ws[0] in GLOSS_STOP:
                ws.pop(0)
            while len(ws) > 1 and ws[-1] in GLOSS_TAIL:
                ws.pop()
            if ws:
                c[' '.join(ws)] += n
        return c.most_common(1)[0][0] if c else ''

    def _phrase_span(self, i, g):
        """Word span [p, q) of ayah i where the n-gram key g (full letters, see build_index) occurs, or None."""
        if not g:
            return None
        target = g.split()
        d = self.ayat[i]['d']
        keys = self._wkeys.get(i)
        if keys is None:   # normalised once per ayah: a graph of every match labels about a thousand phrase links
            keys = self._wkeys[i] = [normalize(w[0]).replace(' ', '') for w in self.ayat[i]['w']]
        for p in range(len(keys)):
            seq = [k for k in keys[p:] if k][:len(target)]
            if seq == target:
                q, got = p, 0
                while got < len(target) and q < len(d):
                    got += bool(keys[q])
                    q += 1
                return p, q
        return None

    def phrase_text(self, i, g):
        """Map an n-gram key back to the Uthmani words in ayah i."""
        span = self._phrase_span(i, g)
        return ' '.join(self.ayat[i]['d'][span[0]:span[1]]) if span else ''

    # ------------------------------------------------------------------ details
    def ayah_detail(self, i):
        a = self.ayat[i]
        s = self.surahs[a['s']]
        words = [dict(f=f, r=w[1], rs=w[1] if w[1] else '', l=w[2], p=w[3], g=w[4]) for f, w in zip(a['d'], a['w'])]
        sim_meaning = []
        if self.Ef is not None:
            sc = self.Ef @ self.Ef[i]
            sc[i] = -1
            sim_meaning = [dict(ref=self.refstr(j), i=j, score=round(float(sc[j]), 3), en=self.ayat[j]['en'],
                                text=self.ayat[j]['ut'])
                           for j in top_ids(sc, 8)]
        lx = np.asarray((self.Xlex @ self.Xlex[i].T).todense()).ravel()
        lx[i] = -1
        sim_roots = []
        for j in top_ids(lx, 8):
            shared = sorted(set(self.ayah_roots[i]) & set(self.ayah_roots[j]),
                            key=lambda r: -self.root_idf.get(r, 1))[:4]
            sim_roots.append(dict(ref=self.refstr(j), i=j, score=round(float(lx[j]), 3),
                                  shared=[r for r in shared],
                                  text=self.ayat[j]['ut']))
        phrases = sorted(self.phrase_nb[i], key=lambda x: -x[1])[:12]
        sim_phrase = [dict(ref=self.refstr(j), i=j, n=n, phrase=self.phrase_text(i, g),
                           curated=tuple(sorted((i, j))) in self.curated,
                           text=self.ayat[j]['ut']) for j, n, g in phrases]
        return dict(i=i, ref=self.refstr(i), s=a['s'], a=a['a'], text=a['ut'], en=a['en'], tafsir=a['tf'],
                    topics=a['t'], words=words,
                    surah=dict(n=s['n'], name=s['name'], tname=s['tname'], ename=s['ename'], type=s['type'],
                               order=s['order'], ayas=s['ayas']),
                    similar=dict(meaning=sim_meaning, roots=sim_roots, phrase=sim_phrase),
                    prev=self.refstr(i - 1) if i > 0 else None, next=self.refstr(i + 1) if i < self.N - 1 else None)

    def root_detail(self, r):
        st = self.roots[r]
        per_surah = [0] * 115
        for s, c in st['surah']:
            per_surah[s] = c
        total_mk = sum(1 for a in self.ayat if self.surahs[a['s']]['type'] == 'Meccan')
        share_mk = st['mk'] / max(1, st['mk'] + st['md'])
        base_mk = sum(len(self.ayah_roots[i]) for i in range(self.N) if self.meccan[i]) / sum(map(len, self.ayah_roots))
        col = self.root_col.get(r)
        ayat, ids = [], []
        if col is not None:
            sc = np.asarray(self.Xr[:, col].todense()).ravel()
            ids = [int(i) for i in np.nonzero(sc)[0]]   # Mushaf order: the roots network lists them as cards
            ayat = [self.refstr(i) for i in ids]
        lem = [dict(l=l, t=lemma_text(l), n=n, na=self.root_lemmas.get(r, {}).get(l, 0), g=(self.lemmas.get(l) or [['', 0]])[0][0],
                    pos=self.lemma_pos.get(l), d=self._display_lemma(l, r),
                    forms=[dict(k=k, t=self.form_display(k, l), n=c) for k, c in self.lemma_forms.get(l, collections.Counter()).most_common()])
               for l, n in st['lem']]
        return dict(root=r, sp=r, n=st['n'], na=st['na'], mk=st['mk'], md=st['md'],
                    share_mk=round(share_mk, 3), base_mk=round(base_mk, 3), lemmas=lem,
                    per_surah=per_surah[1:], surah_types=[self.surahs[s]['type'] for s in range(1, 115)],
                    cooc=[dict(r=x, sp=x, w=w, c=c) for x, w, c in self.cooc.get(r, [])],
                    ayat=ayat, ids=ids, total_meccan_ayat=total_mk)

    def expand(self, node_id, exclude, n=10, q=None, mode='auto', precision='auto', match='auto'):
        """Neighbours for an 'expand' click: a root pulls in its ayat, an ayah pulls in its nearest ayat.
        Highlights of the pulled-in ayat follow the current search q (the main mark always means the
        searched word), never the root or ayah that was expanded."""
        excl = {x for x in exclude if isinstance(x, str)}
        n = max(1, min(50, n))
        new_edges = []
        if node_id.startswith('r:'):
            r = node_id[2:]
            col = self.root_col.get(r)
            if col is None:
                return None
            sc = np.asarray(self.Xr[:, col].todense()).ravel()
            cand = [i for i in top_ids(np.where(sc > 0, sc, -np.inf), n + len(excl)) if f'a:{i}' not in excl][:n]
            for i in cand:
                new_edges.append(dict(s=f'a:{i}', t=node_id, type='root'))
        elif re.fullmatch(r'a:[0-9]{1,5}', node_id) and int(node_id[2:]) < self.N:
            i = int(node_id[2:])
            sc = self.Ef @ self.Ef[i] if self.Ef is not None else np.asarray((self.Xlex @ self.Xlex[i].T).todense()).ravel()
            sc[i] = -np.inf
            cand = [j for j in top_ids(sc, n + len(excl)) if f'a:{j}' not in excl][:n]
            for j in cand:
                new_edges.append(dict(s=node_id, t=f'a:{j}', type='meaning', w=round(float(sc[j]), 3)))
        else:
            return None
        new_nodes = [dict(id=f'a:{i}', type='ayah', role='expanded', ref=self.refstr(i), label=self.refstr(i),
                          s=self.ayat[i]['s'], stype=self.surahs[self.ayat[i]['s']]['type'], rank=1, lexical=False)
                     for i in cand]
        info = self._hl_info(q, mode, precision, match)
        return dict(nodes=new_nodes, edges=new_edges, results=[self._result(i, 0, info, None) for i in cand])

    # ------------------------------------------------------------------ corpus-wide patterns
    @functools.lru_cache(maxsize=8)
    def root_network(self, top=220, min_n=8):
        """Root co-occurrence network (PPMI) grouped into Louvain themes, in the same shape as a search graph."""
        common = {'أله', 'قول', 'كون', 'ربب', 'أمن', 'علم'}  # very frequent hubs flatten everything
        roots = [r for r in sorted(self.roots, key=lambda r: (-self.roots[r]['na'], r))
                 if self.roots[r]['na'] >= min_n and r not in common][:top]
        rs = set(roots)
        G = nx.Graph()
        G.add_nodes_from(roots)
        for r in roots:
            for x, w, c in self.cooc.get(r, [])[:8]:
                if x in rs:
                    G.add_edge(r, x, weight=w)
        # keep the main connected body; isolated roots and tiny islands add nothing to a co-occurrence map
        keep = set().union(*[c for c in nx.connected_components(G) if len(c) >= 4])
        G = G.subgraph(keep).copy()
        roots = [r for r in roots if r in keep]
        parts = sorted((sorted(p) for p in nx.community.louvain_communities(G, weight='weight', resolution=1.0, seed=0)),
                       key=lambda p: (-len(p), p[0]))
        comm = {r: f't{n}' for n, p in enumerate(parts) for r in p}
        nodes = [dict(id=f'r:{r}', type='root', root=r, label=r, n=self.roots[r]['n'], na=self.roots[r]['na'],
                      gloss=self._root_gloss(r), share_mk=round(self.roots[r]['mk'] / max(1, self.roots[r]['n']), 2),
                      parent=comm[r], theme=comm[r], rank=round(1 - min(1, self.roots[r]['na'] / 300), 3))
                 for r in roots]
        edges, tl = [], collections.Counter()
        for a, b, d in G.edges(data=True):
            cross = None if comm[a] == comm[b] else 'theme'
            edges.append(dict(s=f'r:{a}', t=f'r:{b}', type='cooc', w=d['weight'], cross=cross))
            if cross:
                tl[tuple(sorted((comm[a], comm[b])))] += 1
        themes = []
        for n, p in enumerate(parts):
            top_r = sorted(p, key=lambda r: (-G.degree(r, weight='weight'), r))[:3]
            themes.append(dict(id=f't{n}', c=n, size=len(p), misc=False,
                               label_ar=' ، '.join(r for r in top_r[:2]),
                               label_en=', '.join(g for g in (self._root_gloss(r) for r in top_r[:2]) if g),
                               roots=[r for r in top_r]))
        links = [dict(s=a, t=b, n=c, meaning=0, phrase=0, roots=c) for (a, b), c in sorted(tl.items())]
        self._order_themes(themes, links)
        return dict(nodes=nodes, edges=edges, themes=themes, subthemes=[], theme_links=links)

    def phrases(self, q='', limit=150):
        out = self.repeated
        q = clean_query(q).strip()
        if q:
            toks = normalize(q, keep_hamza=True).split()   # hamza seats kept for the word lookup
            if not toks:
                return []
            # يا is written fused to the next word in the Mushaf (يَٰٓأَيُّهَا، يَٰقَوْمِ)
            fused, k = [], 0
            while k < len(toks):
                if toks[k] == 'يا' and k + 1 < len(toks):
                    fused.append('يا' + toks[k + 1])
                    k += 2
                else:
                    fused.append(toks[k])
                    k += 1
            variants = [toks] + ([fused] if fused != toks else [])

            def has(words, seq):
                return any(words[x:x + len(seq)] == seq for x in range(len(words) - len(seq) + 1))
            out = [p for p in out if any(has(p['w1'], v) or has(p['w2'], v) for v in variants)]
        res = []
        for p in out[:limit]:
            res.append(dict(text=p['t'], n=p['n'], count=len(p['ayat']), refs=[self.refstr(i) for i in p['ayat'][:60]]))
        return res

    def suggest(self, q, limit=10):
        """Type-ahead: roots, searchable lemmas and surahs whose letters start with the typed ones. A lemma's
        value is its vowelled text (an exact lemma search), or its id when the text names two words."""
        q = clean_query(q).strip()[:60]
        if not q or (is_arabic(q) and not key(q) and not root_key(q)):
            return []
        out = []
        if is_arabic(q):
            rk = root_key(q)
            k = fkey(q)
            kk = k[2:] if k.startswith('ال') and len(k) > 3 else k   # الصبر offers صَبْر
            for r, st in self.roots.items():
                if rk and st['k'].startswith(rk):
                    out.append(dict(kind='root', value=f'جذر:{r}', label=r, n=st['n']))
            seen = set()
            for lk, ls in self.lem_by_letters.items():
                if not (lk.startswith(kk) or (kk != k and lk.startswith(k))):
                    continue
                for l in ls:
                    if l in seen:
                        continue
                    seen.add(l)
                    out.append(dict(kind='lemma', value=l if '|' in l else lemma_text(l), label=lemma_text(l),
                                    n=int(self.lem_na.get(l, 0)), g=self._gloss(l), pos=self.lemma_pos.get(l)))
            for s_ in self.surahs.values():
                if fkey(s_['name']).startswith(k):
                    out.append(dict(kind='surah', value=f"{s_['n']}:1", label=f"سورة {s_['name']}", n=s_['ayas']))
        else:
            ql = q.lower()
            for s_ in self.surahs.values():
                if s_['tname'].lower().startswith(ql) or s_['ename'].lower().startswith(ql):
                    out.append(dict(kind='surah', value=f"{s_['n']}:1", label=f"{s_['tname']} ({s_['name']})", n=s_['ayas']))
        out.sort(key=lambda x: (x['kind'] != 'root', -x['n']))
        return out[:limit]

"""Arabic normalization for searching Uthmani and plain Quran text.

normalize(t)                 -> plain letters, no tashkeel (for display-free matching)
normalize(t, alef_free=True) -> "rasm key": also drops alef and collapses doubled
                                letters, so Uthmani spelling (ٱلْعَٰلَمِينَ) and modern
                                spelling (العالمين) give the same key (~99.7% agreement).
"""
import re
import unicodedata

_TASHKEEL = re.compile('[\u064B-\u0652\u0653\u0655\u0656-\u065F\u06D6-\u06ED\u08D3-\u08FF]')  # harakat, maddah, Quranic marks (small waw/yeh, ۟ ۠ ۢ ۭ, waqf signs)
_ARABIC = re.compile('[\u0600-\u06FF]')
_MAP = str.maketrans({'\u0671':'ا','أ':'ا','إ':'ا','آ':'ا','\u0672':'ا','\u0673':'ا',
                      'ى':'ي','ة':'ه','ؤ':'ء','ئ':'ء','\u06CC':'ي','\u06A9':'ك'})


# like _MAP but hamza seats stay (إيمان != أيمان, أمر != امر), and so do ة (رحمة != رحمه) and alif maqsura
# (يحيى != يحيي, see _maqsura); only the wasla alef is folded
_MAP_H = str.maketrans({'\u0671': 'ا', '\u0672': 'أ', '\u0673': 'إ', '\u06CC': 'ي', '\u06A9': 'ك'})
_SMALL_HIGH = '\u06E5\u06E6\u06E7'   # small high waw / yeh (داوۥد، إبراهۦم) and small yeh above


def _maqsura(t):
    """Tanzil writes a final yāʾ without dots: فِى، ٱلَّذِى، هِىَ، شَىْءٍ are ي, while مُوسَى، إِلَىٰ، هُدًى end in alif
    maqsura. The marks decide: ى stays ى when it carries a dagger alef (the ىٰ rules take it from there) or
    ends the word after a fatha / fathatan; it becomes ي after a kasra, a sukun, inside a word, before a
    suffix (عَصَاىَ). Unmarked text (a typed query) keeps ى as typed."""
    if 'ى' not in t:
        return t
    out = []
    for i, c in enumerate(t):
        if c != 'ى':
            out.append(c)
            continue
        prev = t[i - 1] if i else ''
        rest = t[i + 1:]
        nxt = rest[:1]
        if nxt == '\u0670':
            out.append('ى')
        elif prev in '\u064E\u064B' and nxt in ('', '\u0653') and not any('ء' <= x <= 'ي' or x in _SMALL_HIGH for x in rest):
            out.append('ى')            # مُوسَى، هُدًى، نَرَىٓ
        elif not rest and (prev == '' or 'ء' <= prev <= 'ي'):
            out.append('ى')            # plain text: موسى as typed
        else:
            out.append('ي')            # فِى، هِىَ، شَىْءٍ، يُحْىِ، عَصَاىَ
    return ''.join(out)


_INVISIBLE = re.compile('[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]')


def clean_query(t):
    """User input -> canonical text: NFKC (folds PDF presentation forms ﺍﻟﺼﺒﺮ), no zero-width/bidi marks."""
    return _INVISIBLE.sub('', unicodedata.normalize('NFKC', t or ''))


def normalize(t, *, alef_free=False, keep_hamza=False):
    t = t.replace('\u0640', '')                  # tatweel (also carrier of ـٰ / ـٔ)
    t = t.replace('\u0654', 'ء')                 # hamza above as letter (شَيْـًٔا -> شيءا)
    if keep_hamza:
        t = _maqsura(t)                          # (needs the marks, so before they go)
    t = _TASHKEEL.sub('', t)                       # keep U+0670 dagger alef for now
    t = re.sub('ى\u0670(?=\\S)', 'ا', t)          # مولىٰهم -> مولاهم (mid-word)
    t = t.replace('ى\u0670', 'ى')                # موسىٰ -> موسى (final)
    t = re.sub('و\u0670(?=ة)', 'ا', t)            # صلوٰة -> صلاة, زكوٰة, حيوٰة
    t = t.replace('\u0670', 'ا')                 # dagger alef -> alef (العٰلمين -> العالمين)
    if keep_hamza:
        t = t.translate(_MAP_H).replace('ءا', 'آ')  # ءامنوا -> آمنوا
        return re.sub(r'\s+', ' ', re.sub('[^\u0621-\u064A ]', ' ', t)).strip()
    t = t.translate(_MAP)
    t = t.replace('ءا', 'ا')                      # ءامنوا/قرءان -> امنوا/قران (= آ)
    t = re.sub('[^\u0621-\u064A ]', ' ', t)      # drop digits, ayah/waqf marks, punctuation
    if alef_free:
        t = t.replace('ا', '')
        t = re.sub(r'(.)\1', r'\1', t)            # اليل == الليل
    return re.sub(r'\s+', ' ', t).strip()


def key(t):
    """Rasm key: loose surface match across Uthmani and modern spelling. It merges some different
    words (الله/له, آدم/دم), so it is only a fallback after skey() and never decides highlights alone."""
    return normalize(t, alef_free=True)


def skey(t):
    """Strict key: like key() but the word-initial alef/hamza is kept and doubled letters are not
    collapsed, so أكل != كل, آدم != دم, الله != له. The final alef is kept too (غفورا != غفور).
    Medial alefs are dropped because Uthmani writes many of them as a dagger alef (إِلَٰه / إله)."""
    t = normalize(t).replace(' ', '')
    # medial hamza goes too: Uthmani يَسْـَٔلُونَ is يسءلون, modern يسألون is يسالون
    return t if len(t) < 3 else t[0] + t[1:-1].replace('ا', '').replace('ء', '') + t[-1]


def is_arabic(t):
    return bool(_ARABIC.search(t))


def root_key(t):
    """'ص ب ر' / 'صبر' / 'صَبَرَ' -> 'صبر' (letters only; every hamza form, ء included, becomes ا, so
    «س ء ل» and «سأل» are the same root key)."""
    return normalize(t).replace(' ', '').replace('ء', 'ا')


_MAP_F = str.maketrans({'ٱ': 'ا', 'ٲ': 'أ', 'ٳ': 'إ', 'ی': 'ي', 'ک': 'ك'})
_SILAH = re.compile('(ه[\u064B-\u0653]*)[\u06E5\u06E6](?=[\u064B-\u0653\u06D6-\u06ED]*$)')   # word-final only: لَهُۥ, not إِبْرَٰهِۦم
HAMZA = 'ءأإآؤئ'


def fkey(t, small=True):
    """Form key: the letters of a word as a reader would type them, with hamza seats, ة, and alif maqsura
    kept (by the marks: _maqsura). Harakat, maddah, the Quranic marks and the tatweel go; the dagger alef
    is read as ا (ٱلْعَٰلَمِينَ -> العالمين) except in ىٰ / وٰة (مُوسَىٰ -> موسى, صَلَوٰة -> صلاة); the wasla alef is
    an alef. A small high waw / yeh is a letter (دَاوُۥد -> داوود, إِبْرَٰهِۦم -> إبراهيم) unless it is the
    pronoun's ṣila after ه (لَهُۥ -> له); small=False drops it instead (the other spelling, داود / إبراهم)."""
    t = t.replace('ـ', '').replace('ٔ', 'ء')
    if small:
        t = _SILAH.sub(r'\1', t)
        t = t.replace('ۥ', 'و').replace('ۦ', 'ي').replace('ۧ', 'ي')
    else:
        t = re.sub('[ۥ-ۧ]', '', t)
    t = _maqsura(t)
    t = t.replace('ء\u064Eا', 'آ')             # ءَامَنُوا۟، قُرْءَان: hamza + fatha + alef is a long alif (آ);
    t = _TASHKEEL.sub('', t)                    # شَيْـًٔا keeps its tanwīn alef (شيءا)
    t = re.sub('ى\u0670(?=\\S)', 'ا', t)
    t = t.replace('ى\u0670', 'ى')
    t = re.sub('و\u0670(?=ة)', 'ا', t)
    t = t.replace('\u0670', 'ا')
    t = t.translate(_MAP_F).replace('آء', 'اء')   # Uthmani جَزَآءً، ٱلسَّمَآءِ: a lengthening madda, plain ا when typed
    t = re.sub('[^\u0621-\u064A]', '', t)
    return 'آ' + t[2:] if t.startswith('ءا') else t   # unmarked text: ءامنوا -> آمنوا


def fold_seats(k):
    """A form key without hamza seats, ة or alif maqsura (for a query typed without them): every hamza
    form (ء included) -> ا, ة -> ه, ى -> ي."""
    return k.translate(_FOLD)


_FOLD = str.maketrans({c: 'ا' for c in HAMZA} | {'ة': 'ه', 'ى': 'ي'})


def lemma_text(l):
    """Lemma id -> its Arabic text: a lemma shared by two roots is stored as «text|root»."""
    return (l or '').split('|')[0]

"""Local web server:  python3 -m qr.server  ->  http://127.0.0.1:5055"""
import json
import os
import re
import sys
import threading
import time

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from .engine import GROUPS, MATCHES, MAX_GRAPH, MAX_PASSAGE, MAX_QUERY, MEANINGS, PRECISIONS, ROOT, Engine

STATIC = ROOT / 'static'
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 1_000_000
app.json.ensure_ascii = False   # Arabic as UTF-8, not \uXXXX: a graph of every match is about half the size
t0 = time.time()
engine = Engine()
print(f'index loaded in {time.time() - t0:.1f}s  (semantic search: {"on" if engine.semantic_ready else "off"})')
if engine.semantic_ready and sys.platform != 'emscripten':   # no threads (or model) in the browser build
    threading.Thread(target=lambda: engine._qvec('warm up'), daemon=True).start()


class BadRequest(Exception):
    pass


def err(msg, code):
    # the message may echo client text: a lone surrogate can't be written as UTF-8 (ensure_ascii is off)
    return jsonify(error=msg.encode('utf-8', 'replace').decode()), code


@app.errorhandler(BadRequest)
def _bad(e):
    return err(str(e), 400)


@app.errorhandler(HTTPException)
def _http(e):
    return err(e.description or e.name, e.code)


@app.errorhandler(Exception)
def _crash(e):
    app.logger.exception(e)
    return err('internal error', 500)


def int_arg(name, default, lo, hi):
    v = request.args.get(name, '')
    try:
        return max(lo, min(hi, int(v))) if v.strip() else default
    except ValueError:
        raise BadRequest(f'{name} must be a whole number' + (', all or auto' if name == 'n' else '')) from None


def json_body():
    """The POST body as JSON (None if it isn't), refusing text that isn't valid Unicode: a lone surrogate
    (\\ud800) would reach the tokenizer or the UTF-8 response and fail there with a 500."""
    body = request.get_json(force=True, silent=True)
    try:
        json.dumps(body, ensure_ascii=False).encode('utf-8')
    except UnicodeEncodeError:
        raise BadRequest('text must be valid Unicode') from None
    return body


def choice_arg(name, options):
    v = request.args.get(name, options[0])
    if v not in options:
        raise BadRequest(f'{name} must be one of {", ".join(options)}')
    return v


MODES = ('auto', 'word', 'root', 'topic', 'ayah')


def precision_args():
    """The optional precision parameters of a search-like request (query string)."""
    return dict(precision=choice_arg('precision', PRECISIONS), match=choice_arg('match', MATCHES))


def body_choice(body, name, options):
    v = body.get(name, options[0])
    if v not in options:
        raise BadRequest(f'{name} must be one of {", ".join(options)}')
    return v


def _ref_to_id(ref):
    try:
        s, a = (int(x) for x in ref.split(':'))
        return engine.ref[(s, a)]
    except (ValueError, KeyError):
        raise BadRequest(f'no ayah {ref}') from None


# Hosts this server answers to. Locally only this machine; online (Hugging Face sets SPACE_HOST, or list
# them in QR_HOSTS) also the public name, and requests get a per-visitor rate limit.
PUBLIC_HOSTS = {h.strip().lower() for h in (os.environ.get('SPACE_HOST', '') + ',' + os.environ.get('QR_HOSTS', '')).split(',')
                if h.strip()}
HOSTS = {'127.0.0.1', 'localhost', '[::1]'} | PUBLIC_HOSTS
RATE_N, RATE_WINDOW = 240, 60         # API requests per visitor per minute (a search makes 2-4, typing ~1 per key)
_hits, _hits_lock = {}, threading.Lock()


def _rate_limited():
    # the visitor's address: the first X-Forwarded-For hop when behind the Space's proxy
    ip = (request.headers.get('X-Forwarded-For') or request.remote_addr or '').split(',')[0].strip()
    now = time.monotonic()
    with _hits_lock:
        if len(_hits) > 20000:   # forget idle visitors
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > RATE_WINDOW]:
                del _hits[k]
        q = [t for t in _hits.get(ip, ()) if now - t < RATE_WINDOW]
        limited = len(q) >= RATE_N
        if not limited:
            q.append(now)
        _hits[ip] = q
    return limited


@app.before_request
def _guard():
    # only answer pages served under a known name (blocks DNS-rebinding and cross-site POSTs)
    host = (request.host or '').rsplit(':', 1)[0].lower()
    if host not in HOSTS:
        return err('forbidden host', 403)
    origin = request.headers.get('Origin')
    if origin and re.sub(r'^https?://', '', origin).rsplit(':', 1)[0].lower() not in HOSTS:
        return err('forbidden origin', 403)
    if PUBLIC_HOSTS and request.path.startswith('/api/') and _rate_limited():
        return err('too many requests, wait a minute', 429)


@app.get('/')
def index():
    return send_from_directory(STATIC, 'index.html')


@app.get('/static/<path:p>')
def static_files(p):
    if any(part.startswith('.') for part in p.split('/')):
        return err('not found', 404)
    return send_from_directory(STATIC, p, max_age=0)


@app.get('/api/status')
def status():
    return jsonify(ayat=engine.N, roots=len(engine.roots), semantic=engine.semantic_ready,
                   model_loaded=engine.model is not None)


@app.get('/api/search')
def search():
    q = request.args.get('q', '').strip()
    if not q:
        return err('empty query', 400)
    if len(q) > MAX_QUERY * 4:
        return err(f'query too long (max {MAX_QUERY} characters)', 400)
    # graph size: a number of ayat, `all` for every match, or `auto` (every hit of a word / root / phrase
    # search up to 200, else 150; 60 for topics and ayat). The list always shows every match
    nv = request.args.get('n', '').strip().lower()
    n = None if nv == 'all' else 'auto' if nv == 'auto' else int_arg('n', 60, 10, MAX_GRAPH)
    meaning = request.args.get('meaning', '').strip().lower() or None
    if meaning is not None and meaning not in MEANINGS:
        raise BadRequest(f'meaning must be one of {", ".join(MEANINGS)}')
    return jsonify(engine.search(q, mode=choice_arg('mode', MODES), n=n, scope=choice_arg('scope', ('all', 'meccan', 'medinan')),
                                 meaning=meaning, group=choice_arg('group', GROUPS), **precision_args()))


@app.get('/api/ayah/<ref>')
def ayah(ref):
    return jsonify(engine.ayah_detail(_ref_to_id(ref)))


@app.get('/api/root/<r>')
def root(r):
    if r not in engine.roots:
        return err(f'no root {r}', 404)
    return jsonify(engine.root_detail(r))


@app.post('/api/expand')
def expand():
    body = json_body()
    if not isinstance(body, dict) or not isinstance(body.get('node'), str) or len(body['node']) > 100:
        raise BadRequest('body must be {"node": "a:<id>" | "r:<root>", "exclude": [...], "n": int}')
    exclude = body.get('exclude') or []
    n = body.get('n', 10)
    if not isinstance(exclude, list) or not isinstance(n, int) or isinstance(n, bool):
        raise BadRequest('exclude must be a list and n a whole number')
    q, mode = body.get('q'), body.get('mode', 'auto')
    if q is not None and (not isinstance(q, str) or len(q) > MAX_QUERY * 4):
        raise BadRequest('q must be the current search text')
    if mode not in MODES:
        raise BadRequest(f'mode must be one of {", ".join(MODES)}')
    out = engine.expand(body['node'], exclude[:5000], n=n, q=q or None, mode=mode,
                        precision=body_choice(body, 'precision', PRECISIONS), match=body_choice(body, 'match', MATCHES))
    if out is None:
        return err(f'unknown node {body["node"][:40]}', 404)
    return jsonify(out)


@app.post('/api/cards')
def cards():
    # the list's `rest` (matches past the graph's n cap), fetched page by page and marked like search results
    body = json_body()
    if not isinstance(body, dict):
        raise BadRequest('body must be {"ids": [int, ...], "q": str, "mode": str}')
    ids, q, mode = body.get('ids'), body.get('q', ''), body.get('mode', 'auto')
    if (not isinstance(ids, list) or len(ids) > 200
            or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < engine.N for i in ids)):
        raise BadRequest(f'ids must be a list of at most 200 ayah indices (0 to {engine.N - 1})')
    if not isinstance(q, str) or len(q) > MAX_QUERY * 4:
        raise BadRequest('q must be the current search text')
    if mode not in MODES:
        raise BadRequest(f'mode must be one of {", ".join(MODES)}')
    return jsonify(results=engine.cards(ids, q.strip(), mode, precision=body_choice(body, 'precision', PRECISIONS),
                                        match=body_choice(body, 'match', MATCHES)))


@app.post('/api/rootmarks')
def rootmarks():
    # the words of a clicked root in the graph's ayat (the «selected node» list underlines them)
    body = json_body()
    if not isinstance(body, dict):
        raise BadRequest('body must be {"root": str, "ids": [int, ...]}')
    r, ids = body.get('root'), body.get('ids')
    if not isinstance(r, str) or r not in engine.roots:
        raise BadRequest('root must be a Quranic root')
    if (not isinstance(ids, list) or len(ids) > MAX_GRAPH + 1000
            or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < engine.N for i in ids)):
        raise BadRequest(f'ids must be a list of at most {MAX_GRAPH + 1000} ayah indices (0 to {engine.N - 1})')
    return jsonify(marks=engine.root_marks(r, ids))


@app.get('/api/passage/<s>')
def passage(s):
    # neighbouring ayat around a selected one (inclusive range, clamped to the surah, ≤ MAX_PASSAGE).
    # The surah is parsed here, not by Werkzeug's int converter, which crashes on >4300 digits
    if not (s.isascii() and s.isdigit() and len(s) <= 3):
        return err(f'no surah {s[:20]}', 404)
    s = int(s)
    q = request.args.get('q', '').strip()
    if len(q) > MAX_QUERY * 4:
        return err(f'query too long (max {MAX_QUERY} characters)', 400)
    a0 = int_arg('from', 1, 1, 286)
    out = engine.passage(s, a0, int_arg('to', a0 + MAX_PASSAGE - 1, 1, 286), q=q or None, mode=choice_arg('mode', MODES),
                         **precision_args())
    if out is None:
        return err(f'no surah {s}', 404)
    return jsonify(out)


@app.get('/api/network/roots')
def root_network():
    return jsonify(engine.root_network(top=int_arg('top', 220, 50, 600)))


@app.get('/api/phrases')
def phrases():
    return jsonify(engine.phrases(request.args.get('q', '')[:200]))


@app.get('/api/suggest')
def suggest():
    return jsonify(engine.suggest(request.args.get('q', '')))


def main():
    try:
        port = int(os.environ.get('PORT', 5055))
    except ValueError:
        raise SystemExit('PORT must be a number') from None
    print(f'Quran Researcher → http://127.0.0.1:{port}')
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)


if __name__ == '__main__':
    main()

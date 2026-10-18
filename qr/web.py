"""Browser build: the Flask app run inside Pyodide by static/worker.js, without a server.

Each fetch of the page becomes handle(); Flask's test client gives the same routes, checks and errors
as the local server. The browser has no torch: the worker embeds query texts with transformers.js and
passes the vectors in with set_vec(). A request needing a vector not passed yet answers 599 with the
text (need_vec), and the worker retries it once the vector is in.
"""
import numpy as np
from flask import jsonify

from . import server
from .engine import Engine

QV = {}


class NeedVector(Exception):
    pass


def _qvec(self, q):
    v = QV.get(q)
    if v is None:
        raise NeedVector(q)
    return v


Engine._qvec = _qvec


@server.app.errorhandler(NeedVector)
def _need(e):
    return jsonify(need_vec='query: ' + e.args[0], q=e.args[0]), 599


def set_vec(q, vec):
    if len(QV) > 2000:
        QV.clear()
    QV[q] = np.asarray(vec.to_py() if hasattr(vec, 'to_py') else vec, dtype=np.float32)


client = server.app.test_client()


def handle(method, url, body=None):
    """-> (status, JSON text) for one API call of the page."""
    r = client.open(url, method=method, data=body,
                    content_type='application/json' if body is not None else None)
    return r.status_code, r.get_data(as_text=True)

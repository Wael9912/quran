// Browser build only (build/web): the app's Python engine runs here in Pyodide, and the page's API
// calls come here instead of to a server (api() in app.js). qr/web.py answers them through Flask's
// test client, so routes, checks and errors are the local server's. Query vectors come from
// transformers.js, with the trimmed float16 copy of the model that qr/web_model.py builds.
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const BASE = new URL('../', import.meta.url);
const say = (m) => postMessage(m);
let manifest, web, embedP;

async function fetchTo(py, path, dest) {
  // ?v= is the file's content hash: unchanged files come from the browser cache after a new publish
  const r = await fetch(new URL(`${path}?v=${manifest.hash[path]}`, BASE));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  py.FS.writeFile(dest, new Uint8Array(await r.arrayBuffer()));
}

async function boot() {
  manifest = await (await fetch(new URL(`web.json?t=${Date.now()}`, BASE))).json();
  say({ type: 'progress', stage: 'py' });
  const py = await loadPyodide({ indexURL: PYODIDE });
  self.__py = py;   // console debugging
  // networkx's package lists matplotlib, which the engine never uses: install the wheel alone
  await py.loadPackage(['numpy', 'scipy', 'scikit-learn', 'micropip', 'jinja2', 'markupsafe', 'click']);
  const micropip = py.pyimport('micropip');
  await micropip.install([PYODIDE + 'networkx-3.6.1-py3-none-any.whl',
    ...manifest.wheels.map((w) => new URL(`wheels/${w}`, BASE).href)], { deps: false });
  say({ type: 'progress', stage: 'data' });
  py.FS.mkdirTree('/app/qr');
  py.FS.mkdirTree('/app/data/index');
  await Promise.all([
    ...manifest.py.map((f) => fetchTo(py, f, `/app/${f}`)),
    ...manifest.data.map((f) => fetchTo(py, f, `/app/${f}`)),
  ]);
  say({ type: 'progress', stage: 'engine' });
  py.runPython("import sys; sys.path.insert(0, '/app')");
  web = py.pyimport('qr.web');
  embedP = loadModel();          // needed by most searches: start it now, wait for it only when asked
  embedP.catch((e) => say({ type: 'progress', stage: 'modelFail', error: String(e && e.message || e) }));
}

async function loadModel() {
  env.allowRemoteModels = false;
  env.useBrowserCache = false;          // the service worker (sw.js) keeps the model; this would be a second copy
  env.allowLocalModels = true;
  env.localModelPath = BASE.pathname;   // a path, not a URL: 4.3.0 skips its local-file check for URLs and finds no tokenizer
  const seen = {};
  return pipeline('feature-extraction', manifest.model, {   // model-<hash>: a new model is a new URL
    dtype: 'fp32', device: 'wasm',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      seen[p.file] = [p.loaded, p.total];
      const v = Object.values(seen);
      say({ type: 'progress', stage: 'model', loaded: v.reduce((a, x) => a + x[0], 0), total: v.reduce((a, x) => a + x[1], 0) });
    },
  }).then((m) => { say({ type: 'progress', stage: 'modelReady' }); return m; });
}

async function vector(text) {
  const out = await (await embedP)(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const ready = boot();
ready.then(() => say({ type: 'ready' }), (e) => say({ type: 'fatal', error: String(e && e.message || e) }));

onmessage = async ({ data: { id, method, url, body } }) => {
  try {
    await ready;
    for (let i = 0; i < 4; i++) {
      const res = web.handle(method, url, body ?? null);
      const [status, text] = res.toJs();
      res.destroy();
      if (status !== 599) { say({ type: 'reply', id, status, text }); return; }
      const need = JSON.parse(text);           // a query text whose vector the engine hasn't got yet
      web.set_vec(need.q, await vector(need.need_vec));
    }
    say({ type: 'reply', id, status: 500, text: '{"error":"internal error"}' });
  } catch (e) {
    console.error(e);
    say({ type: 'reply', id, status: 0, text: JSON.stringify({ error: String(e && e.message || e) }) });
  }
};

/* ============================================================================
   Default WebAssembly playable loader.
   Used when a media item looks like:
     { "type": "playable", "kind": "wasm", "wasm": "media/mandel.wasm" }
   …and no custom "glue" module is given.

   Contract expected from the module:
     memory                     exported linear memory
     framebuffer() -> i32       pointer to an RGBA byte buffer
     render(w, h, ...params)    draws one frame into that buffer

   `render` is called with the canvas resolution followed by `item.params`.
   If the module also exports `main`, it is called once after instantiation.

   Options (all optional, from the media item):
     resolution  [w, h] | number      default [640, 400]
     params      [...]                extra numeric args passed to render()
     interactive true                 drag to pan, wheel to zoom (default true)
     animated    false                keep re-rendering (default: on demand only)
     maxIter     240                  passed through unchanged as params[3] in the demo
   ========================================================================== */

const KNOWN_HOST_FUNCTIONS = {
  log: (...args) => console.log('[wasm]', ...args),
  now: () => performance.now(),
  random: () => Math.random(),
  seed: () => 1,
  abort: () => { throw new Error('wasm aborted'); },
  trace: () => {},
};

function buildImports(spec) {
  const imports = {
    env: {
      abort: KNOWN_HOST_FUNCTIONS.abort,
      log: KNOWN_HOST_FUNCTIONS.log,
      emscripten_notify_memory_growth: () => {},
    },
    wasi_snapshot_preview1: {
      proc_exit: () => {},
      fd_write: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      environ_get: () => 0,
      environ_sizes_get: () => 0,
      clock_time_get: () => 0,
      random_get: () => 0,
    },
  };
  for (const [moduleName, entries] of Object.entries(spec || {})) {
    imports[moduleName] = imports[moduleName] || {};
    for (const [name, ref] of Object.entries(entries || {})) {
      imports[moduleName][name] = typeof ref === 'function'
        ? ref
        : KNOWN_HOST_FUNCTIONS[ref] || (() => 0);
    }
  }
  return imports;
}

function resolutionOf(item) {
  const raw = item.resolution;
  if (Array.isArray(raw) && raw.length >= 2) return [Number(raw[0]), Number(raw[1])];
  if (typeof raw === 'number') return [raw, Math.round(raw * 0.625)];
  const aspect = String(item.aspect || '16 / 9').split('/').map((v) => Number(v.trim()));
  const ratio = aspect.length === 2 && aspect[0] > 0 && aspect[1] > 0 ? aspect[0] / aspect[1] : 16 / 9;
  const width = 640;
  return [width, Math.round(width / ratio)];
}

export default async function mount(host, { wasmUrl, item = {} } = {}) {
  if (!wasmUrl) throw new Error('missing wasm url');

  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${wasmUrl}`);

  const imports = buildImports(item.imports);
  let instance;
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      instance = (await WebAssembly.instantiateStreaming(response.clone(), imports)).instance;
    } catch {
      instance = (await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance;
    }
  } else {
    instance = (await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance;
  }

  const api = instance.exports || {};
  if (typeof api.main === 'function') {
    try { api.main(); } catch (err) { console.warn('[wasm] main() threw', err); }
  }

  const canDraw = typeof api.render === 'function' && typeof api.framebuffer === 'function' && api.memory;
  if (!canDraw) {
    const note = document.createElement('div');
    note.className = 'playable-error';
    note.style.color = 'var(--muted)';
    note.textContent = 'Module loaded and started. It does not expose a render()/framebuffer() pair, so nothing is drawn here.';
    host.append(note);
    return;
  }

  const [width, height] = resolutionOf(item);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.tabIndex = 0;
  host.append(canvas);

  const ctx = canvas.getContext('2d', { alpha: false });
  const state = {
    cx: Number.isFinite(Number(item.params?.[0])) ? Number(item.params[0]) : -0.6,
    cy: Number.isFinite(Number(item.params?.[1])) ? Number(item.params[1]) : 0,
    scale: Number.isFinite(Number(item.params?.[2])) ? Number(item.params[2]) : 3.2 / width,
    maxIter: Number.isFinite(Number(item.maxIter)) ? Number(item.maxIter) : 180,
    params: item.params ?? null,
    queued: false,
    dragging: false,
    last: null,
  };

  function frame() {
    state.queued = false;
    const args = state.params
      ? [width, height, ...state.params]
      : [width, height, state.cx, state.cy, state.scale, state.maxIter];
    try {
      api.render(...args);
    } catch (err) {
      console.error('[wasm] render() failed', err);
      return;
    }
    const ptr = api.framebuffer();
    const bytes = new Uint8ClampedArray(api.memory.buffer, ptr, width * height * 4);
    ctx.putImageData(new ImageData(bytes, width, height), 0, 0);
  }

  function schedule() {
    if (state.queued) return;
    state.queued = true;
    requestAnimationFrame(frame);
  }

  const interactive = item.interactive !== false && state.params === null;
  if (interactive) {
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', (event) => {
      state.dragging = true;
      state.last = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!state.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const dx = (event.clientX - state.last.x) * (width / rect.width);
      const dy = (event.clientY - state.last.y) * (height / rect.height);
      state.last = { x: event.clientX, y: event.clientY };
      state.cx -= dx * state.scale;
      state.cy -= dy * state.scale;
      schedule();
    });
    const end = (event) => {
      state.dragging = false;
      canvas.style.cursor = 'grab';
      if (event.pointerId !== undefined && canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = (event.clientX - rect.left) * (width / rect.width) - width / 2;
      const my = (event.clientY - rect.top) * (height / rect.height) - height / 2;
      const factor = event.deltaY < 0 ? 0.82 : 1.22;
      state.cx += mx * state.scale * (1 - factor);
      state.cy += my * state.scale * (1 - factor);
      state.scale *= factor;
      schedule();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      state.scale *= 0.5;
      schedule();
    });
  }

  schedule();

  if (item.animated) {
    const tick = () => { frame(); if (canvas.isConnected) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  return { instance, canvas, render: schedule, state };
}

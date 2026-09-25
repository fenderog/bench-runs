#!/usr/bin/env node
/**
 * Optional browser smoke test. Drives headless Chrome over CDP to verify that
 * the card grid, detail view, media (image/video/table/chart), WASM and iframe
 * playables all render without console errors.
 *
 *   node scripts/smoke-test.mjs [--keep] [--url http://127.0.0.1:4173/]
 *
 * Requires Chrome/Chromium and a running `npm run serve`. Exits non-zero on
 * any console error or failed assertion. Screenshots land in .smoke/.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.smoke');
const URL_BASE = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:4173/';
const KEEP = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SMOKE_RUN_ID = '2099-01-01_smoke-test-run';
const SMOKE_RUN_DIR = path.join(ROOT, 'public', 'results', SMOKE_RUN_ID);

/** Fake "someone pushed a new result" so the live-update path is exercised for real. */
async function publishSmokeRun() {
  await fsp.mkdir(path.join(SMOKE_RUN_DIR, 'media'), { recursive: true });
  await fsp.writeFile(path.join(SMOKE_RUN_DIR, 'run.json'), JSON.stringify({
    id: SMOKE_RUN_ID,
    title: 'Smoke test run',
    model: 'test/smoke',
    benchmark: 'SmokeBench',
    date: '2099-01-01T00:00:00Z',
    status: 'complete',
    tags: ['smoke'],
    metrics: { accuracy: { value: 1, unit: '%' } },
    media: [],
  }, null, 2));
  const result = spawnSync(process.execPath, ['scripts/build-manifest.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`manifest build failed: ${result.stderr}`);
}

async function unpublishSmokeRun() {
  await fsp.rm(SMOKE_RUN_DIR, { recursive: true, force: true });
  spawnSync(process.execPath, ['scripts/build-manifest.mjs'], { cwd: ROOT, encoding: 'utf8' });
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  throw new Error('no Chrome/Chromium found — set CHROME_PATH');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }

  static async attach(port) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        const target = await res.json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        const cdp = new Cdp(ws);
        ws.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && cdp.pending.has(msg.id)) {
            const { resolve, reject } = cdp.pending.get(msg.id);
            cdp.pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
          } else if (msg.method) {
            cdp.events.push(msg);
          }
        });
        return cdp;
      } catch (err) {
        if (attempt === 59) throw err;
        await sleep(250);
      }
    }
    throw new Error('could not attach to devtools');
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 30000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return result.result.value;
  }

  async shot(name, fullPage = false) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    await fsp.writeFile(path.join(OUT_DIR, `${name}.png`), Buffer.from(result.data, 'base64'));
  }

  consoleProblems() {
    const problems = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params.type)) {
        const text = event.params.args.map((a) => a.description || a.value).join(' ');
        if (/favicon|Download the React/i.test(text)) continue;
        problems.push(`${event.params.type}: ${text}`);
      }
      if (event.method === 'Runtime.exceptionThrown') {
        problems.push(`exception: ${event.params.exceptionDetails.exception?.description}`);
      }
      if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        problems.push(`log: ${event.params.entry.text} ${event.params.entry.url || ''}`);
      }
    }
    return problems;
  }
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  const port = 9333;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-smoke-'));
  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let cdp;
  try {
    cdp = await Cdp.attach(port);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    console.log(`\n▸ loading ${URL_BASE}`);
    await cdp.send('Page.navigate', { url: URL_BASE });
    await sleep(2200);

    // ── grid ────────────────────────────────────────────────────────────────
    const grid = await cdp.eval(`
      const manifest = await (await fetch('data/results.json?t=' + Date.now())).json();
      const cards = [...document.querySelectorAll('#grid .card')];
      const chips = [...document.querySelectorAll('#filters .chip')];
      return {
        expected: manifest.count,
        cards: cards.length,
        titles: cards.map(c => c.querySelector('.card-title')?.textContent),
        chips: chips.length,
        count: document.querySelector('#count').textContent,
        live: document.querySelector('#liveText').textContent,
        thumbsBroken: [...document.querySelectorAll('.card-thumb img')].filter(i => !i.complete || i.naturalWidth === 0).length,
        thumbs: document.querySelectorAll('.card-thumb img').length,
      };
    `);
    check('one card per run', grid.cards === grid.expected, `got ${grid.cards}, expected ${grid.expected}`);
    check('filter chips rendered', grid.chips >= 3, `got ${grid.chips}`);
    check('result counter filled', /\d+ of \d+/.test(grid.count), grid.count);
    check('live indicator reports runs', /live/.test(grid.live), grid.live);
    check('card thumbnails loaded', grid.thumbsBroken === 0, `${grid.thumbsBroken}/${grid.thumbs} broken`);
    console.log(`    runs: ${grid.titles.join(' | ')}`);
    await cdp.shot('01-grid');

    // ── live update: publish a run while the page is open ───────────────────
    // Only meaningful when the manifest being served comes from this checkout.
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(URL_BASE);
    if (!isLocal) {
      console.log('  – skipping live-publish test (not serving a local manifest)');
    } else {
    await publishSmokeRun();
    await sleep(300);
    const live = await cdp.eval(`
      const before = document.querySelectorAll('#grid .card').length;
      document.querySelector('#refreshBtn').click();
      await new Promise(r => setTimeout(r, 1800));
      const cards = [...document.querySelectorAll('#grid .card')];
      return {
        before,
        after: cards.length,
        firstTitle: cards[0]?.querySelector('.card-title')?.textContent,
        firstBadge: cards[0]?.querySelector('.badge-new')?.textContent,
        toast: document.querySelector('#toast').textContent,
        toastVisible: !document.querySelector('#toast').hidden,
      };
    `);
    check('new run appears after refresh', live.after === live.before + 1, `${live.before} → ${live.after}`);
    check('new run is badged', live.firstBadge === 'NEW', `${live.firstTitle} / badge=${live.firstBadge}`);
    check('new run sorted to the top', live.firstTitle === 'Smoke test run', String(live.firstTitle));
    check('user is told about the new result', /new result/i.test(live.toast) && live.toastVisible, live.toast);
    await cdp.shot('02-live-update');
    await unpublishSmokeRun();
    await cdp.eval(`document.querySelector('#refreshBtn').click(); await new Promise(r => setTimeout(r, 1200)); return 1;`);
    }

    // ── detail: charts, metrics, media ──────────────────────────────────────
    const runId = await cdp.eval(`
      const updated = await (await fetch('data/results.json?t=' + Date.now())).json();
      const withMedia = updated.runs.find(r => r.media.some(m => m.type === 'playable'));
      location.hash = '#/run/' + encodeURIComponent(withMedia.id);
      return withMedia.id;
    `);
    await sleep(1200);
    const detail = await cdp.eval(`
      const dialog = document.querySelector('#detail');
      return {
        open: dialog.open,
        title: document.querySelector('.detail-title')?.textContent,
        tiles: document.querySelectorAll('.tile').length,
        charts: document.querySelectorAll('.chart svg').length,
        media: document.querySelectorAll('.gallery .media-block').length,
        videos: document.querySelectorAll('.gallery video').length,
        tables: document.querySelectorAll('.gallery table').length,
        playables: document.querySelectorAll('.playable-launch').length,
        imagesBroken: [...document.querySelectorAll('.gallery img')].filter(i => !i.complete || i.naturalWidth === 0).length,
        images: document.querySelectorAll('.gallery img').length,
        prose: document.querySelectorAll('.prose').length,
        proseText: [...document.querySelectorAll('.prose')].map(p => p.textContent.trim().length).reduce((a, b) => a + b, 0),
        proseLinks: document.querySelectorAll('.prose a').length,
        playIcon: document.querySelector('.playable-launch .play-icon svg') ? getComputedStyle(document.querySelector('.playable-launch .play-icon svg')).width : 'none',
      };
    `);
    check('detail dialog opened', detail.open, 'dialog not open');
    check('title rendered', detail.title?.length > 3, String(detail.title));
    check('metric tiles rendered', detail.tiles >= 4, `got ${detail.tiles}`);
    check('charts rendered as svg', detail.charts >= 2, `got ${detail.charts}`);
    check('video element present', detail.videos >= 1, `got ${detail.videos}`);
    check('csv table rendered', detail.tables >= 1, `got ${detail.tables}`);
    check('playable placeholders present', detail.playables >= 2, `got ${detail.playables}`);
    check('gallery images loaded', detail.imagesBroken === 0, `${detail.imagesBroken}/${detail.images} broken`);
    check('notes prose rendered', detail.prose >= 1, `got ${detail.prose}`);
    check('markdown produced content', detail.proseText > 120, `${detail.proseText} characters of prose`);
    check('markdown links rendered', detail.proseLinks >= 1, `${detail.proseLinks} links`);
    check('play button icon drawn', detail.playIcon !== 'none' && detail.playIcon !== '0px', String(detail.playIcon));

    const tiles = await cdp.eval(`
      return [...document.querySelectorAll('.tile')].map(t => t.querySelector('.tile-label').textContent + '=' + t.querySelector('.tile-value').textContent.trim());
    `);
    check('metric units formatted', tiles.some((t) => t.endsWith('=84.2%')), tiles.join(' '));
    console.log(`    metrics: ${tiles.join(', ')}`);
    await cdp.shot('02-detail-top');
    await cdp.eval(`document.querySelector('.detail-inner').scrollTop = document.querySelector('.gallery').offsetTop - 80; return 1;`);
    await sleep(400);
    await cdp.shot('03-detail-gallery');

    // ── WASM playable ───────────────────────────────────────────────────────
    const wasm = await cdp.eval(`
      const blocks = [...document.querySelectorAll('.gallery .media-block')];
      const block = blocks.find(b => b.textContent.includes('WebAssembly'));
      if (!block) return { found: false };
      block.querySelector('.playable-launch').click();
      await new Promise(r => setTimeout(r, 2500));
      const canvas = block.querySelector('canvas');
      if (!canvas) return { found: true, canvas: false, text: block.textContent.slice(0, 200) };
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 997) seen.add(data[i] + ',' + data[i+1] + ',' + data[i+2]);
      // exercise the pointer path
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 40, clientY: rect.top + 40, bubbles: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 90, clientY: rect.top + 70, bubbles: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 90, clientY: rect.top + 70, bubbles: true, pointerId: 1 }));
      await new Promise(r => setTimeout(r, 600));
      return { found: true, canvas: true, w: canvas.width, h: canvas.height, colors: seen.size, interactive: true };
    `);
    check('wasm module produced a canvas', wasm.canvas, JSON.stringify(wasm).slice(0, 300));
    check('wasm framebuffer has varied pixels', wasm.colors > 20, `${wasm.colors} distinct sampled colours`);
    check('wasm canvas sized from item.resolution', wasm.w === 720 && wasm.h === 480, `${wasm.w}x${wasm.h}`);
    await cdp.shot('04-wasm');

    // ── iframe playable ─────────────────────────────────────────────────────
    const iframe = await cdp.eval(`
      const blocks = [...document.querySelectorAll('.gallery .media-block')];
      const block = blocks.find(b => b.textContent.includes('trajectory'));
      if (!block) return { found: false };
      block.querySelector('.playable-launch').click();
      await new Promise(r => setTimeout(r, 2000));
      const frame = block.querySelector('iframe');
      if (!frame) return { found: true, iframe: false, text: block.textContent.slice(0, 200) };
      const doc = frame.contentDocument;
      const canvas = doc?.querySelector('canvas');
      const parse = (s) => Number(String(s || '0').replace(/[^0-9]/g, ''));
      const stepsA = parse(doc?.querySelector('#steps')?.textContent);
      const fpsA = parse(doc?.querySelector('#fps')?.textContent);
      await new Promise(r => setTimeout(r, 900));
      const stepsB = parse(doc?.querySelector('#steps')?.textContent);
      let painted = false;
      if (canvas) {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        // The demo paints on a near-black background: look for lit pixels.
        for (let i = 0; i < data.length; i += 4 * 37) {
          if (data[i] + data[i+1] + data[i+2] > 90) { painted = true; break; }
        }
      }
      return { found: true, iframe: true, canvas: !!canvas, painted, stepsA, stepsB, fps: fpsA, sandbox: frame.getAttribute('sandbox') };
    `);
    check('iframe playable embedded', iframe.iframe, JSON.stringify(iframe).slice(0, 300));
    check('iframe animation loop is running', iframe.stepsB > iframe.stepsA, `steps ${iframe.stepsA} → ${iframe.stepsB}`);
    check('iframe canvas is painting', iframe.painted, `fps=${iframe.fps} ${JSON.stringify(iframe)}`);
    check('iframe is sandboxed', /allow-scripts/.test(iframe.sandbox || ''), String(iframe.sandbox));
    await cdp.shot('05-iframe');

    // ── theme toggle + search + sort ─────────────────────────────────────────
    const ui = await cdp.eval(`
      const before = document.documentElement.dataset.theme;
      document.querySelector('#themeBtn').click();
      const after = document.documentElement.dataset.theme;
      document.querySelector('#themeBtn').click();
      const restored = document.documentElement.dataset.theme;
      const search = document.querySelector('#search');
      search.value = 'qwen';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const filtered = document.querySelectorAll('#grid .card').length;
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const sort = document.querySelector('#sort');
      sort.value = 'title-asc';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const first = document.querySelector('#grid .card .card-title')?.textContent;
      sort.value = 'date-desc';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return { before, after, restored, filtered, first };
    `);
    check('theme toggle switches theme', ui.after !== ui.before && ui.restored === ui.before, `${ui.before} → ${ui.after} → ${ui.restored}`);
    check('search narrows the grid to 1', ui.filtered === 1, `got ${ui.filtered}`);
    check('sort changes ordering', typeof ui.first === 'string' && ui.first.length > 0, String(ui.first));

    // ── mobile layout ───────────────────────────────────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    await cdp.shot('06-mobile');
    const mobile = await cdp.eval(`
      const grid = document.querySelector('#grid');
      return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, overflow: document.documentElement.scrollWidth <= window.innerWidth + 1 };
    `);
    check('single column on mobile', mobile.columns === 1, `${mobile.columns} columns`);
    check('no horizontal overflow', mobile.overflow, 'page scrolls sideways');

    // ── dark theme via system preference ────────────────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await cdp.eval(`try { localStorage.clear(); } catch {} location.hash = '#/'; location.reload(); return 1;`);
    await sleep(2600);
    const dark = await cdp.eval(`
      return {
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        cards: document.querySelectorAll('#grid .card').length,
      };
    `);
    check('system dark preference respected', dark.theme === 'dark', JSON.stringify(dark));
    check('grid still rendered after reload', dark.cards >= 3, JSON.stringify(dark));
    await cdp.eval(`location.hash = '#/run/' + encodeURIComponent(${JSON.stringify(runId)}); return 1;`);
    await sleep(1200);
    await cdp.eval(`document.querySelector('.detail-inner').scrollTop = 320; return 1;`);
    await cdp.shot('07-dark-detail');
    await cdp.eval(`location.hash = '#/'; return 1;`);
    await sleep(700);
    await cdp.shot('08-dark-grid');

    const problems = cdp.consoleProblems();
    check('no console errors or warnings', problems.length === 0, problems.slice(0, 5).join(' || '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length ? '✗' : '✓'} ${checks.length - failed.length}/${checks.length} checks passed`);
    console.log(`  screenshots: ${path.relative(process.cwd(), OUT_DIR)}/`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(URL_BASE)) await unpublishSmokeRun().catch(() => {});
    try { cdp?.ws.close(); } catch { /* ignore */ }
    if (!KEEP) proc.kill();
    if (!KEEP) await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('✗ smoke test failed:', err);
  process.exit(1);
});

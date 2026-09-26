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
    const size = fullPage ? (await this.send('Page.getLayoutMetrics')).cssContentSize : null;
    const clip = size ? { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } : undefined;
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, clip });
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
    // Bench chips were removed and runs are currently tagless, so only the
    // model chips may be present — the point is the filter row renders.
    check('filter chips rendered', grid.chips >= 1, `got ${grid.chips}`);
    check('result counter filled', /\d+ of \d+/.test(grid.count), grid.count);
    check('live indicator reports runs', /live/.test(grid.live), grid.live);
    check('card thumbnails loaded', grid.thumbsBroken === 0, `${grid.thumbsBroken}/${grid.thumbs} broken`);
    console.log(`    runs: ${grid.titles.join(' | ')}`);
    await cdp.shot('01-grid', true);
    const overview = await cdp.eval(`
      const manifest = await (await fetch('data/results.json')).json();
      return Number(document.querySelector('#statArtifacts').textContent) === manifest.runs.reduce((n, r) => n + r.media.length, 0);
    `);
    check('artifact total reflects the manifest', overview);

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
    const filterChecks = await cdp.eval(`
      [...document.querySelectorAll('#filters .chip')].find(b => b.textContent.startsWith('test/smoke')).click();
      const filtered = document.querySelectorAll('#grid .card').length;
      const search = document.querySelector('#search');
      search.value = 'no-matching-experiment';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 180));
      const empty = !document.querySelector('#empty').hidden;
      document.querySelector('#emptyReset').click();
      const reset = document.querySelectorAll('#grid .card').length;
      document.querySelector('#viewTableBtn').click();
      const link = document.querySelector('#tableBody .table-title-cell a');
      link.focus();
      const keyboardLink = document.activeElement === link;
      link.click();
      await new Promise(r => setTimeout(r, 100));
      const detailOpened = document.querySelector('#detail').open;
      document.querySelector('#closeBtn').click();
      document.querySelector('#viewGridBtn').click();
      return { filtered, empty, reset, keyboardLink, detailOpened };
    `);
    check('model filter narrows results', filterChecks.filtered === 1);
    check('combined search and model filters show empty state', filterChecks.empty);
    check('empty-state reset restores all runs', filterChecks.reset === live.after);
    check('table has keyboard-focusable run links', filterChecks.keyboardLink);
    check('table links open run details', filterChecks.detailOpened);
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
    // A run URL must also work in a new tab or after a reload.
    await cdp.send('Page.reload');
    await sleep(1400);
    check('direct run link reopens after reload', await cdp.eval(`return document.querySelector('#detail').open;`));
    // Wait for image decoding before validating and capturing the gallery.
    await cdp.eval(`
      for (const img of document.querySelectorAll('#detail .gallery img')) {
        img.scrollIntoView({ block: 'center', behavior: 'instant' });
        await img.decode().catch(() => {});
      }
      document.querySelector('.detail-inner').scrollTop = 0;
      return true;
    `);
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
    check('metric tiles rendered', detail.tiles >= 3, `got ${detail.tiles}`);
    if (detail.charts > 0) check('charts rendered as svg', detail.charts >= 1, `got ${detail.charts}`);
    if (detail.videos > 0) check('video element present', detail.videos >= 1, `got ${detail.videos}`);
    if (detail.tables > 0) check('csv table rendered', detail.tables >= 1, `got ${detail.tables}`);
    check('playable placeholders present', detail.playables >= 1, `got ${detail.playables}`);
    check('gallery images loaded', detail.imagesBroken === 0, `${detail.imagesBroken}/${detail.images} broken`);
    check('notes prose rendered', detail.prose >= 1, `got ${detail.prose}`);
    check('markdown produced content', detail.proseText > 50, `${detail.proseText} characters of prose`);
    check('play button icon drawn', detail.playIcon !== 'none' && detail.playIcon !== '0px', String(detail.playIcon));

    const tiles = await cdp.eval(`
      return [...document.querySelectorAll('.tile')].map(t => t.querySelector('.tile-label').textContent + '=' + t.querySelector('.tile-value').textContent.trim());
    `);
    check('metric units formatted', tiles.some((t) => t.includes('100%') || t.includes('%')), tiles.join(' '));
    console.log(`    metrics: ${tiles.join(', ')}`);
    await cdp.shot('02-detail-top');
    await cdp.eval(`document.querySelector('.detail-inner').scrollTop = document.querySelector('.gallery')?.offsetTop - 80 || 200; return 1;`);
    await sleep(400);
    await cdp.shot('03-detail-gallery');
    const lightbox = await cdp.eval(`
      const button = document.querySelector('.image-preview');
      if (!button) return false;
      button.click();
      const box = document.querySelector('#lightbox');
      await document.querySelector('#lightboxImg').decode();
      const visible = box.open && box.matches(':modal') && document.querySelector('#lightboxImg').naturalWidth > 0;
      document.querySelector('#lightboxClose').click();
      return visible && document.querySelector('#detail').open && !box.open;
    `);
    check('image preview opens above detail and closes independently', lightbox);

    // ── playable (iframe / canvas) ──────────────────────────────────────────
    const iframe = await cdp.eval(`
      const blocks = [...document.querySelectorAll('.gallery .media-block')];
      const block = blocks.find(b => b.querySelector('.playable-launch'));
      if (!block) return { found: false };
      block.querySelector('.playable-launch').click();
      await new Promise(r => setTimeout(r, 2200));
      const frame = block.querySelector('iframe');
      if (!frame) return { found: true, iframe: false, text: block.textContent.slice(0, 200) };
      return { found: true, iframe: true, sandbox: frame.getAttribute('sandbox') };
    `);
    check('iframe playable embedded', iframe.iframe, JSON.stringify(iframe).slice(0, 300));
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
      search.value = 'deepseek';
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
    await cdp.shot('06-mobile-detail');
    const detailOverflow = await cdp.eval(`const el = document.querySelector('.detail-inner'); return el.scrollWidth <= el.clientWidth + 1;`);
    check('mobile detail has no horizontal overflow', detailOverflow);
    await cdp.eval(`document.querySelector('#closeBtn').click(); return true;`);
    await sleep(200);
    await cdp.eval(`
      for (const card of document.querySelectorAll('#grid .card')) {
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise(r => setTimeout(r, 350));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
      return true;
    `);
    await cdp.shot('06-mobile', true);
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
    await cdp.shot('08-dark-grid', true);

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

main().then(() => {
  process.exit(process.exitCode || 0);
}).catch((err) => {
  console.error('✗ smoke test failed:', err);
  process.exit(1);
});

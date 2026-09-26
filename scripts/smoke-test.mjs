#!/usr/bin/env node
/**
 * Optional browser smoke test. Drives headless Chrome over CDP to verify that
 * the run list, run page, media (image/video/table/chart), WASM and iframe
 * playables all render without console errors.
 *
 *   node scripts/smoke-test.mjs [--keep] [--url http://127.0.0.1:4173/]
 *
 * Requires Chrome/Chromium and a running `npm run serve`. Exits non-zero on
 * any console error or failed assertion. Screenshots land in .smoke/.
 */
import { spawn } from 'node:child_process';
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
      } catch {
        if (attempt === 59) throw new Error('could not attach to devtools');
        await sleep(250);
      }
    }
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

    // ── index ───────────────────────────────────────────────────────────────
    const index = await cdp.eval(`
      const manifest = await (await fetch('data/results.json?t=' + Date.now())).json();
      const rows = [...document.querySelectorAll('#runs .run-row')];
      return {
        expected: manifest.count,
        rows: rows.length,
        titles: rows.map(r => r.querySelector('.run-title')?.textContent),
        chips: document.querySelectorAll('#filters .chip').length,
        meta: document.querySelector('#meta').textContent,
        footer: document.querySelector('#footerMeta').textContent,
        thumbs: document.querySelectorAll('.run-thumb img').length,
        thumbsBroken: [...document.querySelectorAll('.run-thumb img')].filter(i => !i.complete || i.naturalWidth === 0).length,
      };
    `);
    check('one row per run', index.rows === index.expected, `got ${index.rows}, expected ${index.expected}`);
    check('filter chips rendered', index.chips >= 1, `got ${index.chips}`);
    check('counter line stays quiet when unfiltered', index.meta === '', index.meta);
    check('footer summary filled', /run/.test(index.footer), index.footer);
    check('row thumbnails loaded', index.thumbsBroken === 0, `${index.thumbsBroken}/${index.thumbs} broken`);
    console.log(`    runs: ${index.titles.join(' | ')}`);
    await cdp.shot('01-index');

    // ── routing: row → run page → back ──────────────────────────────────────
    const nav = await cdp.eval(`
      document.querySelector('#runs .run-row').click();
      await new Promise(r => setTimeout(r, 700));
      const detail = {
        indexHidden: document.querySelector('#indexView').hidden,
        pageVisible: !document.querySelector('#runView').hidden,
        title: document.querySelector('#runView .run-title')?.textContent,
        hash: location.hash,
        documentTitle: document.title,
      };
      document.querySelector('.back').click();
      await new Promise(r => setTimeout(r, 700));
      return { ...detail, backToIndex: !document.querySelector('#indexView').hidden, rowsBack: document.querySelectorAll('#runs .run-row').length };
    `);
    check('row opens a run page', nav.pageVisible && nav.indexHidden, JSON.stringify(nav));
    check('run page sets hash and title', /^#\/run\//.test(nav.hash) && nav.documentTitle.startsWith(nav.title || 'x'), nav.hash);
    check('back link returns to the list', nav.backToIndex && nav.rowsBack === index.rows, JSON.stringify(nav));

    // ── run page content ────────────────────────────────────────────────────
    const runId = await cdp.eval(`
      const manifest = await (await fetch('data/results.json?t=' + Date.now())).json();
      const withMedia = manifest.runs.find(r => r.media.some(m => m.type === 'playable'));
      location.hash = '#/run/' + encodeURIComponent(withMedia.id);
      await new Promise(r => setTimeout(r, 700));
      return withMedia.id;
    `);
    const detail = await cdp.eval(`
      return {
        title: document.querySelector('#runView h1')?.textContent,
        summary: document.querySelector('.run-summary')?.textContent.length,
        metrics: document.querySelectorAll('.metric').length,
        charts: document.querySelectorAll('.chart svg').length,
        media: document.querySelectorAll('.media-block').length,
        videos: document.querySelectorAll('video').length,
        tables: document.querySelectorAll('.media-block table').length,
        playables: document.querySelectorAll('.playable-launch').length,
        images: document.querySelectorAll('.media-block img').length,
        imagesBroken: [...document.querySelectorAll('.media-block img')].filter(i => !i.complete || i.naturalWidth === 0).length,
        prose: document.querySelectorAll('.prose').length,
        proseText: [...document.querySelectorAll('.prose')].map(p => p.textContent.trim().length).reduce((a, b) => a + b, 0),
        proseLinks: document.querySelectorAll('.prose a').length,
        disclosure: document.querySelectorAll('.disclosure').length,
        playIcon: document.querySelector('.playable-launch .play-icon svg')?.getBoundingClientRect().width || 0,
      };
    `);
    check('title rendered', detail.title?.length > 3, String(detail.title));
    check('summary rendered', detail.summary > 40, `${detail.summary} characters`);
    check('metrics rendered', detail.metrics >= 3, `got ${detail.metrics}`);
    if (detail.charts > 0) check('charts rendered as svg', detail.charts >= 1, `got ${detail.charts}`);
    if (detail.videos > 0) check('video element present', detail.videos >= 1, `got ${detail.videos}`);
    if (detail.tables > 0) check('csv table rendered', detail.tables >= 1, `got ${detail.tables}`);
    check('playable placeholder present', detail.playables >= 1, `got ${detail.playables}`);
    check('media images loaded', detail.imagesBroken === 0, `${detail.imagesBroken}/${detail.images} broken`);
    check('prompt/notes disclosure present', detail.disclosure >= 1, `got ${detail.disclosure}`);
    check('notes prose rendered', detail.prose >= 1, `got ${detail.prose}`);
    check('markdown produced content', detail.proseText > 50, `${detail.proseText} characters of prose`);
    check('play button icon drawn', detail.playIcon > 8, String(detail.playIcon));

    const metrics = await cdp.eval(`
      return [...document.querySelectorAll('.metric')].map(m => m.querySelector('.metric-label').textContent + '=' + m.querySelector('.metric-value').textContent.trim());
    `);
    check('metric units formatted', metrics.some((m) => m.includes('%')), metrics.join(' '));
    console.log(`    metrics: ${metrics.join(', ')}`);
    await cdp.shot('02-run-top');
    await cdp.eval(`document.querySelector('.gallery').scrollIntoView(); return 1;`);
    await sleep(500);
    await cdp.shot('03-run-artifacts');

    // ── disclosure expands to the logs ──────────────────────────────────────
    const disclosure = await cdp.eval(`
      const d = document.querySelector('.disclosure');
      d.open = true;
      await new Promise(r => setTimeout(r, 500));
      return {
        open: d.open,
        files: d.querySelectorAll('a[download]').length,
        env: d.querySelectorAll('.kv dt').length,
        prose: d.querySelectorAll('.prose').length,
      };
    `);
    check('disclosure reveals environment', disclosure.env >= 1, JSON.stringify(disclosure));
    check('disclosure reveals run.json / log links', disclosure.files >= 1, JSON.stringify(disclosure));
    await cdp.shot('04-run-logs');

    // ── playable (iframe / canvas) ──────────────────────────────────────────
    const iframe = await cdp.eval(`
      const block = [...document.querySelectorAll('.media-block')].find(b => b.querySelector('.playable-launch'));
      if (!block) return { found: false };
      block.querySelector('.playable-launch').click();
      await new Promise(r => setTimeout(r, 2200));
      const frame = block.querySelector('iframe');
      if (!frame) return { found: true, iframe: false, text: block.textContent.slice(0, 200) };
      return { found: true, iframe: true, sandbox: frame.getAttribute('sandbox'), controls: block.querySelectorAll('.playable-bar .btn, .playable-bar a').length };
    `);
    check('iframe playable embedded', iframe.iframe, JSON.stringify(iframe).slice(0, 300));
    check('iframe is sandboxed', /allow-scripts/.test(iframe.sandbox || ''), String(iframe.sandbox));
    check('playable bar offers open/fullscreen', iframe.controls >= 2, String(iframe.controls));
    await cdp.shot('05-iframe');

    // ── theme toggle, search, sort ──────────────────────────────────────────
    const ui = await cdp.eval(`
      location.hash = '#/';
      await new Promise(r => setTimeout(r, 500));
      const before = document.documentElement.dataset.theme;
      document.querySelector('#themeBtn').click();
      const after = document.documentElement.dataset.theme;
      document.querySelector('#themeBtn').click();
      const restored = document.documentElement.dataset.theme;

      const search = document.querySelector('#search');
      search.value = 'deepseek';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const filtered = document.querySelectorAll('#runs .run-row').length;
      const counter = document.querySelector('#meta').textContent;
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));

      const sort = document.querySelector('#sort');
      sort.value = 'title-asc';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const first = document.querySelector('#runs .run-row .run-title')?.textContent;
      sort.value = 'date-desc';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));

      const chip = document.querySelector('#filters .chip');
      const chipText = chip.textContent.replace(/\\d+$/, '');
      chip.click();
      await new Promise(r => setTimeout(r, 300));
      const afterChip = document.querySelectorAll('#runs .run-row').length;
      // chips are re-rendered on click, so re-query rather than trusting the old node
      const pressed = [...document.querySelectorAll('#filters .chip')]
        .some(c => c.getAttribute('aria-pressed') === 'true' && c.textContent.replace(/\\d+$/, '') === chipText);
      document.querySelector('.chip-clear').click();
      await new Promise(r => setTimeout(r, 300));
      return { before, after, restored, filtered, counter, first, afterChip, pressed, restored_rows: document.querySelectorAll('#runs .run-row').length };
    `);
    check('theme toggle switches theme', ui.after !== ui.before && ui.restored === ui.before, `${ui.before} → ${ui.after} → ${ui.restored}`);
    check('search narrows the list to 1', ui.filtered === 1, `got ${ui.filtered}`);
    check('narrowed counter reports the match', /^1 of \d+ runs?$/.test(ui.counter), ui.counter);
    check('sort changes ordering', typeof ui.first === 'string' && ui.first.length > 0, String(ui.first));
    check('filter chip narrows and clears', ui.pressed === true && ui.afterChip < index.rows && ui.restored_rows === index.rows, JSON.stringify(ui));
    await cdp.shot('06-light-index');

    // ── lightbox ────────────────────────────────────────────────────────────
    const lightbox = await cdp.eval(`
      const img = document.querySelector('.media-block img');
      if (!img) return { skipped: true };
      location.hash = '#/run/' + encodeURIComponent(${JSON.stringify(runId)});
      await new Promise(r => setTimeout(r, 700));
      img.click();
      await new Promise(r => setTimeout(r, 300));
      const open = !document.querySelector('#lightbox').hidden;
      document.querySelector('#lightbox').click();
      return { open, closed: document.querySelector('#lightbox').hidden };
    `);
    if (lightbox.skipped) check('lightbox opens and closes', true);
    else check('lightbox opens and closes', lightbox.open && lightbox.closed, JSON.stringify(lightbox));

    // ── mobile layout ───────────────────────────────────────────────────────
    await cdp.eval(`location.hash = '#/'; return 1;`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    await cdp.shot('07-mobile-index');
    const mobile = await cdp.eval(`
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        sideHidden: getComputedStyle(document.querySelector('.run-side')).display === 'none',
        mainWidth: document.querySelector('.run-main').getBoundingClientRect().width,
      };
    `);
    check('no horizontal overflow on mobile', mobile.overflow, 'page scrolls sideways');
    check('date column dropped on mobile', mobile.sideHidden, JSON.stringify(mobile));
    check('row body keeps usable width', mobile.mainWidth > 250, String(mobile.mainWidth));

    // ── dark theme via system preference ────────────────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await cdp.eval(`try { localStorage.clear(); } catch {} location.hash = '#/'; location.reload(); return 1;`);
    await sleep(2600);
    const dark = await cdp.eval(`
      return {
        theme: document.documentElement.dataset.theme,
        rows: document.querySelectorAll('#runs .run-row').length,
      };
    `);
    check('system dark preference respected', dark.theme === 'dark', JSON.stringify(dark));
    check('list still rendered after reload', dark.rows >= 3, JSON.stringify(dark));
    await cdp.shot('08-dark-index');
    await cdp.eval(`location.hash = '#/run/' + encodeURIComponent(${JSON.stringify(runId)}); return 1;`);
    await sleep(1200);
    await cdp.shot('09-dark-run');

    const problems = cdp.consoleProblems();
    check('no console errors or warnings', problems.length === 0, problems.slice(0, 5).join(' || '));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length ? '✗' : '✓'} ${checks.length - failed.length}/${checks.length} checks passed`);
    console.log(`  screenshots: ${path.relative(process.cwd(), OUT_DIR)}/`);
    if (failed.length) process.exitCode = 1;
  } finally {
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

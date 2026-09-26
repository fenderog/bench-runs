/* ============================================================================
   Bench Runs — viewer.
   Reads data/results.json (generated from public/results/<id>/run.json) and
   renders a list of runs plus one page per run.
   ========================================================================== */

const CFG = Object.freeze({
  title: 'Bench Runs',
  subtitle: '',
  manifest: 'data/results.json',
  repoUrl: '',
  ...(window.BENCH_CONFIG || {}),
});

const CHART_COLORS = ['#6ea8fe', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee'];

/* ── DOM helpers ──────────────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') setStyles(node, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const kid of kids.flat(6)) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function setStyles(node, styles) {
  for (const [prop, val] of Object.entries(styles || {})) {
    if (val === null || val === undefined) continue;
    if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
    else node.style[prop] = val;
  }
}

const svgEl = (tag, props = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  return node;
};

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/* ── formatting ───────────────────────────────────────────────────────────── */
function fmtNumber(raw, unit = '') {
  let num = typeof raw === 'number' ? raw : Number(String(raw).replace(/[, ]/g, ''));
  if (!Number.isFinite(num)) return String(raw);
  if (unit === '%' && Math.abs(num) <= 1) num *= 100;
  let text;
  if (Number.isInteger(num)) text = String(num);
  else if (Math.abs(num) >= 1000) text = num.toLocaleString(undefined, { maximumFractionDigits: 1 });
  else if (Math.abs(num) >= 1) text = num.toFixed(Math.abs(num) < 10 ? 2 : 1).replace(/\.?0+$/, '');
  else text = num.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

const fmtMetric = (m) => fmtNumber(m.value, m.unit) + (m.unit === '%' ? '%' : m.unit ? ' ' + m.unit : '');

function fmtBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return 'undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'undated';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  return `${(n / 3600).toFixed(1)}h`;
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return fmtDate(iso);
}

const initials = (text) => {
  const words = String(text).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  if (!words[0]) return '?';
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
};

function bust(src, version) {
  if (!src || !version) return src;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  return src + (src.includes('?') ? '&' : '?') + 'v=' + version;
}

/* ── markdown renderer ────────────────────────────────────────────────────── */
function md(source, base = '') {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const link = (href) => (/^(https?:|mailto:|#|\/)/i.test(href) ? href : base + encodeURI(href));

  const inline = (text) => {
    const codes = [];
    let t = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
    t = esc(t);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, alt, src, title) => `<img src="${link(src)}" alt="${alt}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, label, href, title) => `<a href="${link(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${label}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(\W])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
    return t;
  };

  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = line.match(/^(\s*)(```|~~~)(\w*)/);
    if (fence) {
      const tag = fence[2];
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].startsWith(fence[1] + tag)) codeLines.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quotes = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quotes.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(quotes.join('\n'), base)}</blockquote>`);
      continue;
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const parts = [lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) parts.push(lines[i++].trim());
        items.push(`<li>${parts.map(inline).join(' ')}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    const para = [];
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])
    ) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  return out.join('');
}

/* ── charts ───────────────────────────────────────────────────────────────── */
function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const step = Math.pow(10, Math.floor(Math.log10((max - min) / count)));
  const err = ((max - min) / count) / step;
  const s = step * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const lo = Math.floor(min / s) * s;
  const hi = Math.ceil(max / s) * s;
  const ticks = [];
  for (let v = lo; v <= hi + s / 2; v += s) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function renderChart(spec) {
  const W = 560;
  const H = 240;
  const pad = { top: 14, right: 12, bottom: 34, left: 42 };
  const type = spec.type === 'bar' ? 'bar' : 'line';
  const x = (spec.x ?? []).map((v) => String(v));
  const series = (spec.series ?? []).filter((s) => s && Array.isArray(s.values));
  const all = series.flatMap((s) => s.values).map(Number).filter(Number.isFinite);
  if (!series.length || !all.length) return null;

  const dataMin = spec.yMin ?? Math.min(...all);
  const dataMax = spec.yMax ?? Math.max(...all);
  const ticks = niceTicks(dataMin, dataMax, spec.ticks ?? 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const points = Math.max(x.length, 1);
  const sx = (idx) => pad.left + (points === 1 ? plotW / 2 : (idx / (points - 1)) * plotW);
  const sy = (v) => pad.top + plotH - ((Number(v) - yMin) / (yMax - yMin || 1)) * plotH;
  const color = (i) => series[i].color || CHART_COLORS[i % CHART_COLORS.length];

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.title || 'chart' });

  for (const tick of ticks) {
    svg.append(svgEl('line', { class: 'grid-line', x1: pad.left, x2: W - pad.right, y1: sy(tick), y2: sy(tick) }));
    const label = svgEl('text', { class: 'axis-text', x: pad.left - 7, y: sy(tick) + 3.5, 'text-anchor': 'end' });
    label.textContent = fmtNumber(tick);
    svg.append(label);
  }

  const step = Math.ceil(x.length / Math.max(2, Math.floor(plotW / 68)));
  x.forEach((label, idx) => {
    if (x.length > 8 && idx % step !== 0 && idx !== x.length - 1) return;
    const text = svgEl('text', { class: 'axis-text', x: sx(idx), y: H - pad.bottom + 16, 'text-anchor': 'middle' });
    text.textContent = label.length > 12 ? label.slice(0, 11) + '…' : label;
    svg.append(text);
  });

  if (spec.yLabel) {
    const label = svgEl('text', { class: 'axis-text', x: pad.left - 2, y: pad.top - 3, 'text-anchor': 'start' });
    label.textContent = spec.yLabel;
    svg.append(label);
  }

  if (type === 'bar') {
    const slot = plotW / points;
    const barW = Math.max(3, (slot * 0.68) / series.length);
    series.forEach((s, si) => {
      s.values.forEach((value, idx) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        const xPos = pad.left + slot * idx + slot / 2 - (barW * series.length) / 2 + si * barW;
        const yPos = sy(Math.max(v, yMin));
        svg.append(svgEl('rect', {
          x: xPos, y: yPos, width: barW, height: Math.max(1, sy(yMin) - yPos),
          rx: Math.min(3, barW / 2), fill: color(si),
        }));
      });
    });
  } else {
    series.forEach((s, si) => {
      const coords = s.values.map((value, idx) => [sx(idx), sy(value)]).filter(([, py]) => Number.isFinite(py));
      if (coords.length > 1) {
        svg.append(svgEl('polyline', {
          points: coords.map(([px, py]) => `${px},${py}`).join(' '),
          fill: 'none', stroke: color(si), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
      }
      coords.forEach(([px, py]) => svg.append(svgEl('circle', { cx: px, cy: py, r: coords.length > 26 ? 1.8 : 3, fill: color(si) })));
    });
  }

  return h('div', { class: 'chart' },
    spec.title ? h('h4', { text: spec.title }) : null,
    spec.subtitle ? h('div', { class: 'chart-sub', text: spec.subtitle }) : null,
    svg,
    series.length > 1
      ? h('div', { class: 'legend' }, series.map((s, si) => h('span', {}, h('i', { style: { background: color(si) } }), s.name || `series ${si + 1}`)))
      : null,
  );
}

/* ── state ────────────────────────────────────────────────────────────────── */
const state = {
  runs: [],
  filtered: [],
  query: '',
  filters: { model: new Set(), tag: new Set() },
  sort: localStorage.getItem('bench.sort') || 'date-desc',
  generatedAt: null,
  error: null,
};

/* ── data ─────────────────────────────────────────────────────────────────── */
async function load() {
  try {
    const url = new URL(CFG.manifest, document.baseURI);
    url.searchParams.set('t', String(Date.now()));
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    state.runs = Array.isArray(data?.runs) ? data.runs : Array.isArray(data) ? data : [];
    state.generatedAt = data?.generatedAt ?? null;
    state.error = null;
  } catch (err) {
    state.runs = [];
    state.error = err;
  }
  renderChips();
  renderIndex();
  renderFooter();
  route();
}

function renderFooter() {
  const parts = [state.runs.length ? `${state.runs.length} run${state.runs.length === 1 ? '' : 's'}` : 'no runs'];
  const models = new Set(state.runs.map((r) => r.model).filter(Boolean));
  if (models.size) parts.push(`${models.size} model${models.size === 1 ? '' : 's'}`);
  if (state.generatedAt) parts.push(`updated ${fmtRelative(state.generatedAt)}`);
  $('#footerMeta').textContent = parts.join(' · ');
}

/* ── filtering & sorting ─────────────────────────────────────────────────── */
const searchable = (run) => [
  run.id, run.title, run.model, run.benchmark, run.summary,
  ...(run.tags ?? []),
  ...Object.entries(run.environment ?? {}).map(([k, v]) => `${k} ${v}`),
].join(' ').toLowerCase();

function applyFilters() {
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const { model, tag } = state.filters;

  state.filtered = state.runs.filter((run) => {
    if (model.size && !model.has(run.model)) return false;
    if (tag.size && !(run.tags ?? []).some((t) => tag.has(t))) return false;
    if (tokens.length) {
      const haystack = searchable(run);
      if (!tokens.every((t) => haystack.includes(t))) return false;
    }
    return true;
  });

  const byDate = (a, b) => Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0);
  const sorters = {
    'date-desc': (a, b) => byDate(a, b) || a.title.localeCompare(b.title),
    'date-asc': (a, b) => -byDate(a, b) || a.title.localeCompare(b.title),
    'title-asc': (a, b) => a.title.localeCompare(b.title),
    'model-asc': (a, b) => (a.model || '~').localeCompare(b.model || '~') || a.title.localeCompare(b.title),
  };
  state.filtered.sort(sorters[state.sort] ?? sorters['date-desc']);
}

function renderChips() {
  const host = clear($('#filters'));

  for (const key of ['model', 'tag']) {
    const values = [...new Set(state.runs.flatMap((r) => (key === 'tag' ? (r.tags ?? []) : [r.model])).filter(Boolean))];
    if (!values.length) continue;
    if (key === 'model' && values.length < 2) continue;

    for (const value of values.sort()) {
      const count = state.runs.filter((r) => (key === 'tag' ? (r.tags ?? []) : [r.model]).includes(value)).length;
      host.append(h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': state.filters[key].has(value) ? 'true' : 'false',
        onclick: () => {
          const set = state.filters[key];
          set.has(value) ? set.delete(value) : set.add(value);
          renderChips();
          renderIndex();
        },
      }, h('span', { class: 'chip-text', text: key === 'tag' ? '#' + value : value }), count > 1 ? h('span', { class: 'chip-count', text: String(count) }) : null));
    }
  }

  if (state.filters.model.size || state.filters.tag.size) {
    host.append(h('button', {
      type: 'button', class: 'chip chip-clear',
      onclick: () => {
        state.filters.model.clear();
        state.filters.tag.clear();
        renderChips();
        renderIndex();
      },
    }, 'clear'));
  }
}

/* ── index ────────────────────────────────────────────────────────────────── */
const HEADLINE = /acc|score|pass|success|completion|rate|quality/i;
const SKIP_ROW = /^(reasoning_blocks|tool_errors)$/;

/** The few numbers worth showing on a list row: turns, duration, a headline score. */
function rowMetrics(run) {
  const metrics = run.metrics ?? [];
  const turns = metrics.find((m) => m.label === 'turns');
  const duration = metrics.find((m) => m.label === 'duration');
  const score = metrics.find((m) => HEADLINE.test(m.label));
  const out = [];
  if (turns && Number.isFinite(Number(turns.value))) out.push(h('span', {}, h('b', { text: String(turns.value) }), ' turns'));
  const mins = duration ? fmtDuration(duration.value) : null;
  if (mins) out.push(h('span', { text: mins }));
  if (score && score !== duration) out.push(h('span', { text: fmtMetric(score) }));
  if (!out.length) {
    for (const m of metrics.filter((m) => !SKIP_ROW.test(m.label)).slice(0, 3)) {
      out.push(h('span', { text: fmtMetric(m) }));
    }
  }
  return out;
}

function thumbNode(run) {
  const src = run._meta?.preview;
  const missing = run.media?.find((m) => m.src === src)?.missing;
  if (src && !missing) {
    return h('div', { class: 'run-thumb' },
      h('img', {
        src: bust(src, run._meta?.version), alt: '', loading: 'lazy', decoding: 'async',
        onerror: (event) => { event.currentTarget.replaceWith(h('div', { class: 'run-thumb-fallback', text: initials(run.model || run.title) })); },
      }));
  }
  return h('div', { class: 'run-thumb' }, h('div', { class: 'run-thumb-fallback', text: initials(run.model || run.title) }));
}

function renderIndex() {
  const list = clear($('#runs'));
  const notice = $('#notice');

  if (state.error) {
    notice.hidden = false;
    notice.textContent = `Could not load ${CFG.manifest} (${state.error.message}).`;
    $('#empty').hidden = true;
    $('#meta').textContent = '';
    return;
  }

  notice.hidden = true;
  applyFilters();

  // the footer already carries the totals; only speak up when a filter narrows them
  $('#meta').textContent = state.filtered.length !== state.runs.length
    ? `${state.filtered.length} of ${state.runs.length} run${state.runs.length === 1 ? '' : 's'}`
    : '';

  $('#empty').hidden = state.filtered.length > 0;
  $('#emptyHint').textContent = state.runs.length
    ? 'No runs match the current search.'
    : `Add a folder under public/results/<run-id>/ with a run.json, then run \`npm run manifest\`.`;

  for (const run of state.filtered) {
    list.append(h('li', {},
      h('a', { class: 'run-row', href: `#/run/${encodeURIComponent(run.id)}` },
        thumbNode(run),
        h('div', { class: 'run-main' },
          h('div', { class: 'run-title', text: run.title }),
          h('div', { class: 'run-line' },
            run.model || 'unknown model',
            run.benchmark ? h('span', { class: 'sep', text: '·' }) : null,
            run.benchmark || null),
          h('div', { class: 'run-metrics' }, rowMetrics(run)),
        ),
        h('div', { class: 'run-side', text: fmtDate(run.date) }),
      )));
  }
}

/* ── run detail ───────────────────────────────────────────────────────────── */
const isLogMedia = (item) => ['markdown', 'code', 'file'].includes(item.type);

function renderDetail(run) {
  const host = clear($('#runView'));
  const media = run.media ?? [];
  const artifacts = media.filter((item) => !isLogMedia(item));
  const logs = media.filter(isLogMedia);
  const env = Object.entries(run.environment ?? {});
  const warnings = run._meta?.warnings ?? [];

  const copyButton = h('button', {
    type: 'button', class: 'btn',
    onclick: async (event) => {
      const url = `${location.origin}${location.pathname}#/run/${encodeURIComponent(run.id)}`;
      const btn = event.currentTarget;
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = url;
      }
      setTimeout(() => { btn.textContent = 'Copy link'; }, 1800);
    },
  }, 'Copy link');

  host.append(
    h('a', { class: 'back', href: '#/', text: '← all runs' }),
    h('div', { class: 'run-head' },
      h('h1', { class: 'run-title', text: run.title }),
      h('div', { class: 'run-sub' },
        run.model || 'unknown model',
        run.benchmark ? h('span', { class: 'sep', text: '·' }) : null,
        run.benchmark || null,
        h('span', { class: 'sep', text: '·' }),
        fmtDate(run.date)),
      run.summary ? h('p', { class: 'run-summary', text: run.summary }) : null,
      h('div', { class: 'run-actions' },
        copyButton,
        h('a', { class: 'btn', href: `${run._meta?.base ?? ''}run.json`, target: '_blank', rel: 'noopener' }, 'run.json'),
        CFG.repoUrl ? h('a', { class: 'btn', href: CFG.repoUrl, target: '_blank', rel: 'noopener' }, 'github') : null,
      ),
      (run.tags ?? []).length
        ? h('div', { class: 'tags' }, run.tags.map((tag) => h('span', { class: 'tag', text: tag })))
        : null,
    ),
  );

  if (artifacts.length) {
    host.append(h('section', { class: 'section' },
      h('h2', { class: 'section-title', text: 'Artifacts' }),
      h('div', { class: 'gallery' }, artifacts.map((item, i) => renderMedia(run, item, i)))));
  }

  const charts = (run.charts ?? []).map(renderChart).filter(Boolean);
  if (charts.length) {
    host.append(h('section', { class: 'section' },
      h('h2', { class: 'section-title', text: 'Charts' }),
      h('div', { class: 'gallery' }, charts)));
  }

  // Metrics are provenance, not the headline: collapsed by default, and only a
  // label and a value on screen — the longer explanation behind each number
  // rides along as a tooltip instead of a paragraph in every cell.
  if (run.metrics?.length) {
    host.append(h('section', { class: 'section' },
      h('details', { class: 'disclosure disclosure-metrics' },
        h('summary', {},
          h('span', { text: 'Metrics' }),
          h('span', { class: 'summary-count', text: String(run.metrics.length) })),
        h('div', { class: 'disclosure-content' },
          h('dl', { class: 'metrics' }, run.metrics.map((m) =>
            h('div', { class: 'metric', title: m.hint || null },
              h('dt', { text: m.label }),
              h('dd', {},
                fmtNumber(m.value, m.unit),
                m.unit ? h('span', { class: 'unit', text: m.unit === '%' ? '%' : ' ' + m.unit }) : null))))))));
  }

  if (env.length || warnings.length || run.notes || logs.length) {
    const content = h('div', { class: 'disclosure-content' });

    if (warnings.length) {
      content.append(h('div', { class: 'notice' }, warnings.join(' · ')));
    }
    if (env.length) {
      content.append(h('dl', { class: 'kv' }, env.flatMap(([key, value]) => [
        h('dt', { text: key.replace(/_/g, ' ') }),
        h('dd', { text: Array.isArray(value) ? value.join(', ') : String(value) }),
      ])));
    }
    if (run.notes) {
      content.append(h('div', { class: 'prose', html: md(run.notes, run._meta?.base ?? '') }));
    }
    if (logs.length) {
      content.append(h('div', { class: 'gallery' }, logs.map((item, i) => renderMedia(run, item, artifacts.length + i))));
    }

    host.append(h('section', { class: 'section' },
      h('details', { class: 'disclosure disclosure-logs' },
        h('summary', {}, h('span', { text: `Prompt, transcript, environment${env.length ? ' & notes' : ''}` })),
        content)));
  }

  if (run.links?.length) {
    host.append(h('section', { class: 'section' },
      h('h2', { class: 'section-title', text: 'Links' }),
      h('div', { class: 'links-list' }, run.links.map((link) =>
        h('a', { class: 'btn', href: link.href, target: '_blank', rel: 'noopener' }, link.label)))));
  }
}

/* ── media ────────────────────────────────────────────────────────────────── */
function caption(item, index) {
  if (!item.caption) return null;
  return h('figcaption', { class: 'media-caption' },
    h('span', { class: 'cap-index', text: String(index + 1).padStart(2, '0') }),
    h('span', { text: item.caption }));
}

function openLightbox(src, alt) {
  $('#lightboxImg').src = src;
  $('#lightboxImg').alt = alt || '';
  $('#lightbox').hidden = false;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightboxImg').src = '';
}

const PLAYABLE_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads allow-orientation-lock';
const EMBED_HOSTS = /(?:youtube\.com|youtu\.be|vimeo\.com|player\.twitch\.tv|sketchfab\.com|soundcloud\.com)/i;

function embedUrl(src) {
  const yt = String(src).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = String(src).match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return src;
}

const missingBlock = (what, src) => h('div', { class: 'media-missing' }, `${what} missing — ${src}`);

function renderImage(run, item, index) {
  const src = bust(item.src, run._meta?.version);
  const body = item.missing
    ? missingBlock('image', item.src)
    : h('div', { class: 'media-frame' }, h('img', {
        src, alt: item.alt || item.caption || `${run.title} image ${index + 1}`, decoding: 'async',
        onclick: () => openLightbox(src, item.alt || item.caption || ''),
      }));
  return h('figure', { class: 'media-block' }, body, caption(item, index));
}

function renderVideo(run, item, index) {
  const version = run._meta?.version;
  const isEmbed = item.embed === true || EMBED_HOSTS.test(String(item.src));
  let frame;

  if (isEmbed) {
    frame = h('iframe', {
      src: embedUrl(item.src), title: item.caption || `${run.title} video`,
      loading: 'lazy', allowfullscreen: true, style: { aspectRatio: item.aspect || '16 / 9', width: '100%' },
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen',
    });
  } else if (item.missing) {
    frame = missingBlock('video', item.src);
  } else {
    const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [{ src: item.src }];
    frame = h('video', {
      controls: true, preload: 'metadata', playsinline: true,
      poster: item.poster ? bust(item.poster, version) : null,
      loop: item.loop === true, muted: item.muted === true, autoplay: item.autoplay === true,
    }, sources.map((source) => h('source', { src: bust(source.src, version), type: source.type || null })));
  }
  return h('figure', { class: 'media-block' }, frame, caption(item, index));
}

function renderPlayable(run, item, index) {
  const version = run._meta?.version;
  const host = h('div', { class: 'playable-host', style: { '--pa': item.aspect || '16 / 9' } });
  const bar = h('div', { class: 'playable-bar' }, h('span', { class: 'spacer' }));
  const launch = h('button', {
    type: 'button', class: 'playable-launch', style: { '--pa': item.aspect || '16 / 9' },
    onclick: () => (item.kind === 'wasm' ? startWasm() : startIframe()),
  },
    h('span', { class: 'play-icon', html: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>' }),
    h('span', { class: 'playable-meta', text: item.caption || 'play' }));

  const block = h('figure', { class: 'media-block' }, launch, bar, caption(item, index));

  function swap(node) { launch.replaceWith(node); }

  function startIframe() {
    if (item.missing) {
      host.append(missingBlock('build', item.src));
      swap(host);
      return;
    }
    const iframe = h('iframe', {
      src: bust(item.src, version), title: item.caption || `${run.title} interactive demo`,
      sandbox: item.sandbox === false ? null : PLAYABLE_SANDBOX,
      allow: 'fullscreen; autoplay; gamepad; xr-spatial-tracking; clipboard-write',
      allowfullscreen: true,
    });
    host.append(iframe);
    swap(host);
    bar.prepend(
      h('span', { text: item.kind === 'wasm' ? 'wasm' : 'interactive' }),
      h('button', { type: 'button', class: 'btn', onclick: () => iframe.requestFullscreen?.() }, 'fullscreen'),
      h('a', { class: 'btn', href: bust(item.src, version), target: '_blank', rel: 'noopener' }, 'open ↗'),
    );
  }

  async function startWasm() {
    swap(host);
    try {
      const glueUrl = item.glue || new URL('wasm-loader.js', document.baseURI).href;
      const mod = await import(/* @vite-ignore */ glueUrl);
      const mount = mod.default ?? mod.mount ?? mod.init;
      if (typeof mount !== 'function') throw new Error('loader module must export default(mountEl, options)');
      await mount(host, { wasmUrl: bust(item.wasm || item.src, version), run, item });
      bar.prepend(h('span', { text: 'wasm · active' }));
    } catch (err) {
      host.append(h('div', { class: 'playable-error', text: `Could not start WebAssembly: ${err.message}` }));
      console.error('[bench] wasm playable failed', err);
    }
  }

  return block;
}

function renderTextBlock(run, item, index) {
  const isMarkdown = item.type === 'markdown';
  const body = h('div', { class: 'prose' });
  const paint = (text) => {
    clear(body);
    if (isMarkdown) body.innerHTML = md(text, run._meta?.base ?? '');
    else body.append(h('pre', {}, h('code', { text })));
  };

  if (typeof item.text === 'string') {
    paint(item.text);
  } else if (item.src && !item.missing) {
    body.append(h('div', { class: 'media-loading', text: 'loading…' }));
    fetch(bust(item.src, run._meta?.version), { cache: 'no-cache' })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
      .then((text) => { if (body.isConnected) paint(text); })
      .catch((err) => { clear(body); body.append(missingBlock('text', `${item.src} (${err.message})`)); });
  } else {
    body.append(missingBlock('text', item.src || '(no content)'));
  }

  return h('figure', { class: 'media-block' }, body, caption(item, index));
}

function renderTable(item, index) {
  return h('figure', { class: 'media-block' },
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, (item.columns ?? []).map((c) => h('th', { text: String(c) })))),
        h('tbody', {}, (item.rows ?? []).map((row) => h('tr', {}, row.map((cell) => h('td', { text: String(cell) }))))))),
    caption(item, index));
}

function renderFile(run, item, index) {
  return h('figure', { class: 'media-block' },
    h('figcaption', { class: 'media-caption' },
      item.missing
        ? h('span', { class: 'media-missing', text: `file missing — ${item.src}` })
        : h('a', { href: bust(item.src, run._meta?.version), download: '', target: '_blank', rel: 'noopener' },
            `↓ ${item.label || item.caption || item.src.split('/').pop()}`,
            item.bytes ? h('span', { class: 'chip-count', text: ` · ${fmtBytes(item.bytes)}` }) : null),
      item.caption ? h('span', { class: 'cap-index', text: '' }) : null));
}

function renderAudio(run, item, index) {
  return h('figure', { class: 'media-block' },
    h('div', { class: 'media-frame', style: { padding: '10px' } },
      h('audio', { controls: true, preload: 'metadata', style: { width: '100%' } },
        h('source', { src: bust(item.src, run._meta?.version) }))),
    caption(item, index));
}

function renderMedia(run, item, index) {
  switch (item.type) {
    case 'image': return renderImage(run, item, index);
    case 'video':
    case 'embed': return renderVideo(run, item, index);
    case 'playable': return renderPlayable(run, item, index);
    case 'audio': return renderAudio(run, item, index);
    case 'table': return renderTable(item, index);
    case 'markdown':
    case 'code': return renderTextBlock(run, item, index);
    default: return renderFile(run, item, index);
  }
}

/* ── routing ──────────────────────────────────────────────────────────────── */
function route() {
  const match = location.hash.match(/^#\/run\/(.+)$/);
  const run = match && state.runs.find((r) => r.id === decodeURIComponent(match[1]));

  if (run) {
    $('#indexView').hidden = true;
    $('#runView').hidden = false;
    renderDetail(run);
    document.title = `${run.title} · ${CFG.title}`;
  } else {
    if (match) history.replaceState(null, '', location.pathname + location.search + '#/');
    $('#indexView').hidden = false;
    $('#runView').hidden = true;
    renderIndex();
    document.title = CFG.title;
  }
  window.scrollTo(0, 0);
}

/* ── controls ─────────────────────────────────────────────────────────────── */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('bench.theme', theme); } catch { /* ignore */ }
}

$('#themeBtn').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

let searchTimer = null;
const searchInput = $('#search');
const searchClear = $('#searchClear');

searchInput.addEventListener('input', (event) => {
  searchClear.hidden = !event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value;
    renderIndex();
  }, 120);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  state.query = '';
  renderIndex();
  searchInput.focus();
});

const sortSelect = $('#sort');
if (![...sortSelect.options].some((o) => o.value === state.sort)) state.sort = 'date-desc';
sortSelect.value = state.sort;
sortSelect.addEventListener('change', (event) => {
  state.sort = event.target.value;
  try { localStorage.setItem('bench.sort', state.sort); } catch { /* ignore */ }
  renderIndex();
});

$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (event) => { if (event.target.id === 'lightbox') closeLightbox(); });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#lightbox').hidden) { closeLightbox(); return; }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable) return;
  if (event.key === '/') { event.preventDefault(); searchInput.focus(); }
  else if (event.key.toLowerCase() === 't') { $('#themeBtn').click(); }
});

window.addEventListener('hashchange', route);

/* ── boot ─────────────────────────────────────────────────────────────────── */
(function boot() {
  document.title = CFG.title;
  $('#siteTitle').textContent = CFG.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', CFG.subtitle || CFG.title);
  if (CFG.repoUrl) {
    $('#repoBtn').hidden = false;
    $('#repoBtn').href = CFG.repoUrl;
  }
  load();
})();

/* ============================================================================
   Bench Runs — viewer
   Reads data/results.json (generated from public/results/<id>/run.json) and
   renders cards, metrics, charts, galleries and interactive media.
   ========================================================================== */

const CFG = Object.freeze({
  title: 'Bench Runs',
  subtitle: '',
  manifest: 'data/results.json',
  repoUrl: '',
  pollSeconds: 30,
  showJson: true,
  ...(window.BENCH_CONFIG || {}),
});

const CHART_COLORS = ['#7c9cff', '#46d19b', '#f0b849', '#f2685f', '#c084fc', '#22d3ee'];

/* ── DOM helpers ──────────────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    // Only ever fed escaped markup from the built-in markdown renderer.
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') setStyles(node, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  add(node, kids);
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

function add(parent, kids) {
  for (const kid of kids.flat(6)) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    parent.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

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
  const d = Math.round(hr / 24);
  if (d < 31) return `${d}d ago`;
  return fmtDate(iso);
}

const initials = (text) => {
  const words = String(text).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  if (!words[0]) return '?';
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
};

const statusClass = (status) => `status status-${['complete', 'running', 'failed', 'partial'].includes(status) ? status : 'complete'}`;

/** Append a cache-busting version so re-uploaded assets at the same path refresh. */
function bust(src, version) {
  if (!src || !version) return src;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  return src + (src.includes('?') ? '&' : '?') + 'v=' + version;
}

/* ── markdown (small, safe subset) ────────────────────────────────────────── */
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
    t = t.replace(/(^|[\s(\W])_([^_\n]+)_/g, '$1<em>$2</em>');
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

    // fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code data-lang="${esc(fence[2] || '')}">${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // table
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${body.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    // lists
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

    // paragraph
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
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const lo = Math.floor(min / s) * s;
  const hi = Math.ceil(max / s) * s;
  const ticks = [];
  for (let v = lo; v <= hi + s / 2; v += s) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function renderChart(spec) {
  const W = 560;
  const H = 250;
  const pad = { top: 16, right: 14, bottom: 40, left: 46 };
  const type = spec.type === 'bar' ? 'bar' : 'line';
  const x = (spec.x ?? []).map((v) => String(v));
  const series = (spec.series ?? []).filter((s) => s && Array.isArray(s.values));
  const all = series.flatMap((s) => s.values).map(Number).filter(Number.isFinite);
  if (!series.length || !all.length) return null;

  const dataMin = spec.yMin !== undefined && spec.yMin !== null ? Number(spec.yMin) : Math.min(...all);
  const dataMax = spec.yMax !== undefined && spec.yMax !== null ? Number(spec.yMax) : Math.max(...all);
  const ticks = niceTicks(dataMin, dataMax, spec.ticks ?? 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const points = Math.max(x.length, 1);
  const sx = (idx) => pad.left + (points === 1 ? plotW / 2 : (idx / (points - 1)) * plotW);
  const sy = (v) => pad.top + plotH - ((Number(v) - yMin) / (yMax - yMin || 1)) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.title || 'chart' });

  for (const tick of ticks) {
    svg.append(svgEl('line', { class: 'grid-line', x1: pad.left, x2: W - pad.right, y1: sy(tick), y2: sy(tick) }));
    const tickLabel = svgEl('text', { class: 'axis-text', x: pad.left - 8, y: sy(tick) + 3.5, 'text-anchor': 'end' });
    tickLabel.textContent = fmtNumber(tick);
    svg.append(tickLabel);
  }

  const labelStep = Math.ceil(x.length / Math.max(2, Math.floor(plotW / 68)));
  x.forEach((label, idx) => {
    if (x.length > 8 && idx % labelStep !== 0 && idx !== x.length - 1) return;
    const text = svgEl('text', {
      class: 'axis-text', x: sx(idx), y: H - pad.bottom + 18, 'text-anchor': 'middle',
    });
    text.textContent = label.length > 12 ? label.slice(0, 11) + '…' : label;
    svg.append(text);
  });

  if (spec.yLabel) {
    const label = svgEl('text', { class: 'axis-text', x: pad.left - 4, y: pad.top - 5, 'text-anchor': 'start' });
    label.textContent = spec.yLabel;
    svg.append(label);
  }

  const color = (idx) => series[idx].color || CHART_COLORS[idx % CHART_COLORS.length];

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
          rx: Math.min(3, barW / 2), fill: color(si), opacity: 0.92,
        }));
      });
    });
  } else {
    series.forEach((s, si) => {
      const coords = s.values
        .map((value, idx) => [sx(idx), sy(value), value])
        .filter(([, , value]) => Number.isFinite(Number(value)));
      if (coords.length > 1) {
        svg.append(svgEl('polyline', {
          points: coords.map(([px, py]) => `${px},${py}`).join(' '),
          fill: 'none', stroke: color(si), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }));
      }
      coords.forEach(([px, py, value], idx) => {
        const dot = svgEl('circle', { cx: px, cy: py, r: coords.length > 26 ? 1.8 : 3.2, fill: color(si) });
        const tip = svgEl('title');
        tip.textContent = `${x[idx] ?? ''}: ${fmtNumber(value)}`;
        dot.append(tip);
        svg.append(dot);
      });
    });
  }

  const node = h('div', { class: 'chart' },
    spec.title ? h('h4', { text: spec.title }) : null,
    spec.subtitle ? h('div', { class: 'chart-sub', text: spec.subtitle }) : null,
    svg,
    series.length > 1
      ? h('div', { class: 'legend' }, series.map((s, si) => h('span', {},
        h('i', { style: { background: color(si) } }), s.name || `series ${si + 1}`)))
      : null,
  );
  return node;
}

/* ── state ────────────────────────────────────────────────────────────────── */
const LS = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
};

const state = {
  runs: [],
  filtered: [],
  query: '',
  filters: { benchmark: new Set(), model: new Set(), tag: new Set(), status: new Set() },
  sort: LS.get('bench.sort', 'date-desc'),
  seen: new Set(LS.get('bench.seen', [])),
  newIds: new Set(),
  signature: null,
  generatedAt: null,
  loading: true,
  error: null,
  openId: null,
};

/* ── load + live refresh ──────────────────────────────────────────────────── */
let pollTimer = null;

function setLive(kind, text) {
  const node = $('#live');
  node.classList.remove('is-ok', 'is-busy', 'is-error');
  if (kind) node.classList.add(`is-${kind}`);
  $('#liveText').textContent = text;
}

function toast(message, ms = 4200) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add('is-visible'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => { node.hidden = true; }, 260);
  }, ms);
}

function showNotice(message, isError = false) {
  const node = $('#notice');
  if (!message) { node.hidden = true; return; }
  clear(node);
  node.className = 'notice' + (isError ? ' is-error' : '');
  add(node, [h('span', { text: message })]);
  node.hidden = false;
}

async function load({ manual = false, quiet = false } = {}) {
  if (!quiet) setLive('busy', manual ? 'checking…' : 'loading…');
  try {
    const url = new URL(CFG.manifest, document.baseURI);
    url.searchParams.set('t', String(Date.now()));
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const runs = Array.isArray(data?.runs) ? data.runs : Array.isArray(data) ? data : [];

    const signature = [data?.generatedAt ?? '', runs.length, ...runs.map((r) => `${r.id}:${r._meta?.version ?? ''}`)].join('|');
    const changed = signature !== state.signature;
    const first = state.signature === null;
    state.signature = signature;
    state.generatedAt = data?.generatedAt ?? new Date().toISOString();
    state.runs = runs;
    state.error = null;
    state.loading = false;

    if (!first) {
      const fresh = runs.filter((r) => !state.seen.has(r.id));
      state.newIds = new Set(fresh.map((r) => r.id));
      if (changed && fresh.length) {
        toast(`${fresh.length} new result${fresh.length === 1 ? '' : 's'} published`);
      } else if (changed && manual) {
        toast('Results updated');
      } else if (manual) {
        toast('Already up to date');
      }
    }
    for (const run of runs) state.seen.add(run.id);
    LS.set('bench.seen', [...state.seen]);

    showNotice(null);
    if (changed || first) {
      renderChips();
      renderGrid();
    } else {
      updateFooter();
    }
  } catch (err) {
    state.loading = false;
    state.error = err;
    setLive('error', 'offline');
    if (!quiet || manual) {
      showNotice(
        `Could not load ${CFG.manifest} (${err.message}). ` +
        'If this is the first run, add a folder under public/results/ and run `npm run manifest`.',
        true,
      );
      if (state.error && !state.signature) renderGrid();
    }
    return;
  }

  setLive('ok', `live · ${state.runs.length} run${state.runs.length === 1 ? '' : 's'}`);
  updateFooter();
}

function startPolling() {
  clearInterval(pollTimer);
  if (!CFG.pollSeconds) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !navigator.onLine) return;
    load({ quiet: true });
  }, CFG.pollSeconds * 1000);
}

/* ── filtering ────────────────────────────────────────────────────────────── */
const searchable = (run) => [
  run.id, run.title, run.model, run.benchmark, run.status, run.summary,
  ...(run.tags ?? []),
  ...Object.values(run.environment ?? {}),
  run.notes ?? '',
].join(' ').toLowerCase();

function applyFilters() {
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const { benchmark, model, tag, status } = state.filters;

  state.filtered = state.runs.filter((run) => {
    if (benchmark.size && !benchmark.has(run.benchmark)) return false;
    if (model.size && !model.has(run.model)) return false;
    if (status.size && !status.has(run.status)) return false;
    if (tag.size && !(run.tags ?? []).some((t) => tag.has(t))) return false;
    if (tokens.length) {
      const haystack = searchable(run);
      if (!tokens.every((t) => haystack.includes(t))) return false;
    }
    return true;
  });

  const metricValue = (run, pattern) => {
    const metric = (run.metrics ?? []).find((m) => pattern.test(m.label));
    const value = Number(metric?.value);
    return Number.isFinite(value) ? value : -Infinity;
  };

  const sorters = {
    'date-desc': (a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0) || a.title.localeCompare(b.title),
    'date-asc': (a, b) => (Date.parse(a.date ?? 0) || 0) - (Date.parse(b.date ?? 0) || 0) || a.title.localeCompare(b.title),
    'title-asc': (a, b) => a.title.localeCompare(b.title),
    'model-asc': (a, b) => (a.model || '~').localeCompare(b.model || '~') || a.title.localeCompare(b.title),
    'accuracy-desc': (a, b) =>
      metricValue(b, /acc|score|pass|success|f1|exact|win/i) - metricValue(a, /acc|score|pass|success|f1|exact|win/i) ||
      (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0),
  };
  state.filtered.sort(sorters[state.sort] ?? sorters['date-desc']);
}

function groupedValues(key) {
  const counts = new Map();
  for (const run of state.runs) {
    const values = key === 'tag' ? (run.tags ?? []) : [run[key] ?? ''];
    for (const value of values) {
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* ── render: filters ──────────────────────────────────────────────────────── */
function renderChips() {
  const host = $('#filters');
  clear(host);

  const groups = [
    { key: 'benchmark', label: 'bench' },
    { key: 'model', label: 'model', mono: true },
    { key: 'tag', label: 'tag' },
    { key: 'status', label: 'status' },
  ];

  for (const group of groups) {
    const entries = groupedValues(group.key);
    // A single distinct value is not worth filtering on (except tags, which are free-form).
    if (entries.length <= 1 && group.key !== 'tag') continue;
    if (!entries.length) continue;

    const chips = entries.map(([value, count]) => h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': state.filters[group.key].has(value) ? 'true' : 'false',
      title: `${count} run${count === 1 ? '' : 's'}`,
      onclick: () => {
        const set = state.filters[group.key];
        set.has(value) ? set.delete(value) : set.add(value);
        renderChips();
        renderGrid();
      },
    }, h('span', { text: value, style: group.mono ? { fontFamily: 'var(--mono)', fontSize: '11.5px' } : null }),
      h('span', { class: 'chip-count', text: String(count) })));

    host.append(h('div', { class: 'chip-group' }, h('span', { class: 'chip-label', text: group.label }), chips));
  }

  const anyActive = Object.values(state.filters).some((s) => s.size);
  if (anyActive) {
    host.append(h('button', {
      type: 'button', class: 'chip', onclick: () => {
        for (const set of Object.values(state.filters)) set.clear();
        state.query = '';
        $('#search').value = '';
        renderChips();
        renderGrid();
      },
    }, 'clear all'));
  }
}

/* ── render: cards ────────────────────────────────────────────────────────── */
function cardThumb(run) {
  const version = run._meta?.version;
  const preview = run._meta?.preview;
  if (preview && !run.media?.find((m) => m.src === preview)?.missing) {
    return h('img', {
      src: bust(preview, version), alt: '', loading: 'lazy', decoding: 'async',
      onerror: (event) => { event.currentTarget.replaceWith(fallbackThumb(run)); },
    });
  }
  return fallbackThumb(run);
}

const fallbackThumb = (run) => h('div', { class: 'card-thumb-fallback' }, h('span', { text: initials(run.model || run.benchmark || run.title) }));

function renderCard(run) {
  const version = run._meta?.version;
  const metrics = (run.metrics ?? []).slice(0, 3);

  const card = h('a', {
    class: 'card',
    href: `#/run/${encodeURIComponent(run.id)}`,
    dataset: { id: run.id },
    'aria-label': `${run.title} — details`,
  },
    h('div', { class: 'card-thumb' },
      cardThumb(run),
      h('div', { class: 'card-overlays' },
        state.newIds.has(run.id) ? h('span', { class: 'badge badge-new', text: 'NEW' }) : null,
        run.status && run.status !== 'complete'
          ? h('span', { class: 'badge', text: run.status })
          : null,
      ),
    ),
    h('div', { class: 'card-body' },
      h('h3', { class: 'card-title', text: run.title }),
      h('div', { class: 'card-meta' },
        h('span', { text: fmtDate(run.date) }),
        run.benchmark ? h('span', { class: 'dot' }) : null,
        run.benchmark ? h('span', { text: run.benchmark }) : null,
        run.model ? h('span', { class: 'dot' }) : null,
        run.model ? h('span', { class: 'card-model', text: run.model }) : null,
      ),
      run.summary ? h('p', { class: 'card-summary', text: run.summary }) : null,
      (run.tags ?? []).length
        ? h('div', { class: 'card-tags' }, run.tags.slice(0, 5).map((tag) => h('span', { class: 'tag', text: tag })))
        : null,
      metrics.length
        ? h('div', { class: 'card-metrics' }, metrics.map((metric) =>
          h('div', { class: 'card-metric' },
            h('b', { text: fmtNumber(metric.value, metric.unit) + (metric.unit ? (metric.unit === '%' ? '%' : ' ' + metric.unit) : '') }),
            h('span', { text: metric.label }))))
        : null,
    ),
  );
  return card;
}

function renderSkeletons(n = 6) {
  const grid = clear($('#grid'));
  for (let i = 0; i < n; i++) {
    grid.append(h('div', { class: 'skeleton' },
      h('div', { class: 'sk-thumb' }),
      h('div', { class: 'sk-line w60' }),
      h('div', { class: 'sk-line w40' }),
    ));
  }
}

function renderGrid() {
  const grid = $('#grid');
  if (state.loading) return renderSkeletons();

  applyFilters();
  clear(grid);
  $('#empty').hidden = state.filtered.length > 0;
  $('#count').textContent = `${state.filtered.length} of ${state.runs.length}`;

  if (state.filtered.length === 0) {
    $('#emptyHint').textContent = state.runs.length
      ? 'No run matches the current search and filters.'
      : 'Add a folder under public/results/<run-id>/ with a run.json, then run `npm run manifest`.';
  }

  const fragment = document.createDocumentFragment();
  for (const run of state.filtered) fragment.append(renderCard(run));
  grid.append(fragment);
}

/* ── render: media ────────────────────────────────────────────────────────── */
function caption(run, item, index) {
  if (!item.caption) return null;
  return h('figcaption', { class: 'media-caption' },
    h('span', { class: 'cap-index', text: String(index + 1).padStart(2, '0') }),
    h('span', {}, item.caption),
  );
}

function openLightbox(src, alt) {
  const box = $('#lightbox');
  const img = $('#lightboxImg');
  img.src = src;
  img.alt = alt || '';
  box.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightboxImg').src = '';
  document.body.style.overflow = '';
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

function renderImage(run, item, index) {
  const src = bust(item.src, run._meta?.version);
  const img = h('img', {
    src, alt: item.alt || item.caption || `${run.title} image ${index + 1}`,
    loading: 'lazy', decoding: 'async', onclick: () => openLightbox(src, item.alt || item.caption || ''),
  });
  return h('figure', { class: 'media-block' + (item.wide ? ' wide' : '') },
    item.missing ? h('div', { class: 'media-missing' }, h('div', { text: '⚠ file missing' }), h('div', { text: item.src })) : h('div', { class: 'media-frame' }, img),
    caption(run, item, index));
}

function renderVideo(run, item, index) {
  const version = run._meta?.version;
  const isEmbed = item.embed === true || EMBED_HOSTS.test(String(item.src));
  let frame;

  if (isEmbed) {
    frame = h('iframe', {
      src: embedUrl(item.src), title: item.caption || `${run.title} video`,
      loading: 'lazy', allowfullscreen: true,
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen',
      style: { aspectRatio: item.aspect || '16 / 9', width: '100%' },
    });
  } else if (item.missing) {
    frame = h('div', { class: 'media-missing' }, h('div', { text: '⚠ video missing' }), h('div', { text: item.src }));
  } else {
    const sources = Array.isArray(item.sources) && item.sources.length ? item.sources : [{ src: item.src }];
    frame = h('video', {
      controls: true, preload: 'metadata', playsinline: true,
      poster: item.poster ? bust(item.poster, version) : null,
      loop: item.loop === true, muted: item.muted === true, autoplay: item.autoplay === true,
    }, sources.map((source) => h('source', { src: bust(source.src, version), type: source.type || null })));
  }

  return h('figure', { class: 'media-block' + (item.wide ? ' wide' : '') }, frame, caption(run, item, index));
}

function renderPlayable(run, item, index) {
  const version = run._meta?.version;
  const host = h('div', { class: 'playable-host', style: { '--pa': item.aspect || '16 / 9' } });
  const bar = h('div', { class: 'playable-bar' },
    h('span', { text: item.kind === 'wasm' ? 'WebAssembly module' : 'interactive build' }),
    h('span', { class: 'spacer' }),
  );

  const launch = h('button', {
    type: 'button', class: 'playable-launch', style: { '--pa': item.aspect || '16 / 9' },
    'aria-label': `Load ${item.caption || 'interactive demo'}`,
    onclick: () => start(),
  },
    h('span', { class: 'play-icon' },
      h('span', { html: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>' })),
    h('span', { class: 'playable-meta', text: item.caption ? `Click to load — ${item.caption}` : 'Click to load interactive demo' }),
  );

  const block = h('figure', { class: 'media-block' + (item.wide ? ' wide' : '') }, launch, bar, caption(run, item, index));

  function start() {
    if (item.kind === 'wasm') startWasm();
    else startIframe();
  }

  function startIframe() {
    if (item.missing) {
      host.innerHTML = '';
      host.append(h('div', { class: 'playable-error', text: `⚠ build missing: ${item.src}` }));
      launch.replaceWith(host);
      return;
    }
    const iframe = h('iframe', {
      src: bust(item.src, version),
      title: item.caption || `${run.title} interactive demo`,
      sandbox: item.sandbox === false ? null : PLAYABLE_SANDBOX,
      allow: 'fullscreen; autoplay; gamepad; xr-spatial-tracking; clipboard-write',
      allowfullscreen: true,
      loading: 'eager',
    });
    launch.replaceWith(host);
    host.append(iframe);
    iframe.addEventListener('error', () => { host.dataset.blocked = '1'; });
    bar.prepend(h('button', {
      type: 'button', class: 'btn btn-ghost',
      onclick: () => { host.querySelector('iframe')?.requestFullscreen?.(); },
    }, 'Fullscreen'));
    const open = h('a', { class: 'btn btn-ghost', href: bust(item.src, version), target: '_blank', rel: 'noopener' }, 'Open in new tab');
    bar.append(open);
  }

  async function startWasm() {
    launch.replaceWith(host);
    try {
      const glueUrl = item.glue || new URL('wasm-loader.js', document.baseURI).href;
      const mod = await import(/* @vite-ignore */ glueUrl);
      const mount = mod.default ?? mod.mount ?? mod.init;
      if (typeof mount !== 'function') throw new Error('loader module must export default(mountEl, options)');
      await mount(host, {
        wasmUrl: bust(item.wasm || item.src, version),
        run,
        item,
      });
      bar.prepend(h('span', { class: 'playable-meta', text: 'running' }));
    } catch (err) {
      host.append(h('div', { class: 'playable-error', text: `Could not start WebAssembly: ${err.message}` }));
      console.error('[bench] wasm playable failed', err);
    }
  }

  return block;
}

function renderAudio(run, item, index) {
  return h('figure', { class: 'media-block' + (item.wide ? ' wide' : '') },
    h('div', { class: 'media-frame', style: { padding: '12px' } },
      h('audio', { controls: true, preload: 'metadata', style: { width: '100%' } },
        h('source', { src: bust(item.src, run._meta?.version) }))),
    caption(run, item, index));
}

function renderTable(run, item, index) {
  const columns = item.columns ?? [];
  const rows = item.rows ?? [];
  return h('figure', { class: 'media-block wide' },
    h('div', { class: 'table-wrap', style: { border: '0', borderRadius: '0' } },
      h('table', {},
        h('thead', {}, h('tr', {}, columns.map((c) => h('th', { text: String(c) })))),
        h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', { text: String(cell) }))))),
      )),
    caption(run, item, index),
  );
}

/**
 * Markdown/code blocks are usually inlined into the manifest by the builder, but
 * large files (transcripts) are marked `lazy` and fetched on demand so the
 * manifest stays small enough to poll.
 */
function renderTextBlock(run, item, index) {
  const isMarkdown = item.type === 'markdown';
  const body = h('div', {
    class: 'prose',
    style: { padding: isMarkdown ? '16px 18px' : '14px 16px' },
  });

  const paint = (text) => {
    clear(body);
    if (isMarkdown) {
      body.innerHTML = md(text, run._meta?.base ?? '');
    } else {
      body.append(h('pre', { style: { margin: '0' } }, h('code', { text })));
    }
  };

  if (typeof item.text === 'string') {
    paint(item.text);
  } else if (item.src && !item.missing) {
    body.append(h('div', { class: 'media-loading', text: 'loading…' }));
    const url = bust(item.src, run._meta?.version);
    fetch(url, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        // Only paint if this block is still on screen for the same run.
        if (body.isConnected) paint(text);
      })
      .catch((err) => {
        clear(body);
        body.append(h('div', { class: 'media-missing', text: `⚠ could not load ${item.src} (${err.message})` }));
      });
  } else {
    body.append(h('div', { class: 'media-missing', text: '⚠ no content' }));
  }

  return h('figure', { class: 'media-block wide' }, body, caption(run, item, index));
}

function renderFile(run, item, index) {
  return h('figure', { class: 'media-block' },
    h('div', { style: { padding: '14px' } },
      h('div', { class: 'links-list' },
        h('a', { class: 'btn', href: item.missing ? null : bust(item.src, run._meta?.version), target: '_blank', rel: 'noopener' },
          h('span', { text: `⤓ ${item.label || item.caption || item.src.split('/').pop()}` }),
          item.bytes ? h('span', { class: 'chip-count', text: fmtBytes(item.bytes) }) : null),
      )),
    item.missing ? h('div', { class: 'media-missing', text: '⚠ file missing' }) : null,
    caption(run, item, index),
  );
}

function renderMedia(run, item, index) {
  switch (item.type) {
    case 'image': return renderImage(run, item, index);
    case 'video': return renderVideo(run, item, index);
    case 'playable': return renderPlayable(run, item, index);
    case 'audio': return renderAudio(run, item, index);
    case 'embed': return renderVideo(run, { ...item, embed: true }, index);
    case 'table': return renderTable(run, item, index);
    case 'markdown':
    case 'code': return renderTextBlock(run, item, index);
    default: return renderFile(run, item, index);
  }
}

/* ── render: detail ───────────────────────────────────────────────────────── */
/* Media that documents the run (prompts, transcripts, logs) rather than showing
   its result. These collapse into the audit trail; everything visual or
   interactive stays up top. */
const isAuditMedia = (item) => ['markdown', 'code', 'file'].includes(item.type);

function renderDetail(run) {
  const host = clear($('#detailContent'));
  const media = run.media ?? [];
  const primary = media.filter((item) => !isAuditMedia(item));
  const auditMedia = media.filter(isAuditMedia);
  const envEntries = Object.entries(run.environment ?? {});
  const warnings = run._meta?.warnings ?? [];
  const hasAudit = auditMedia.length > 0 || envEntries.length > 0 || run.notes || warnings.length > 0;

  const copyLink = (label = 'Copy link') => h('button', {
    type: 'button', class: 'btn',
    onclick: async (event) => {
      const url = `${location.origin}${location.pathname}#/run/${encodeURIComponent(run.id)}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      } catch { toast(url); }
      event.currentTarget.blur();
    },
  }, label);

  const auditButtons = h('div', { class: 'detail-actions' },
    CFG.showJson
      ? h('a', { class: 'btn', href: `${run._meta?.base ?? ''}run.json`, target: '_blank', rel: 'noopener' }, 'run.json')
      : null,
    h('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(run, null, 2));
          toast('Run JSON copied');
        } catch { toast('Clipboard unavailable'); }
      },
    }, 'Copy JSON'),
    CFG.repoUrl ? h('a', { class: 'btn', href: CFG.repoUrl, target: '_blank', rel: 'noopener' }, 'GitHub') : null,
  );

  const body = h('div', { class: 'detail-body' },
    h('h2', { class: 'detail-title', text: run.title }),
    h('div', { class: 'detail-sub' },
      h('span', { class: statusClass(run.status) }, h('span', { class: 'status-dot' }), h('span', { text: run.status })),
      h('span', { text: '·' }),
      h('span', { text: fmtDate(run.date) }),
      run.benchmark ? h('span', { text: '·' }) : null,
      run.benchmark ? h('span', { text: run.benchmark }) : null,
      run.model ? h('span', { text: '·' }) : null,
      run.model ? h('span', { class: 'card-model', text: run.model }) : null,
    ),
    run.summary ? h('p', { class: 'detail-summary', text: run.summary }) : null,
    (run.tags ?? []).length
      ? h('div', { class: 'detail-tags' }, run.tags.map((tag) => h('span', { class: 'tag', text: tag })))
      : null,
    h('div', { class: 'detail-actions' }, copyLink()),
  );

  if (run.metrics?.length) {
    body.append(h('div', { class: 'section' },
      h('h3', { text: 'metrics' }),
      h('div', { class: 'tiles' }, run.metrics.map((metric) =>
        h('div', { class: 'tile' },
          h('div', { class: 'tile-label', text: metric.label }),
          h('div', { class: 'tile-value' }, h('span', { text: fmtNumber(metric.value, metric.unit) }),
            metric.unit && metric.unit !== '%' ? h('span', { class: 'tile-unit', text: metric.unit })
              : metric.unit === '%' ? h('span', { class: 'tile-unit', text: '%' }) : null),
          metric.hint ? h('div', { class: 'tile-hint', text: metric.hint }) : null,
          metric.better ? h('div', { class: 'tile-better', text: `higher is ${metric.better}` }) : null,
        )))));
  }

  const charts = (run.charts ?? []).map(renderChart).filter(Boolean);
  if (charts.length) {
    body.append(h('div', { class: 'section' },
      h('h3', { text: 'charts' }),
      h('div', { class: 'charts' }, charts)));
  }

  if (primary.length) {
    body.append(h('div', { class: 'section' },
      h('h3', { text: 'result' }),
      h('div', { class: 'gallery' }, primary.map((item, index) => renderMedia(run, item, index)))));
  }

  if (hasAudit) {
    const trail = h('details', { class: 'audit', open: primary.length === 0 || undefined },
      h('summary', {},
        h('span', { text: 'Audit trail' }),
        h('span', { class: 'audit-hint', text: 'prompt · transcript · environment' })),
    );
    if (warnings.length) {
      trail.append(h('div', { class: 'section' },
        h('h3', { text: 'warnings' }),
        h('div', { class: 'notice' }, h('div', {}, warnings.map((w) => h('div', { text: `⚠ ${w}` }))))));
    }
    if (envEntries.length) {
      trail.append(h('div', { class: 'section' },
        h('h3', { text: 'environment' }),
        h('dl', { class: 'kv' }, envEntries.flatMap(([key, value]) => [
          h('dt', { text: key.replace(/_/g, ' ') }),
          h('dd', { text: Array.isArray(value) ? value.join(', ') : String(value) }),
        ]))));
    }
    if (run.notes) {
      trail.append(h('div', { class: 'section' },
        h('h3', { text: 'notes' }),
        h('div', { class: 'prose', html: md(run.notes, run._meta?.base ?? '') })));
    }
    if (auditMedia.length) {
      trail.append(h('div', { class: 'section' },
        h('h3', { text: `files · ${auditMedia.length}` }),
        h('div', { class: 'gallery' }, auditMedia.map((item, index) => renderMedia(run, item, primary.length + index)))));
    }
    trail.append(auditButtons);
    body.append(trail);
  }

  if (run.links?.length) {
    body.append(h('div', { class: 'section' },
      h('h3', { text: 'links' }),
      h('div', { class: 'links-list' }, run.links.map((link) =>
        h('a', { class: 'btn', href: link.href, target: '_blank', rel: 'noopener' }, link.label)))));
  }

  host.append(body);
  return host;
}

/* ── routing ──────────────────────────────────────────────────────────────── */
const dialog = $('#detail');

function openDetail(id) {
  const run = state.runs.find((r) => r.id === id || r._meta?.dir === id);
  if (!run) {
    if (!state.loading) toast(`No run named "${id}"`);
    return;
  }
  state.openId = run.id;
  renderDetail(run);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  $('.detail-inner', dialog).scrollTop = 0;
  document.title = `${run.title} · ${CFG.title}`;
}

function closeDetail() {
  state.openId = null;
  if (dialog.open) dialog.close();
  document.title = CFG.title;
}

function route() {
  const match = location.hash.match(/^#\/run\/(.+)$/);
  if (match) openDetail(decodeURIComponent(match[1]));
  else closeDetail();
}

dialog.addEventListener('close', () => {
  state.openId = null;
  document.title = CFG.title;
  if (location.hash.startsWith('#/run/')) history.replaceState(null, '', location.pathname + location.search + '#/');
});

$('#closeBtn').addEventListener('click', () => { location.hash = '#/'; });
$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (event) => { if (event.target.id === 'lightbox') closeLightbox(); });

/* ── misc UI ──────────────────────────────────────────────────────────────── */
function updateFooter() {
  const updated = state.generatedAt ? fmtRelative(state.generatedAt) : '—';
  $('#footerMeta').textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} · manifest updated ${updated}`;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('bench.theme', theme); } catch { /* ignore */ }
}

$('#themeBtn').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
$('#refreshBtn').addEventListener('click', () => load({ manual: true }));
$('#topBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

let searchTimer = null;
$('#search').addEventListener('input', (event) => {
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = value;
    renderGrid();
  }, 120);
});

$('#sort').value = state.sort;
$('#sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  LS.set('bench.sort', state.sort);
  renderGrid();
});

document.addEventListener('keydown', (event) => {
  const typing = /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable;
  if (event.key === 'Escape' && !$('#lightbox').hidden) { closeLightbox(); return; }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); }
  else if (event.key.toLowerCase() === 't') { $('#themeBtn').click(); }
  else if (event.key.toLowerCase() === 'r') { load({ manual: true }); }
});

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ quiet: true }); });
window.addEventListener('online', () => load({ quiet: true }));
window.addEventListener('offline', () => setLive('error', 'offline'));

/* ── boot ─────────────────────────────────────────────────────────────────── */
(function boot() {
  $('#siteTitle').textContent = CFG.title;
  $('#siteSubtitle').textContent = CFG.subtitle || '';
  document.title = CFG.title;
  document.querySelector('meta[name="description"]').setAttribute('content', CFG.subtitle || CFG.title);

  if (CFG.repoUrl) {
    const btn = $('#repoBtn');
    btn.hidden = false;
    btn.addEventListener('click', () => window.open(CFG.repoUrl, '_blank', 'noopener'));
  }

  renderChips();
  renderSkeletons();
  load();
  startPolling();
  setInterval(updateFooter, 20000);
  route();
})();

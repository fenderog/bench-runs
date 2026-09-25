#!/usr/bin/env node
/**
 * Scans public/results/<run>/run.json and emits public/data/results.json —
 * a single manifest the website fetches and renders.
 *
 *   node scripts/build-manifest.mjs [--strict]
 *
 * Everything is derived from files on disk, so a run is "published" simply by
 * committing its folder. The GitHub Action runs this on every push.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(ROOT, 'public', 'results');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'results.json');

const STRICT = process.argv.includes('--strict');
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.py', '.js', '.mjs', '.ts', '.c', '.h', '.cpp', '.rs',
  '.sh', '.bash', '.html', '.xml', '.sql', '.gitignore', '.env',
]);
const INLINE_LIMIT = 200_000; // bytes
const KNOWN_MEDIA = new Set(['image', 'video', 'playable', 'embed', 'markdown', 'table', 'code', 'file', 'audio']);

/** FNV-1a — small, stable, dependency-free content fingerprint. */
function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const warnings = [];
const warn = (runId, message) => warnings.push({ run: runId, message });

async function readTextIfSmall(abs) {
  try {
    const stat = await fsp.stat(abs);
    if (stat.size > INLINE_LIMIT) return null;
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Minimal RFC4180-ish CSV parser (handles quoted fields + embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const delim = text.split('\n')[0]?.includes('\t') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!clean.length) return { columns: [], rows: [] };
  const [columns, ...body] = clean;
  return { columns, rows: body };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

function normalizeDate(value, folderName, runId) {
  const raw = str(value);
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  if (raw) warn(runId, `date "${raw}" is not parseable ISO-8601, ignoring`);
  const m = folderName.match(/(\d{4}-\d{2}-\d{2})(?:[T_ ]?(\d{2})[-:]?(\d{2}))?/);
  if (m) {
    const iso = `${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:00Z`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  warn(runId, 'no date — set "date" in run.json or prefix the folder with YYYY-MM-DD');
  return null;
}

function normalizeMetrics(raw, runId) {
  const entries = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      const value = m.value;
      if (value === undefined || value === null || value === '') continue;
      entries.push({
        label: str(m.label) || str(m.key) || 'metric',
        value,
        unit: str(m.unit),
        better: str(m.better) || null,
        hint: str(m.hint),
      });
    }
    return entries;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.value === undefined || value.value === null) continue;
        entries.push({
          label: str(value.label) || key,
          value: value.value,
          unit: str(value.unit),
          better: str(value.better) || null,
          hint: str(value.hint),
        });
      } else if (value !== null && value !== undefined && value !== '') {
        entries.push({ label: key, value, unit: '', better: null, hint: '' });
      }
    }
  }
  return entries;
}

function normalizeMedia(raw, runId) {
  const seen = [];
  for (const item of arr(raw)) {
    if (!item) continue;
    if (typeof item === 'string') { seen.push({ type: inferType(item), src: item }); continue; }
    if (typeof item !== 'object') continue;
    const type = str(item.type) || inferType(str(item.src));
    if (!KNOWN_MEDIA.has(type)) {
      warn(runId, `unknown media type "${type}" — skipped`);
      continue;
    }
    seen.push({ ...item, type });
  }
  return seen;
}

function inferType(src) {
  const ext = path.extname(str(src).split('?')[0]).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.csv' || ext === '.tsv') return 'table';
  if (ext === '.html') return 'playable';
  if (ext === '.wasm') return 'playable';
  return 'file';
}

async function processMedia(item, dirAbs, base, runId, fingerprint) {
  const out = { ...item };
  // A wasm playable may omit `src` and point straight at its module.
  const src = str(item.src) || (item.type === 'playable' && str(item.kind) === 'wasm' ? str(item.wasm) : '');

  // Remote (absolute URL) media: pass through untouched.
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) {
    out.src = src;
    out.remote = true;
    return out;
  }

  if (item.type === 'table' && !arr(item.columns).length && !arr(item.rows).length) {
    const text = src ? await readTextIfSmall(path.join(dirAbs, src)) : str(item.text);
    if (text) {
      const { columns, rows } = parseCsv(text);
      out.columns = columns;
      out.rows = rows;
      fingerprint.push(`csv:${src}:${text.length}`);
      if (src) out.src = base + encodeURI(src);
      return out;
    }
    warn(runId, 'table has no columns/rows and no readable src');
    return out;
  }

  if (['markdown', 'code', 'table'].includes(item.type) && !str(item.text) && src) {
    const text = await readTextIfSmall(path.join(dirAbs, src));
    if (text !== null) {
      out.text = text;
      fingerprint.push(`txt:${src}:${text.length}`);
      out.src = base + encodeURI(src);
      return out;
    }
  }

  if (!src) {
    if (item.type === 'markdown' && str(item.text)) return out;
    if (item.type === 'table' && (arr(item.columns).length || arr(item.rows).length)) return out;
    warn(runId, `${item.type} entry has no src`);
    return out;
  }

  const abs = path.join(dirAbs, src);
  let size = 0;
  let ok = false;
  try {
    const stat = await fsp.stat(abs);
    if (stat.isFile()) { ok = true; size = stat.size; }
  } catch { /* missing */ }

  if (!ok) {
    out.missing = true;
    warn(runId, `missing file: ${src}`);
  } else {
    fingerprint.push(`${src}:${size}`);
  }

  out.bytes = size;
  out.src = base + encodeURI(src);
  if (str(item.poster) && !/^(https?:)?\/\//i.test(str(item.poster))) {
    out.poster = base + encodeURI(str(item.poster));
  }
  for (const key of ['glue', 'wasm', 'href', 'download', 'thumb']) {
    if (str(item[key]) && !/^(https?:)?\/\//i.test(str(item[key]))) {
      out[key] = base + encodeURI(str(item[key]));
    }
  }
  if (Array.isArray(item.sources)) {
    out.sources = item.sources.map((s) => ({
      ...s,
      src: /^(https?:)?\/\//i.test(str(s.src)) ? str(s.src) : base + encodeURI(str(s.src)),
    }));
  }
  return out;
}

async function buildRun(entry) {
  const folderName = entry.name;
  const dirAbs = path.join(RESULTS_DIR, folderName);
  const rawJson = await fsp.readFile(path.join(dirAbs, 'run.json'), 'utf8');

  let data;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    warn(folderName, `run.json is not valid JSON: ${err.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warn(folderName, 'run.json must be a JSON object');
    return null;
  }

  const id = str(data.id) || folderName;
  const title = str(data.title) || str(data.name) || id;
  if (!str(data.title)) warn(id, 'no "title" — falling back to the folder name');
  if (data.id && str(data.id) !== folderName) {
    warn(id, `"id" differs from folder name ("${folderName}") — links use the id`);
  }

  const base = `results/${encodeURIComponent(folderName)}/`;
  const fingerprint = [createHash('sha1').update(rawJson).digest('hex').slice(0, 12)];
  const media = [];
  for (const item of normalizeMedia(data.media ?? data.artifacts ?? data.gallery, id)) {
    media.push(await processMedia(item, dirAbs, base, id, fingerprint));
  }

  let notes = str(data.notes);
  if (!notes && fs.existsSync(path.join(dirAbs, 'notes.md'))) {
    notes = (await readTextIfSmall(path.join(dirAbs, 'notes.md'))) ?? '';
  }

  const preview =
    media.find((m) => m.type === 'image' && !m.missing)?.src ??
    media.find((m) => m.type === 'video' && m.poster)?.poster ??
    media.find((m) => m.type === 'playable' && m.thumb)?.thumb ??
    null;

  const version = fnv1a(fingerprint.join('|')).toString(36);
  const bytes = media.reduce((sum, m) => sum + (Number(m.bytes) || 0), 0);

  return {
    id,
    title,
    model: str(data.model),
    benchmark: str(data.benchmark),
    date: normalizeDate(data.date, folderName, id),
    status: str(data.status) || 'complete',
    tags: arr(data.tags).map(str).filter(Boolean),
    summary: str(data.summary) || str(data.description),
    metrics: normalizeMetrics(data.metrics, id),
    charts: arr(data.charts).filter(Boolean),
    environment: data.environment && typeof data.environment === 'object' ? data.environment : {},
    links: arr(data.links)
      .filter((l) => l && (str(l.href) || str(l.url)))
      .map((l) => ({ label: str(l.label) || str(l.href) || 'link', href: str(l.href) || str(l.url) })),
    notes,
    media,
    _meta: {
      dir: folderName,
      base,
      version,
      preview,
      mediaCount: media.filter((m) => m.type !== 'markdown').length,
      bytes,
    },
  };
}

async function main() {
  if (!fs.existsSync(RESULTS_DIR)) {
    await fsp.mkdir(RESULTS_DIR, { recursive: true });
  }
  const entries = (await fsp.readdir(RESULTS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const runs = [];
  for (const entry of entries) {
    if (!fs.existsSync(path.join(RESULTS_DIR, entry.name, 'run.json'))) {
      warn(entry.name, 'no run.json — folder ignored');
      continue;
    }
    const run = await buildRun(entry);
    if (run) runs.push(run);
  }

  runs.sort((a, b) => {
    const ad = a.date ? Date.parse(a.date) : 0;
    const bd = b.date ? Date.parse(b.date) : 0;
    if (bd !== ad) return bd - ad;
    return a.title.localeCompare(b.title);
  });

  const byRun = new Map();
  for (const w of warnings) {
    if (!byRun.has(w.run)) byRun.set(w.run, []);
    byRun.get(w.run).push(w.message);
  }
  for (const run of runs) {
    run._meta.warnings = byRun.get(run.id) ?? [];
  }

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    count: runs.length,
    runs,
  };

  await fsp.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fsp.writeFile(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`✓ ${runs.length} run${runs.length === 1 ? '' : 's'} → public/data/results.json`);
  for (const w of warnings) console.log(`  ⚠ ${w.run}: ${w.message}`);
  if (STRICT && warnings.length) {
    console.error(`\n✗ ${warnings.length} warning(s) in --strict mode`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('✗ manifest build failed:', err);
  process.exit(1);
});

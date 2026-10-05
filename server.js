#!/usr/bin/env node
/*
 * Game Player: serves ONE HTML5 game, full-screen, with no other UI.
 *
 *   game/                       drop the game's files here (index.html + assets), or a single .zip
 *   node server.js              serve it on $PORT (default 8080)
 *   node server.js --prepare    unzip + pre-compress ahead of time (the Dockerfile runs this)
 *
 * No dependencies. Node 18+. Options are documented in README.md.
 */
'use strict';

const os = require('node:os');
const PREPARE = process.argv.includes('--prepare');
const CPUS = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
// zlib and fs work runs on libuv's thread pool; let --prepare use every core.
if (PREPARE && !process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(Math.min(64, Math.max(4, CPUS)));

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable, pipeline } = require('node:stream');
const { pipeline: pump } = require('node:stream/promises');

const env = process.env;
const PORT = Number(env.PORT) || 8080;
const GAME_PATH = path.resolve(__dirname, env.GAME_PATH || 'game');
const GAME_URL = env.GAME_URL || '';
const ENTRY = (env.ENTRY || '').replace(/\\/g, '/').replace(/^\/+/, '');
const TITLE = env.TITLE || '';
const ISOLATE = (env.ISOLATE || 'auto').toLowerCase();
const CACHE_SECONDS = Math.max(0, Math.floor(Number(env.CACHE_SECONDS) || 0));
let CACHE_DIR = path.resolve(__dirname, env.CACHE_DIR || '.cache');
const HEALTH_PATH = '/__player/health';

const UTF8 = '; charset=utf-8';
const TYPES = {
  html: 'text/html' + UTF8, htm: 'text/html' + UTF8, js: 'text/javascript' + UTF8, mjs: 'text/javascript' + UTF8,
  css: 'text/css' + UTF8, json: 'application/json' + UTF8, map: 'application/json' + UTF8, txt: 'text/plain' + UTF8,
  xml: 'application/xml' + UTF8, csv: 'text/csv' + UTF8, webmanifest: 'application/manifest+json' + UTF8,
  wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', ktx2: 'image/ktx2',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', swf: 'application/x-shockwave-flash', zip: 'application/zip',
};
// Binary formats that still shrink a lot with brotli (engine data packs, fonts, models...).
const PACKABLE = new Set(['wasm', 'data', 'pck', 'bin', 'mem', 'symbols', 'ttf', 'otf', 'eot', 'ico', 'bmp', 'tga', 'glb', 'obj', 'fnt', 'atlas']);
// Content-hashed names (main.3f9a2b1c.js, Unity's 32-hex names) never change, so browsers may cache them for a year.
const HASHED = /(?:[.\-_~](?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}|^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,})(?=[.\-_~])/i;

let site = null;      // { files: Map<url, file>, lower: Map<url, file>, entry, title }
let shell = null;     // the pre-rendered player page
let BASE = { 'X-Content-Type-Options': 'nosniff' };
const noop = () => {};

// ------------------------------------------------------------------ helpers

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const extOf = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[n]);

async function eachLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ------------------------------------------------------------------ zip (stored + deflate, ZIP64)

async function readZipIndex(fh, size) {
  const tailLen = Math.min(size, 22 + 0xffff + 20);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a valid .zip file');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {   // ZIP64 locator
    const rec = Buffer.alloc(56);
    await fh.read(rec, 0, 56, Number(tail.readBigUInt64LE(eocd - 12)));
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('corrupt ZIP64 .zip file');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt .zip file (central directory)');
    const e = {
      flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10),
      csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42),
    };
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    e.name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {   // ZIP64 extra: only the fields that overflowed, in this order
        let q = x + 4;
        if (e.usize === 0xffffffff) { e.usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (e.csize === 0xffffffff) { e.csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (e.offset === 0xffffffff) { e.offset = Number(cd.readBigUInt64LE(q)); }
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    entries.push(e);
  }
  // The central directory lists every name, size and CRC, so its hash identifies the zip's contents.
  return { entries, key: crypto.createHash('sha1').update(cd).digest('hex').slice(0, 16) };
}

function cleanZipPath(name) {
  const norm = name.replace(/\\/g, '/');   // some Windows tools write backslashes
  if (norm.endsWith('/')) return null;     // directory entry
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..') || parts[0].includes(':') || parts[0] === '__MACOSX') return null;
  return parts.join('/');
}

async function unzip(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { entries, key } = await readZipIndex(fh, (await fh.stat()).size);
    const parent = path.join(CACHE_DIR, 'unzipped');
    const dest = path.join(parent, key);
    const done = path.join(dest, '.complete');
    if (!fs.existsSync(done)) {
      await fsp.rm(dest, { recursive: true, force: true });
      const files = new Map();
      for (const e of entries) { const rel = cleanZipPath(e.name); if (rel) files.set(rel, e); }
      await eachLimit([...files], 8, async ([rel, e]) => {
        if (e.flags & 1) throw new Error(`${rel} is password-protected; re-zip it without a password`);
        if (e.method !== 0 && e.method !== 8) throw new Error(`${rel} uses compression method ${e.method}; re-zip with standard "Deflate"`);
        const out = path.join(dest, rel);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, e.offset);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt .zip file (${rel})`);
        if (e.csize === 0) return fsp.writeFile(out, '');
        const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const src = fs.createReadStream(zipPath, { start, end: start + e.csize - 1 });
        await (e.method === 8
          ? pump(src, zlib.createInflateRaw(), fs.createWriteStream(out))
          : pump(src, fs.createWriteStream(out)));
      });
      await fsp.writeFile(done, '');
    }
    // Drop copies of older zips so the cache doesn't grow forever.
    for (const old of await fsp.readdir(parent)) if (old !== key) await fsp.rm(path.join(parent, old), { recursive: true, force: true });
    return dest;
  } finally {
    await fh.close();
  }
}

async function download(url) {
  const u = new URL(url);
  console.log(`Downloading ${u.origin}${u.pathname} ...`);   // query strings often hold tokens; don't log them
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GAME_URL download failed: HTTP ${res.status}`);
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error('GAME_URL returned a web page, not a .zip; use a direct download link');
  }
  const dest = path.join(CACHE_DIR, 'download.zip');
  await pump(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.tmp'));
  await fsp.rename(dest + '.tmp', dest);
  return dest;
}

// ------------------------------------------------------------------ loading the game

async function loneZip(dir) {
  const items = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => !d.name.startsWith('.') && d.name !== '__MACOSX');
  if (items.some((d) => d.isDirectory() || /\.html?$/i.test(d.name))) return null;
  const zips = items.filter((d) => /\.zip$/i.test(d.name));
  if (zips.length > 1) throw new Error(`found ${zips.length} .zip files in ${dir}; keep only one`);
  return zips.length ? path.join(dir, zips[0].name) : null;
}

async function scan(root) {
  const found = [];
  async function walk(dir, prefix) {
    await Promise.all((await fsp.readdir(dir, { withFileTypes: true })).map(async (d) => {
      if (d.name.startsWith('.') || d.name === '__MACOSX' || d.name === 'Thumbs.db' || d.name === 'desktop.ini') return;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) return walk(abs, prefix + d.name + '/');
      const st = await fsp.stat(abs).catch(() => null);   // follows file symlinks; directory symlinks are skipped
      if (st && st.isFile()) found.push({ rel: prefix + d.name, abs, size: st.size });
    }));
  }
  await walk(root, '');
  return found;
}

function findEntry(files) {
  if (ENTRY) {
    if (!files.some((f) => f.rel === ENTRY)) throw new Error(`ENTRY "${ENTRY}" was not found in the game`);
    return ENTRY;
  }
  // Prefer index.html, then the shallowest page.
  const rank = (rel) => (/(^|\/)index\.html$/i.test(rel) ? 0 : /(^|\/)index\.htm$/i.test(rel) ? 1 : 2) * 1000 + rel.split('/').length;
  const pages = files.map((f) => f.rel).filter((rel) => /\.html?$/i.test(rel));
  return pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

function makeFile({ abs, size }, url) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  let ext = extOf(name);
  let encoding = null;
  if (ext === 'br' || ext === 'gz') {   // pre-compressed build output, e.g. Unity's Build/game.wasm.br
    const inner = extOf(name.slice(0, -ext.length - 1));
    if (TYPES[inner] || PACKABLE.has(inner)) { encoding = ext === 'br' ? 'br' : 'gzip'; ext = inner; }
  }
  const type = TYPES[ext] || 'application/octet-stream';
  return {
    abs, size, type, encoding,
    html: ext === 'html' || ext === 'htm',
    compress: !encoding && size >= 1024 && (PACKABLE.has(ext) || /^text\/|javascript|json|xml|svg/.test(type)),
    immutable: HASHED.test(name),
    etag: null, hashing: null, variants: {},
  };
}

async function pageInfo(abs) {
  const fh = await fsp.open(abs, 'r');
  const buf = Buffer.alloc(65536);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0).finally(() => fh.close());
  const html = buf.toString('utf8', 0, bytesRead);
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const link = (html.match(/<link\b[^>]*>/gi) || []).find((l) => /\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(l));
  const href = link && /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(link);
  return {
    title: title ? decodeEntities(title[1]).trim() : '',
    icon: href ? decodeEntities(href[1] ?? href[2] ?? href[3]) : '',
  };
}

async function loadGame() {
  let src = GAME_PATH;
  let label = path.relative(process.cwd(), GAME_PATH) || '.';
  if (GAME_URL) { src = await download(GAME_URL); label = 'GAME_URL'; }
  let st = await fsp.stat(src).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) {
    const zip = await loneZip(src);
    if (zip) { src = zip; label = path.relative(process.cwd(), zip); st = await fsp.stat(zip); }
  }
  let root = src;
  let entry = ENTRY;
  if (st.isFile()) {
    if (/\.html?$/i.test(src)) { root = path.dirname(src); entry = entry || path.basename(src); }
    else { root = await unzip(src); label += ' (unzipped)'; }
  }

  const all = await scan(root);
  entry = entry || findEntry(all);
  if (!entry) { console.warn(`No .html page found in ${label}`); return null; }
  if (!all.some((f) => f.rel === entry)) throw new Error(`entry page "${entry}" not found`);

  // The folder holding the entry page becomes the web root, so absolute paths like /Build/x.js work.
  const baseDir = entry.slice(0, entry.lastIndexOf('/') + 1);
  const files = new Map();
  const lower = new Map();
  let bytes = 0;
  for (const f of all) {
    if (!f.rel.startsWith(baseDir)) continue;
    const url = '/' + f.rel.slice(baseDir.length);
    const file = makeFile(f, url);
    files.set(url, file);
    if (!lower.has(url.toLowerCase())) lower.set(url.toLowerCase(), file);   // forgives Windows-style case mismatches
    bytes += f.size;
  }
  const count = files.size;
  for (const [url, file] of [...files]) {
    const dir = /^(.*\/)index\.html?$/i.exec(url);
    if (dir && dir[1] !== '/' && !files.has(dir[1])) { files.set(dir[1], file); lower.set(dir[1].toLowerCase(), file); }
  }

  const entryUrl = '/' + entry.slice(baseDir.length);
  const info = await pageInfo(files.get(entryUrl).abs);
  const zipName = /\.zip$/i.test(src) && !GAME_URL ? path.basename(src).slice(0, -4) : '';
  const isolate = ISOLATE === 'on' || ISOLATE === 'true' || ISOLATE === '1' ||
    (ISOLATE === 'auto' && [...files.keys()].some((u) => /\.pck$|\.worker\.js$/i.test(u)));   // Godot / threaded Emscripten
  return {
    files, lower, entry: entryUrl, isolate, label, count, bytes,
    title: TITLE || info.title || zipName || 'Game',
    icon: info.icon || (files.has('/favicon.ico') ? '/favicon.ico' : 'data:,'),
  };
}

// ------------------------------------------------------------------ hashing + compression cache

function etagOf(f) {
  return f.hashing || (f.hashing = new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(f.abs)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(f.etag = h.digest('base64url').slice(0, 20)));
  }));
}

function encoder(f, enc) {
  if (enc === 'gzip') return zlib.createGzip({ level: 6 });
  // --prepare has time for max quality (~15% smaller); at runtime q5 is ~100x faster and close behind.
  const quality = PREPARE ? (f.size <= 32 * 1048576 ? 11 : 6) : 5;
  const text = /^text\/|javascript|json|xml|svg/.test(f.type);
  return zlib.createBrotliCompress({
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: f.size,
      [zlib.constants.BROTLI_PARAM_MODE]: text ? zlib.constants.BROTLI_MODE_TEXT : zlib.constants.BROTLI_MODE_GENERIC,
    },
  });
}

// Compressed copies live on disk, named by content hash, so they survive restarts and are made once.
// Resolves to { path, size }, or null when compressing doesn't pay off.
function variant(f, enc) {
  return f.variants[enc] || (f.variants[enc] = (async () => {
    const base = path.join(CACHE_DIR, 'compressed', await etagOf(f));
    const best = `${base}.${enc === 'br' ? 'br' : 'gz'}`;
    // Quick runtime brotli gets its own name, so --prepare never mistakes it for a max-quality file.
    const out = PREPARE || enc !== 'br' ? best : `${base}.fast.br`;
    for (const p of new Set([best, out])) {
      const st = await fsp.stat(p).catch(() => null);
      if (st) return st.size ? { path: p, size: st.size } : null;
    }
    const tmp = `${out}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await pump(fs.createReadStream(f.abs), encoder(f, enc), fs.createWriteStream(tmp));
      let { size } = await fsp.stat(tmp);
      if (size > f.size * 0.95) { size = 0; await fsp.truncate(tmp, 0); }   // an empty file records "not worth it"
      await fsp.rename(tmp, out);
      return size ? { path: out, size } : null;
    } catch (err) {
      fsp.rm(tmp, { force: true }).catch(noop);
      console.error(`Could not compress ${f.abs}: ${err.message}`);
      return null;
    }
  })());
}

async function warm(game, limit) {
  const files = [...new Set(game.files.values())].filter((f) => f.compress).sort((a, b) => b.size - a.size);
  let before = 0, after = 0;
  await eachLimit(files, limit, async (f) => {
    const v = await variant(f, 'br');
    before += f.size;
    after += v ? v.size : f.size;
  });
  return { count: files.length, before, after };
}

// ------------------------------------------------------------------ player page

function renderShell(game) {
  let html, status = 200;
  if (game) {
    const vars = {
      TITLE: escapeHtml(game.title),
      ICON: escapeHtml(game.icon),
      ENTRY: JSON.stringify(game.entry.split('/').map(encodeURIComponent).join('/')).replace(/</g, '\\u003c'),
    };
    html = fs.readFileSync(path.join(__dirname, 'player.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
  } else {
    status = 503;
    html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>No game</title><style>html{background:#000;color:#aaa;font:16px/1.5 system-ui,sans-serif}' +
      'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;text-align:center}' +
      'code{color:#fff}</style><p>No game found.<br>Put your game (its files, or one <code>.zip</code>) in the ' +
      '<code>game/</code> folder, or set <code>GAME_URL</code>.</p>';
  }
  const raw = Buffer.from(html);
  return {
    status, raw,
    br: zlib.brotliCompressSync(raw),
    gzip: zlib.gzipSync(raw, { level: 9 }),
    id: crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20),
  };
}

// ------------------------------------------------------------------ HTTP

function accepts(req, enc) {
  for (const part of (req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.split(';');
    const token = name.trim().toLowerCase();
    if (token !== enc && token !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || parseFloat(q.slice(2)) > 0;
  }
  return false;
}

function fresh(req, etag) {
  const inm = req.headers['if-none-match'];
  return !!inm && (inm.trim() === '*' || inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag));
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;   // multi-range or junk: send the whole file
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; if (!Number(m[2])) return -1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  return start >= size || start > end ? -1 : [start, end];
}

function end(res, status, headers, body) {
  res.writeHead(status, { ...BASE, ...headers });
  res.end(body);
}

function send(req, res, status, h, file, start, last) {
  h['Content-Length'] = last - start + 1;
  res.writeHead(status, h);
  if (req.method === 'HEAD' || last < start) return res.end();
  pipeline(fs.createReadStream(file, { start, end: last, highWaterMark: 256 * 1024 }), res, noop);
}

function cacheControl(f) {
  if (f.html) return 'no-cache';
  if (f.immutable) return 'public, max-age=31536000, immutable';
  return CACHE_SECONDS ? `public, max-age=${CACHE_SECONDS}` : 'no-cache';   // no-cache = revalidate (cheap 304s)
}

function serveShell(req, res) {
  const enc = accepts(req, 'br') ? 'br' : accepts(req, 'gzip') ? 'gzip' : null;
  const body = enc ? shell[enc] : shell.raw;
  const h = { ...BASE, 'Content-Type': 'text/html' + UTF8, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ETag: `"${shell.id}${enc ? '-' + enc : ''}"` };
  if (shell.status === 200 && fresh(req, h.ETag)) return end(res, 304, h);
  if (enc) h['Content-Encoding'] = enc;
  h['Content-Length'] = body.length;
  res.writeHead(shell.status, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveFile(req, res, f) {
  const id = f.etag || await etagOf(f);
  const h = { ...BASE, 'Content-Type': f.type, 'Cache-Control': cacheControl(f) };
  let file = f.abs, size = f.size, enc = null, decode = null;
  if (f.encoding) {
    h.Vary = 'Accept-Encoding';
    if (accepts(req, f.encoding)) enc = f.encoding; else decode = f.encoding;
  } else if (f.compress) {
    h.Vary = 'Accept-Encoding';
    const want = req.headers.range ? null : accepts(req, 'br') ? 'br' : accepts(req, 'gzip') ? 'gzip' : null;
    const v = want && await variant(f, want);
    if (v) { enc = want; file = v.path; size = v.size; }
  }
  h.ETag = `"${id}${enc ? '-' + enc : ''}"`;
  if (fresh(req, h.ETag)) return end(res, 304, h);

  if (enc) {
    h['Content-Encoding'] = enc;
  } else if (decode) {   // browser can't take the pre-compressed file as-is: decompress on the fly
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    const unpack = decode === 'br' ? zlib.createBrotliDecompress() : zlib.createGunzip();
    return pipeline(fs.createReadStream(file), unpack, res, noop);
  } else {
    h['Accept-Ranges'] = 'bytes';
    const range = req.headers.range;
    if (range && (!req.headers['if-range'] || req.headers['if-range'] === h.ETag)) {
      const r = parseRange(range, size);
      if (r === -1) return end(res, 416, { 'Content-Range': `bytes */${size}` });
      if (r) { h['Content-Range'] = `bytes ${r[0]}-${r[1]}/${size}`; return send(req, res, 206, h, file, r[0], r[1]); }
    }
  }
  send(req, res, 200, h, file, 0, size - 1);
}

async function route(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, { Allow: 'GET, HEAD' });
  const q = req.url.indexOf('?');
  let p;
  try { p = decodeURIComponent(q < 0 ? req.url : req.url.slice(0, q)).replace(/\/{2,}/g, '/'); }
  catch { return end(res, 400); }

  if (p === '/') return serveShell(req, res);
  if (p === HEALTH_PATH) return end(res, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'ok');
  if (site) {
    const f = site.files.get(p) || site.lower.get(p.toLowerCase());
    if (f) return serveFile(req, res, f);
    if (!p.endsWith('/') && (site.files.has(p + '/') || site.lower.has(p.toLowerCase() + '/'))) {
      const location = p.split('/').map(encodeURIComponent).join('/') + '/' + (q < 0 ? '' : req.url.slice(q));
      return end(res, 301, { Location: location });
    }
    // Only log misses from the game itself (not bots probing random URLs): usually a wrong path or file-name case.
    if (req.headers['sec-fetch-site'] === 'same-origin') console.warn(`404 ${p}`);
  }
  end(res, 404, { 'Content-Type': 'text/plain' + UTF8 }, 'Not found');
}

// ------------------------------------------------------------------ main

async function main() {
  try {
    await fsp.mkdir(path.join(CACHE_DIR, 'compressed'), { recursive: true });
    await fsp.access(CACHE_DIR, fs.constants.W_OK);
  } catch {
    CACHE_DIR = path.join(os.tmpdir(), 'game-player');
    await fsp.mkdir(path.join(CACHE_DIR, 'compressed'), { recursive: true });
  }

  const started = Date.now();
  site = await loadGame();
  if (site) {
    if (site.isolate) BASE = { ...BASE, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    console.log(`Game:  ${site.label}  (${site.count} files, ${mb(site.bytes)})`);
    console.log(`Entry: ${site.entry}  "${site.title}"${site.isolate ? '  [cross-origin isolated]' : ''}`);
  }

  if (PREPARE) {
    if (!site) return console.log('Nothing to prepare (no game yet).');
    const r = await warm(site, CPUS);
    return console.log(`Prepared ${r.count} files: ${mb(r.before)} -> ${mb(r.after)} brotli in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  shell = renderShell(site);
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) end(res, 500); else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000;   // outlive proxy idle timeouts (avoids sporadic 502s behind Railway's edge)
  server.headersTimeout = 66000;
  server.listen(PORT, () => console.log(`Playing on http://localhost:${PORT}  (ready in ${Date.now() - started} ms)`));

  // Compress in the background so the first player doesn't wait (a no-op after --prepare).
  if (site) warm(site, 2).catch((err) => console.error(err));

  const stop = () => {
    server.close(() => process.exit(0));
    if (server.closeIdleConnections) server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

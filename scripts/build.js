// Build step (runs automatically after `npm install`, or manually with `npm run build`).
//
//  1. Copies the client-side proxy libraries and our front-end into build/www.
//  2. Gives every asset a content-hashed name (/assets/<hash>.js) so browsers can
//     cache it forever and never mix old and new files after an update. The
//     names also don't reveal which proxy libraries are in use.
//  3. Generates the URL codec with this installation's private key, so proxied
//     URLs can't be read (or base64-decoded) from the address.
//  4. Pre-compresses everything with brotli + gzip once, so the Raspberry Pi
//     never compresses multi-megabyte files per request.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "public");
const out = join(root, "build", "www");
const assetsDir = join(out, "assets");

// Proxied pages live under these neutral prefixes.
const SJ_PREFIX = "/s/";
const UV_PREFIX = "/u/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pkgDir(name) {
  // Some packages don't export ./package.json, so look for them on disk.
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot find package ${name}. Did you run npm install?`);
  }
}

const hash = (data) => createHash("sha256").update(data).digest("base64url").slice(0, 12);

/** name -> public URL of the emitted asset */
const assets = {};

function emitAsset(name, data, ext = extname(name)) {
  const url = `/assets/${hash(data)}${ext}`;
  writeFileSync(join(out, url), data);
  assets[name] = url;
  return url;
}

function template(text) {
  return text.replace(/\{\{([\w.-]+)\}\}/g, (m, key) => {
    if (key in assets) return assets[key];
    if (key in vars) return vars[key];
    throw new Error(`Unknown template variable ${m}`);
  });
}

// ---------------------------------------------------------------------------
// URL codec with a per-installation key
// ---------------------------------------------------------------------------
function loadKey() {
  if (process.env.CODEC_KEY) return Buffer.from(createHash("sha256").update(process.env.CODEC_KEY).digest());
  const file = join(root, ".codec-key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

// These functions are serialised with .toString() and re-created inside the
// service worker and proxied pages, so they must be fully self-contained.
function codecSource(key) {
  const k = `[${[...key].join(",")}]`;
  const encode = `function (s) {
    if (!s) return s;
    var k = ${k}, b = unescape(encodeURIComponent(s)), o = "";
    for (var i = 0; i < b.length; i++) o += String.fromCharCode(b.charCodeAt(i) ^ k[i % k.length] ^ ((i * 151) & 255));
    return btoa(o).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }`;
  const decode = `function (s) {
    if (!s) return s;
    var cut = s.search(/[?#]/), rest = "";
    if (cut >= 0) { rest = s.slice(cut); s = s.slice(0, cut); }
    try {
      var k = ${k}, b = atob(s.replace(/-/g, "+").replace(/_/g, "/")), o = "";
      for (var i = 0; i < b.length; i++) o += String.fromCharCode(b.charCodeAt(i) ^ k[i % k.length] ^ ((i * 151) & 255));
      return decodeURIComponent(escape(o)) + rest;
    } catch (e) {
      return s + rest;
    }
  }`;
  return { encode, decode };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
// Keep the previous build's assets for one more cycle: tabs that are still open
// (and Scramjet's saved config) may reference them right after an update.
const manifestPath = join(root, "build", "manifest.json");
const keep = new Set();
if (existsSync(manifestPath)) {
  try {
    for (const url of Object.values(JSON.parse(readFileSync(manifestPath, "utf8")).assets)) keep.add(url.split("/").pop());
  } catch {
    /* corrupt manifest -> start clean */
  }
}
if (existsSync(out)) {
  for (const name of readdirSync(out)) if (name !== "assets") rmSync(join(out, name), { recursive: true, force: true });
}
mkdirSync(assetsDir, { recursive: true });
for (const name of readdirSync(assetsDir)) {
  if (!keep.has(name.replace(/\.(br|gz)$/, ""))) rmSync(join(assetsDir, name));
}

const lib = {
  "scramjet.all.js": join(pkgDir("@mercuryworkshop/scramjet"), "dist/scramjet.all.js"),
  "scramjet.sync.js": join(pkgDir("@mercuryworkshop/scramjet"), "dist/scramjet.sync.js"),
  "scramjet.wasm": join(pkgDir("@mercuryworkshop/scramjet"), "dist/scramjet.wasm.wasm"),
  "uv.bundle.js": join(pkgDir("@titaniumnetwork-dev/ultraviolet"), "dist/uv.bundle.js"),
  "uv.handler.js": join(pkgDir("@titaniumnetwork-dev/ultraviolet"), "dist/uv.handler.js"),
  "uv.client.js": join(pkgDir("@titaniumnetwork-dev/ultraviolet"), "dist/uv.client.js"),
  "uv.sw.js": join(pkgDir("@titaniumnetwork-dev/ultraviolet"), "dist/uv.sw.js"),
  "baremux.js": join(pkgDir("@mercuryworkshop/bare-mux"), "dist/index.js"),
  "baremux.worker.js": join(pkgDir("@mercuryworkshop/bare-mux"), "dist/worker.js"),
  "epoxy.mjs": join(pkgDir("@mercuryworkshop/epoxy-transport"), "dist/index.mjs"),
  "libcurl.mjs": join(pkgDir("@mercuryworkshop/libcurl-transport"), "dist/index.mjs"),
};

const stripSourceMap = (buf) => Buffer.from(buf.toString("utf8").replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n"));

for (const [name, file] of Object.entries(lib)) {
  let data = readFileSync(file);
  if (/\.m?js$/.test(name)) data = stripSourceMap(data);
  emitAsset(name, data);
}

const codec = codecSource(loadKey());
const vars = {
  SJ_PREFIX,
  UV_PREFIX,
  CODEC_ENCODE: codec.encode,
  CODEC_DECODE: codec.decode,
};

// Front-end assets with no dependencies on other hashed names.
for (const name of ["style.css", "favicon.svg", "app.js"]) {
  emitAsset(name, readFileSync(join(src, name)));
}

// Shared runtime config (codec + paths) used by the page and the service worker.
emitAsset("config.js", template(readFileSync(join(src, "config.js"), "utf8")));

// UV's config file must contain its own URL, so hash it with a placeholder first.
{
  const text = readFileSync(join(src, "uv.config.js"), "utf8");
  vars["uv.config.js"] = `/assets/${hash(template(text.replace("{{uv.config.js}}", "")))}.js`;
  const final = template(text);
  writeFileSync(join(out, vars["uv.config.js"]), final);
  assets["uv.config.js"] = vars["uv.config.js"];
}

// Cache namespace for the service worker: changes whenever any asset changes.
vars.BUILD_ID = hash(JSON.stringify(assets));

// Pages and the service worker keep fixed URLs and reference hashed assets.
for (const name of ["index.html", "login.html", "404.html", "sw.js"]) {
  writeFileSync(join(out, name), template(readFileSync(join(src, name), "utf8")));
}

// Pre-compress.
let count = 0;
let before = 0;
let after = 0;
const t0 = Date.now();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(m?js|wasm|css|html|svg)$/.test(name)) continue;
    const buf = readFileSync(p);
    if (buf.length < 512) continue;
    // Hashed assets never change, so skip work already done by a previous build.
    if (dir === assetsDir && existsSync(p + ".br") && existsSync(p + ".gz")) continue;
    const br = brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    });
    writeFileSync(p + ".br", br);
    writeFileSync(p + ".gz", gzipSync(buf, { level: 9 }));
    before += buf.length;
    after += br.length;
    count++;
  }
})(out);

writeFileSync(join(root, "build", "manifest.json"), JSON.stringify({ build: vars.BUILD_ID, assets }, null, 2));
console.log(
  `[build] ${Object.keys(assets).length} assets, ${count} pre-compressed ` +
    `(${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB brotli) in ${Date.now() - t0} ms -> build/www`
);

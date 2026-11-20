// Copies the client-side proxy libraries into build/lib and pre-compresses
// them (brotli + gzip) once, so the Raspberry Pi never has to compress the
// multi-megabyte JS/WASM bundles on every request.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "lib");

// Some packages don't export ./package.json, so locate them on disk directly.
function pkgDir(name) {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot find package ${name}. Did you run npm install?`);
  }
}

const libs = {
  scram: join(pkgDir("@mercuryworkshop/scramjet"), "dist"),
  uv: join(pkgDir("@titaniumnetwork-dev/ultraviolet"), "dist"),
  baremux: join(pkgDir("@mercuryworkshop/bare-mux"), "dist"),
  libcurl: join(pkgDir("@mercuryworkshop/libcurl-transport"), "dist"),
  epoxy: join(pkgDir("@mercuryworkshop/epoxy-transport"), "dist"),
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const COMPRESSIBLE = /\.(m?js|wasm|css|html|json|svg)$/;
let count = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (name.endsWith(".map") || name.endsWith(".d.ts")) { rmSync(p); continue; }
    if (!COMPRESSIBLE.test(name)) continue;
    const buf = readFileSync(p);
    if (buf.length < 1024) continue;
    writeFileSync(p + ".br", brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }));
    writeFileSync(p + ".gz", gzipSync(buf, { level: 9 }));
    count++;
  }
}

for (const [name, src] of Object.entries(libs)) {
  const dest = join(out, name);
  cpSync(src, dest, { recursive: true });
  walk(dest);
}

console.log(`[build] copied ${Object.keys(libs).length} libraries, pre-compressed ${count} files -> build/lib`);

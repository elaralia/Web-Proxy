import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(join(root, ".env"));

// ---------------------------------------------------------------------------
// Configuration (environment variables or a .env file in the project root)
// ---------------------------------------------------------------------------
const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  // Leave empty to disable the login page.
  password: process.env.PROXY_PASSWORD || "",
  // IPs of reverse proxies (nginx/Apache/Caddy/cloudflared) we trust for X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY || "127.0.0.1,::1",
  // Comma separated hostnames (regex) the proxy must never connect to.
  blocklist: (process.env.BLOCKLIST || "").split(",").map((s) => s.trim()).filter(Boolean),
  // Optional custom DNS servers, e.g. "1.1.1.1,1.0.0.1" (empty = use the Pi's resolver).
  dnsServers: (process.env.DNS_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // DANGEROUS: lets proxy users reach devices on your home network (router, NAS, the Pi itself).
  allowLocalNetwork: process.env.ALLOW_LOCAL_NETWORK === "true",
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
};

const libDir = join(root, "build", "lib");
if (!existsSync(libDir)) {
  console.error("build/lib is missing. Run `npm run build` (it normally runs automatically after `npm install`).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Wisp (the actual network relay). The browser does all of the heavy page
// rewriting; the server only pipes encrypted TCP bytes, which is cheap enough
// for a Raspberry Pi.
// ---------------------------------------------------------------------------
logging.set_level(config.logLevel === "debug" ? logging.DEBUG : logging.WARN);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  allow_private_ips: config.allowLocalNetwork, // by default never let the proxy reach your home LAN
  allow_loopback_ips: config.allowLocalNetwork, // ...or the Pi itself
  hostname_blacklist: config.blocklist.length ? config.blocklist.map((h) => new RegExp(h, "i")) : null,
  ...(config.dnsServers.length ? { dns_method: "resolve", dns_servers: config.dnsServers } : {}),
});

// ---------------------------------------------------------------------------
// Optional password protection
// ---------------------------------------------------------------------------
const COOKIE = "wp_session";
const sessionToken = config.password
  ? createHmac("sha256", config.password).update("web-proxy-session-v1").digest("hex")
  : null;

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isAuthed(cookieHeader) {
  if (!sessionToken) return true;
  const c = parseCookies(cookieHeader)[COOKIE];
  return !!c && safeEqual(c, sessionToken);
}

const PUBLIC_PATHS = new Set(["/login", "/login.html", "/style.css", "/favicon.svg", "/api/login"]);

// Simple brute-force protection: 10 failed logins per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60_000) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60_000) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const fastify = Fastify({
  logger: config.logLevel === "debug",
  trustProxy: config.trustProxy === "true" ? true : config.trustProxy,
  serverFactory: (handler) =>
    createServer()
      .on("request", (req, res) => {
        // Needed for SharedArrayBuffer, which Scramjet uses for synchronous XHR.
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        handler(req, res);
      })
      .on("upgrade", (req, socket, head) => {
        if (!req.url.startsWith("/wisp/") || !isAuthed(req.headers.cookie)) {
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        wisp.routeRequest(req, socket, head);
      }),
});

fastify.addHook("onRequest", async (req, reply) => {
  if (!sessionToken) return;
  const path = req.url.split("?")[0];
  if (PUBLIC_PATHS.has(path) || isAuthed(req.headers.cookie)) return;
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return reply.redirect("/login");
  }
  return reply.code(401).type("text/plain").send("Unauthorized");
});

fastify.get("/login", (req, reply) => {
  if (!sessionToken) return reply.redirect("/");
  return reply.sendFile("login.html");
});

fastify.post("/api/login", async (req, reply) => {
  if (!sessionToken) return { ok: true };
  if (tooManyFailures(req.ip)) {
    return reply.code(429).send({ ok: false, error: "Too many attempts. Try again in 15 minutes." });
  }
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!safeEqual(password, config.password)) {
    recordFailure(req.ip);
    return reply.code(401).send({ ok: false, error: "Wrong password." });
  }
  failures.delete(req.ip);
  const secure = req.protocol === "https" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`
  );
  return { ok: true };
});

fastify.post("/api/logout", async (req, reply) => {
  reply.header("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return { ok: true };
});

fastify.get("/api/info", async () => ({ auth: !!sessionToken }));

// Front-end (small, changes when you edit it -> short cache).
fastify.register(fastifyStatic, {
  root: join(root, "public"),
  decorateReply: true,
  cacheControl: true,
  maxAge: 0,
  setHeaders(reply, path) {
    // The service worker must be allowed to control the whole origin.
    if (path.endsWith("sw.js")) reply.header("Service-Worker-Allowed", "/");
  },
});

// Proxy libraries (large, versioned by npm -> cache for a day, served pre-compressed).
for (const name of ["scram", "uv", "baremux", "libcurl", "epoxy"]) {
  fastify.register(fastifyStatic, {
    root: join(libDir, name),
    prefix: `/${name}/`,
    decorateReply: false,
    preCompressed: true,
    cacheControl: true,
    maxAge: "1d",
  });
}

fastify.setNotFoundHandler((req, reply) => {
  reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
  const { port } = fastify.server.address();
  console.log(`Web-Proxy listening on http://${hostname()}:${port} (and http://localhost:${port})`);
  console.log(config.password ? "Password protection: ON" : "Password protection: OFF (set PROXY_PASSWORD to enable)");
});

function shutdown() {
  fastify.close().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

fastify.listen({ port: config.port, host: config.host }).catch((err) => {
  console.error(err);
  process.exit(1);
});

// Minimal .env loader (so we don't need an extra dependency or Node 20.6+).
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

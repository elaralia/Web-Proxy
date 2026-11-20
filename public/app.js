/* global BareMux, $scramjetLoadController, __uv$config */
"use strict";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SHORTCUTS = [
  { name: "Google", url: "https://www.google.com" },
  { name: "YouTube", url: "https://www.youtube.com" },
  { name: "Wikipedia", url: "https://en.wikipedia.org" },
  { name: "Reddit", url: "https://www.reddit.com" },
  { name: "Discord", url: "https://discord.com/app" },
  { name: "Spotify", url: "https://open.spotify.com" },
  { name: "GitHub", url: "https://github.com" },
];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("wp:" + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("wp:" + key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

const settings = {
  engine: store.get("engine", "scramjet"),
  transport: store.get("transport", "epoxy"),
  search: store.get("search", "https://duckduckgo.com/?q=%s"),
  restore: store.get("restore", true),
};

// ---------------------------------------------------------------------------
// Proxy setup
// ---------------------------------------------------------------------------
const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
  prefix: "/scramjet/",
  files: {
    wasm: "/scram/scramjet.wasm.wasm",
    all: "/scram/scramjet.all.js",
    sync: "/scram/scramjet.sync.js",
  },
  flags: { interceptDownloads: true },
});
const scramjetReady = scramjet.init();
const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

const TRANSPORTS = {
  epoxy: "/epoxy/index.mjs",
  libcurl: "/libcurl/index.mjs",
};

let setupPromise = null;
function ensureProxy() {
  if (!setupPromise) {
    setupPromise = (async () => {
      if (!("serviceWorker" in navigator)) {
        throw new Error(
          location.protocol === "https:"
            ? "Your browser doesn't support service workers, which this proxy needs."
            : "This page must be opened over HTTPS. Browsers only allow service workers on secure (https://) sites.\nSee the README for how to add HTTPS to your Raspberry Pi."
        );
      }
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      await scramjetReady;
      await applyTransport();
    })().catch((err) => {
      setupPromise = null;
      throw err;
    });
  }
  return setupPromise;
}

async function applyTransport() {
  const wisp = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
  const path = TRANSPORTS[settings.transport] || TRANSPORTS.epoxy;
  if ((await connection.getTransport()) !== path) {
    await connection.setTransport(path, [{ wisp, websocket: wisp }]);
  }
}

function encodeProxyUrl(url, engine) {
  if (engine === "uv") return __uv$config.prefix + __uv$config.encodeUrl(url);
  return scramjet.encodeUrl(url);
}

function decodeProxyUrl(href) {
  try {
    const u = new URL(href);
    if (u.origin !== location.origin) return null;
    if (u.pathname.startsWith(__uv$config.prefix)) {
      return __uv$config.decodeUrl(u.pathname.slice(__uv$config.prefix.length)) + "";
    }
    if (u.pathname.startsWith("/scramjet/")) return scramjet.decodeUrl(href);
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Address bar helpers
// ---------------------------------------------------------------------------
function toUrl(input) {
  input = input.trim();
  if (!input) return null;
  try {
    const u = new URL(input);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* not a full URL */
  }
  if (!/\s/.test(input)) {
    try {
      const u = new URL("https://" + input);
      if (u.hostname.includes(".") || u.hostname === "localhost") return u.href;
    } catch {
      /* not a hostname */
    }
  }
  return settings.search.replace("%s", encodeURIComponent(input));
}

function prettyUrl(url) {
  return url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : "";
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const tabsEl = $("tabs");
const homePage = $("home-page");
const address = $("address");
const progress = $("progress");

let tabs = [];
let active = null;
let nextId = 1;

function createTab(url, { activate = true, lazy = false } = {}) {
  const tab = {
    id: nextId++,
    engine: settings.engine,
    url: null,
    title: "New tab",
    icon: null,
    iframe: null,
    frame: null,
    loading: false,
    el: document.createElement("div"),
  };
  tab.el.className = "tab";
  tab.el.setAttribute("role", "tab");
  tab.el.innerHTML =
    '<span class="dot"></span><span class="title"></span>' +
    '<button class="close" title="Close tab" aria-label="Close tab"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  tab.el.addEventListener("click", () => selectTab(tab));
  tab.el.addEventListener("auxclick", (e) => e.button === 1 && closeTab(tab));
  tab.el.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tabsEl.appendChild(tab.el);
  tabs.push(tab);
  if (url && lazy) {
    // Restored tab: don't load it until the user actually opens it.
    tab.url = url;
    tab.title = prettyUrl(url);
    tab.pending = true;
  }
  renderTab(tab);
  if (activate) selectTab(tab);
  if (url && !tab.pending) navigate(tab, url);
  saveTabs();
  return tab;
}

function makeFrame(tab) {
  if (tab.iframe) tab.iframe.remove();
  let iframe;
  if (tab.engine === "scramjet") {
    tab.frame = scramjet.createFrame();
    iframe = tab.frame.frame;
    tab.frame.addEventListener("urlchange", (e) => updateFromFrame(tab, e.url));
  } else {
    tab.frame = null;
    iframe = document.createElement("iframe");
  }
  iframe.setAttribute(
    "allow",
    "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-read; clipboard-write; camera; microphone; geolocation; gamepad"
  );
  iframe.addEventListener("load", () => {
    setLoading(tab, false);
    updateFromFrame(tab);
    hookFrame(tab);
  });
  iframe.hidden = tab !== active;
  tab.iframe = iframe;
  viewport.appendChild(iframe);
}

// Watch for navigations that start inside the page so the loading bar works.
function hookFrame(tab) {
  try {
    const win = tab.iframe.contentWindow;
    win.addEventListener("beforeunload", () => setLoading(tab, true));
    // Links with target=_blank / window.open -> open in a new proxy tab instead.
    win.open = (u) => {
      if (u) {
        const real = decodeProxyUrl(new URL(u, win.location.href).href) || new URL(u, win.location.href).href;
        createTab(real);
      }
      return null;
    };
  } catch {
    /* cross-origin (shouldn't happen) */
  }
}

async function navigate(tab, url) {
  showError(null);
  if (!url) return;
  try {
    await ensureProxy();
  } catch (err) {
    showError(String(err.message || err));
    return;
  }
  if (tab.engine !== settings.engine || !tab.iframe) {
    tab.engine = settings.engine;
    makeFrame(tab);
  }
  tab.url = url;
  setLoading(tab, true);
  if (tab.frame) tab.frame.go(url);
  else tab.iframe.src = encodeProxyUrl(url, "uv");
  renderTab(tab);
  if (tab === active) syncChrome();
  saveTabs();
}

function updateFromFrame(tab, urlFromEvent) {
  let url = urlFromEvent || null;
  let title = null;
  let icon = null;
  try {
    const win = tab.iframe.contentWindow;
    if (!url) url = decodeProxyUrl(win.location.href);
    const doc = win.document;
    title = doc.title;
    // Proxied pages report the *real* favicon URL, so route it through the proxy too.
    const link = doc.querySelector('link[rel~="icon"]');
    const real = url || tab.url;
    if (real && /^https?:/.test(real)) {
      icon = encodeProxyUrl(new URL(link ? link.getAttribute("href") : "/favicon.ico", real).href, tab.engine);
    }
  } catch {
    /* frame not ready */
  }
  let changed = false;
  if (url && url !== tab.url) { tab.url = url; changed = true; }
  if (title && title !== tab.title) { tab.title = title; changed = true; }
  if (icon && icon === tab.badIcon) icon = null;
  if (icon !== tab.icon && tab.url) { tab.icon = icon; changed = true; }
  if (changed) {
    renderTab(tab);
    if (tab === active) syncChrome();
    saveTabs();
  }
}

function renderTab(tab) {
  const titleEl = tab.el.querySelector(".title");
  titleEl.textContent = tab.title || prettyUrl(tab.url) || "New tab";
  tab.el.title = tab.title + (tab.url ? "\n" + tab.url : "");
  const old = tab.el.firstElementChild;
  if (tab.icon && old.tagName !== "IMG") {
    const img = document.createElement("img");
    img.onerror = () => { tab.badIcon = img.src; tab.icon = null; renderTab(tab); };
    old.replaceWith(img);
  } else if (!tab.icon && old.tagName === "IMG") {
    const dot = document.createElement("span");
    dot.className = "dot";
    old.replaceWith(dot);
  }
  if (tab.icon && tab.el.firstElementChild.src !== tab.icon) tab.el.firstElementChild.src = tab.icon;
  tab.el.classList.toggle("active", tab === active);
}

function selectTab(tab) {
  active = tab;
  for (const t of tabs) {
    t.el.classList.toggle("active", t === tab);
    t.el.setAttribute("aria-selected", t === tab);
    if (t.iframe) t.iframe.hidden = t !== tab || !t.url;
  }
  tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  syncChrome();
  if (tab.pending) {
    tab.pending = false;
    navigate(tab, tab.url);
  }
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.el.remove();
  if (tab.iframe) {
    tab.iframe.src = "about:blank";
    tab.iframe.remove();
  }
  if (!tabs.length) createTab();
  else if (tab === active) selectTab(tabs[Math.min(i, tabs.length - 1)]);
  saveTabs();
}

function syncChrome() {
  const tab = active;
  if (!tab) return;
  const onHome = !tab.url;
  homePage.hidden = !onHome;
  if (tab.iframe) tab.iframe.hidden = onHome;
  if (document.activeElement !== address) address.value = tab.url || "";
  $("engine-badge").textContent = onHome ? (settings.engine === "uv" ? "UV" : "SJ") : tab.engine === "uv" ? "UV" : "SJ";
  $("back").disabled = onHome;
  $("forward").disabled = onHome;
  $("reload").disabled = onHome;
  document.title = onHome ? "Web Proxy" : (tab.title || prettyUrl(tab.url)) + " – Web Proxy";
  progress.className = "progress" + (tab.loading ? " loading" : "");
  if (onHome) setTimeout(() => $("home-input").focus(), 0);
}

function setLoading(tab, loading) {
  tab.loading = loading;
  if (tab !== active) return;
  if (loading) {
    progress.className = "progress";
    void progress.offsetWidth;
    progress.className = "progress loading";
  } else {
    progress.className = "progress done";
  }
}

function saveTabs() {
  if (!settings.restore) return store.set("tabs", []);
  store.set("tabs", tabs.filter((t) => t.url).map((t) => t.url));
}

function showError(msg) {
  const el = $("home-error");
  el.hidden = !msg;
  el.textContent = msg || "";
  if (msg && active) {
    homePage.hidden = false;
  }
}

// Keep title/URL fresh for pages that change them without a navigation (SPAs).
setInterval(() => {
  if (active && active.url && active.iframe) updateFromFrame(active);
}, 1000);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
$("address-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = toUrl(address.value);
  if (!url || !active) return;
  address.blur();
  navigate(active, url);
});
address.addEventListener("focus", () => address.select());

$("home-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("home-input");
  const url = toUrl(input.value);
  if (!url) return;
  input.value = "";
  navigate(active, url);
});

function frameHistory(dir) {
  const tab = active;
  if (!tab || !tab.iframe) return;
  try {
    if (dir === "back") tab.iframe.contentWindow.history.back();
    else if (dir === "forward") tab.iframe.contentWindow.history.forward();
    else {
      setLoading(tab, true);
      tab.iframe.contentWindow.location.reload();
    }
  } catch {
    if (tab.frame) tab.frame[dir]();
  }
}
$("back").addEventListener("click", () => frameHistory("back"));
$("forward").addEventListener("click", () => frameHistory("forward"));
$("reload").addEventListener("click", () => frameHistory("reload"));
$("home").addEventListener("click", () => {
  if (!active) return;
  active.url = null;
  active.title = "New tab";
  active.icon = null;
  if (active.iframe) {
    active.iframe.remove();
    active.iframe = null;
    active.frame = null;
  }
  renderTab(active);
  syncChrome();
  saveTabs();
});
$("new-tab").addEventListener("click", () => createTab());
$("fullscreen").addEventListener("click", () => {
  const el = active && active.url && active.iframe ? active.iframe : document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
});
$("engine-badge").addEventListener("click", () => $("settings-btn").click());

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); address.focus(); }
  else if (e.altKey && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(); }
  else if (e.altKey && e.key.toLowerCase() === "w") { e.preventDefault(); if (active) closeTab(active); }
  else if (e.key === "F5" || (mod && e.key.toLowerCase() === "r")) {
    if (active && active.url) { e.preventDefault(); frameHistory("reload"); }
  }
});

// ---------------------------------------------------------------------------
// Shortcuts on the home page
// ---------------------------------------------------------------------------
function renderShortcuts() {
  const list = store.get("shortcuts", DEFAULT_SHORTCUTS);
  const box = $("shortcuts");
  box.innerHTML = "";
  list.forEach((s, i) => {
    const b = document.createElement("div");
    b.className = "shortcut";
    b.tabIndex = 0;
    b.innerHTML = '<span class="icon"></span><span class="label"></span>' +
      '<button class="remove" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    b.querySelector(".icon").textContent = s.name.charAt(0).toUpperCase();
    b.querySelector(".label").textContent = s.name;
    b.title = s.url;
    b.addEventListener("click", () => navigate(active, s.url));
    b.addEventListener("keydown", (e) => e.key === "Enter" && navigate(active, s.url));
    b.querySelector(".remove").addEventListener("click", (e) => {
      e.stopPropagation();
      list.splice(i, 1);
      store.set("shortcuts", list);
      renderShortcuts();
    });
    box.appendChild(b);
  });
  const add = document.createElement("button");
  add.className = "shortcut";
  add.innerHTML = '<span class="icon">+</span><span class="label">Add shortcut</span>';
  add.addEventListener("click", () => {
    const url = prompt("Shortcut URL (e.g. example.com):");
    if (!url) return;
    const full = toUrl(url);
    const name = prompt("Name:", prettyUrl(full).split("/")[0]) || prettyUrl(full);
    list.push({ name, url: full });
    store.set("shortcuts", list);
    renderShortcuts();
  });
  box.appendChild(add);
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
const dialog = $("settings");
$("settings-btn").addEventListener("click", () => {
  $("set-engine").value = settings.engine;
  $("set-transport").value = settings.transport;
  $("set-search").value = settings.search;
  $("set-restore").checked = settings.restore;
  dialog.showModal();
});
$("set-engine").addEventListener("change", (e) => {
  settings.engine = e.target.value;
  store.set("engine", settings.engine);
  syncChrome();
});
$("set-transport").addEventListener("change", async (e) => {
  settings.transport = e.target.value;
  store.set("transport", settings.transport);
  if (setupPromise) await applyTransport().catch((err) => showError(String(err)));
});
$("set-search").addEventListener("change", (e) => {
  settings.search = e.target.value;
  store.set("search", settings.search);
});
$("set-restore").addEventListener("change", (e) => {
  settings.restore = e.target.checked;
  store.set("restore", settings.restore);
  saveTabs();
});
$("clear-data").addEventListener("click", async () => {
  if (!confirm("Clear cookies, logins and storage for all proxied sites?")) return;
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name);
    const keep = Object.keys(localStorage).filter((k) => k.startsWith("wp:"));
    const saved = keep.map((k) => [k, localStorage.getItem(k)]);
    localStorage.clear();
    for (const [k, v] of saved) localStorage.setItem(k, v);
    sessionStorage.clear();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* best effort */
  }
  location.reload();
});

fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    if (!info.auth) return;
    const btn = $("logout");
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      location.href = "/login";
    });
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Downloads (Scramjet intercepts them so they don't break the page)
// ---------------------------------------------------------------------------
scramjet.addEventListener("download", async (e) => {
  try {
    const { download } = e;
    const blob = await new Response(download.body).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = download.filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (err) {
    console.error("download failed", err);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
renderShortcuts();
const params = new URLSearchParams(location.search);
const initial = params.get("url");
const restored = settings.restore ? store.get("tabs", []) : [];
if (initial) {
  history.replaceState(null, "", "/");
  restored.forEach((u) => createTab(u, { activate: false, lazy: true }));
  createTab(toUrl(initial));
} else if (restored.length) {
  restored.forEach((u, i) => createTab(u, { activate: i === 0, lazy: true }));
} else {
  createTab();
}
// Warm up the service worker + transport in the background.
ensureProxy().catch((err) => showError(String(err.message || err)));

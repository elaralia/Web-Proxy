# Web-Proxy

A fast web proxy built to run on a Raspberry Pi. It replaces PHP-Proxy.

It handles sites PHP-Proxy can't: **YouTube and other video, Discord, Spotify, Reddit, Google, logins, WebSockets and modern JavaScript apps**. It has a browser-style interface with tabs, back/forward/reload, fullscreen, home-page shortcuts and an optional password.

## Why it's faster than PHP-Proxy

PHP-Proxy downloads every page on the Pi, rewrites the HTML/CSS/JS with PHP regexes and sends it back. That is slow on a Pi's CPU, and the regexes break modern sites.

Web-Proxy works the other way round:

```
 Your browser (restricted network)                    Raspberry Pi                 Internet
 ┌────────────────────────────────────────┐      ┌──────────────────┐
 │  Service worker (Scramjet/Ultraviolet) │      │  Node.js + Wisp  │
 │  • rewrites pages, JS, CSS, workers    │ wss  │  just relays     │  TCP   youtube.com
 │  • TLS encryption (Epoxy / libcurl)    │◄────►│  encrypted bytes │◄─────► discord.com ...
 └────────────────────────────────────────┘      └──────────────────┘
```

* **The rewriting runs in your browser**, on your computer's CPU, not the Pi's.
* **The Pi only relays bytes** over one WebSocket (the [Wisp protocol](https://github.com/MercuryWorkshop/wisp-protocol)). That costs almost no CPU.
* **The connection is encrypted end-to-end.** TLS runs in the browser, so even the Pi can't read your traffic. The restricted network only sees a WebSocket to your site.
* **Proxied files are cached in your browser.** Scripts, stylesheets, images and fonts are kept (already rewritten) for as long as each site allows. Going back to a site doesn't re-download them through the Pi or rewrite them again.
* The proxy's own files are **pre-compressed with Brotli at install time** and cached by the browser permanently. After the first visit (about 900 KB), opening the proxy costs a single tiny request.

The limit is now your home internet **upload** speed, because every byte you view passes through the Pi. On a typical home connection that's enough for 720p–1080p YouTube.

## What's included

| | |
|---|---|
| **Scramjet** (default engine) | The newest interception proxy. Best site support (YouTube, Discord, Spotify, CAPTCHAs). |
| **Ultraviolet** (fallback engine) | A mature proxy engine. Switch to it in Settings if a particular site misbehaves in Scramjet. |
| **Epoxy / libcurl transports** | Encrypted transports that run in the browser. Epoxy is the default and the fastest. |
| **Hidden URLs** | The address of the site you're visiting never appears in the URL. It's encrypted with a key unique to your install (see below). |
| **Password protection** | Stops strangers from using your home connection. |
| **LAN protection** | The proxy refuses to connect to your router, NAS, the Pi itself or any other private/local address. |

## Setup on the Raspberry Pi

### 1. Install Node.js 20+ (once)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # should print v22.x
```

A Pi 3, 4 or 5 running 64-bit Raspberry Pi OS is recommended. The Pi Zero/1 (ARMv6) can't run current Node.js.

### 2. Get the code and install it as a service

```bash
git clone https://github.com/elaralia/Web-Proxy.git
cd Web-Proxy
sudo ./deploy/install.sh
```

The script installs the dependencies, asks you for a password, creates `.env` and starts a `web-proxy` systemd service on port 8080. The service starts on boot and restarts if it crashes.

### 3. Put it behind HTTPS (required)

Browsers only allow service workers on `https://` sites, and the proxy relies on them. Your existing site has to serve Web-Proxy over HTTPS. Pick the config that matches what your Pi already runs:

* **Apache** (likely, if you ran PHP-Proxy): [`deploy/apache.conf`](deploy/apache.conf). It shows how to keep the old PHP-Proxy available at `/old/`.
* **nginx**: [`deploy/nginx.conf`](deploy/nginx.conf)
* **Nothing yet / easiest**: [`deploy/Caddyfile`](deploy/Caddyfile). Caddy gets HTTPS certificates automatically.

For Apache or nginx, `sudo certbot --apache -d your.domain` (or `--nginx`) gets a free Let's Encrypt certificate.

> Use the **same domain** that already works on the restricted network. Web-Proxy must be served from the root of the site (`https://your.domain/`), not a sub-folder.

Then open `https://your.domain/`, sign in, and browse.

## Hidden URLs

PHP-Proxy hides the target address with plain base64, which anyone (or any filter) can decode. Web-Proxy XORs the address with a random key unique to your installation, then base64url-encodes it, so a proxied page looks like:

```
https://your.domain/s/kJoUIqHzMWgjm6kutkaa48DotPNd8GOCmPPYpQKKQps
```

Decoding that as base64 gives gibberish. You need your key to read it. Other things that could give the proxy away are hidden too:

* Paths are short and generic: `/s/…` (Scramjet), `/u/…` (Ultraviolet) and `/assets/<hash>.js` for every script. Library names like "scramjet" or "uv.bundle.js" never appear.
* Without signing in, nobody can download the proxy scripts or the file that contains your key. Only the login page is public.
* The browser's own address bar always shows just `https://your.domain/`.

The key is created on first install and saved in `.codec-key` in the project folder. Keep it: if you delete it, a new one is generated, and links to proxied pages you saved earlier stop working. Nothing else is lost.

## Configuration

Edit `.env` in the project folder, then run `sudo systemctl restart web-proxy`. All options are documented in [`.env.example`](.env.example):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port Node listens on |
| `HOST` | `127.0.0.1` | `127.0.0.1` = only reachable through your reverse proxy |
| `PROXY_PASSWORD` | *(empty)* | Login password. Empty disables the login. **Set one.** |
| `BLOCKLIST` | *(empty)* | Comma-separated hostname regexes the proxy refuses |
| `DNS_SERVERS` | *(system)* | e.g. `1.1.1.2,1.0.0.2` |
| `ALLOW_LOCAL_NETWORK` | `false` | Allow access to LAN/loopback addresses. Leave it off. |

In the browser, ⚙ **Settings** lets each user pick the engine (Scramjet / Ultraviolet), the transport (Epoxy / libcurl) and the search engine. It also lets them clear proxied site data (cookies, logins and the cache) and log out.

Keyboard shortcuts: `Ctrl+L` focuses the address bar, `Alt+T` opens a new tab, `Alt+W` closes the tab, `Ctrl+R`/`F5` reloads the page inside the proxy.

## Updating

```bash
cd Web-Proxy
git pull
npm ci --omit=dev
sudo systemctl restart web-proxy
```

## Troubleshooting

* **"This page must be opened over HTTPS"**: see step 3. Service workers don't work on plain `http://` (except `localhost`).
* **The page loads but every site shows an error**: your reverse proxy probably isn't passing WebSockets. Check the `/wisp/` and `Upgrade` lines in the sample config. Run `journalctl -u web-proxy -f` to see the logs.
* **A specific site breaks**: open Settings, switch the engine to Ultraviolet (or the transport to libcurl), then reload. If it still fails, use *Clear site data*.
* **YouTube or Google keep showing CAPTCHAs**: that happens when a lot of traffic comes from one IP. A home IP is usually fine.
* **Sites that won't work through any web proxy**: Netflix, Disney+ and other DRM video services, and some banking sites.
* **Right after an update a tab acts strangely**: reload the proxy page once. The previous version's files are kept for one update, so open tabs normally keep working.

## Local development

```bash
npm install          # also runs the build step
npm run dev          # rebuild + start on http://localhost:8080 (service workers are allowed on localhost)
```

Files in `public/` are templates: after editing them, run `npm run build` (or `npm run dev`) and restart. The build is incremental and takes well under a second once the libraries have been compressed.

Layout:

```
src/server.js        Fastify server: static files, login, Wisp WebSocket relay
public/index.html    Browser UI (tabs, toolbar, home page, settings)
public/app.js        UI logic, tab management, Scramjet/UV/bare-mux setup
public/sw.js         Service worker: runs Scramjet + Ultraviolet, response cache
public/config.js     Template for the shared config (URL codec, asset paths)
public/uv.config.js  Template for Ultraviolet's config
scripts/build.js     Builds build/www: hashed assets, codec key, templates, brotli/gzip
deploy/              systemd unit, install script, nginx/Apache/Caddy configs
```

### Performance notes

Measured with headless Chromium against a local test site on a fast VM. A Pi 4 is roughly 3–5× slower on server CPU:

| | Result |
|---|---|
| Pi CPU to relay 100 MB | ~0.35 s (a Pi 4 can relay far more than a home upload link) |
| Wisp protocol overhead | 0.02% |
| Return visit to a page with 1.5 MB of JS, after a browser restart | 1524 KB → **1 KB** through the Pi, 35–60% faster |
| Opening the proxy again | 1 KB (everything else is cached permanently) |

## Credits and license

Built on [Scramjet](https://github.com/MercuryWorkshop/scramjet), [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet), [bare-mux](https://github.com/MercuryWorkshop/bare-mux), [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls), [libcurl.js](https://github.com/ading2210/libcurl.js) and [wisp-js](https://github.com/MercuryWorkshop/wisp-client-js). Some of these are AGPL-3.0, so this project is AGPL-3.0-or-later.

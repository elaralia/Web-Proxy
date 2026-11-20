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

What's left for the Pi is small: relaying bytes, and the HTTPS encryption your web server (Apache/nginx/Caddy) does. The relay is tuned for a Pi's limited RAM and CPU (see [Performance notes](#performance-notes)). On a Pi 4 or older, also do [step 4](#4-pi-4-or-older-make-https-use-chacha20).

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

### 4. Pi 4 or older: make HTTPS use ChaCha20

**This is the biggest CPU saving available on these Pis.** Every byte the proxy sends you is HTTPS-encrypted on the Pi by your web server, and that costs more CPU than the proxy itself. Raspberry Pis before the Pi 5 have no AES instructions, so the default cipher, AES-GCM, is very slow on them. ChaCha20-Poly1305 is designed for CPUs without AES hardware. Measured on this project's Pi (one CPU core):

| Cipher | Encryption speed |
|---|---|
| AES-128-GCM (the default) | 13 MB/s |
| ChaCha20-Poly1305 | **93 MB/s (7× faster)** |

So the same traffic costs about a seventh of the CPU. Every browser supports both. Laptops ask for AES first only because *their* CPUs have AES hardware, so the server has to insist on ChaCha20. `install.sh` tells you whether your Pi lacks AES. To measure it yourself:

```bash
openssl speed -seconds 2 -bytes 16384 -evp aes-128-gcm
openssl speed -seconds 2 -bytes 16384 -evp chacha20-poly1305
```

Do the part that matches your web server, then reload it:

* **Apache**: uncomment the three ChaCha20 lines (`SSLHonorCipherOrder`, `SSLCipherSuite` ×2) in [`deploy/apache.conf`](deploy/apache.conf). If certbot added an `Include` line, put them below it.
* **nginx 1.19.4 or newer** (`nginx -v`): uncomment the three ChaCha20 lines in [`deploy/nginx.conf`](deploy/nginx.conf).
* **nginx 1.18**: this is what Raspberry Pi OS 11 "bullseye" ships. If `openssl version` says 1.1.1, you're probably on it. nginx 1.18 doesn't know `ssl_conf_command` and won't start with that line, so uncomment only `ssl_prefer_server_ciphers` and `ssl_ciphers`. Then set the TLS 1.3 order with the included OpenSSL file, which only nginx uses:
  ```bash
  sudo cp deploy/openssl-chacha.cnf /etc/nginx/
  sudo mkdir -p /etc/systemd/system/nginx.service.d
  printf '[Service]\nEnvironment=OPENSSL_CONF=/etc/nginx/openssl-chacha.cnf\n' | sudo tee /etc/systemd/system/nginx.service.d/chacha.conf
  sudo systemctl daemon-reload && sudo systemctl restart nginx
  ```
* **Caddy**: nothing to do. It picks ChaCha20 automatically on CPUs without AES.

Check that it worked by running this on the Pi. The client deliberately asks for AES first, like a laptop browser:

```bash
echo | openssl s_client -connect your.domain:443 -tls1_3 -ciphersuites TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256 2>/dev/null | grep "Cipher is"
```

It should print `TLS_CHACHA20_POLY1305_SHA256`. Each of these setups was tested with nginx, Apache and Chromium, and all of them negotiated ChaCha20 even though the browser preferred AES.

## Hidden URLs

PHP-Proxy hides the target address with plain base64, which anyone (or any filter) can decode. Web-Proxy XORs the address with a random key unique to your installation, then base64url-encodes it, so a proxied page looks like:

```
https://your.domain/s/kJoUIqHzMWgjm6kutkaa48DotPNd8GOCmPPYpQKKQps
```

Decoding that as base64 gives gibberish. You need your key to read it. These `/s/…` addresses are also handled entirely inside your browser by the service worker, so they never cross the network. The network only sees `your.domain`, the `/assets/…` files and one encrypted WebSocket. Other things that could give the proxy away are hidden too:

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
src/server.js        Fastify server: static files, login, WebSocket upgrade
src/relay.js         Wisp relay tuned for low RAM/CPU (flow control, single-copy data path)
public/index.html    Browser UI (tabs, toolbar, home page, settings)
public/app.js        UI logic, tab management, Scramjet/UV/bare-mux setup
public/sw.js         Service worker: runs Scramjet + Ultraviolet, response cache
public/config.js     Template for the shared config (URL codec, asset paths)
public/uv.config.js  Template for Ultraviolet's config
scripts/build.js     Builds build/www: hashed assets, codec key, templates, brotli/gzip
deploy/              systemd unit, install script, nginx/Apache/Caddy configs,
                     openssl-chacha.cnf (ChaCha20 for nginx 1.18)
```

### Performance notes

Measured on a fast VM with headless Chromium and a Wisp test client against local test sites. A Pi 4 is roughly 3–5× slower on CPU:

| | Result |
|---|---|
| Pi CPU to relay 100 MB | ~0.1 s, about 27% less than stock wisp-js. The relay builds each packet with one copy instead of two. |
| Pi RAM, slow client downloading 3 files at once | **~110 MB peak** (stock wisp-js: 237 MB). A full buffer pauses the website's connection instead of storing more. |
| Large download when the website closes the connection | Complete (stock wisp-js delivered only 38 of 100 MB on a slow link) |
| Wisp protocol overhead | 0.02% |
| Return visit to a page with 1.5 MB of JS, after a browser restart | 1524 KB → **1 KB** through the Pi, 35–60% faster |
| Opening the proxy again | 1 KB (everything else is cached permanently) |

## Credits and license

Built on [Scramjet](https://github.com/MercuryWorkshop/scramjet), [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet), [bare-mux](https://github.com/MercuryWorkshop/bare-mux), [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls), [libcurl.js](https://github.com/ading2210/libcurl.js) and [wisp-js](https://github.com/MercuryWorkshop/wisp-client-js). Some of these are AGPL-3.0, so this project is AGPL-3.0-or-later.

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
* The large proxy libraries are **pre-compressed with Brotli at install time**. Browsers cache them, so after the first visit almost nothing is re-downloaded.

The limit is now your home internet **upload** speed, because every byte you view passes through the Pi. On a typical home connection that's enough for 720p–1080p YouTube.

## What's included

| | |
|---|---|
| **Scramjet** (default engine) | The newest interception proxy. Best site support (YouTube, Discord, Spotify, CAPTCHAs). |
| **Ultraviolet** (fallback engine) | A mature proxy engine. Switch to it in Settings if a particular site misbehaves in Scramjet. |
| **Epoxy / libcurl transports** | Encrypted transports that run in the browser. Epoxy is the default and the fastest. |
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

In the browser, ⚙ **Settings** lets each user pick the engine (Scramjet / Ultraviolet), the transport (Epoxy / libcurl) and the search engine. It also lets them clear proxied site data and log out.

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

## Local development

```bash
npm install          # also runs the build step (copies + compresses the proxy libraries)
npm start            # http://localhost:8080 (service workers are allowed on localhost)
```

Layout:

```
src/server.js        Fastify server: static files, login, Wisp WebSocket relay
public/index.html    Browser UI (tabs, toolbar, home page, settings)
public/app.js        UI logic, tab management, Scramjet/UV/bare-mux setup
public/sw.js         Service worker that runs Scramjet and Ultraviolet
scripts/build.js     Copies client libraries to build/lib and pre-compresses them
deploy/              systemd unit, install script, nginx/Apache/Caddy configs
```

## Credits and license

Built on [Scramjet](https://github.com/MercuryWorkshop/scramjet), [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet), [bare-mux](https://github.com/MercuryWorkshop/bare-mux), [epoxy-tls](https://github.com/MercuryWorkshop/epoxy-tls), [libcurl.js](https://github.com/ading2210/libcurl.js) and [wisp-js](https://github.com/MercuryWorkshop/wisp-client-js). Some of these are AGPL-3.0, so this project is AGPL-3.0-or-later.

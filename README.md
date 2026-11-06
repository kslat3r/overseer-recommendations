# Overseer Recommendations

A swipe-style recommendation deck for **Overseerr** and **Jellyseerr**. It runs in two modes, auto-detected by the browser:

- **Server mode (recommended):** a small Express server (`server/`) serves the built SPA and a fixed same-origin `/api/v1` proxy to your Overseerr. The Overseerr URL and API key live only in the server's environment and never reach the browser. Everything except the login page and `/healthz` is behind an `APP_PASSWORD` login. Designed for a [Fly Sprite](#deploy-on-a-fly-sprite) that reaches a private Overseerr over Tailscale.
- **Static mode (legacy):** the same SPA hosted on GitHub Pages at <https://kslat3r.github.io/overseer-recommendations/> (served from the `gh-pages` branch, left untouched). There is no backend; the server URL and API key are stored in this browser's `localStorage` and sent straight to your server. See [Legacy: GitHub Pages](#legacy-github-pages-https--cors).

Mode detection: on load the page requests `api/status`. Only the Node server answers it (`{"mode":"server"}`); static hosts return 404, so the app falls back to direct mode with its Settings form. In server mode Settings hides the URL/key fields and explains that they are configured on the server.

## How it works

1. `GET /api/v1/auth/me` verifies the URL and key.
2. It pages through `GET /api/v1/media` (`available`, `partial`, `processing`, `allavailable`, `pending` filters) to learn what you own, are downloading, or have requested.
3. For library titles it fetches `/api/v1/{movie|tv}/{id}/recommendations` and `/similar`.
4. Results are de-duplicated by media type + TMDB id, anything in the library, in requests, skipped, or already flagged by Overseerr is dropped, and the rest are ranked by how many **distinct** library titles point to them (ties: TMDB rating).
5. Swipe / drag / press:
   - **Left / `←` / ✕** saves a skip in `localStorage` so the title never returns.
   - **Right / `→` / ＋** sends `POST /api/v1/request` — movies as `{"mediaType":"movie","mediaId":ID}`, TV as `{"mediaType":"tv","mediaId":ID,"seasons":[1]}`. Controls lock while the request is pending, and if it fails the card stays in the deck with an error toast.

Posters are loaded from `image.tmdb.org` (TMDB's image CDN) with no referrer. Settings has a "Try the demo" mode with an in-memory fake API.

## Getting your API key

In Overseerr/Jellyseerr open **Settings > General** and copy the **API Key**.

## Server API (server mode)

Fixed whitelist; the upstream URL and body are rebuilt from validated values and nothing else is forwarded:

| Browser call | Validation | Upstream |
| --- | --- | --- |
| `GET /api/v1/auth/me` | no query | same; response reduced to id/name/email fields |
| `GET /api/v1/media` | `filter` in `all,available,partial,allavailable,processing,pending`; `take` 1–100; `skip` ≥ 0 | same |
| `GET /api/v1/{movie\|tv}/{id}/{recommendations\|similar}` | numeric id; `page` 1–500 | same |
| `POST /api/v1/request` | `{mediaType,mediaId}` only | movie: `{"mediaType":"movie","mediaId":ID}`; tv: `{"mediaType":"tv","mediaId":ID,"seasons":[1]}` |

Anything else is 404/405/400. Errors: no/expired session → `401 {"code":"session"}` (the app shows **Sign in**); Overseerr rejecting the server's key → `502 {"code":"upstream-auth"}` (a distinct "update OVERSEERR_API_KEY on the server" message). The API key is redacted from all output and never logged.

Security: login with `APP_PASSWORD` (timing-safe compare, 5 failures/15 min per IP plus a global cap), random HMAC-signed expiring session in an `HttpOnly; SameSite=Strict` cookie (`Secure` when `NODE_ENV=production`), logout, CSP and other security headers, small body limits, same-origin check on POSTs. Sessions are in memory, so a restart logs everyone out. `trust proxy` is on (1 hop, `TRUST_PROXY_HOPS` to change) because the Sprite terminates HTTPS. Only Overseerr calls use `https-proxy-agent` via `TAILSCALE_PROXY` (default `http://127.0.0.1:1055`; empty = direct); no global proxy is set.

Environment: `OVERSEERR_URL`, `OVERSEERR_API_KEY`, `APP_PASSWORD` (all required), `PORT` (8080), `NODE_ENV`, `TAILSCALE_PROXY`, `SESSION_TTL_HOURS` (12). Listens on `0.0.0.0`.

```sh
pnpm build   # SPA -> dist/, server -> dist-server/
node --env-file=/path/to/private.env dist-server/index.js
```

## Deploy on a Fly Sprite

Only a Fly **Sprite** is used: no Dockerfile, no `fly.toml`, no Machine `start.sh`. `deploy/sprite-setup.sh` runs *inside* the Sprite (Ubuntu 25.10 with Node and Git preinstalled).

From your local checkout of this repo:

```sh
sprite -o while-true-ltd login
sprite -o while-true-ltd create overseer-recs --skip-console
sprite -o while-true-ltd use overseer-recs
sprite -o while-true-ltd file push -p deploy/sprite-setup.sh /home/sprite/sprite-setup.sh
sprite -o while-true-ltd console
```

Every `sprite` command here passes the organization explicitly (`-o while-true-ltd`) so nothing depends on, or lands in, a different default org. `sprite use` still records the active Sprite for convenience, but the org is explicit everywhere. `--skip-console` stops `create` from opening a console before the script is uploaded.

Inside the Sprite console (your local environment does **not** propagate; type the secrets here, they stay out of shell history and `ps`):

```sh
read -r  -p 'Overseerr URL (reachable over your tailnet): ' OVERSEERR_URL
read -rs -p 'Overseerr API key: ' OVERSEERR_API_KEY; echo
read -rs -p 'App password (min 8 chars): ' APP_PASSWORD; echo
read -rs -p 'Tailscale auth key: ' TS_AUTHKEY; echo
export OVERSEERR_URL OVERSEERR_API_KEY APP_PASSWORD TS_AUTHKEY
bash /home/sprite/sprite-setup.sh
```

Back on your machine, make the URL reachable and look at it:

```sh
sprite -o while-true-ltd config update --url-auth public   # the app's own APP_PASSWORD login is the gate
sprite -o while-true-ltd info                              # shows the public https URL
```

Open that URL and sign in with `APP_PASSWORD`.

What the script does (idempotent, safe to re-run): clones or fast-forwards a clean `main` into `/home/sprite/overseer-recommendations`; installs pnpm if missing; `pnpm install --frozen-lockfile && pnpm build`; validates and writes `/home/sprite/overseer-recs.env` (mode 600, outside `dist/`, containing `NODE_ENV=production`, `PORT=8080`, `TAILSCALE_PROXY=http://127.0.0.1:1055` and the three secrets); installs Tailscale with the official script if missing; (re)creates the `tailscaled` Sprite Service (kernel networking by default, started via `sudo -n` because Sprite services are unprivileged; `TS_USERSPACE=1` switches to userspace networking; the script errors clearly if `/dev/net/tun` is missing; state in `/var/lib/tailscale`, socket in `/var/run/tailscale`, loopback outbound HTTP proxy and SOCKS5 on `127.0.0.1:1055`); runs `tailscale up` once with the auth key (hostname `overseer-recs`, override with `TS_HOSTNAME`), passing the key through a mode-600 temp file, never argv; and (re)creates the `overseer-recs` Service (`--http-port 8080 --needs tailscaled`, working dir = repo, `node --env-file=/home/sprite/overseer-recs.env dist-server/index.js`). Secrets are never echoed or put in service arguments. `TS_AUTHKEY` is only needed the first time; `TAILSCALE_AUTHKEY` is accepted as a fallback name. On re-runs, any secret you do not export is reused from the env file.

Check and update:

```sh
sprite -o while-true-ltd exec -- sprite-env services list
sprite -o while-true-ltd exec -- tail -n 100 /.sprite/logs/services/overseer-recs.log
sprite -o while-true-ltd exec -- tail -n 100 /.sprite/logs/services/tailscaled.log

# update: re-run the script (pull, build, recreate services)
sprite -o while-true-ltd console
bash /home/sprite/sprite-setup.sh             # (inside the Sprite) secrets come from the env file
# after changing the script itself, push it again first:
sprite -o while-true-ltd file push -p deploy/sprite-setup.sh /home/sprite/sprite-setup.sh
# if kernel Tailscale fails to start, re-run inside the Sprite with: TS_USERSPACE=1 bash /home/sprite/sprite-setup.sh
```

### Tailscale

Create a **reusable, pre-authorized, tagged, NON-ephemeral** auth key (e.g. `tag:overseer-recs`). Do not use an ephemeral key: ephemeral nodes can be reaped by Tailscale while the Sprite sleeps. The node state persists on the Sprite's disk, so the one-time `tailscale up` is all that is needed. Add an ACL rule letting that tag reach only your Overseerr host and port. Do **not** apply a Sprite network-policy domain allowlist: reaching a private tailnet needs unrestricted outbound UDP (WireGuard/DERP/direct paths), which domain policies block.

Kernel Tailscale is the default: Sprites provide `/dev/net/tun` and `CAP_NET_ADMIN`, and allow UDP when no network policy is set. The app still reaches Overseerr through tailscaled's loopback HTTP proxy (`127.0.0.1:1055`; tailscaled is started with both `--outbound-http-proxy-listen` and `--socks5-server` on it), so no HTTPS, CORS or Caddy is needed. If kernel mode fails, re-run the script with `TS_USERSPACE=1` (adds `--tun=userspace-networking`).

**Overseerr address:** MagicDNS names may not resolve on a Sprite because `/etc/resolv.conf` can be read-only. Prefer the Tailscale IP, e.g. `OVERSEERR_URL=http://100.x.y.z:5055`. Use the Overseerr machine's short MagicDNS hostname only after confirming `getent hosts <name>` works inside the Sprite; the full `*.ts.net` name may resolve to public DNS incorrectly.

### Behaviour and cost notes

- The env file and Tailscale state persist on the Sprite's disk. Services are restarted when the Sprite wakes from cold; `tailscaled` starts first (`--needs`).
- Logins live in memory: a restart or cold wake signs everyone out (you just log in again). Skips stay in each browser's `localStorage`.
- Pricing (from fly.io/sprites): you pay for compute only while the Sprite is awake, plus storage. A light web workload at ~30 awake hours/month is about **$1.05/month** — an example, not a guarantee. RAM dominates the compute cost. Bandwidth is not currently metered.
- The public URL is reachable by anyone, but every page, asset and API route (except the login form and `/healthz`) needs the `APP_PASSWORD` session.

## Legacy: GitHub Pages (HTTPS + CORS)

This section applies only to the static, no-backend mode. The page is served over HTTPS from `kslat3r.github.io`, so:

- **Mixed content:** browsers block `http://` servers (other than localhost) from an `https://` page. Your server must be reachable via an `https://` URL.
- **CORS:** Overseerr and Jellyseerr do **not** send CORS headers themselves, so a direct browser call from another origin is blocked. You need a reverse proxy that adds them and answers the `OPTIONS` preflight (the `X-Api-Key` header forces one).

A simple setup is Caddy in front of Overseerr, exposed over HTTPS inside your tailnet with `tailscale serve`. Assuming Overseerr listens on `127.0.0.1:5055`:

### `Caddyfile`

```caddyfile
{
	auto_https off
}

# Plain HTTP on loopback only; Tailscale terminates TLS in front of it.
http://127.0.0.1:8080 {
	bind 127.0.0.1

	@preflight method OPTIONS
	handle @preflight {
		header Access-Control-Allow-Origin "https://kslat3r.github.io"
		header Access-Control-Allow-Methods "GET, POST, OPTIONS"
		header Access-Control-Allow-Headers "X-Api-Key, Content-Type, Accept"
		header Access-Control-Max-Age "86400"
		header Vary "Origin"
		respond 204
	}

	handle {
		header Access-Control-Allow-Origin "https://kslat3r.github.io"
		header Vary "Origin"
		reverse_proxy 127.0.0.1:5055
	}
}
```

Run it with `caddy run --config ./Caddyfile` (or `caddy reload` if it is already running as a service).

### Expose it with Tailscale

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```

Use the printed `https://<machine>.<tailnet>.ts.net` address as the **Server URL** in Settings. Only devices on your tailnet can reach it (this is `serve`, not `funnel`). Do not enter a trailing `/api/v1`; it is stripped if pasted.

Quick check from a tailnet device:

```sh
curl -i -X OPTIONS https://<machine>.<tailnet>.ts.net/api/v1/auth/me \
  -H 'Origin: https://kslat3r.github.io' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-api-key'
```

You should see `204` and the `Access-Control-Allow-*` headers.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| Browser blocks http:// from this https:// page | Mixed content. Use the HTTPS proxy URL. |
| Server reachable, but the browser blocked the response (CORS) | The proxy is missing the CORS headers/`OPTIONS` handling above, or the origin does not match exactly. |
| Could not reach the server | Wrong URL, server down, device not on the tailnet, or untrusted certificate. |
| The API key was rejected | Re-copy it from Settings > General. |
| Couldn't request … | 403 = missing request permission or quota; 409 = already requested; 5xx = see Overseerr logs. |

## Development

```sh
pnpm install
pnpm dev       # local dev server
pnpm test      # vitest, against a mocked API (src/mock/mockApi.ts)
pnpm build     # typecheck + production build into dist/
```

### Browser smoke tests

Playwright tests (mobile viewport, `e2e/`) run against the **production build**, not the dev server:

```sh
pnpm exec playwright install chromium   # first time only
pnpm build
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist &
pnpm test:e2e                           # E2E_BASE_URL overrides http://127.0.0.1:4173
```

Server-mode E2E (login gate, deck via the proxy, no key in the browser, logout) starts the built server against `e2e/fake-overseerr.mjs` with throwaway values:

```sh
pnpm build && pnpm test:e2e:server
```

The static tests cover setup overflow, the demo deck, skip (and its persistence), request via key/button, drag-to-skip and the settings dialog. A mobile deck screenshot is written to `/workspace/overseer-deck.png` (override with `E2E_SCREENSHOT`).

## Deployment (static GitHub Pages)

For the Sprite, see [Deploy on a Fly Sprite](#deploy-on-a-fly-sprite). The legacy static site is served from the `gh-pages` branch, which contains only the contents of `dist/` (`.nojekyll` included). `main` holds the source. To publish, run `pnpm build` and push the contents of `dist/` to `gh-pages`; any other static host works the same way. No workflow files are included.

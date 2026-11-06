# Overseer Recommendations

A swipe-style recommendation deck for **Overseerr** and **Jellyseerr**. It is a browser-only static SPA (Vite + TypeScript, no runtime dependencies): there is no app backend, no analytics and no secrets in the code. Your server URL and API key live in this browser's `localStorage` and are only ever sent to the server you configure.

Published at <https://kslat3r.github.io/overseer-recommendations/> (GitHub Pages, project site, `.nojekyll` included). The build uses a relative base, so it works from any sub-path.

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

## Connecting: HTTPS + CORS (required)

The page is served over HTTPS from `kslat3r.github.io`, so:

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

`dist/` is a plain static folder; publish it to the `gh-pages` branch or any static host. No workflow files are included.

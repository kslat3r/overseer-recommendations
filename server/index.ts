import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createUpstreamFetch } from './proxiedFetch.js';

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : 'Invalid configuration.');
  process.exit(1);
}

// Only Overseerr calls go through the tailnet proxy; set TAILSCALE_PROXY="" to connect directly.
const proxy = process.env.TAILSCALE_PROXY ?? 'http://127.0.0.1:1055';
const app = createApp({ config, fetchImpl: createUpstreamFetch(proxy || undefined) });

const server = app.listen(config.port, '0.0.0.0', () => {
  const addr = server.address();
  console.log(`overseer-recs listening on port ${typeof addr === 'object' && addr ? addr.port : config.port}`);
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));

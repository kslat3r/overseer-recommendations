// Starts the built Node server (dist-server/) against the fake Overseerr, for server-mode E2E.
//   pnpm build && node e2e/start-server-mode.mjs   # app on :4175, password "e2e-test-password"
// Uses throwaway values only; direct connections (no Tailscale proxy).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const children = [
  spawn(process.execPath, [here('./fake-overseerr.mjs'), '5056'], { stdio: 'inherit' }),
  spawn(process.execPath, [here('../dist-server/index.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      OVERSEERR_URL: 'http://127.0.0.1:5056',
      OVERSEERR_API_KEY: 'e2e-key',
      APP_PASSWORD: 'e2e-test-password',
      PORT: '4175',
      TAILSCALE_PROXY: '',
    },
  }),
];
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', stop));

// Runs the server-mode Playwright spec end to end: fake Overseerr + built Node server + browser.
//   pnpm build && pnpm test:e2e:server
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const stack = spawn(process.execPath, [here('./start-server-mode.mjs')], { stdio: 'inherit' });

const base = 'http://127.0.0.1:4175';
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const pw = spawn('pnpm', ['exec', 'playwright', 'test', 'e2e/server.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_SERVER_URL: base, E2E_SERVER_PASSWORD: 'e2e-test-password' },
});
pw.on('exit', (code) => {
  stack.kill();
  process.exit(code ?? 1);
});

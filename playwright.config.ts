import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against the production build (`pnpm build`) served statically,
// e.g. `python3 -m http.server 4173 --bind 127.0.0.1 --directory dist`.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
});

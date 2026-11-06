import { expect, test } from '@playwright/test';

// Server-mode E2E. Needs the Node server running against e2e/fake-overseerr.mjs (see README):
//   E2E_SERVER_URL=http://127.0.0.1:4174 E2E_SERVER_PASSWORD=... pnpm test:e2e e2e/server.spec.ts
const url = process.env.E2E_SERVER_URL;
const password = process.env.E2E_SERVER_PASSWORD ?? '';

test.describe('server mode', () => {
  test.skip(!url, 'set E2E_SERVER_URL to run server-mode tests');
  test.use({ baseURL: url });

  test('login gate, deck from server-side key, no key in browser, logout', async ({ page, context }) => {
    await page.goto('./');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect password')).toBeVisible();

    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.card[data-top="1"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#count')).toHaveCount(0);
    await expect(page.locator('.card[data-top="1"] .why')).toContainText('Because you have: Fake Library Movie');
    const cache = await page.evaluate(() => localStorage.getItem('overseer-recs:deck'));
    expect(cache).not.toContain('e2e-key');

    const cookie = (await context.cookies()).find((c) => c.name === 'overseer_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');

    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored).not.toContain('e2e-key');
    expect(await page.content()).not.toContain('e2e-key');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText(/configured on the server/)).toBeVisible();
    await expect(page.locator('#f-url')).toHaveCount(0);
    await expect(page.locator('#f-key')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('overseer-recs:deck'))).toBeNull();
    await page.goto('./');
    await expect(page).toHaveURL(/\/login$/);
  });
});

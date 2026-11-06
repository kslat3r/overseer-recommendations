import { expect, test, type Page } from '@playwright/test';

const SKIPPED_KEY = 'overseer-recs:skipped';
const DECK_KEY = 'overseer-recs:deck';

const topCard = (page: Page) => page.locator('.card[data-top="1"]');
const topTitle = (page: Page) => topCard(page).getByRole('heading', { level: 2 });

async function openDemoDeck(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
}

/** Pointer drag across the top card: dir -1 = left (skip), 1 = right (request). */
async function swipe(page: Page, dir: 1 | -1) {
  const box = (await topCard(page).boundingBox())!;
  const y = box.y + box.height * 0.4;
  const from = dir === 1 ? 0.3 : 0.7;
  const to = dir === 1 ? 0.9 : 0.1;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from + to) / 2), y, { steps: 6 });
  await page.mouse.move(box.x + box.width * to, y, { steps: 6 });
  await page.mouse.up();
}

test('initial setup has no horizontal overflow', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Find your next watch' })).toBeVisible();
  const { scrollW, clientW } = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(scrollW).toBeLessThanOrEqual(clientW);
});

test('Try the demo loads the deck without bottom controls', async ({ page }) => {
  await openDemoDeck(page);
  await expect(topTitle(page)).not.toBeEmpty();
  expect(await page.locator('.card').count()).toBeGreaterThan(1);
  await expect(page.locator('#count')).toHaveCount(0);
  await expect(page.locator('.controls, #skip-btn, #req-btn')).toHaveCount(0);
  await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? '/workspace/overseer-deck.png' });
});

test('cards say which library titles produced them', async ({ page }) => {
  await openDemoDeck(page);
  await expect(topCard(page).locator('.why')).toHaveText('Because you have: Arrival, Blade Runner, Severance');
});

test('overview is scrollable and the card info stays inside the card', async ({ page }) => {
  await openDemoDeck(page);
  const overview = topCard(page).locator('.overview');
  await expect(overview).not.toBeEmpty();
  await expect(overview).toHaveCSS('overflow-y', 'auto');
  const { card, info } = await page.evaluate(() => {
    const c = document.querySelector('.card[data-top="1"]')!.getBoundingClientRect();
    const i = document.querySelector('.card[data-top="1"] .info')!.getBoundingClientRect();
    return { card: c.height, info: i.height };
  });
  expect(info).toBeLessThanOrEqual(card);
});

test('swipe left skips, persists the skip, and the cached deck omits it on reload', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  await swipe(page, -1);
  await expect(topTitle(page)).not.toHaveText(before);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), SKIPPED_KEY);
  expect(stored).toHaveLength(1);

  await page.reload();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('.card h2').allInnerTexts()).not.toContain(before);
  const cached = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), DECK_KEY);
  expect(cached.deck.some((c: { title: string }) => c.title === before)).toBe(false);
});

test('swipe right requests, advances and stays gone after reload', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  await swipe(page, 1);
  await expect(topTitle(page)).not.toHaveText(before);

  await page.reload();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('.card h2').allInnerTexts()).not.toContain(before);
});

test('arrow keys skip and request', async ({ page }) => {
  await openDemoDeck(page);
  const first = await topTitle(page).innerText();
  await page.keyboard.press('ArrowLeft');
  await expect(topTitle(page)).not.toHaveText(first);
  const second = await topTitle(page).innerText();
  await page.keyboard.press('ArrowRight');
  await expect(topTitle(page)).not.toHaveText(second);
});

test('refresh bypasses the cache, rebuilds and rewrites it without secrets', async ({ page }) => {
  await openDemoDeck(page);
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ savedAt: Date.now(), deck: [] })), DECK_KEY);
  await page.getByRole('button', { name: 'Refresh recommendations' }).click();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
  const cached = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), DECK_KEY);
  expect(cached.deck.length).toBeGreaterThan(1);
  expect(JSON.stringify(cached)).not.toMatch(/demo-key|apiKey/);
});

test('settings modal opens and closes', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Server URL')).toBeFocused();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

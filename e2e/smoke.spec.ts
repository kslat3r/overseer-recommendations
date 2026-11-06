import { expect, test, type Page } from '@playwright/test';

const SKIPPED_KEY = 'overseer-recs:skipped';

const topCard = (page: Page) => page.locator('.card[data-top="1"]');
const topTitle = (page: Page) => topCard(page).getByRole('heading', { level: 2 });
const leftCount = async (page: Page) => Number((await page.locator('#count').innerText()).match(/\d+/)![0]);

async function openDemoDeck(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#count')).toContainText('left');
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

test('Try the demo loads the recommendation deck', async ({ page }) => {
  await openDemoDeck(page);
  await expect(topTitle(page)).not.toBeEmpty();
  expect(await leftCount(page)).toBeGreaterThan(1);
  await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? '/workspace/overseer-deck.png' });
});

test('skip button advances and persists the skip', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  const n = await leftCount(page);
  await page.getByRole('button', { name: /^Skip/ }).click();
  await expect(page.locator('#count')).toHaveText(`${n - 1} left`);
  await expect(topTitle(page)).not.toHaveText(before);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), SKIPPED_KEY);
  expect(stored).toHaveLength(1);

  await page.reload();
  await expect(topCard(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#count')).toHaveText(`${n - 1} left`);
  const titles = await page.locator('.card h2').allInnerTexts();
  expect(titles).not.toContain(before);
});

test('right arrow requests, advances and shows a success toast', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  const n = await leftCount(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.toast.ok')).toContainText(`Requested ${before}`);
  await expect(page.locator('#count')).toHaveText(`${n - 1} left`);
  await expect(topTitle(page)).not.toHaveText(before);
});

test('request button advances with a success toast', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  await page.getByRole('button', { name: /^Request/ }).click();
  await expect(page.locator('.toast.ok')).toContainText(`Requested ${before}`);
  await expect(topTitle(page)).not.toHaveText(before);
});

test('pointer drag left skips the card', async ({ page }) => {
  await openDemoDeck(page);
  const before = await topTitle(page).innerText();
  const n = await leftCount(page);
  const box = (await topCard(page).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.7, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.1, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#count')).toHaveText(`${n - 1} left`);
  await expect(topTitle(page)).not.toHaveText(before);
  await expect(page.locator('.toast.info')).toContainText(`Skipped ${before}`);
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

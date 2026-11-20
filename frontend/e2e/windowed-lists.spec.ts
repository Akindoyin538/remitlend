import { test, expect } from "@playwright/test";
import { injectAxe, checkA11y } from "axe-playwright";

/**
 * Windowed list a11y + scroll restoration (#791).
 * Requires the app running with mock data (1,000 loans); skipped otherwise.
 */
const LIST = '[role="list"][aria-label]';

test.describe("windowed loan list", () => {
  test("exposes aria-setsize/posinset, renders a small window and has no axe violations", async ({
    page,
  }) => {
    await page.goto("/en/loans");
    const list = page.locator(LIST).first();
    test.skip(!(await list.isVisible().catch(() => false)), "no list rendered (no mock data)");

    const items = list.locator('[role="listitem"]');
    const count = await items.count();
    expect(count).toBeLessThan(60);
    const first = items.first();
    await expect(first).toHaveAttribute("aria-posinset", "1");
    expect(Number(await first.getAttribute("aria-setsize"))).toBeGreaterThanOrEqual(count);

    await injectAxe(page);
    await checkA11y(page, LIST, {
      axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
    });
  });

  test("restores scroll position when navigating back from a detail page", async ({ page }) => {
    await page.goto("/en/loans");
    const list = page.locator(LIST).first();
    test.skip(!(await list.isVisible().catch(() => false)), "no list rendered (no mock data)");

    await list.evaluate((el) => {
      el.scrollTop = 1200;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.locator('a[href*="/loans/"]').first().click();
    await page.goBack();

    const restored = await page.locator(LIST).first().evaluate((el) => el.scrollTop);
    expect(restored).toBeGreaterThan(0);
  });
});

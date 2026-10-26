import { expect, test, type Page } from "@playwright/test";

/**
 * iPhone Duo / foldable layout smoke tests. Viewports are the Duo's CSS sizes
 * (outer 466×678, inner 890×626, Split View ~445 wide). Book posture is
 * emulated with Chromium's Device Posture override (the game then assumes the
 * Duo's centered hinge); tabletop stubs the Viewport Segments API.
 */

type Box = { x: number; y: number; width: number; height: number };

async function canvases(page: Page): Promise<Box[]> {
  return page.locator("canvas").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

async function foldBook(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDevicePostureOverride", { posture: { type: "folded" } });
}

async function openPlay(page: Page): Promise<void> {
  await page.goto("/play");
  await expect(page.locator("canvas").first()).toBeVisible();
}

test.describe("outer screen (466×678)", () => {
  test.use({ viewport: { width: 466, height: 678 } });

  test("one full-width highway, no two-player option", async ({ page }) => {
    await openPlay(page);
    const [canvas] = await canvases(page);
    expect(canvas?.width).toBe(466);
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "2 players" })).toHaveCount(0);
  });

  test("unfolding mid-song pauses with the screen-change message", async ({ page }) => {
    await openPlay(page);
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 6000 });
    await page.setViewportSize({ width: 890, height: 626 });
    await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible();
    await expect(page.getByText(/screen changed shape/)).toBeVisible();
  });
});

test.describe("inner screen open flat (890×626)", () => {
  test.use({ viewport: { width: 890, height: 626 } });

  test("two players get one highway each", async ({ page }) => {
    await openPlay(page);
    await page.getByRole("button", { name: "2 players" }).click();
    const boxes = await canvases(page);
    expect(boxes.map((b) => [b.x, b.width])).toEqual([
      [0, 445],
      [445, 445],
    ]);
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("Get ready…")).toBeVisible();
  });

  test("two players can go back to one", async ({ page }) => {
    await openPlay(page);
    await page.getByRole("button", { name: "2 players" }).click();
    await page.getByRole("button", { name: "1 player" }).click();
    await expect(page.getByRole("heading", { name: "Ready?" })).toBeVisible();
    expect(await canvases(page)).toHaveLength(1);
  });

  test("the ready card fits the short screen with Start in view", async ({ page }) => {
    await openPlay(page);
    await expect(page.getByRole("button", { name: "Start" })).toBeInViewport();
  });
});

test.describe("book posture (half-folded, vertical hinge)", () => {
  test.use({ viewport: { width: 890, height: 626 } });

  test("highway stays on one side of the hinge and can swap", async ({ page }) => {
    await foldBook(page);
    await openPlay(page);
    await expect.poll(async () => (await canvases(page))[0]?.x).toBe(445);
    expect((await canvases(page))[0]?.width).toBe(445);
    await page.getByRole("button", { name: "⇄ Swap sides" }).click({ force: true });
    await expect.poll(async () => (await canvases(page))[0]?.x).toBe(0);
  });
});

test.describe("tabletop posture (horizontal hinge)", () => {
  test.use({ viewport: { width: 626, height: 890 } });

  test("highway on the upright half, fret pads on the flat half", async ({ page }) => {
    await page.addInitScript(() => {
      const segs = [new DOMRect(0, 0, 626, 445), new DOMRect(0, 445, 626, 445)];
      Object.defineProperty(window, "viewport", { value: { segments: segs } });
    });
    await foldBook(page);
    await openPlay(page);
    const pads = page.getByRole("group", { name: /Fret pads/ });
    await expect(pads).toBeVisible();
    const padBox = await pads.boundingBox();
    const [canvas] = await canvases(page);
    expect(canvas && canvas.y + canvas.height).toBeLessThanOrEqual(446);
    expect(padBox?.y).toBeGreaterThanOrEqual(445);
  });
});

test.describe("Split View (~445×626)", () => {
  test.use({ viewport: { width: 445, height: 626 } });

  test("plays as a narrow single screen even when folded", async ({ page }) => {
    await foldBook(page);
    await openPlay(page);
    const boxes = await canvases(page);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.width).toBe(445);
    await expect(page.getByRole("button", { name: "2 players" })).toHaveCount(0);
  });
});

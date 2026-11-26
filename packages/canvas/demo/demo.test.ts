import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

/**
 * The basics of the canvas in a real browser, on the demo page: what the
 * view math tests can't see. One server, one page, kept quick.
 */

type View = { x: number; y: number; scale: number };

let server: ViteDevServer;
let browser: Browser;
let page: Page;

before(async () => {
  server = await createServer({ root: new URL(".", import.meta.url).pathname, logLevel: "silent", server: { port: 0 } });
  await server.listen();
  const port = (server.httpServer?.address() as AddressInfo).port;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => assert.fail(error));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector(".card");
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const view = () => page.evaluate(() => (window as unknown as { canvas: { view(): View } }).canvas.view());
const viewportSize = () => page.evaluate(() => {
  const viewport = document.querySelector("#viewport") as HTMLElement;
  return { width: viewport.clientWidth, height: viewport.clientHeight };
});
/** The demo's drawing is 2400 × 1600, fitted with 16px around it, never past 1. */
const fitted = (size: { width: number; height: number }): View => {
  const scale = Math.min(1, (size.width - 32) / 2400, (size.height - 32) / 1600);
  return { x: (size.width - 2400 * scale) / 2, y: (size.height - 1600 * scale) / 2, scale };
};
const assertNear = (actual: View, expected: View) => {
  assert.ok(Math.abs(actual.x - expected.x) < 0.5 && Math.abs(actual.y - expected.y) < 0.5 && Math.abs(actual.scale - expected.scale) < 0.001, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
};

test("fitted at first, and fitted again when the viewport changes size", async () => {
  assertNear(await view(), fitted(await viewportSize()));
  await page.evaluate(() => ((document.querySelector("#viewport") as HTMLElement).style.height = "300px"));
  await page.waitForFunction(() => (document.querySelector("#viewport") as HTMLElement).clientHeight === 300);
  // The observer runs before the next frame.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assertNear(await view(), fitted(await viewportSize()));
});

test("a click on a link goes through; a drag from it moves the view and clicks nothing", async () => {
  const card = await page.locator(".card", { hasText: /^Card 14$/ }).boundingBox();
  assert.ok(card !== null);
  // Its middle: fitted small, a card is only some pixels high.
  const middle = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  await page.mouse.click(middle.x, middle.y);
  assert.match((await page.locator("#log").textContent()) ?? "", /^clicked Card 14\n$/);

  const start = await view();
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 100, middle.y + 60, { steps: 4 });
  await page.mouse.up();
  assertNear(await view(), { x: start.x + 100, y: start.y + 60, scale: start.scale });
  assert.match((await page.locator("#log").textContent()) ?? "", /^clicked Card 14\n$/);
});

test("a link focused out of sight is moved into it, and zooming still turns around the pointer", async () => {
  await page.evaluate(() => (window as unknown as { canvas: { setView(view: View): void } }).canvas.setView({ x: 0, y: 0, scale: 1 }));
  // As Tab does: the browser scrolls the viewport to show it.
  await page.locator(".card", { hasText: /^Card 140$/ }).focus();
  await page.waitForFunction(() => {
    const viewport = document.querySelector("#viewport") as HTMLElement;
    return viewport.scrollLeft === 0 && viewport.scrollTop === 0;
  }, undefined, { timeout: 2000 });
  const box = await page.locator("#viewport").boundingBox();
  const card = await page.locator(".card", { hasText: /^Card 140$/ }).boundingBox();
  assert.ok(box !== null && card !== null);
  assert.ok(card.x >= box.x && card.y >= box.y && card.x + card.width <= box.x + box.width && card.y + card.height <= box.y + box.height, "Card 140 is in sight");

  const pointer = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  const under = () => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".card")?.textContent, pointer);
  assert.equal(await under(), "Card 140");
  const before = await view();
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForFunction((scale) => (window as unknown as { canvas: { view(): View } }).canvas.view().scale !== scale, before.scale);
  assert.equal(await under(), "Card 140");
});

test("the wheel moves; ctrl + wheel zooms around the pointer", async () => {
  const box = await page.locator("#viewport").boundingBox();
  assert.ok(box !== null);
  const pointer = { x: 300, y: 150 };
  await page.mouse.move(box.x + pointer.x, box.y + pointer.y);

  const start = await view();
  await page.mouse.wheel(40, 80);
  await page.waitForFunction((y) => (window as unknown as { canvas: { view(): View } }).canvas.view().y !== y, start.y);
  assertNear(await view(), { x: start.x - 40, y: start.y - 80, scale: start.scale });

  const moved = await view();
  const under = { x: (pointer.x - moved.x) / moved.scale, y: (pointer.y - moved.y) / moved.scale };
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -50);
  await page.keyboard.up("Control");
  await page.waitForFunction((scale) => (window as unknown as { canvas: { view(): View } }).canvas.view().scale !== scale, moved.scale);
  const zoomed = await view();
  assert.ok(zoomed.scale > moved.scale);
  assertNear({ x: (pointer.x - zoomed.x) / zoomed.scale, y: (pointer.y - zoomed.y) / zoomed.scale, scale: 1 }, { ...under, scale: 1 });
});

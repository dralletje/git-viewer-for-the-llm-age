import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

/**
 * The basics of <Canvas> in real browsers, on the demo page: what the view
 * math tests can't see. Chromium runs here; Firefox and WebKit run in
 * Playwright's own Docker image (their system libraries aren't on every
 * machine), reached through a Playwright server in it. The three run at
 * the same time.
 */

type View = { x: number; y: number; scale: number };
type Size = { width: number; height: number };

const image = "mcr.microsoft.com/playwright:v1.65.1-noble";
let server: ViteDevServer;
let url: string;
let container: ChildProcess | null = null;
const containerName = `canvas-component-test-${process.pid}`;
let containerEndpoint: Promise<string>;

before(async () => {
  // The Playwright server in Docker runs this machine's playwright-core, so
  // client and server are the same version.
  const playwrightEntry = createRequire(import.meta.url).resolve("playwright");
  const core = dirname(createRequire(playwrightEntry).resolve("playwright-core/package.json"));
  const started = spawn("docker", ["run", "--rm", "--init", "--name", containerName, "-p", "127.0.0.1::3000", "-v", `${core}:/pw:ro`, image, "node", "/pw/cli.js", "run-server", "--port", "3000", "--host", "0.0.0.0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  container = started;
  containerEndpoint = new Promise<string>((resolve, reject) => {
    started.on("exit", (code) => reject(new Error(`The Playwright container stopped (${code}). Is Docker running, and the image ${image} pulled?`)));
    started.stdout?.on("data", (chunk: Buffer) => {
      if (!chunk.toString().includes("Listening")) return;
      promisify(execFile)("docker", ["port", containerName, "3000"]).then(({ stdout }) => resolve(`ws://${stdout.trim().split("\n")[0]}/`), reject);
    });
  });
  // Keeps an early failure from being unhandled before a browser waits for it.
  containerEndpoint.catch(() => {});

  server = await createServer({ root: new URL(".", import.meta.url).pathname, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}/`;
});

after(async () => {
  if (container !== null) {
    await promisify(execFile)("docker", ["rm", "--force", containerName]).catch(() => {});
  }
  await server?.close();
});

const browsers: Array<{ name: string; open: () => Promise<Browser> }> = [
  { name: "chromium", open: () => chromium.launch() },
  // `exposeNetwork`: the browser in Docker reaches this machine's 127.0.0.1.
  { name: "firefox", open: async () => firefox.connect(await containerEndpoint, { exposeNetwork: "<loopback>" }) },
  { name: "webkit", open: async () => webkit.connect(await containerEndpoint, { exposeNetwork: "<loopback>" }) },
];

describe("<Canvas> in every browser", { concurrency: true }, () => {
  for (const { name, open } of browsers) {
    // The browsers side by side, but one page's tests one after another: they share it.
    describe(name, { concurrency: 1 }, () => {
      let browser: Browser;
      let page: Page;
      const errors: Array<string> = [];

      before(async () => {
        browser = await open();
        page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(url);
        await page.waitForSelector(".card");
      });
      after(async () => {
        await browser?.close();
      });

      const view = () => page.evaluate(() => (window as unknown as { canvas: { current: { view(): View } } }).canvas.current.view());
      const viewChanged = (from: View) =>
        page.waitForFunction((before) => {
          const now = (window as unknown as { canvas: { current: { view(): View } } }).canvas.current.view();
          return now.x !== before.x || now.y !== before.y || now.scale !== before.scale;
        }, from, { timeout: 2000 });
      const sizes = () =>
        page.evaluate(() => {
          const viewport = document.querySelector(".viewport") as HTMLElement;
          const drawing = document.querySelector(".drawing") as HTMLElement;
          return { viewport: { width: viewport.clientWidth, height: viewport.clientHeight }, drawing: { width: drawing.offsetWidth, height: drawing.offsetHeight } };
        });
      /** The demo fits with 16px around it, never larger than drawn. */
      const fitted = (viewport: Size, drawing: Size): View => {
        const scale = Math.min(1, (viewport.width - 32) / drawing.width, (viewport.height - 32) / drawing.height);
        return { x: (viewport.width - drawing.width * scale) / 2, y: (viewport.height - drawing.height * scale) / 2, scale };
      };
      const assertNear = (actual: View, expected: View) => {
        assert.ok(Math.abs(actual.x - expected.x) < 0.5 && Math.abs(actual.y - expected.y) < 0.5 && Math.abs(actual.scale - expected.scale) < 0.001, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
      };
      const assertFitted = async () => {
        const { viewport, drawing } = await sizes();
        assertNear(await view(), fitted(viewport, drawing));
      };
      /** Which point of the drawing is under a point of the page: from where the browser drew it. */
      const drawingPointAt = (clientX: number, clientY: number) =>
        page.evaluate(
          ({ x, y }) => {
            const drawing = (document.querySelector(".drawing") as HTMLElement).getBoundingClientRect();
            const scale = drawing.width / (document.querySelector(".drawing") as HTMLElement).offsetWidth;
            return { x: (x - drawing.left) / scale, y: (y - drawing.top) / scale };
          },
          { x: clientX, y: clientY },
        );
      const logText = async () => (await page.getByTestId("log").textContent()) ?? "";

      test("fitted at first, and fitted again when the viewport or the drawing changes size", async () => {
        await assertFitted();
        let before = await view();
        await page.locator('input[type="range"]').nth(1).fill("300");
        await viewChanged(before);
        await assertFitted();
        before = await view();
        await page.getByRole("button", { name: "Wider drawing" }).click();
        await viewChanged(before);
        await assertFitted();
        before = await view();
        await page.getByRole("button", { name: "Narrower drawing" }).click();
        await viewChanged(before);
        await assertFitted();
      });

      test("a click on a link goes through; a drag from it moves the view and clicks nothing", async () => {
        const card = await page.locator(".card", { hasText: /^Card 14$/ }).boundingBox();
        assert.ok(card !== null);
        // Its middle: fitted small, a card is only some pixels high.
        const middle = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
        await page.mouse.click(middle.x, middle.y);
        assert.equal(await logText(), "clicked Card 14");

        const start = await view();
        await page.mouse.move(middle.x, middle.y);
        await page.mouse.down();
        await page.mouse.move(middle.x + 100, middle.y + 60, { steps: 4 });
        await page.mouse.up();
        assertNear(await view(), { x: start.x + 100, y: start.y + 60, scale: start.scale });
        assert.equal(await logText(), "clicked Card 14");
        assert.match((await page.getByTestId("view").textContent()) ?? "", /by user$/);
      });

      test("the wheel moves; ctrl + wheel zooms around the pointer, inside the border", async () => {
        const box = await page.locator(".viewport").boundingBox();
        assert.ok(box !== null);
        const pointer = { x: box.x + 300, y: box.y + 150 };
        await page.mouse.move(pointer.x, pointer.y);

        const start = await view();
        await page.mouse.wheel(40, 80);
        await viewChanged(start);
        const moved = await view();
        // Pixels or lines (Firefox): the same way, in the same proportion.
        assert.ok(moved.x < start.x && moved.y < start.y && Math.abs((start.x - moved.x) * 2 - (start.y - moved.y)) < 1, `${JSON.stringify(start)} to ${JSON.stringify(moved)}`);
        assert.equal(moved.scale, start.scale);

        const under = await drawingPointAt(pointer.x, pointer.y);
        const handleSays = await page.evaluate(({ x, y }) => (window as unknown as { canvas: { current: { toContent(x: number, y: number): { x: number; y: number } } } }).canvas.current.toContent(x, y), pointer);
        assert.ok(Math.abs(handleSays.x - under.x) < 0.5 && Math.abs(handleSays.y - under.y) < 0.5, `toContent says ${JSON.stringify(handleSays)}, the page ${JSON.stringify(under)}`);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -50);
        await page.keyboard.up("Control");
        await viewChanged(moved);
        const zoomed = await view();
        assert.ok(zoomed.scale > moved.scale);
        const underAfter = await drawingPointAt(pointer.x, pointer.y);
        assert.ok(Math.abs(underAfter.x - under.x) < 0.5 && Math.abs(underAfter.y - under.y) < 0.5, `${JSON.stringify(under)} moved to ${JSON.stringify(underAfter)}`);
      });

      test("a link focused out of sight is moved into it, and zooming still turns around the pointer", async () => {
        await page.evaluate(() => (window as unknown as { canvas: { current: { setView(view: View): void } } }).canvas.current.setView({ x: 0, y: 0, scale: 1 }));
        // As Tab does: the browser scrolls the viewport to show it.
        await page.locator(".card", { hasText: /^Card 140$/ }).focus();
        await page.waitForFunction(
          () => {
            const viewport = document.querySelector(".viewport") as HTMLElement;
            return viewport.scrollLeft === 0 && viewport.scrollTop === 0 && (window as unknown as { canvas: { current: { view(): View } } }).canvas.current.view().x !== 0;
          },
          undefined,
          { timeout: 2000 },
        );
        const box = await page.locator(".viewport").boundingBox();
        const card = await page.locator(".card", { hasText: /^Card 140$/ }).boundingBox();
        assert.ok(box !== null && card !== null);
        assert.ok(card.x >= box.x && card.y >= box.y && card.x + card.width <= box.x + box.width && card.y + card.height <= box.y + box.height, "Card 140 is in sight");

        const pointer = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
        const under = await drawingPointAt(pointer.x, pointer.y);
        const before = await view();
        await page.mouse.move(pointer.x, pointer.y);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -100);
        await page.keyboard.up("Control");
        await viewChanged(before);
        const underAfter = await drawingPointAt(pointer.x, pointer.y);
        assert.ok(Math.abs(underAfter.x - under.x) < 0.5 && Math.abs(underAfter.y - under.y) < 0.5, `${JSON.stringify(under)} moved to ${JSON.stringify(underAfter)}`);
      });

      test("with focus, arrows move, + zooms and 0 fits", async () => {
        await page.locator(".viewport").focus();
        const start = await view();
        await page.keyboard.press("ArrowRight");
        assertNear(await view(), { ...start, x: start.x - 40 });
        await page.keyboard.press("ArrowDown");
        assertNear(await view(), { ...start, x: start.x - 40, y: start.y - 40 });
        const moved = await view();
        await page.keyboard.press("+");
        await page.waitForFunction((scale) => Math.abs((window as unknown as { canvas: { current: { view(): View } } }).canvas.current.view().scale - scale) < 0.0001, Math.min(3, moved.scale * 1.25));
        await page.keyboard.press("0");
        await page.waitForTimeout(250);
        await assertFitted();
      });

      test("no errors on the page", () => {
        assert.deepEqual(errors, []);
      });
    });
  }
});

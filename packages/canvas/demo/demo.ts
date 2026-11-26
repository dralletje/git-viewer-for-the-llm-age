import { attachCanvas } from "#/canvas.ts";

/**
 * A page to try the canvas by hand: a large drawing of cards (each a
 * link), and buttons for what the app does with it. Every behaviour has
 * something here to see it by:
 * - drag, wheel, ctrl + wheel / pinch: move and zoom; the view is shown below;
 * - a card clicked without dragging is logged, a drag never clicks one;
 * - Fit, then the width and height sliders: it stays fitted until moved,
 *   and after a move the middle stays in the middle;
 * - "Fit while hidden": fitted once it shows again;
 * - "Show 5 cards in a row": ends on the last card, not short of it.
 */

const viewport = document.querySelector<HTMLDivElement>("#viewport");
const content = document.querySelector<HTMLDivElement>("#content");
const viewText = document.querySelector<HTMLSpanElement>("#view");
const log = document.querySelector<HTMLPreElement>("#log");
if (viewport === null || content === null || viewText === null || log === null) throw new Error("The demo page is missing an element");

const say = (line: string) => {
  log.textContent = `${line}\n${log.textContent ?? ""}`;
};

// 12 × 12 cards over the drawing, numbered row by row.
const cards: Array<{ element: HTMLAnchorElement; x: number; y: number; width: number; height: number }> = [];
for (let row = 0; row < 12; row++) {
  for (let column = 0; column < 12; column++) {
    const number = row * 12 + column + 1;
    const element = document.createElement("a");
    element.className = "card";
    element.href = `#card-${number}`;
    element.textContent = `Card ${number}`;
    const x = column * 200 + 20;
    const y = row * 133 + 20;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    content.append(element);
    cards.push({ element, x, y, width: 160, height: 90 });
  }
}

const canvas = attachCanvas(viewport, content, {
  size: { width: 2400, height: 1600 },
  minScale: 0.05,
  maxScale: 3,
  onChange: (view) => {
    viewText.textContent = `x ${view.x.toFixed(1)}, y ${view.y.toFixed(1)}, scale ${view.scale.toFixed(3)}`;
  },
});
canvas.fit({ maxScale: 1 });

// For poking at it from the console, and for scripts driving the page.
(window as unknown as { canvas: typeof canvas }).canvas = canvas;

// A card's link: logged instead of followed, so the page stays put.
content.addEventListener("click", (event) => {
  const card = event.target instanceof Element ? event.target.closest("a.card") : null;
  if (card === null) return;
  event.preventDefault();
  say(`clicked ${card.textContent}`);
});

const showCard = (index: number) => {
  const card = cards[index];
  if (card === undefined) return;
  content.querySelectorAll("[data-shown]").forEach((element) => element.removeAttribute("data-shown"));
  card.element.setAttribute("data-shown", "");
  canvas.show({ x: card.x, y: card.y, width: card.width, height: card.height }, { animate: true, margin: 40 });
};

document.querySelector("#fit")?.addEventListener("click", () => canvas.fit({ maxScale: 1, animate: true }));
document.querySelector("#zoom-in")?.addEventListener("click", () => canvas.zoomBy(1.25));
document.querySelector("#zoom-out")?.addEventListener("click", () => canvas.zoomBy(0.8));
document.querySelector("#show-corner")?.addEventListener("click", () => {
  say("show the last card");
  showCard(cards.length - 1);
});
document.querySelector("#show-run")?.addEventListener("click", () => {
  // Five calls inside one animation's time, as reading through the code does.
  const picks = [13, 40, 77, 101, 130];
  say(`show cards ${picks.map((index) => index + 1).join(", ")}, 30ms apart`);
  picks.forEach((index, order) => {
    setTimeout(() => showCard(index), order * 30);
  });
});

const toggle = document.querySelector<HTMLButtonElement>("#toggle-hidden");
const setHidden = (hidden: boolean) => {
  viewport.style.display = hidden ? "none" : "";
  if (toggle !== null) toggle.textContent = hidden ? "Show the viewport" : "Hide the viewport";
};
toggle?.addEventListener("click", () => setHidden(viewport.style.display !== "none"));
document.querySelector("#fit-hidden")?.addEventListener("click", () => {
  setHidden(true);
  // Zoomed in first, so the fit that follows is plain to see.
  canvas.setView({ x: -300, y: -300, scale: 2 });
  canvas.fit({ maxScale: 1 });
  say("fitted while hidden; showing again in 500ms");
  setTimeout(() => setHidden(false), 500);
});

const width = document.querySelector<HTMLInputElement>("#width");
const height = document.querySelector<HTMLInputElement>("#height");
width?.addEventListener("input", () => {
  viewport.style.width = `${width.value}%`;
});
height?.addEventListener("input", () => {
  viewport.style.height = `${height.value}px`;
});

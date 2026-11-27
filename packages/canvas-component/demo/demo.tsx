import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
// The package's entry, as an app gets it: only what it exports.
import { Canvas, type CanvasHandle, type ChangeCause, type View } from "#/index.ts";

/**
 * A page to try the canvas by hand, through what the package exports: a
 * large drawing of cards (each a link), and controls for what an app does
 * with it. Every behaviour has something here to see it by:
 * - drag, wheel, ctrl + wheel / pinch, and keys (Tab to it: arrows, + - 0);
 * - a card clicked without dragging is logged, a drag never clicks one;
 * - Fit, then the sliders or "Wider drawing": it stays fitted until moved,
 *   and after a move the middle stays in the middle;
 * - "Fit while hidden": fitted once it shows again;
 * - "Show 5 cards in a row": ends on the last card, not short of it;
 * - the readout says what moved the view: user, code or layout.
 */

const rows = 12;
const columns = 12;

function Demo() {
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<{ view: View; by: ChangeCause } | null>(null);
  const [log, setLog] = useState<Array<string>>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(480);
  const [wide, setWide] = useState(false);
  const [wheel, setWheel] = useState<"pan" | "zoom">("pan");
  const say = (line: string) => setLog((lines) => [line, ...lines]);

  // For poking at it from the console, and for the tests driving the page.
  (window as unknown as { canvas: typeof canvas }).canvas = canvas;

  const cards: Array<{ number: number; x: number; y: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cards.push({ number: row * columns + column + 1, x: column * (wide ? 300 : 200) + 20, y: row * 133 + 20 });
    }
  }
  const showCard = (number: number) => {
    const card = cards[number - 1];
    if (card === undefined) return;
    setShown(number);
    canvas.current?.show({ x: card.x, y: card.y, width: 160, height: 90 }, { animate: true, margin: 40 });
  };

  return (
    <>
      <div className="controls">
        <button type="button" onClick={() => canvas.current?.fit({ animate: true })}>
          Fit
        </button>
        <button type="button" onClick={() => canvas.current?.zoomBy(1.25)}>
          +
        </button>
        <button type="button" onClick={() => canvas.current?.zoomBy(0.8)}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            say("show the last card");
            showCard(rows * columns);
          }}
        >
          Show the far corner
        </button>
        <button
          type="button"
          onClick={() => {
            // Five calls inside one animation's time, as reading through code does.
            const picks = [14, 41, 78, 102, 131];
            say(`show cards ${picks.join(", ")}, 30ms apart`);
            picks.forEach((number, order) => {
              setTimeout(() => showCard(number), order * 30);
            });
          }}
        >
          Show 5 cards in a row, quickly
        </button>
        <button type="button" onClick={() => setHidden(!hidden)}>
          {hidden ? "Show the viewport" : "Hide the viewport"}
        </button>
        <button
          type="button"
          onClick={() => {
            setHidden(true);
            // Zoomed in first, so the fit that follows is plain to see.
            canvas.current?.setView({ x: -300, y: -300, scale: 2 });
            canvas.current?.fit();
            say("fitted while hidden; showing again in 500ms");
            setTimeout(() => setHidden(false), 500);
          }}
        >
          Fit while hidden, then show
        </button>
        <button type="button" onClick={() => setWide(!wide)}>
          {wide ? "Narrower drawing" : "Wider drawing"}
        </button>
        <label>
          Wheel
          <select value={wheel} onChange={(event) => setWheel(event.target.value === "zoom" ? "zoom" : "pan")}>
            <option value="pan">pans</option>
            <option value="zoom">zooms</option>
          </select>
        </label>
        <label>
          Width <input type="range" min="20" max="100" value={width} onChange={(event) => setWidth(Number(event.target.value))} />%
        </label>
        <label>
          Height <input type="range" min="120" max="800" value={height} onChange={(event) => setHeight(Number(event.target.value))} />
          px
        </label>
      </div>
      <Canvas
        ref={canvas}
        className="viewport"
        aria-label="Cards"
        wheel={wheel}
        minScale={0.05}
        maxScale={3}
        style={{ width: `${width}%`, height: `${height}px`, display: hidden ? "none" : undefined, boxSizing: "border-box" }}
        onChange={(next, by) => setView({ view: next, by })}
        onClick={(event) => {
          // A card's link: logged instead of followed, so the page stays put.
          const card = event.target instanceof Element ? event.target.closest("a.card") : null;
          if (card === null) return;
          event.preventDefault();
          say(`clicked ${card.textContent}`);
        }}
      >
        <div className="drawing" style={{ width: columns * (wide ? 300 : 200), height: rows * 133 + 4 }}>
          {cards.map((card) => (
            <a key={card.number} className="card" href={`#card-${card.number}`} data-shown={shown === card.number ? "" : undefined} style={{ left: card.x, top: card.y }}>
              Card {card.number}
            </a>
          ))}
        </div>
      </Canvas>
      <div className="readouts">
        <div>
          View:{" "}
          <span data-testid="view">
            {view === null ? "" : `x ${view.view.x.toFixed(1)}, y ${view.view.y.toFixed(1)}, scale ${view.view.scale.toFixed(3)}, by ${view.by}`}
          </span>
        </div>
        <pre className="log" data-testid="log">
          {log.join("\n")}
        </pre>
      </div>
    </>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("The demo page has no #root");
createRoot(root).render(<Demo />);

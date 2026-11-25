import { fitView, viewShowing, zoomAt, type Limits, type Rect, type Size, type View } from "#/view.ts";

export type CanvasOptions = Partial<Limits> & {
  /** The content's own size: what fitting fits. */
  size: Size;
  /** Called after every change of the view. */
  onChange?: (view: View) => void;
};

export type Canvas = {
  view(): View;
  /** Moves the view there; `animate` eases it over a short moment. */
  setView(view: View, options?: { animate?: boolean }): void;
  /** The whole content in sight (not past `maxScale`, or `options.maxScale`). */
  fit(options?: { padding?: number; maxScale?: number; animate?: boolean }): void;
  /** Zooms around the viewport's middle: buttons and keys. */
  zoomBy(factor: number): void;
  /** Moves as little as it takes to show `rect`, in the content's coordinates. */
  show(rect: Rect, options?: { margin?: number; animate?: boolean }): void;
  /** Takes every listener off again. */
  destroy(): void;
};

/** Pixels a press may move before it's a drag, not a click. */
const dragThreshold = 4;

/**
 * Makes `viewport` a canvas over `content`: the content is moved and scaled
 * by a CSS transform, and the viewport (which clips it) takes:
 * - a drag with the mouse or one finger: moves it;
 * - two-finger scrolling on a touchpad, or a mouse wheel: moves it;
 * - a pinch on a touchpad (the browser sends it as a wheel with ctrlKey),
 *   ctrl + wheel, a two-finger pinch on a touch screen, or Safari's
 *   gesture events: zooms, around the pointer or the pinch's middle.
 * A press that turns into a drag doesn't click what it started on (a link
 * in the content), so links in it still work with a plain click.
 */
export function attachCanvas(viewport: HTMLElement, content: HTMLElement | SVGElement, options: CanvasOptions): Canvas {
  const limits: Limits = { minScale: options.minScale ?? 0.05, maxScale: options.maxScale ?? 4 };
  let current: View = { x: 0, y: 0, scale: 1 };
  let animation = 0;

  content.style.transformOrigin = "0 0";
  viewport.style.touchAction = "none";
  viewport.style.overflow = "hidden";

  const apply = (view: View) => {
    current = view;
    content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    options.onChange?.(view);
  };
  const viewportSize = (): Size => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  /** A point of the page, in the viewport's pixels. */
  const local = (clientX: number, clientY: number) => {
    const box = viewport.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  const setView = (view: View, settings: { animate?: boolean } = {}) => {
    cancelAnimationFrame(animation);
    if (settings.animate !== true) {
      apply(view);
      return;
    }
    const from = current;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 180);
      // Ease out: fast first, settling.
      const eased = 1 - (1 - t) ** 3;
      apply({
        x: from.x + (view.x - from.x) * eased,
        y: from.y + (view.y - from.y) * eased,
        scale: from.scale + (view.scale - from.scale) * eased,
      });
      if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  };

  // Wheel: a touchpad's two-finger scroll moves, its pinch (ctrlKey) zooms.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    cancelAnimationFrame(animation);
    // Lines or pages, as some mice send: about 16 pixels a line.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      apply(zoomAt(current, local(event.clientX, event.clientY), Math.exp(-event.deltaY * unit * 0.01), limits));
    } else {
      apply({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit });
    }
  };

  // Safari on a Mac sends a touchpad pinch as gesture events, not wheels.
  let gestureScale = 1;
  const onGestureStart = (event: Event) => {
    event.preventDefault();
    gestureScale = 1;
  };
  const onGestureChange = (event: Event) => {
    event.preventDefault();
    const gesture = event as Event & { scale: number; clientX: number; clientY: number };
    apply(zoomAt(current, local(gesture.clientX, gesture.clientY), gesture.scale / gestureScale, limits));
    gestureScale = gesture.scale;
  };

  // Pointers: one moves, two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pressStart: { x: number; y: number } | null = null;
  let dragged = false;
  let pinch: { distance: number; middle: { x: number; y: number } } | null = null;
  const pinchOf = () => {
    const [a, b] = [...pointers.values()];
    if (a === undefined || b === undefined) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelAnimationFrame(animation);
    pointers.set(event.pointerId, local(event.clientX, event.clientY));
    if (pointers.size === 1) {
      pressStart = local(event.clientX, event.clientY);
      dragged = false;
    } else {
      pinch = pinchOf();
      dragged = true;
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) return;
    const now = local(event.clientX, event.clientY);
    pointers.set(event.pointerId, now);

    if (pointers.size >= 2 && pinch !== null) {
      const next = pinchOf();
      if (next === null) return;
      const zoomed = zoomAt(current, next.middle, next.distance / Math.max(1, pinch.distance), limits);
      apply({ ...zoomed, x: zoomed.x + next.middle.x - pinch.middle.x, y: zoomed.y + next.middle.y - pinch.middle.y });
      pinch = next;
      return;
    }
    if (!dragged && pressStart !== null && Math.hypot(now.x - pressStart.x, now.y - pressStart.y) < dragThreshold) return;
    if (!dragged) {
      dragged = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.style.cursor = "grabbing";
    }
    apply({ ...current, x: current.x + now.x - previous.x, y: current.y + now.y - previous.y });
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      pressStart = null;
      viewport.style.cursor = "";
    }
  };
  // A drag isn't a click on the link it started on.
  const onClick = (event: MouseEvent) => {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    dragged = false;
  };

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("gesturestart", onGestureStart);
  viewport.addEventListener("gesturechange", onGestureChange);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("click", onClick, { capture: true });

  apply(current);

  return {
    view: () => current,
    setView,
    fit: (settings = {}) => {
      setView(fitView(options.size, viewportSize(), settings.padding ?? 16, { ...limits, maxScale: settings.maxScale ?? limits.maxScale }), { animate: settings.animate });
    },
    zoomBy: (factor) => {
      const size = viewportSize();
      setView(zoomAt(current, { x: size.width / 2, y: size.height / 2 }, factor, limits), { animate: true });
    },
    show: (rect, settings = {}) => {
      const next = viewShowing(current, rect, viewportSize(), settings.margin ?? 24);
      if (next.x !== current.x || next.y !== current.y) setView(next, { animate: settings.animate });
    },
    destroy: () => {
      cancelAnimationFrame(animation);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("pointercancel", onPointerUp);
      viewport.removeEventListener("click", onClick, { capture: true });
    },
  };
}

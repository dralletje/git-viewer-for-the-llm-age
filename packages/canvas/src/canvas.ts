import { fitView, resizedView, viewShowing, zoomAt, type Limits, type Rect, type Size, type View } from "#/view.ts";

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
  /**
   * The whole content in sight (not past `maxScale`, or `options.maxScale`).
   * It stays fitted when the viewport changes size, until the view is moved.
   */
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
 * When the viewport changes size, a fitted view is fitted again, and any
 * other view keeps what was in the middle in the middle.
 */
export function attachCanvas(viewport: HTMLElement, content: HTMLElement | SVGElement, options: CanvasOptions): Canvas {
  const limits: Limits = { minScale: options.minScale ?? 0.05, maxScale: options.maxScale ?? 4 };
  let current: View = { x: 0, y: 0, scale: 1 };
  let animation = 0;
  /** Where a running animation is going, so calls in quick succession build on where it ends. */
  let heading: View | null = null;
  /** The last fit's settings, while nothing has moved the view since: a resize fits again. */
  let fitted: { padding: number; maxScale: number } | null = null;

  content.style.transformOrigin = "0 0";
  viewport.style.touchAction = "none";
  viewport.style.overflow = "hidden";

  const apply = (view: View) => {
    current = view;
    content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    options.onChange?.(view);
  };
  const stop = () => {
    cancelAnimationFrame(animation);
    heading = null;
  };
  const viewportSize = (): Size => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  /** A point of the page, in the viewport's pixels. */
  const local = (clientX: number, clientY: number) => {
    const box = viewport.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  const setView = (view: View, settings: { animate?: boolean } = {}) => {
    stop();
    fitted = null;
    if (settings.animate !== true) {
      apply(view);
      return;
    }
    heading = view;
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
      if (t < 1) {
        animation = requestAnimationFrame(step);
      } else {
        heading = null;
      }
    };
    animation = requestAnimationFrame(step);
  };

  // Wheel: a touchpad's two-finger scroll moves, its pinch (ctrlKey) zooms.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    stop();
    fitted = null;
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
    stop();
    gestureScale = 1;
  };
  const onGestureChange = (event: Event) => {
    event.preventDefault();
    fitted = null;
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
    stop();
    pointers.set(event.pointerId, local(event.clientX, event.clientY));
    if (pointers.size === 1) {
      pressStart = local(event.clientX, event.clientY);
      dragged = false;
    } else {
      pinch = pinchOf();
      dragged = true;
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      pressStart = null;
      viewport.style.cursor = "";
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) return;
    // Let go outside the viewport before it was a drag (nothing captured it
    // yet, so no pointerup came): moving over it again mustn't drag along.
    if (event.buttons === 0) {
      onPointerUp(event);
      return;
    }
    const now = local(event.clientX, event.clientY);
    pointers.set(event.pointerId, now);

    if (pointers.size >= 2 && pinch !== null) {
      const next = pinchOf();
      if (next === null) return;
      fitted = null;
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
    fitted = null;
    apply({ ...current, x: current.x + now.x - previous.x, y: current.y + now.y - previous.y });
  };
  // A drag isn't a click on the link it started on.
  const onClick = (event: MouseEvent) => {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    dragged = false;
  };
  // A link or an image in the content would otherwise be dragged out by the
  // browser itself, which cancels the pointer: the view would stop moving.
  const onDragStart = (event: DragEvent) => {
    event.preventDefault();
  };

  // The viewport changing size: the page's layout, the window, a hidden tab shown.
  let size = viewportSize();
  const resizes = new ResizeObserver(() => {
    const now = viewportSize();
    // Hidden: nothing to fit to. Kept as it was until it shows again.
    if (now.width === 0 || now.height === 0) return;
    const before = size;
    size = now;
    // Fitted: fitted to the size it has now. Also when that's the size it
    // had before it was hidden, and fit() was called while hidden.
    if (fitted !== null) {
      stop();
      apply(fitView(options.size, now, fitted.padding, { ...limits, maxScale: fitted.maxScale }));
      return;
    }
    if (now.width === before.width && now.height === before.height) return;
    // Never had a size: nothing was in its middle yet.
    if (before.width === 0 || before.height === 0) return;
    const from = heading ?? current;
    stop();
    apply(resizedView(from, before, now));
  });
  resizes.observe(viewport);

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("gesturestart", onGestureStart);
  viewport.addEventListener("gesturechange", onGestureChange);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("click", onClick, { capture: true });
  viewport.addEventListener("dragstart", onDragStart);

  apply(current);

  return {
    view: () => current,
    setView,
    fit: (settings = {}) => {
      const fit = { padding: settings.padding ?? 16, maxScale: settings.maxScale ?? limits.maxScale };
      const now = viewportSize();
      // Not laid out yet (a hidden tab): fitted when it gets a size.
      if (now.width === 0 || now.height === 0) {
        stop();
        fitted = fit;
        return;
      }
      setView(fitView(options.size, now, fit.padding, { ...limits, maxScale: fit.maxScale }), { animate: settings.animate });
      fitted = fit;
    },
    zoomBy: (factor) => {
      const now = viewportSize();
      // From where a running zoom ends: two quick clicks zoom twice as far.
      setView(zoomAt(heading ?? current, { x: now.width / 2, y: now.height / 2 }, factor, limits), { animate: true });
    },
    show: (rect, settings = {}) => {
      // From where a running animation ends: a quick run of calls ends on the last one.
      const from = heading ?? current;
      const next = viewShowing(from, rect, viewportSize(), settings.margin ?? 24);
      if (next.x !== from.x || next.y !== from.y) setView(next, { animate: settings.animate });
    },
    destroy: () => {
      stop();
      resizes.disconnect();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("pointercancel", onPointerUp);
      viewport.removeEventListener("click", onClick, { capture: true });
      viewport.removeEventListener("dragstart", onDragStart);
    },
  };
}

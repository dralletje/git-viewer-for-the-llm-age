import { fitView, resizedView, viewShowing, zoomAt, type Limits, type Rect, type Size, type View } from "#/view.ts";

/**
 * What moved the view: the person using it (drag, wheel, pinch, keys), the
 * code (the handle's methods), or the page around it (the viewport or the
 * content changed size, or the browser scrolled to show something).
 */
export type ChangeCause = "user" | "code" | "layout";

export type CanvasOptions = Partial<Limits> & {
  /**
   * What a plain wheel does: "pan" (the default; a touchpad's two-finger
   * scroll moves) or "zoom" (a mouse wheel zooms; panning is by dragging).
   * Ctrl + wheel, and a touchpad's pinch, always zoom.
   */
  wheel?: "pan" | "zoom";
  /** Arrows move, + and - zoom, 0 fits, while the viewport has focus. On by default. */
  keyboard?: boolean;
  /** Called after every change of the view. */
  onChange?: (view: View, by: ChangeCause) => void;
};

export type FitOptions = {
  /** Pixels around the content. 16 by default. */
  padding?: number;
  /** Not larger than this: 1 by default, so small content isn't blown up. */
  maxScale?: number;
  animate?: boolean;
};

export type AttachedCanvas = {
  view(): View;
  /** Moves the view there; `animate` eases it over a short moment. */
  setView(view: View, options?: { animate?: boolean }): void;
  /**
   * The whole content in sight. It stays fitted when the viewport or the
   * content changes size, until the view is moved.
   */
  fit(options?: FitOptions): void;
  /** Zooms around the viewport's middle: buttons. */
  zoomBy(factor: number): void;
  /** Moves as little as it takes to show `rect`, in the content's coordinates. */
  show(rect: Rect, options?: { margin?: number; animate?: boolean }): void;
  /** A point of the page (a pointer's clientX, clientY) in the content's coordinates. */
  toContent(clientX: number, clientY: number): { x: number; y: number };
  /** A point of the content where it is on the page, as clientX, clientY. */
  toClient(point: { x: number; y: number }): { x: number; y: number };
  /** Takes every listener off, and the styles it set. */
  destroy(): void;
};

/** Pixels a press may move before it's a drag, not a click. */
const dragThreshold = 4;

/**
 * Makes `viewport` a canvas over `content`: the content is moved and scaled
 * by a CSS transform, and the viewport (which clips it) takes:
 * - a drag with the mouse or one finger: moves it;
 * - two-finger scrolling on a touchpad, or a mouse wheel: moves it (or
 *   zooms, with `wheel: "zoom"`);
 * - a pinch on a touchpad (the browser sends it as a wheel with ctrlKey),
 *   ctrl + wheel, a two-finger pinch on a touch screen, or Safari's
 *   gesture events: zooms, around the pointer or the pinch's middle;
 * - with focus: arrows move, + and - zoom, 0 fits.
 * A press that turns into a drag doesn't click what it started on (a link
 * in the content), so links in it still work with a plain click.
 * When the viewport or the content changes size, a fitted view is fitted
 * again, and any other view keeps what was in the middle in the middle.
 * When the browser scrolls the viewport (focus, find in page), the scroll
 * becomes the view.
 *
 * The viewport is the containing block of `content`, which sits at its top
 * left (position: absolute; left: 0; top: 0). Its own `touch-action` and
 * `overflow` are kept when set; otherwise they become "none" and "hidden".
 */
export function attachCanvas(viewport: HTMLElement, content: HTMLElement, options: CanvasOptions): AttachedCanvas {
  const limits: Limits = { minScale: options.minScale ?? 0.05, maxScale: options.maxScale ?? 4 };
  const wheel = options.wheel ?? "pan";
  const keyboard = options.keyboard ?? true;
  let current: View = { x: 0, y: 0, scale: 1 };
  let animation = 0;
  /** Where a running animation is going, so calls in quick succession build on where it ends. */
  let heading: View | null = null;
  /** The last fit's settings, while nothing has moved the view since: a resize fits again. */
  let fitted: { padding: number; maxScale: number } | null = null;

  // What was there before, to put back on destroy().
  const before = {
    touchAction: viewport.style.touchAction,
    overflow: viewport.style.overflow,
    cursor: viewport.style.cursor,
    transform: content.style.transform,
    transformOrigin: content.style.transformOrigin,
  };
  content.style.transformOrigin = "0 0";
  if (viewport.style.touchAction === "") viewport.style.touchAction = "none";
  if (viewport.style.overflow === "") viewport.style.overflow = "hidden";

  const apply = (view: View, by: ChangeCause) => {
    current = view;
    content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    options.onChange?.(view, by);
  };
  const stop = () => {
    cancelAnimationFrame(animation);
    heading = null;
  };
  const viewportSize = (): Size => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  // The content's own size, as laid out: a transform doesn't change it.
  const contentSize = (): Size => ({ width: content.offsetWidth, height: content.offsetHeight });
  /**
   * A point of the page, in the viewport's pixels: from inside its border,
   * where the content's 0, 0 is.
   */
  const local = (clientX: number, clientY: number) => {
    const box = viewport.getBoundingClientRect();
    return { x: clientX - box.left - viewport.clientLeft, y: clientY - box.top - viewport.clientTop };
  };
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const moveTo = (view: View, animate: boolean, by: ChangeCause) => {
    stop();
    fitted = null;
    if (!animate || reducedMotion()) {
      apply(view, by);
      return;
    }
    heading = view;
    const from = current;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 180);
      // Ease out: fast first, settling.
      const eased = 1 - (1 - t) ** 3;
      apply(
        {
          x: from.x + (view.x - from.x) * eased,
          y: from.y + (view.y - from.y) * eased,
          scale: from.scale + (view.scale - from.scale) * eased,
        },
        by,
      );
      if (t < 1) {
        animation = requestAnimationFrame(step);
      } else {
        heading = null;
      }
    };
    animation = requestAnimationFrame(step);
  };
  const fit = (settings: FitOptions, by: ChangeCause) => {
    const fitting = { padding: settings.padding ?? 16, maxScale: settings.maxScale ?? 1 };
    const now = viewportSize();
    // Not laid out yet (a hidden tab): fitted when it gets a size.
    if (now.width === 0 || now.height === 0) {
      stop();
      fitted = fitting;
      return;
    }
    moveTo(fitView(contentSize(), now, fitting.padding, { ...limits, maxScale: Math.min(limits.maxScale, fitting.maxScale) }), settings.animate === true, by);
    fitted = fitting;
  };
  const zoomBy = (factor: number, by: ChangeCause) => {
    const now = viewportSize();
    // From where a running zoom ends: two quick clicks zoom twice as far.
    moveTo(zoomAt(heading ?? current, { x: now.width / 2, y: now.height / 2 }, factor, limits), true, by);
  };

  // Wheel: a touchpad's two-finger scroll moves, its pinch (ctrlKey) zooms.
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    stop();
    fitted = null;
    // Lines or pages, as some mice send: about 16 pixels a line.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    if (event.ctrlKey || event.metaKey || wheel === "zoom") {
      apply(zoomAt(current, local(event.clientX, event.clientY), Math.exp(-event.deltaY * unit * 0.01), limits), "user");
    } else {
      apply({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit }, "user");
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
    apply(zoomAt(current, local(gesture.clientX, gesture.clientY), gesture.scale / gestureScale, limits), "user");
    gestureScale = gesture.scale;
  };

  // Pointers: one moves, two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pressStart: { x: number; y: number } | null = null;
  let dragged = false;
  let pinch: { distance: number; middle: { x: number; y: number } } | null = null;
  /** The cursor the page gave the viewport, put back after a drag. */
  let cursorBeforeDrag = "";
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
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      pressStart = null;
      if (dragged) viewport.style.cursor = cursorBeforeDrag;
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
      apply({ ...zoomed, x: zoomed.x + next.middle.x - pinch.middle.x, y: zoomed.y + next.middle.y - pinch.middle.y }, "user");
      pinch = next;
      return;
    }
    if (!dragged && pressStart !== null && Math.hypot(now.x - pressStart.x, now.y - pressStart.y) < dragThreshold) return;
    if (!dragged) {
      dragged = true;
      viewport.setPointerCapture(event.pointerId);
      cursorBeforeDrag = viewport.style.cursor;
      viewport.style.cursor = "grabbing";
    }
    fitted = null;
    apply({ ...current, x: current.x + now.x - previous.x, y: current.y + now.y - previous.y }, "user");
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
  // The browser scrolls the viewport itself (hidden overflow still scrolls)
  // to show what it moves to: a link reached with Tab, a match of find in
  // page. Zooming would then turn around the wrong point, as the view no
  // longer says where the content is. So that scroll becomes part of the
  // view: the same picture, with the viewport back at 0, 0.
  const onScroll = () => {
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    if (left === 0 && top === 0) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    stop();
    fitted = null;
    apply({ ...current, x: current.x - left, y: current.y - top }, "layout");
  };

  // Keys, with focus on the viewport or on something in the content (a link).
  const onKeyDown = (event: KeyboardEvent) => {
    if (!keyboard || event.defaultPrevented) return;
    // Ctrl + plus is the browser's own zoom; alt and meta are shortcuts.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Typing in a field in the content.
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select") !== null)) return;
    const step = event.shiftKey ? 200 : 40;
    if (event.key === "ArrowLeft") {
      moveTo({ ...(heading ?? current), x: (heading ?? current).x + step }, false, "user");
    } else if (event.key === "ArrowRight") {
      moveTo({ ...(heading ?? current), x: (heading ?? current).x - step }, false, "user");
    } else if (event.key === "ArrowUp") {
      moveTo({ ...(heading ?? current), y: (heading ?? current).y + step }, false, "user");
    } else if (event.key === "ArrowDown") {
      moveTo({ ...(heading ?? current), y: (heading ?? current).y - step }, false, "user");
    } else if (event.key === "+" || event.key === "=") {
      zoomBy(1.25, "user");
    } else if (event.key === "-" || event.key === "_") {
      zoomBy(0.8, "user");
    } else if (event.key === "0") {
      fit({ animate: true }, "user");
    } else {
      return;
    }
    event.preventDefault();
  };

  // The viewport or the content changing size: the page's layout, the
  // window, a hidden tab shown, the content drawn anew.
  let size = viewportSize();
  let drawn = contentSize();
  const resizes = new ResizeObserver(() => {
    const now = viewportSize();
    // Hidden: nothing to fit to. Kept as it was until it shows again.
    if (now.width === 0 || now.height === 0) return;
    const sizeBefore = size;
    size = now;
    drawn = contentSize();
    // Fitted: fitted to the sizes they have now. Also when that's the size
    // it had before it was hidden, and fit() was called while hidden.
    if (fitted !== null) {
      stop();
      apply(fitView(drawn, now, fitted.padding, { ...limits, maxScale: Math.min(limits.maxScale, fitted.maxScale) }), "layout");
      return;
    }
    if (now.width === sizeBefore.width && now.height === sizeBefore.height) return;
    // Never had a size: nothing was in its middle yet.
    if (sizeBefore.width === 0 || sizeBefore.height === 0) return;
    const from = heading ?? current;
    stop();
    apply(resizedView(from, sizeBefore, now), "layout");
  });
  resizes.observe(viewport);
  resizes.observe(content);

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("gesturestart", onGestureStart);
  viewport.addEventListener("gesturechange", onGestureChange);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("click", onClick, { capture: true });
  viewport.addEventListener("dragstart", onDragStart);
  viewport.addEventListener("scroll", onScroll);
  viewport.addEventListener("keydown", onKeyDown);

  apply(current, "code");

  return {
    view: () => current,
    setView: (view, settings = {}) => moveTo(view, settings.animate === true, "code"),
    fit: (settings = {}) => fit(settings, "code"),
    zoomBy: (factor) => zoomBy(factor, "code"),
    show: (rect, settings = {}) => {
      // From where a running animation ends: a quick run of calls ends on the last one.
      const from = heading ?? current;
      const next = viewShowing(from, rect, viewportSize(), settings.margin ?? 24);
      if (next.x !== from.x || next.y !== from.y) moveTo(next, settings.animate === true, "code");
    },
    toContent: (clientX, clientY) => {
      const point = local(clientX, clientY);
      return { x: (point.x - current.x) / current.scale, y: (point.y - current.y) / current.scale };
    },
    toClient: (point) => {
      const box = viewport.getBoundingClientRect();
      return {
        x: box.left + viewport.clientLeft + current.x + point.x * current.scale,
        y: box.top + viewport.clientTop + current.y + point.y * current.scale,
      };
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
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.style.touchAction = before.touchAction;
      viewport.style.overflow = before.overflow;
      viewport.style.cursor = before.cursor;
      content.style.transform = before.transform;
      content.style.transformOrigin = before.transformOrigin;
    },
  };
}

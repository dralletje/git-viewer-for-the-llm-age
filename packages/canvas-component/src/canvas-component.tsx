import { useImperativeHandle, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type Ref } from "react";
import { attachCanvas, type AttachedCanvas, type ChangeCause, type FitOptions } from "#/canvas.ts";
import type { Rect, View } from "#/view.ts";

/** What a ref on <Canvas> gets: to move the view from code. */
export type CanvasHandle = {
  view(): View;
  /** Moves the view there; `animate` eases it over a short moment. */
  setView(view: View, options?: { animate?: boolean }): void;
  /**
   * The whole content in sight. It stays fitted when the viewport or the
   * content changes size, until the view is moved.
   */
  fit(options?: FitOptions): void;
  /** Zooms around the viewport's middle: zoom buttons. */
  zoomBy(factor: number): void;
  /** Moves as little as it takes to show `rect`, in the content's coordinates. */
  show(rect: Rect, options?: { margin?: number; animate?: boolean }): void;
  /** A point of the page (a pointer's clientX, clientY) in the content's coordinates. */
  toContent(clientX: number, clientY: number): { x: number; y: number };
  /** A point of the content where it is on the page, as clientX, clientY. */
  toClient(point: { x: number; y: number }): { x: number; y: number };
};

export type CanvasProps = Omit<ComponentProps<"div">, "children" | "onChange" | "ref"> & {
  /** What's moved and zoomed. Its own size is what fitting fits. */
  children: ReactNode;
  ref?: Ref<CanvasHandle>;
  /** How far it zooms out: 0.05 by default. */
  minScale?: number;
  /** How far it zooms in: 4 by default. */
  maxScale?: number;
  /** The view at first: "fit" (the default) shows the whole content, not larger than drawn. */
  initialView?: View | "fit";
  /**
   * What a plain wheel does: "pan" (the default; a touchpad's two-finger
   * scroll moves) or "zoom" (a mouse wheel zooms). Ctrl + wheel and a
   * touchpad's pinch always zoom.
   */
  wheel?: "pan" | "zoom";
  /** Arrows move, + and - zoom, 0 fits, while it has focus. On by default (it takes tab focus). */
  keyboard?: boolean;
  /** After every change of the view, with what moved it. */
  onChange?: (view: View, by: ChangeCause) => void;
};

/**
 * A pan and zoom viewport over its children: dragged, scrolled and pinched
 * like a map, and moved from code through its ref. Give it a size (the
 * viewport clips the content); the content keeps its own size, and sits at
 * the viewport's top left before it's moved.
 *
 * Touch: by default the viewport takes every touch (`touch-action: none`).
 * To let a finger scroll the page past it, set it in `style`, e.g.
 * `style={{ touchAction: "pan-y" }}`: then vertical swipes scroll the page,
 * and sideways drags and pinches stay with the canvas.
 */
export function Canvas({ children, ref, minScale, maxScale, initialView = "fit", wheel = "pan", keyboard = true, onChange, style, tabIndex, ...rest }: CanvasProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const attached = useRef<AttachedCanvas | null>(null);
  // The view so far: options changing attach it anew, in the same place.
  const lastView = useRef<View | null>(null);
  // The newest onChange, without attaching anew when it's another function.
  const latestOnChange = useRef(onChange);
  useLayoutEffect(() => {
    latestOnChange.current = onChange;
  });

  useLayoutEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    // Read before attaching: attaching reports its own first view.
    const previous = lastView.current;
    const canvas = attachCanvas(frame, drawing, {
      minScale,
      maxScale,
      wheel,
      keyboard,
      onChange: (view, by) => {
        lastView.current = view;
        latestOnChange.current?.(view, by);
      },
    });
    if (previous !== null) {
      canvas.setView(previous);
    } else if (initialView === "fit") {
      canvas.fit();
    } else {
      canvas.setView(initialView);
    }
    attached.current = canvas;
    return () => {
      canvas.destroy();
      attached.current = null;
    };
    // initialView is only the first view: changing it later moves nothing.
  }, [minScale, maxScale, wheel, keyboard]);

  useImperativeHandle(
    ref,
    () => ({
      view: () => attached.current?.view() ?? lastView.current ?? { x: 0, y: 0, scale: 1 },
      setView: (view, options) => attached.current?.setView(view, options),
      fit: (options) => attached.current?.fit(options),
      zoomBy: (factor) => attached.current?.zoomBy(factor),
      show: (rect, options) => attached.current?.show(rect, options),
      toContent: (clientX, clientY) => attached.current?.toContent(clientX, clientY) ?? { x: clientX, y: clientY },
      toClient: (point) => attached.current?.toClient(point) ?? point,
    }),
    [],
  );

  return (
    <div {...rest} ref={viewport} tabIndex={tabIndex ?? (keyboard ? 0 : undefined)} style={{ position: "relative", ...style }}>
      <div ref={content} style={{ position: "absolute", left: 0, top: 0 }}>
        {children}
      </div>
    </div>
  );
}

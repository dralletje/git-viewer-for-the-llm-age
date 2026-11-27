/**
 * What a wheel event says about its device. `wheelDeltaY` is non-standard
 * (Chrome and Safari have it, Firefox doesn't): leave it out when missing.
 */
export type WheelSample = { deltaX: number; deltaY: number; deltaMode: number; wheelDeltaY?: number };

/**
 * A guess at what sent a wheel event: a mouse wheel ("mouse"), a touchpad's
 * two-finger scroll ("touchpad"), or "unclear". Browsers send both as the
 * same event, so it is only a guess, from the first event of a gesture:
 * - sideways movement: a touchpad (a mouse moves sideways only with shift
 *   or a tilt wheel, where moving is what's meant too);
 * - lines or pages instead of pixels (Firefox, for a notched wheel): a mouse;
 * - one notch, as Chrome and Safari report it (wheelDeltaY a multiple of
 *   120) and a large step: a mouse;
 * - a large whole step of pixels (50 or more) with nothing to say otherwise: a mouse;
 * - small or fractional steps: a touchpad, or a smooth-scrolling mouse;
 *   these, and anything else, are "unclear".
 */
export function wheelKind(event: WheelSample): "mouse" | "touchpad" | "unclear" {
  if (event.deltaX !== 0) return "touchpad";
  if (event.deltaY === 0) return "unclear";
  if (event.deltaMode !== 0) return "mouse";
  if (event.wheelDeltaY !== undefined && event.wheelDeltaY !== 0) {
    if (event.wheelDeltaY % 120 === 0 && Math.abs(event.deltaY) >= 50) return "mouse";
    return "unclear";
  }
  if (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50) return "mouse";
  return "unclear";
}

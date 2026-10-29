/**
 * The 2D academy map: an equirectangular world painted on a canvas with one
 * marker per member, always at the member's true saved city. Drag to pan,
 * scroll or pinch to zoom. Overlapping markers collapse into a count bubble
 * at the true spot; tapping a bubble zooms toward it while cities can still
 * separate, then fans the members out in a small screen-space circle around
 * the city anchor (spiderfy) so each stays tappable without ever displacing
 * anyone geographically.
 */
import type { MapPin } from "../../shared/types";
import { paintWorld, project } from "./geo";
import {
  clampView,
  clusterIndices,
  fitView,
  panBy,
  spiderfyPositions,
  toScreen,
  zoomAt,
  type ViewState,
} from "./view";

export interface MapColors {
  ocean: string;
  land: string;
  border: string;
  member: string;
  mentor: string;
  pinEdge: string;
}

export function readColors(): MapColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    ocean: v("--canvas", "#fdfbf7"),
    land: v("--map-land", "#dfe6dd"),
    border: v("--map-border", "#b9c4b6"),
    member: v("--map-pin", "#e8a33d"),
    mentor: v("--map-pin-mentor", "#3d8e8a"),
    pinEdge: v("--map-pin-edge", "#ffffff"),
  };
}

/** What the view controller hands back: zoom buttons + cleanup. */
export interface MapController {
  zoomBy(factor: number): void;
  reset(): void;
  destroy(): void;
}

interface Placed {
  pin: MapPin;
  bx: number;
  by: number;
}

interface Drawn {
  kind: "pin" | "cluster" | "spider";
  x: number;
  y: number;
  r: number;
  pins: MapPin[];
  bx: number;
  by: number;
}

const PIN_R = 5;
const HIT_R = 18;
const CLUSTER_PX = 26;

const cityKey = (p: MapPin) => `${p.city}|${p.country}`;

export function startMap(
  canvas: HTMLCanvasElement,
  pins: MapPin[],
  onSelect: (pins: MapPin[]) => void,
): MapController {
  const ctx = canvas.getContext("2d");
  const colors = readColors();
  let view: ViewState = fitView(1, 1);
  let placed: Placed[] = [];
  let drawn: Drawn[] = [];
  let selectedId: string | null = null;
  /** The cluster currently fanned out around its true anchor, if any. */
  let spiderCity: { ids: Set<string>; bx: number; by: number } | null = null;
  let w = 0;
  let h = 0;

  function layout() {
    const parent = canvas.parentElement;
    if (!parent || !ctx) return false;
    const dpr = window.devicePixelRatio || 1;
    w = parent.clientWidth;
    h = Math.max(220, Math.round(w * 0.52));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function drawPin(x: number, y: number, pin: MapPin) {
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(x, y, PIN_R, 0, Math.PI * 2);
    ctx.fillStyle = pin.isMentor ? colors.mentor : colors.member;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, PIN_R, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.pinEdge;
    ctx.stroke();
    if (pin.id === selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, PIN_R + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.member;
      ctx.stroke();
    }
  }

  function draw() {
    if (!ctx || !layout()) return;
    if (view.cx === 0.5) view = fitView(w, h); // first paint
    ctx.clearRect(0, 0, w, h);

    // World painted in base coordinates under the view transform.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(view.z, view.z);
    ctx.translate(-view.cx, -view.cy);
    paintWorld(ctx, w, h, colors.land, colors.border);
    ctx.restore();

    // Pins always render at their true saved city.
    placed = pins.map((pin) => {
      const [bx, by] = project(pin.lat, pin.lon, w, h);
      return { pin, bx, by };
    });
    const sx = placed.map((p) => toScreen(view, w, h, p.bx, p.by)[0]);
    const sy = placed.map((p) => toScreen(view, w, h, p.bx, p.by)[1]);
    const groups = clusterIndices(sx, sy, CLUSTER_PX);

    drawn = [];
    for (const idxs of groups) {
      const members = idxs.map((i) => placed[i].pin);
      const cbx = idxs.reduce((s, i) => s + placed[i].bx, 0) / idxs.length;
      const cby = idxs.reduce((s, i) => s + placed[i].by, 0) / idxs.length;
      const cx = idxs.reduce((s, i) => s + sx[i], 0) / idxs.length;
      const cy = idxs.reduce((s, i) => s + sy[i], 0) / idxs.length;
      if (idxs.length === 1) {
        drawn.push({ kind: "pin", x: cx, y: cy, r: PIN_R, pins: members, bx: cbx, by: cby });
        continue;
      }
      if (
        spiderCity &&
        members.every((p) => spiderCity!.ids.has(p.id))
      ) {
        // Fan out around the true city anchor: small screen-space circle,
        // legs back to the anchor, no geographic displacement.
        const [ax, ay] = toScreen(view, w, h, spiderCity.bx, spiderCity.by);
        ctx.beginPath();
        ctx.arc(ax, ay, 4, 0, Math.PI * 2);
        ctx.fillStyle = colors.border;
        ctx.fill();
        const pos = spiderfyPositions(members.length, ax, ay);
        members.forEach((pin, i) => {
          const [fx, fy] = pos[i];
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(fx, fy);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = colors.border;
          ctx.stroke();
          drawn.push({ kind: "spider", x: fx, y: fy, r: PIN_R, pins: [pin], bx: spiderCity!.bx, by: spiderCity!.by });
        });
        continue;
      }
      // Count bubble at the true spot (centroid == city when same-city).
      drawn.push({
        kind: "cluster",
        x: cx,
        y: cy,
        r: Math.min(16, 9 + members.length),
        pins: members,
        bx: cbx,
        by: cby,
      });
    }

    for (const d of drawn) {
      if (d.kind === "cluster") {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.pins.every((p) => p.isMentor) ? colors.mentor : colors.member;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors.pinEdge;
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${Math.max(10, d.r * 0.75)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(d.pins.length), d.x, d.y + 0.5);
      } else {
        drawPin(d.x, d.y, d.pins[0]);
      }
    }
  }

  function pointFromEvent(e: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function hitAt(x: number, y: number): Drawn | null {
    let best: Drawn | null = null;
    let bestD = Infinity;
    for (const d of drawn) {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist <= Math.max(HIT_R, d.r + 4) && dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    return best;
  }

  const closeSpider = () => {
    spiderCity = null;
  };

  // --- interaction: drag to pan, pinch or wheel to zoom, tap to select ---
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;
  let pinchDist = 0;

  const onDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) {
      const [x, y] = pointFromEvent(e);
      canvas.style.cursor = hitAt(x, y) ? "pointer" : "grab";
      return;
    }
    const prev = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && dist > 0) {
        const rect = canvas.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        view = zoomAt(view, w, h, mx, my, dist / pinchDist);
        closeSpider();
        draw();
        moved = true;
      }
      pinchDist = dist;
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved) {
      view = panBy(view, w, h, dx, dy);
      draw();
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (moved || pointers.size > 0) return; // a drag/pinch, not a tap
    const [x, y] = pointFromEvent(e);
    const hit = hitAt(x, y);
    if (!hit) {
      selectedId = null;
      closeSpider();
      draw();
      onSelect([]);
      return;
    }
    if (hit.kind === "cluster") {
      const sameCity = hit.pins.every((p) => cityKey(p) === cityKey(hit.pins[0]));
      const zoomed = clampView({ z: view.z * 3, cx: hit.bx, cy: hit.by }, w, h);
      // Zoom while it still separates cities. A same-city bubble spiderfies
      // once zoomed in (z >= 6) or out of zoom: the fan's anchor IS the true
      // city. A mixed-city bubble at max zoom opens the member list instead -
      // its centroid is nobody's city, so no fan and no false anchor.
      if (sameCity && (view.z >= 6 || zoomed.z === view.z)) {
        spiderCity = {
          ids: new Set(hit.pins.map((p) => p.id)),
          bx: hit.bx,
          by: hit.by,
        };
        selectedId = null;
        draw();
        onSelect([]);
        return;
      }
      if (zoomed.z !== view.z) {
        view = zoomed;
        closeSpider();
        selectedId = null;
        draw();
        onSelect([]);
        return;
      }
      closeSpider();
      selectedId = null;
      draw();
      onSelect(hit.pins);
      return;
    }
    selectedId = hit.pins[0].id;
    draw();
    onSelect(hit.pins);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = pointFromEvent(e);
    view = zoomAt(view, w, h, x, y, Math.exp(-e.deltaY * 0.0016));
    closeSpider();
    draw();
  };
  const onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    const [x, y] = pointFromEvent(e);
    view = zoomAt(view, w, h, x, y, 2);
    closeSpider();
    draw();
  };
  const onResize = () => {
    if (view.cx === 0.5) view = fitView(canvas.parentElement?.clientWidth ?? 1, 1);
    draw();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDblClick);
  window.addEventListener("resize", onResize);
  canvas.style.cursor = "grab";
  draw();

  return {
    zoomBy(factor: number) {
      view = zoomAt(view, w, h, w / 2, h / 2, factor);
      closeSpider();
      draw();
    },
    reset() {
      view = fitView(w, h);
      selectedId = null;
      closeSpider();
      draw();
      onSelect([]);
    },
    destroy() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("resize", onResize);
    },
  };
}

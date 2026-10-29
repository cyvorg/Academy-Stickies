/**
 * The 2D academy map: an equirectangular world painted on a canvas with one
 * dot per member. Pins sharing a city (the whole initial cohort starts in
 * Kuta) fan out in a golden-angle spiral so each stays tappable.
 */
import type { MapPin } from "../../shared/types";
import { paintWorld, project } from "./geo";

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

interface Placed {
  pin: MapPin;
  x: number;
  y: number;
}

/** Deterministic spiral offsets for co-located pins: the first sits on the
 *  city, the rest spread around it. */
function spread(pins: MapPin[]): { pin: MapPin; dLat: number; dLon: number }[] {
  const groups = new Map<string, MapPin[]>();
  for (const p of pins) {
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const out: { pin: MapPin; dLat: number; dLon: number }[] = [];
  for (const group of groups.values()) {
    group.forEach((pin, i) => {
      if (i === 0) {
        out.push({ pin, dLat: 0, dLon: 0 });
      } else {
        const angle = i * 2.39996; // golden angle
        const r = 0.12 * Math.sqrt(i); // degrees; ~10px rings at map scale
        out.push({
          pin,
          dLat: r * Math.cos(angle),
          dLon: r * Math.sin(angle),
        });
      }
    });
  }
  return out;
}

/**
 * Paint the map onto `canvas` and wire pointer hit-testing. Returns a cleanup
 * function. `canvas` fills its parent; the parent controls the aspect.
 */
export function startMap(
  canvas: HTMLCanvasElement,
  pins: MapPin[],
  onSelect: (pins: MapPin[]) => void,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const colors = readColors();
  let placed: Placed[] = [];
  let selectedId: string | null = null;

  function draw() {
    if (!ctx) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = Math.max(220, Math.round(w * 0.52));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    paintWorld(ctx, w, h, colors.land, colors.border);

    placed = spread(pins).map(({ pin, dLat, dLon }) => {
      const [x, y] = project(pin.lat + dLat, pin.lon + dLon, w, h);
      return { pin, x, y };
    });
    for (const p of placed) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.pin.id === selectedId ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = p.pin.isMentor ? colors.mentor : colors.member;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colors.pinEdge;
      ctx.stroke();
    }
  }

  /** Every pin inside the tap radius, nearest first - co-located members
   *  (the whole cohort starts in Kuta) are returned together so the UI can
   *  offer the cluster instead of making people tap blindly. */
  function pinsAt(x: number, y: number): MapPin[] {
    const hitRadius = 16; // px
    return placed
      .map((p) => ({ p, d: Math.hypot(p.x - x, p.y - y) }))
      .filter(({ d }) => d <= hitRadius)
      .sort((a, b) => a.d - b.d)
      .map(({ p }) => p.pin);
  }

  function pointFromEvent(e: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  const onTap = (e: PointerEvent) => {
    const [x, y] = pointFromEvent(e);
    const hits = pinsAt(x, y);
    selectedId = hits.length === 1 ? hits[0].id : null;
    draw();
    onSelect(hits);
  };
  const onMove = (e: PointerEvent) => {
    const [x, y] = pointFromEvent(e);
    canvas.style.cursor = pinsAt(x, y).length ? "pointer" : "default";
  };
  const onResize = () => draw();

  canvas.addEventListener("pointerdown", onTap);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("resize", onResize);
  draw();

  return () => {
    canvas.removeEventListener("pointerdown", onTap);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("resize", onResize);
  };
}

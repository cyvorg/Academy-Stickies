/**
 * Pure view math for the 2D map: a zoom/pan transform over the base
 * equirectangular world (w x h in base pixels) plus screen-space clustering.
 * Kept free of DOM/canvas so the behavior is unit-testable.
 */

export interface ViewState {
  /** Zoom factor; 1 = whole world fits the canvas. */
  z: number;
  /** Base-coordinate point at the canvas center. */
  cx: number;
  cy: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 14;

export function fitView(w: number, h: number): ViewState {
  return { z: 1, cx: w / 2, cy: h / 2 };
}

/** Keep zoom in range and the visible window inside the world. */
export function clampView(v: ViewState, w: number, h: number): ViewState {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z));
  const vw = w / z;
  const vh = h / z;
  const cx = vw >= w ? w / 2 : Math.min(w - vw / 2, Math.max(vw / 2, v.cx));
  const cy = vh >= h ? h / 2 : Math.min(h - vh / 2, Math.max(vh / 2, v.cy));
  return { z, cx, cy };
}

/** Base (world) coordinates -> canvas screen coordinates. */
export function toScreen(
  v: ViewState,
  w: number,
  h: number,
  bx: number,
  by: number,
): [number, number] {
  return [(bx - v.cx) * v.z + w / 2, (by - v.cy) * v.z + h / 2];
}

/** Canvas screen coordinates -> base (world) coordinates. */
export function toBase(
  v: ViewState,
  w: number,
  h: number,
  sx: number,
  sy: number,
): [number, number] {
  return [(sx - w / 2) / v.z + v.cx, (sy - h / 2) / v.z + v.cy];
}

/** Zoom by `factor` keeping the base point under (sx, sy) fixed on screen. */
export function zoomAt(
  v: ViewState,
  w: number,
  h: number,
  sx: number,
  sy: number,
  factor: number,
): ViewState {
  const [bx, by] = toBase(v, w, h, sx, sy);
  const z = v.z * factor;
  return clampView(
    { z, cx: bx - (sx - w / 2) / z, cy: by - (sy - h / 2) / z },
    w,
    h,
  );
}

/** Pan the view by a screen-space drag delta. */
export function panBy(
  v: ViewState,
  w: number,
  h: number,
  dx: number,
  dy: number,
): ViewState {
  return clampView({ ...v, cx: v.cx - dx / v.z, cy: v.cy - dy / v.z }, w, h);
}

/**
 * Group point indices whose screen positions are within `r` px of each other
 * (transitively, so a chain of close pins forms one cluster). Union-find;
 * O(n^2) is fine for a cohort-sized pin set.
 */
export function clusterIndices(
  xs: number[],
  ys: number[],
  r: number,
): number[][] {
  const n = xs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) < r) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/**
 * Screen-space fan positions for a spiderfied cluster: pins spread on a
 * circle around the true city point (cx, cy), first pin at the top. Radius
 * grows with the count so markers never overlap; everything stays within a
 * small, fixed pixel distance of the saved city at any zoom.
 */
export function spiderfyPositions(
  count: number,
  cx: number,
  cy: number,
): [number, number][] {
  if (count === 1) return [[cx, cy - 26]];
  const r = Math.max(26, 9 * count);
  return Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** Rescale a view from old canvas base size (w,h) to a new one (nw,nh),
 * keeping every base point at the same relative screen position. */
export function rescaleView(
  v: ViewState,
  w: number,
  h: number,
  nw: number,
  nh: number,
): ViewState {
  return clampView(
    { z: v.z, cx: (v.cx / w) * nw, cy: (v.cy / h) * nh },
    nw,
    nh,
  );
}

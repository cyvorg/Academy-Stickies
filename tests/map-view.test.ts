import { describe, expect, it } from "vitest";
import {
  clampView,
  clusterIndices,
  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  spiderfyPositions,
  toBase,
  toScreen,
  zoomAt,
} from "../src/map/view";

const W = 390;
const H = 203;

describe("map view math", () => {
  it("fit view shows the whole world centered", () => {
    const v = fitView(W, H);
    expect(v).toEqual({ z: 1, cx: W / 2, cy: H / 2 });
    // world corners land on canvas corners
    expect(toScreen(v, W, H, 0, 0)).toEqual([0, 0]);
    expect(toScreen(v, W, H, W, H)).toEqual([W, H]);
  });

  it("zoomAt keeps the cursor's world point fixed on screen", () => {
    const v0 = fitView(W, H);
    const cursor: [number, number] = [300, 120];
    const before = toBase(v0, W, H, ...cursor);
    const v1 = zoomAt(v0, W, H, ...cursor, 2.5);
    const after = toScreen(v1, W, H, ...before);
    expect(after[0]).toBeCloseTo(cursor[0], 6);
    expect(after[1]).toBeCloseTo(cursor[1], 6);
    expect(v1.z).toBeCloseTo(2.5);
  });

  it("clamps zoom and keeps the window inside the world", () => {
    const v = fitView(W, H);
    expect(zoomAt(v, W, H, 0, 0, 1000).z).toBe(MAX_ZOOM);
    expect(zoomAt(v, W, H, 0, 0, 0.001).z).toBe(MIN_ZOOM);
    // panning far past the edge clamps back inside
    const panned = panBy({ z: 2, cx: W / 2, cy: H / 2 }, W, H, -10000, 10000);
    const clamped = clampView(panned, W, H);
    expect(clamped.cx - W / clamped.z / 2).toBeGreaterThanOrEqual(0);
    expect(clamped.cx + W / clamped.z / 2).toBeLessThanOrEqual(W);
    expect(clamped.cy - H / clamped.z / 2).toBeGreaterThanOrEqual(0);
    expect(clamped.cy + H / clamped.z / 2).toBeLessThanOrEqual(H);
    // at fit zoom the center cannot move
    expect(panBy(v, W, H, 50, 50)).toEqual(v);
  });

  it("round-trips base and screen coordinates", () => {
    const v = zoomAt(fitView(W, H), W, H, 100, 80, 3);
    const p: [number, number] = [123.4, 56.7];
    expect(toBase(v, W, H, ...toScreen(v, W, H, ...p))).toEqual([
      expect.closeTo(p[0], 6),
      expect.closeTo(p[1], 6),
    ]);
  });
});

describe("clusterIndices", () => {
  it("groups points within the radius, transitively", () => {
    // chain a-b-c with each link < r but a..c > r: one cluster
    const xs = [0, 20, 39, 200];
    const ys = [0, 0, 0, 0];
    const groups = clusterIndices(xs, ys, 25).map((g) => g.sort());
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([0, 1, 2]);
    expect(groups[1]).toEqual([3]);
  });

  it("keeps separated points as singletons", () => {
    const groups = clusterIndices([0, 100, 300], [0, 100, 0], 25);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 1, 1]);
  });

  it("handles an empty pin set", () => {
    expect(clusterIndices([], [], 25)).toEqual([]);
  });
});

describe("spiderfyPositions", () => {
  it("fans pins on a small screen-space circle around the true city", () => {
    const pos = spiderfyPositions(6, 100, 80);
    expect(pos).toHaveLength(6);
    for (const [x, y] of pos) {
      const d = Math.hypot(x - 100, y - 80);
      // never far from the true spot, whatever the zoom
      expect(d).toBeGreaterThanOrEqual(28);
      expect(d).toBeLessThanOrEqual(70);
    }
    // no two markers overlap (pin radius 6)
    for (let i = 0; i < pos.length; i++)
      for (let j = i + 1; j < pos.length; j++)
        expect(
          Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]),
        ).toBeGreaterThan(12);
  });

  it("keeps a single pin just above the anchor", () => {
    expect(spiderfyPositions(1, 50, 60)).toEqual([[50, 34]]);
  });
});

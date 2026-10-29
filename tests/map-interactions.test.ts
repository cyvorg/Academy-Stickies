// Targeted regression tests for PR #4 review findings in the map code:
// globe far-side occlusion, 2D map resize rescale, and the stale async
// search guard. Each test includes a mutation probe showing the pre-fix
// behavior would have failed it.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { pickGlobePins } from "../src/map/globe";
import { spherePosition } from "../src/map/geo";
import { clampView, rescaleView, toScreen } from "../src/map/view";
import { SearchGuard } from "../shared/search-guard";
import type { MapPin } from "../shared/types";

const pin = (id: string, lat: number, lon: number): MapPin => ({
  id,
  name: id,
  avatarUrl: null,
  thumbUrl: null,
  city: "X",
  country: "Y",
  lat,
  lon,
  updatedAt: 0,
  source: "member",
  isMentor: false,
});

function pointsFor(pins: MapPin[]): THREE.Points {
  const positions = new Float32Array(pins.length * 3);
  pins.forEach((p, i) => positions.set(spherePosition(p.lat, p.lon, 1.01), i * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const pts = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 7 }));
  pts.updateMatrixWorld(true);
  return pts;
}

describe("globe tap occlusion", () => {
  // Camera on +z looking at the origin: lat 0/lon -90 is the near-side dot,
  // lat 0/lon 90 is the far-side dot on the SAME tap ray through the center.
  const front = pin("front", 0, -90);
  const back = pin("back", 0, 90);
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial(),
  );
  sphere.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100);
  camera.position.set(0, 0, 2.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 0.03 };
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

  it("mutation probe: the raw ray hits BOTH dots on the same ray", () => {
    const hits = raycaster.intersectObject(pointsFor([front, back]));
    expect(hits.length).toBe(2); // what the pre-fix code acted on
  });

  it("keeps the near-side dot and rejects the occluded far-side dot", () => {
    const picked = pickGlobePins(raycaster, pointsFor([front, back]), sphere, [
      front,
      back,
    ]);
    expect(picked.map((p) => p.id)).toEqual(["front"]);
  });
});

describe("2D map resize rescale", () => {
  // The production canvas height rule: nh = max(220, round(nw * 0.52)).
  const W = 1280, H = 666, NW = 700, NH = 364;
  // A zoomed+panned view, i.e. anything but the initial fit.
  const view = clampView({ z: 3, cx: 900, cy: 420 }, W, H);
  // A pin's base coords before resize; after resize the pin is re-projected
  // from lat/lon onto the new base grid, i.e. scaled by (NW/W, NH/H).
  const pinBase: [number, number] = [1000, 500];
  const pinRescaled: [number, number] = [
    (pinBase[0] / W) * NW,
    (pinBase[1] / H) * NH,
  ];

  it("keeps every pin at the same relative screen position after resize", () => {
    const before = toScreen(view, W, H, pinBase[0], pinBase[1]);
    const resized = rescaleView(view, W, H, NW, NH);
    const after = toScreen(resized, NW, NH, pinRescaled[0], pinRescaled[1]);
    expect(after[0]).toBeCloseTo((before[0] / W) * NW, 6);
    expect(after[1]).toBeCloseTo((before[1] / H) * NH, 6);
  });

  it("mutation probe: reusing the old view at the new size drifts off-center", () => {
    const before = toScreen(view, W, H, pinBase[0], pinBase[1]);
    const drifted = toScreen(
      clampView(view, NW, NH),
      NW,
      NH,
      pinRescaled[0],
      pinRescaled[1],
    );
    const expectedX = (before[0] / W) * NW;
    expect(Math.abs(drifted[0] - expectedX)).toBeGreaterThan(50); // pre-fix behavior
  });
});

describe("async search guard", () => {
  it("drops a stale query that resolves after a newer one", async () => {
    const guard = new SearchGuard();
    const applied: string[] = [];
    const deferred = <T>(v: T) => {
      let resolve!: (v: T) => void;
      const p = new Promise<T>((r) => (resolve = r));
      return { p, resolve };
    };
    const run = async (query: string, data: Promise<string[]>) => {
      const seq = guard.next();
      const results = await data;
      if (!guard.owns(seq)) return; // the guarded code path
      applied.push(...results);
    };
    const slow = deferred(["kuta-stale"]);
    const fast = deferred(["denpasar-fresh"]);
    const q1 = run("ku", slow.p);
    const q2 = run("den", fast.p);
    fast.resolve(fast.p && ["denpasar-fresh"]);
    await q2;
    slow.resolve(["kuta-stale"]); // the older query lands LAST
    await q1;
    expect(applied).toEqual(["denpasar-fresh"]);
  });

  it("mutation probe: without the guard the stale query wins", async () => {
    const applied: string[] = [];
    const deferred = <T>(v: T) => {
      let resolve!: (v: T) => void;
      const p = new Promise<T>((r) => (resolve = r));
      return { p, resolve };
    };
    const runNaive = async (data: Promise<string[]>) => {
      applied.push(...(await data)); // pre-fix behavior: last writer wins
    };
    const slow = deferred(["kuta-stale"]);
    const fast = deferred(["denpasar-fresh"]);
    const q1 = runNaive(slow.p);
    const q2 = runNaive(fast.p);
    fast.resolve(["denpasar-fresh"]);
    await q2;
    slow.resolve(["kuta-stale"]);
    await q1;
    expect(applied).toEqual(["denpasar-fresh", "kuta-stale"]); // wrong order = stale overwrite
  });
});

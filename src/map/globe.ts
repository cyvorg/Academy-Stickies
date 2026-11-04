/**
 * The 3D globe: a WebGL sphere (three.js) flat-textured with the same Natural
 * Earth outlines as the 2D map, one flat dot per member. Drag to spin, scroll
 * or pinch to zoom; it slowly rotates on its own when left alone. Tap a dot
 * for the member card. Loaded lazily - three.js only lands on devices that
 * open the globe.
 */
import * as THREE from "three";
import type { MapPin } from "../../shared/types";
import { paintWorld, spherePosition } from "./geo";
import { readColors, type MapController } from "./map2d";

const RADIUS = 1;
const MIN_DIST = 1.9;
const MAX_DIST = 4.6;

/** Paint the equirectangular world onto an offscreen canvas for the sphere. */
function earthTexture(colors: ReturnType<typeof readColors>): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 1024;
  const ctx = c.getContext("2d");
  if (ctx) {
    // Opaque ocean first: an unpainted texture renders black on the sphere.
    ctx.fillStyle = colors.ocean;
    ctx.fillRect(0, 0, c.width, c.height);
    paintWorld(ctx, c.width, c.height, colors.land, colors.border);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function pinPoints(pins: MapPin[], colors: ReturnType<typeof readColors>) {
  const positions = new Float32Array(pins.length * 3);
  const color = new Float32Array(pins.length * 3);
  const member = new THREE.Color(colors.member);
  const mentor = new THREE.Color(colors.mentor);
  // Every dot sits at its member's true saved city; co-located members stack,
  // and a tap raycasts through the stack to offer them all.
  pins.forEach((pin, i) => {
    const [x, y, z] = spherePosition(pin.lat, pin.lon, RADIUS * 1.01);
    positions.set([x, y, z], i * 3);
    const c = pin.isMentor ? mentor : member;
    color.set([c.r, c.g, c.b], i * 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const material = new THREE.PointsMaterial({
    size: 7,
    sizeAttenuation: false,
    vertexColors: true,
    map: dotTexture(),
    alphaTest: 0.5,
    transparent: true,
  });
  return new THREE.Points(geometry, material);
}

/** A soft round sprite so the square point quad renders as a dot. */
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.beginPath();
    ctx.arc(16, 16, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

/** Pins under a tap ray, far hemisphere occluded by the sphere: without the
 * sphere test a tap also returns dots directly behind the globe on the same
 * ray. Dots sit at 1.01 * RADIUS, so allow a small margin past the surface. */
export function pickGlobePins(
  raycaster: THREE.Raycaster,
  points: THREE.Points,
  sphere: THREE.Mesh,
  pins: MapPin[],
): MapPin[] {
  // All intersected dots, nearest first: co-located pins come back as a
  // cluster so nobody has to rotate-and-guess for an overlapping member.
  const hits = raycaster.intersectObject(points);
  const surface = raycaster.intersectObject(sphere)[0];
  const limit = surface ? surface.distance + 0.05 : Infinity;
  return hits
    .filter((h) => h.index !== undefined && h.distance <= limit)
    .map((h) => pins[h.index as number]);
}

export function startGlobe(
  canvas: HTMLCanvasElement,
  pins: MapPin[],
  onSelect: (pins: MapPin[]) => void,
): MapController {
  const colors = readColors();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 12);
  camera.position.z = 3;

  // Flat unlit sphere: the paper palette stays exactly as on the 2D map.
  const world = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS, 64, 48),
    new THREE.MeshBasicMaterial({ map: earthTexture(colors) }),
  );
  const points = pinPoints(pins, colors);
  world.add(sphere, points);
  scene.add(world);

  // Start facing the pins' center of mass (for the cohort, Kuta).
  const home = { y: 0, x: 0 };
  if (pins.length) {
    const lat = pins.reduce((s, p) => s + p.lat, 0) / pins.length;
    const lon = pins.reduce((s, p) => s + p.lon, 0) / pins.length;
    home.y = THREE.MathUtils.degToRad(-lon - 90);
    home.x = THREE.MathUtils.degToRad(lat * 0.5);
    world.rotation.y = home.y;
    world.rotation.x = home.x;
  }

  // --- interaction: drag to spin, pinch or wheel to zoom, tap to select ---
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;
  let pinchDist = 0;
  let autoRotate = true;
  let autoTimer = 0;

  const clampDist = () => {
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, MIN_DIST, MAX_DIST);
  };
  const pauseAuto = () => {
    autoRotate = false;
    window.clearTimeout(autoTimer);
    autoTimer = window.setTimeout(() => (autoRotate = true), 4000);
  };

  const onDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    pauseAuto();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pauseAuto();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && dist > 0) {
        camera.position.z *= pinchDist / dist;
        clampDist();
        moved = true;
      }
      pinchDist = dist;
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (moved) {
      world.rotation.y += dx * 0.005;
      world.rotation.x = THREE.MathUtils.clamp(world.rotation.x + dy * 0.003, -1.2, 1.2);
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (moved || pointers.size > 0) return; // a drag/pinch, not a tap
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.03 };
    raycaster.setFromCamera(ndc, camera);
    onSelect(pickGlobePins(raycaster, points, sphere, pins));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    pauseAuto();
    camera.position.z *= Math.exp(e.deltaY * 0.0012);
    clampDist();
  };

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = Math.max(280, Math.min(w, 520));
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  let raf = 0;
  function tick() {
    if (autoRotate) world.rotation.y += 0.0015;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", resize);
  canvas.style.cursor = "grab";
  resize();
  tick();

  return {
    zoomBy(factor: number) {
      camera.position.z /= factor;
      clampDist();
      pauseAuto();
    },
    reset() {
      camera.position.z = 3;
      world.rotation.y = home.y;
      world.rotation.x = home.x;
      autoRotate = true;
      onSelect([]);
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.clearTimeout(autoTimer);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", resize);
      sphere.geometry.dispose();
      (sphere.material as THREE.Material).dispose();
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
      renderer.dispose();
    },
  };
}

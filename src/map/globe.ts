/**
 * The 3D globe: a real WebGL sphere (three.js) textured with the same Natural
 * Earth outlines as the 2D map, one THREE.Points dot per member. Drag to
 * spin; it slowly rotates on its own when left alone. Tap a dot for the
 * member card. Loaded lazily — three.js only lands on devices that open the
 * globe.
 */
import * as THREE from "three";
import type { MapPin } from "../../shared/types";
import { paintWorld, spherePosition } from "./geo";
import { readColors } from "./map2d";

const RADIUS = 1;

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

export function startGlobe(
  canvas: HTMLCanvasElement,
  pins: MapPin[],
  onSelect: (pins: MapPin[]) => void,
): () => void {
  const colors = readColors();
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10);
  camera.position.z = 3;

  const world = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS, 64, 48),
    new THREE.MeshBasicMaterial({ map: earthTexture(colors) }),
  );
  const points = pinPoints(pins, colors);
  world.add(sphere, points);
  scene.add(world);

  // Start facing the pins' center of mass (for the cohort, Kuta).
  if (pins.length) {
    const lat = pins.reduce((s, p) => s + p.lat, 0) / pins.length;
    const lon = pins.reduce((s, p) => s + p.lon, 0) / pins.length;
    world.rotation.y = THREE.MathUtils.degToRad(-lon - 90);
    world.rotation.x = THREE.MathUtils.degToRad(lat * 0.5);
  }

  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  let autoRotate = true;

  const onDown = (e: PointerEvent) => {
    dragging = true;
    moved = false;
    autoRotate = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    world.rotation.y += dx * 0.005;
    world.rotation.x = THREE.MathUtils.clamp(
      world.rotation.x + dy * 0.003,
      -1.2,
      1.2,
    );
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    window.setTimeout(() => (autoRotate = true), 4000);
    if (moved) return; // a drag, not a tap
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.03 };
    raycaster.setFromCamera(ndc, camera);
    // All intersected dots, nearest first: co-located pins come back as a
    // cluster so nobody has to rotate-and-guess for an overlapping member.
    const hits = raycaster.intersectObject(points);
    onSelect(
      hits
        .filter((h) => h.index !== undefined)
        .map((h) => pins[h.index as number]),
    );
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
  window.addEventListener("resize", resize);
  resize();
  tick();

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    window.removeEventListener("resize", resize);
    sphere.geometry.dispose();
    (sphere.material as THREE.Material).dispose();
    points.geometry.dispose();
    (points.material as THREE.Material).dispose();
    renderer.dispose();
  };
}

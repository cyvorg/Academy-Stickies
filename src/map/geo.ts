/**
 * Shared geography helpers for the academy map: country outlines from Natural
 * Earth (via the world-atlas package, public domain) projected
 * equirectangularly. The 2D map paints these directly; the globe paints them
 * into a texture canvas, where the same projection wraps onto the sphere.
 */
import topology from "world-atlas/countries-110m.json";
import { feature } from "topojson-client";

export type Ring = [lon: number, lat: number][];
export type Polygon = Ring[];

let cached: Polygon[] | null = null;

/** Every country's outline as a flat list of polygons, [lon, lat] pairs. */
export function worldPolygons(): Polygon[] {
  if (cached) return cached;
  // world-atlas ships untyped JSON; the 110m file always has objects.countries.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fc: any = feature(topology as any, (topology as any).objects.countries);
  const polys: Polygon[] = [];
  for (const f of fc.features) {
    if (f.geometry.type === "Polygon") {
      polys.push(f.geometry.coordinates);
    } else if (f.geometry.type === "MultiPolygon") {
      polys.push(...f.geometry.coordinates);
    }
  }
  cached = polys;
  return polys;
}

/** Equirectangular projection: lon -180..180 -> x, lat 90..-90 -> y. */
export function project(
  lat: number,
  lon: number,
  w: number,
  h: number,
): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

/**
 * Fill land onto a canvas context. Rings that cross the antimeridian would
 * smear a line across the whole canvas, so a jump wider than half the map
 * starts a new subpath instead of drawing the segment.
 */
export function paintWorld(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fill: string,
  stroke: string,
): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(0.5, w / 2000);
  for (const poly of worldPolygons()) {
    for (const ring of poly) {
      ctx.beginPath();
      let prevX = 0;
      ring.forEach(([lon, lat], i) => {
        const [x, y] = project(lat, lon, w, h);
        if (i === 0 || Math.abs(x - prevX) > w / 2) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevX = x;
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** lat/lon -> unit-sphere position matching THREE.SphereGeometry's UV layout,
 *  so points land on the painted texture. */
export function spherePosition(
  lat: number,
  lon: number,
  radius: number,
): [number, number, number] {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const theta = ((90 - lat) / 180) * Math.PI;
  return [
    -radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

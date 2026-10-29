import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MapPin } from "../../shared/types";
import { locationStamp } from "../../shared/types";
import { getMapPins } from "../api";
import { Avatar } from "../components/Avatar";
import { Spinner } from "../components/controls";
import { useToast } from "../toast";

type Mode = "map" | "globe";

/** One member row: a real link to their wall, so it works with a keyboard,
 *  a screen reader, and without any canvas at all. */
function PinRow({ pin }: { pin: MapPin }) {
  return (
    <li>
      <a class="pinrow" href={`#/m/${pin.id}`}>
        <Avatar
          name={pin.name}
          url={pin.thumbUrl ?? pin.avatarUrl}
          zoomable={false}
        />
        <span class="pinrow__body">
          <span class="pinrow__name">
            {pin.name}
            {pin.isMentor && <span class="mapcard__badge">Mentor</span>}
          </span>
          {locationStamp(pin) && (
            <span class="pinrow__stamp">{locationStamp(pin)}</span>
          )}
        </span>
      </a>
    </li>
  );
}

/**
 * Where the academy is: every member who saved a city and hasn't hidden their
 * pin. The flat map is the default; the 3D globe is opt-in and lazy-loaded.
 * The list under the canvas is the keyboard/no-WebGL path and the way to
 * reach every member of a city cluster without precision tapping.
 */
export function MapView() {
  const toast = useToast();
  const [pins, setPins] = useState<MapPin[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("map");
  const [selected, setSelected] = useState<MapPin[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctlRef = useRef<{ zoomBy(f: number): void; reset(): void } | null>(null);

  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoadFailed(false);
    getMapPins()
      .then((p) => alive && setPins(p))
      .catch(() => {
        if (!alive) return;
        // A failed load must not sit on the spinner forever: show a real
        // error state with a retry instead of "Loading the map...". (Do not
        // setPins([]) here - an empty list reads as "nobody pinned yet".)
        setLoadFailed(true);
        toast("Couldn't load the map.", "error");
      });
    return () => {
      alive = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!pins || !canvasRef.current) return;
    let destroy: (() => void) | undefined;
    let alive = true;
    const loading = (
      mode === "map"
        ? import("../map/map2d").then((m) => m.startMap)
        : import("../map/globe").then((m) => m.startGlobe)
    );
    loading
      .then((start) => {
        if (!alive || !canvasRef.current) return;
        const ctl = start(canvasRef.current, pins, setSelected);
        ctlRef.current = ctl;
        destroy = ctl.destroy;
      })
      .catch(() => {
        if (!alive) return;
        if (mode === "globe") {
          // No WebGL (old device, blocked driver): the flat map and the list
          // below carry every member either way.
          toast("The globe needs WebGL - showing the flat map instead.", "error");
          setMode("map");
        } else {
          toast("Couldn't load the map renderer.", "error");
        }
      });
    return () => {
      alive = false;
      ctlRef.current = null;
      destroy?.();
    };
  }, [pins, mode]);

  /** Pins grouped by city for the accessible list. */
  const cities = useMemo(() => {
    if (!pins) return [];
    const groups = new Map<string, MapPin[]>();
    for (const pin of pins) {
      const key = `${pin.city}, ${pin.country}`;
      const g = groups.get(key);
      if (g) g.push(pin);
      else groups.set(key, [pin]);
    }
    return [...groups.entries()]
      .map(([where, members]) => ({ where, members }))
      .sort((a, b) => b.members.length - a.members.length);
  }, [pins]);

  const cluster = selected.length > 1 ? selected : null;
  const single = selected.length === 1 ? selected[0] : null;
  // A tap can catch pins from neighbouring cities (spiral spread), so only
  // name the place when every pin in the cluster shares it.
  const clusterWhere =
    cluster && cluster.every(
      (p) => p.city === cluster[0].city && p.country === cluster[0].country,
    )
      ? `${cluster[0].city}, ${cluster[0].country}`
      : null;

  return (
    <main class="page">
      <div class="mapview">
        <div class="mapview__bar">
          <p class="mapview__hint">
            {pins
              ? pins.length === 0
                ? "No one has pinned their city yet."
                : `${pins.length} ${pins.length === 1 ? "member" : "members"} on the map. Drag, scroll or pinch to explore - tap a marker, or use the list below.`
              : "Loading the map…"}
          </p>
          <div class="seg" role="group" aria-label="Map style">
            <button
              type="button"
              class="seg__btn"
              aria-pressed={mode === "map"}
              onClick={() => setMode("map")}
            >
              Map
            </button>
            <button
              type="button"
              class="seg__btn"
              aria-pressed={mode === "globe"}
              onClick={() => setMode("globe")}
            >
              Globe
            </button>
          </div>
        </div>

        {pins === null && loadFailed ? (
          <div class="center-screen">
            <p>The map didn't load.</p>
            <button
              type="button"
              class="btn btn--plain"
              onClick={() => setLoadAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : pins === null ? (
          <div class="center-screen">
            <Spinner />
          </div>
        ) : (
          <>
            {pins.length > 0 && (
              <div class="mapview__stage">
                {/* Keyed by mode: a canvas that already has a 2D context cannot
                    become a WebGL one, so the globe needs a fresh element. */}
                <canvas
                  key={mode}
                  ref={canvasRef}
                  class="mapview__canvas"
                  role="img"
                  aria-label={`World map with ${pins.length} member pins`}
                />
                {/* Top-right of the stage: always scrollable clear of the
                    fixed New Sticky button's bottom-right lane. */}
                <div class="mapzoom">
                  <button
                    type="button"
                    class="mapzoom__btn"
                    aria-label="Zoom in"
                    onClick={() => ctlRef.current?.zoomBy(1.6)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="mapzoom__btn"
                    aria-label="Zoom out"
                    onClick={() => ctlRef.current?.zoomBy(1 / 1.6)}
                  >
                    -
                  </button>
                  <button
                    type="button"
                    class="mapzoom__btn mapzoom__btn--reset"
                    aria-label="Reset the view"
                    onClick={() => ctlRef.current?.reset()}
                  >
                    &#x27F2;
                  </button>
                </div>
              </div>
            )}

            {single && (
              <div class="mapcard mapcard--flow">
                <Avatar
                  name={single.name}
                  url={single.thumbUrl ?? single.avatarUrl}
                  zoomable={false}
                />
                <span class="mapcard__body">
                  <a class="mapcard__name" href={`#/m/${single.id}`}>
                    {single.name}
                    {single.isMentor && (
                      <span class="mapcard__badge">Mentor</span>
                    )}
                  </a>
                  <span class="mapcard__where">
                    {single.city}, {single.country}
                  </span>
                  {locationStamp(single) && (
                    <span class="mapcard__stamp">{locationStamp(single)}</span>
                  )}
                </span>
              </div>
            )}

            {cluster && (
              <div class="mapcard mapcard--flow mapcard--cluster">
                <span class="mapcard__where">
                  {clusterWhere
                    ? `${clusterWhere} - ${cluster.length} members here:`
                    : `${cluster.length} members in this area:`}
                </span>
                <ul class="pinlist">
                  {cluster.map((pin) => (
                    <PinRow key={pin.id} pin={pin} />
                  ))}
                </ul>
              </div>
            )}

            {cities.length > 0 && (
              <div class="maplist">
                <div class="group__header">Everyone on the map</div>
                {cities.map(({ where, members }) => (
                  <details
                    key={where}
                    class="maplist__city"
                    open={cities.length <= 3}
                  >
                    <summary>
                      {where}
                      <span class="maplist__count">
                        {members.length}{" "}
                        {members.length === 1 ? "member" : "members"}
                      </span>
                    </summary>
                    <ul class="pinlist">
                      {members.map((pin) => (
                        <PinRow key={pin.id} pin={pin} />
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            )}
          </>
        )}

        <p class="mapview__credit">
          Only members who saved a city appear here, and anyone can hide their
          pin from Edit Profile. Markers spread a little around a city so every
          member stays tappable - the small dot is the city itself. City data ©
          GeoNames (CC BY 4.0), map outlines from Natural Earth (public
          domain).
        </p>
      </div>
    </main>
  );
}

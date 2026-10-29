import { useRef, useState } from "preact/hooks";
import type { City } from "../../shared/cities";
import { locationStamp } from "../../shared/types";
import type { Me } from "../../shared/types";
import { clearLocation, saveLocation, setLocationHidden } from "../api";
import { useToast } from "../toast";
import { SearchGuard } from "../../shared/search-guard";
import { guardedCitySearch } from "../../shared/city-search";

/**
 * The member's own pin on the academy map: pick a city from the bundled
 * dataset (never free text or GPS), remove it, or hide it without removing
 * it. Each action saves immediately, apart from the prose form around it.
 * The city dataset is a megabyte, so it lazy-loads on first use.
 */
export function LocationEditor({
  me,
  onMeChange,
}: {
  me: Me;
  onMeChange: (me: Me) => void;
}) {
  const toast = useToast();
  const [results, setResults] = useState<City[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic query guard: an async search that resolves late (the first one
  // waiting on the cities chunk) must never overwrite a newer query's results.
  const searchGuard = useRef(new SearchGuard()).current;
  const citiesModule = useRef<typeof import("../../shared/cities") | null>(
    null,
  );

  const location = me.location;

  async function ensureCities() {
    if (!citiesModule.current) {
      citiesModule.current = await import("../../shared/cities");
    }
    return citiesModule.current;
  }

  async function onSearch(value: string) {
    const outcome = await guardedCitySearch(searchGuard, value, ensureCities);
    if (outcome.status === "ok") {
      setResults(outcome.results);
    } else if (outcome.status === "failed") {
      toast("Couldn't load the city list. Check your connection and try again.", "error");
    }
  }

  async function pick(city: City) {
    setBusy(true);
    try {
      const updated = await saveLocation(city.id);
      onMeChange(updated);
      if (inputRef.current) inputRef.current.value = "";
      setResults([]);
      toast(
        updated.location?.hidden
          ? `${city.name} saved - your pin stays hidden from the map.`
          : `${city.name} is on the map.`,
      );
    } catch {
      toast("Couldn't save your city.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      onMeChange(await clearLocation());
      toast("Your pin is off the map.");
    } catch {
      toast("Couldn't remove your city.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleHidden(hidden: boolean) {
    setBusy(true);
    try {
      onMeChange(await setLocationHidden(hidden));
      toast(hidden ? "Your pin is hidden." : "Your pin is visible again.");
    } catch {
      toast("Couldn't change that setting.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="locedit">
      {location ? (
        <div class="locedit__current">
          <span class="locedit__city">
            {location.city}, {location.country}
          </span>
          {locationStamp(location) && (
            <span class="locedit__stamp">{locationStamp(location)}</span>
          )}
          {location.source === "admin" && (
            <span class="locedit__hint">
              Pick your city below to set your own pin - it will show as
              confirmed by you.
            </span>
          )}
        </div>
      ) : (
        <p class="editor__hint">
          Pin the city you're based in. Only the city shows - never your exact
          location.
        </p>
      )}

      <div class="locedit__search">
        <input
          ref={inputRef}
          class="field"
          type="search"
          placeholder="Search for your city…"
          disabled={busy}
          aria-label="Search for your city"
          onInput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
        />
        {results.length > 0 && (
          // In-flow, not an overlay: a floating dropdown lands under the
          // fixed New Sticky button on phones with no way to scroll clear.
          <ul class="locedit__results" role="listbox">
            {results.map((city) => (
              <li key={city.id}>
                <button
                  type="button"
                  class="locedit__result"
                  disabled={busy}
                  onClick={() => pick(city)}
                >
                  {city.name}
                  <span class="locedit__country">{city.country}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {location && (
        <div class="locedit__actions">
          <label class="locedit__hide">
            <input
              type="checkbox"
              checked={location.hidden}
              disabled={busy}
              onChange={(e) =>
                toggleHidden((e.currentTarget as HTMLInputElement).checked)
              }
            />
            Hide my pin from the map
          </label>
          <button
            type="button"
            class="btn btn--plain"
            disabled={busy}
            onClick={clear}
          >
            Remove city
          </button>
        </div>
      )}
    </div>
  );
}

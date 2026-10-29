import type { City } from "./cities";
import { SearchGuard } from "./search-guard";

/**
 * One city-search pass for the location editor: load the lazily-bundled
 * city dataset, then apply the newest query only. A chunk load that fails
 * (offline, deploy mid-session) resolves as "failed" so the caller can
 * surface it, instead of rejecting the input handler's promise silently.
 */
export type CitySearchOutcome =
  | { status: "ok"; results: City[] }
  | { status: "skipped" } // a newer query owns the results
  | { status: "failed" }; // the city dataset could not be loaded

export async function guardedCitySearch(
  guard: SearchGuard,
  query: string,
  ensureCities: () => Promise<{ searchCities(query: string): City[] }>,
): Promise<CitySearchOutcome> {
  const seq = guard.next();
  if (query.trim().length < 2) {
    return { status: "ok", results: [] };
  }
  let cities: { searchCities(query: string): City[] };
  try {
    cities = await ensureCities();
  } catch {
    return { status: "failed" };
  }
  if (!guard.owns(seq)) return { status: "skipped" };
  return { status: "ok", results: cities.searchCities(query) };
}

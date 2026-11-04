import { CITIES_DATA } from "./cities-data";

export interface City {
  id: number;
  name: string;
  countryCode: string;
  country: string;
  lat: number;
  lon: number;
}

const byId = new Map<number, City>();

/** Normalized so "denpasar" matches and diacritics don't matter. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const indexed: { city: City; key: string }[] = CITIES_DATA.cities.map(
  ([id, name, countryCode, lat, lon]) => {
    const city: City = {
      id,
      name,
      countryCode,
      country: CITIES_DATA.countries[countryCode] ?? countryCode,
      lat,
      lon,
    };
    byId.set(id, city);
    return { city, key: norm(name) };
  },
);

/** Kuta, Bali — the admin-set starting pin for the initial cohort. */
export const KUTA: City = byId.get(1639002) as City;

export function cityById(id: number): City | null {
  return byId.get(id) ?? null;
}

/**
 * Prefix matches first, then substring matches. At least two characters, so a
 * single letter doesn't scan 27k cities for nothing.
 */
export function searchCities(query: string, limit = 8): City[] {
  const q = norm(query.trim());
  if (q.length < 2) return [];
  const starts: City[] = [];
  const contains: City[] = [];
  for (const { city, key } of indexed) {
    if (key.startsWith(q)) {
      starts.push(city);
      if (starts.length >= limit) return starts;
    } else if (key.includes(q) && contains.length < limit) {
      contains.push(city);
    }
  }
  return starts.concat(contains).slice(0, limit);
}

import { describe, expect, it } from "vitest";
import { KUTA, cityById, searchCities } from "../shared/cities";
import { CITIES_DATA } from "../shared/cities-data";

describe("city dataset", () => {
  it("includes Kuta, Bali — the admin-set starting pin for the cohort", () => {
    expect(KUTA.name).toBe("Kuta");
    expect(KUTA.country).toBe("Indonesia");
    expect(KUTA.lat).toBeCloseTo(-8.72, 1);
    expect(KUTA.lon).toBeCloseTo(115.17, 1);
    expect(cityById(1639002)).toEqual(KUTA);
  });

  it("resolves every country code in the dataset", () => {
    for (const [, , cc] of CITIES_DATA.cities) {
      expect(CITIES_DATA.countries[cc]).toBeTruthy();
    }
  });

  it("returns null for unknown city ids", () => {
    expect(cityById(1)).toBeNull();
  });
});

describe("searchCities", () => {
  it("needs at least two characters", () => {
    expect(searchCities("k")).toEqual([]);
  });

  it("finds Kuta by prefix, case-insensitive", () => {
    const hits = searchCities("kuta");
    expect(hits.some((c) => c.id === 1639002)).toBe(true);
  });

  it("ranks prefix matches before substring matches", () => {
    const hits = searchCities("bali");
    expect(hits.length).toBeGreaterThan(0);
    // Normalize the way searchCities does, so "Bāli" counts as a prefix hit.
    const norm = (n: string) =>
      n
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    const firstSubstring = hits.findIndex((c) => !norm(c.name).startsWith("bali"));
    const prefixTail = hits.findLastIndex((c) => norm(c.name).startsWith("bali"));
    expect(firstSubstring === -1 || firstSubstring > prefixTail).toBe(true);
  });

  it("matches diacritic-free queries against accented names", () => {
    const hits = searchCities("malmo");
    expect(hits.some((c) => c.name === "Malmö")).toBe(true);
  });
});

// Regression tests for the PR #4 re-review finding: LocationEditor's
// onSearch awaited the lazily-loaded cities chunk with no rejection
// handling, so a failed chunk load (offline, mid-deploy) became an
// unhandled promise rejection with no member feedback. Includes a
// mutation probe showing the pre-fix flow would have failed the test.
import { describe, expect, it } from "vitest";
import { guardedCitySearch } from "../shared/city-search";
import { SearchGuard } from "../shared/search-guard";
import type { City } from "../shared/cities";

const city = (id: string, name: string): City => ({
  id,
  name,
  country: "X",
  lat: 0,
  lon: 0,
  admin1: null,
  population: 1,
} as City);

const loaded = {
  searchCities: (q: string) => [city("1", `${q}town`)],
};

describe("guardedCitySearch", () => {
  it("mutation probe: the pre-fix inline flow rejects on chunk failure", async () => {
    const failingEnsure = () => Promise.reject(new Error("chunk load failed"));
    // What onSearch did before the fix: await ensureCities() with no catch.
    const preFixOnSearch = async () => {
      const cities = await failingEnsure();
      return cities.searchCities("aa");
    };
    await expect(preFixOnSearch()).rejects.toThrow("chunk load failed");
  });

  it("resolves to failed (never rejects) when the cities chunk cannot load", async () => {
    const outcome = await guardedCitySearch(new SearchGuard(), "ber", () =>
      Promise.reject(new Error("chunk load failed")),
    );
    expect(outcome).toEqual({ status: "failed" });
  });

  it("returns matches from the loaded dataset for a fresh query", async () => {
    const outcome = await guardedCitySearch(
      new SearchGuard(),
      "ber",
      () => Promise.resolve(loaded),
    );
    expect(outcome).toEqual({ status: "ok", results: [city("1", "bertown")] });
  });

  it("clears results for sub-two-character queries without loading the chunk", async () => {
    let loads = 0;
    const outcome = await guardedCitySearch(new SearchGuard(), " b", () => {
      loads += 1;
      return Promise.resolve(loaded);
    });
    expect(outcome).toEqual({ status: "ok", results: [] });
    expect(loads).toBe(0);
  });

  it("marks a late-resolving older query as skipped", async () => {
    const guard = new SearchGuard();
    let release!: () => void;
    const slow = new Promise<typeof loaded>((resolve) => {
      release = () => resolve(loaded);
    });
    const pending = guardedCitySearch(guard, "ber", () => slow);
    // A newer query takes the guard before the slow chunk resolves.
    const newer = await guardedCitySearch(guard, "par", () =>
      Promise.resolve(loaded),
    );
    expect(newer.status).toBe("ok");
    release();
    const older = await pending;
    expect(older).toEqual({ status: "skipped" });
  });
});

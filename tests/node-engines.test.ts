// Regression test for the PR #4 re-review finding: engines.node
// ">=22.13.0" admitted Node 23.0-23.3.x, where node:sqlite is still
// behind --experimental-sqlite (per the Node API history, SQLite left the
// flag in v22.13.0 and v23.4.0). The range must reject the 23.0-23.3 gap.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { satisfies } from "semver";

const engines = JSON.parse(readFileSync("package.json", "utf8")).engines
  .node as string;

describe("engines.node range", () => {
  const cases: [string, boolean][] = [
    ["20.19.0", false], // below the node:sqlite unflagged floor
    ["22.12.0", false], // 22.x before node:sqlite unflagged
    ["22.13.0", true],
    ["22.23.4", true],
    ["23.0.0", false], // 23.x before node:sqlite unflagged
    ["23.2.0", false],
    ["23.3.1", false],
    ["23.4.0", true],
    ["23.11.0", true],
    ["24.0.0", true],
  ];
  for (const [version, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} Node ${version}`, () => {
      expect(satisfies(version, engines)).toBe(expected);
    });
  }
});

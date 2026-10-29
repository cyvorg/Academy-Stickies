import { describe, expect, it } from "vitest";
import { locationStamp } from "../shared/location";

describe("locationStamp", () => {
  it("labels member-set pins as confirmed", () => {
    const stamp = locationStamp({
      updatedAt: Date.UTC(2026, 9, 29) / 1000,
      source: "member",
    });
    expect(stamp).toMatch(/^Confirmed /);
    expect(stamp).not.toMatch(/not confirmed/);
  });

  it("shows no stamp text for admin-set pins (never member-confirmed)", () => {
    const stamp = locationStamp({
      updatedAt: Date.UTC(2026, 9, 29) / 1000,
      source: "admin",
    });
    expect(stamp).toBeNull();
  });
});

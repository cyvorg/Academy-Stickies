// Regression: the admin cohort initializer must never re-pin a member who
// explicitly REMOVED their city. Runs the actual SQL (shared
// ADMIN_PIN_FILTER_SQL) against an in-memory SQLite, mirroring D1.
import { describe, expect, it } from "vitest";
import { ADMIN_PIN_FILTER_SQL } from "../shared/location";

// Runtime lookup: vite's resolver doesn't know the node:sqlite builtin yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as any;

function freshDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE profiles (
    member_id TEXT PRIMARY KEY,
    city TEXT, country TEXT, lat REAL, lon REAL, city_id INTEGER,
    location_updated_at INTEGER, location_source TEXT,
    location_hidden INTEGER NOT NULL DEFAULT 0,
    is_mentor INTEGER
  )`);
  return db;
}

const pinSql = (now: number) =>
  `UPDATE profiles SET city='Kuta', country='Indonesia', lat=-8.72332,
     lon=115.17234, city_id=1639002, location_updated_at=${now},
     location_source='admin'
   WHERE ${ADMIN_PIN_FILTER_SQL}`;

const removeSql = `UPDATE profiles SET city=NULL, country=NULL, lat=NULL,
  lon=NULL, city_id=NULL, location_updated_at=1, location_source='member'
  WHERE member_id=?`;

type Row = { member_id: string; city: string | null; location_source: string | null };

function seed(db: any) {
  const ins = db.prepare(
    `INSERT INTO profiles (member_id, city, location_source, is_mentor) VALUES (?, ?, ?, ?)`,
  );
  ins.run("untouched", null, null, 0); // never made a choice -> gets pinned
  ins.run("admin-pinned", "Kuta", "admin", 0); // already pinned -> skipped
  ins.run("member-set", "Denpasar", "member", 0); // own city -> skipped
  ins.run("member-removed", null, "member", 0); // took pin down -> skipped
  ins.run("mentor", null, null, 1); // mentors excluded
  // Only reachable via the raw visibility API, never the UI: hidden with no
  // city at all. The explicit opt-out must not receive an admin pin.
  db.prepare(
    "INSERT INTO profiles (member_id, city, location_source, is_mentor, location_hidden) VALUES ('hidden-no-city', NULL, NULL, 0, 1)",
  ).run();
}

describe("admin cohort initializer rerun safety", () => {
  it("pins only learners who never made a location choice", () => {
    const db = freshDb();
    seed(db);
    db.exec(pinSql(Date.now()));
    const rows = db
      .prepare("SELECT member_id, city, location_source FROM profiles ORDER BY member_id")
      .all() as Row[];
    const by = Object.fromEntries(rows.map((r) => [r.member_id, r]));
    expect(by["untouched"].city).toBe("Kuta");
    expect(by["untouched"].location_source).toBe("admin");
    expect(by["admin-pinned"].location_source).toBe("admin");
    expect(by["member-set"].city).toBe("Denpasar");
    expect(by["member-set"].location_source).toBe("member");
    expect(by["member-removed"].city).toBeNull();
    expect(by["member-removed"].location_source).toBe("member");
    expect(by["mentor"].city).toBeNull();
    expect(by["hidden-no-city"].city).toBeNull();
    expect(by["hidden-no-city"].location_source).toBeNull();
    db.close();
  });

  it("a rerun after an explicit removal does not resurrect the pin", () => {
    const db = freshDb();
    seed(db);
    db.exec(pinSql(Date.now()));
    // The member removes their (admin-set or own) city, then the admin
    // initializer runs again for new joiners.
    db.prepare(removeSql).run("admin-pinned");
    db.exec(pinSql(Date.now()));
    const row = db
      .prepare("SELECT city, location_source FROM profiles WHERE member_id='admin-pinned'")
      .get() as Row;
    expect(row.city).toBeNull();
    expect(row.location_source).toBe("member");
    // ...while genuinely new members still get pinned on that rerun.
    db.prepare(
      "INSERT INTO profiles (member_id, city, location_source, is_mentor) VALUES ('new-joiner', NULL, NULL, 0)",
    ).run();
    db.exec(pinSql(Date.now()));
    const nj = db
      .prepare("SELECT city FROM profiles WHERE member_id='new-joiner'")
      .get() as Row;
    expect(nj.city).toBe("Kuta");
    db.close();
  });
});

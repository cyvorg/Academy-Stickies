// Regression for PR #4 review findings: the location routes must upsert
// (seeded members can have no profile row) and the visibility route must
// never write on a malformed body. Runs the real route handlers against an
// in-memory SQLite behind a minimal D1-compatible shim.
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, COOKIE_NAME } from "../lib/auth";
import { ADMIN_PIN_FILTER_SQL, ADMIN_PIN_INSERT_SQL } from "../shared/location";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as any;

const SCHEMA = `
CREATE TABLE members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  avatar_key TEXT, login_token TEXT NOT NULL UNIQUE,
  wall_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_login_at INTEGER,
  notifications_seen_at INTEGER
);
CREATE TABLE profiles (
  member_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL, session TEXT, tagline TEXT, photo_key TEXT, thumb_key TEXT,
  intro TEXT, sections TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  city TEXT, country TEXT, lat REAL, lon REAL, city_id INTEGER,
  location_updated_at INTEGER, location_source TEXT,
  location_hidden INTEGER NOT NULL DEFAULT 0,
  is_mentor INTEGER NOT NULL DEFAULT 0,
  role TEXT, nickname TEXT, skills TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE stickies (
  id TEXT PRIMARY KEY, recipient_id TEXT, created_at INTEGER NOT NULL
);`;

/** Tiny D1Database stand-in over node:sqlite: the prepare/bind/run/first/all
 *  surface the routes actually use. */
class FakeD1 {
  private db: any;
  constructor(db: any) {
    this.db = db;
  }
  prepare(sql: string) {
    const db = this.db;
    return {
      bind(...args: unknown[]) {
        const stmt = db.prepare(sql);
        return {
          run: () => {
            const info = stmt.run(...(args as any[]));
            return { success: true, meta: { changes: info.changes } };
          },
          all: async () => ({ results: stmt.all(...(args as any[])) }),
          first: async () => stmt.get(...(args as any[])) ?? null,
        };
      },
    };
  }
}

async function makeApp() {
  const { onRequest } = await import("../functions/api/[[route]]");
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const env = {
    DB: new FakeD1(db),
    SESSION_SECRET: "test-secret",
    MEDIA: { delete: async () => {} },
  };
  const call = (path: string, init: RequestInit = {}) =>
    onRequest({ request: new Request(`http://local/api${path}`, init), env } as any);
  return { db, env, call };
}

async function login(env: any, memberId: string): Promise<string> {
  const s = await createSession(memberId, env.SESSION_SECRET);
  return `${COOKIE_NAME}=${s.value}`;
}

function addMember(db: any, id: string) {
  db.prepare(
    "INSERT INTO members (id, name, email, login_token, created_at) VALUES (?, ?, ?, ?, 1)",
  ).run(id, "Test Member", `${id}@x.test`, `tok-${id}`);
}

const KUTA_ID = 1639002;

describe("location routes (upsert + strict visibility)", () => {
  let db: any, env: any, call: any;
  beforeEach(async () => {
    ({ db, env, call } = await makeApp());
  });

  it("saves a city for a member who has no profile row", async () => {
    addMember(db, "no-profile");
    const res = await call("/me/location", {
      method: "PUT",
      headers: { cookie: await login(env, "no-profile"), "content-type": "application/json" },
      body: JSON.stringify({ cityId: KUTA_ID }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT city, location_source FROM profiles WHERE member_id='no-profile'")
      .get() as any;
    expect(row?.city).toBe("Kuta");
    expect(row?.location_source).toBe("member");
  });

  it("persists the removal tombstone for a member who has no profile row", async () => {
    addMember(db, "no-profile-del");
    const res = await call("/me/location", {
      method: "DELETE",
      headers: { cookie: await login(env, "no-profile-del") },
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT city, location_source FROM profiles WHERE member_id='no-profile-del'")
      .get() as any;
    expect(row?.city).toBeNull();
    expect(row?.location_source).toBe("member");
  });

  it("rejects a malformed visibility body WITHOUT un-hiding the pin", async () => {
    addMember(db, "hidden-member");
    db.prepare(
      "INSERT INTO profiles (member_id, slug, city, location_source, location_hidden, updated_at) VALUES ('hidden-member', 's', 'Kuta', 'member', 1, 1)",
    ).run();
    const cookie = await login(env, "hidden-member");
    for (const bad of ["not json at all", "{}", '{"hidden":"yes"}', '{"hidden":1}']) {
      const res = await call("/me/location-visibility", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: bad,
      });
      expect(res.status).toBe(400);
      const row = db
        .prepare("SELECT location_hidden FROM profiles WHERE member_id='hidden-member'")
        .get() as any;
      expect(row?.location_hidden).toBe(1);
    }
  });

  it("applies a valid visibility toggle, creating the row if needed", async () => {
    addMember(db, "toggler");
    const cookie = await login(env, "toggler");
    const res = await call("/me/location-visibility", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ hidden: true }),
    });
    expect(res.status).toBe(200);
    expect(
      (db.prepare("SELECT location_hidden FROM profiles WHERE member_id='toggler'").get() as any)
        ?.location_hidden,
    ).toBe(1);
  });

  it("admin initializer pins members without profile rows, skips tombstones", () => {
    addMember(db, "fresh-member");
    addMember(db, "removed-member");
    db.prepare(
      "INSERT INTO profiles (member_id, slug, city, location_source, updated_at) VALUES ('removed-member', 's', NULL, 'member', 1)",
    ).run();
    const now = Date.now();
    const insertSql = ADMIN_PIN_INSERT_SQL.replace(":city", "'Kuta'")
      .replace(":country", "'Indonesia'")
      .replace(":lat", "-8.72332")
      .replace(":lon", "115.17234")
      .replace(":city_id", "1639002")
      .replace(/:now/g, String(now));
    db.exec(
      `UPDATE profiles SET city='Kuta', location_source='admin' WHERE ${ADMIN_PIN_FILTER_SQL};`,
    );
    db.exec(insertSql);
    expect(
      (db.prepare("SELECT city, location_source FROM profiles WHERE member_id='fresh-member'").get() as any)
        ?.city,
    ).toBe("Kuta");
    const removed = db
      .prepare("SELECT city, location_source FROM profiles WHERE member_id='removed-member'")
      .get() as any;
    expect(removed?.city).toBeNull();
    expect(removed?.location_source).toBe("member");
  });
});

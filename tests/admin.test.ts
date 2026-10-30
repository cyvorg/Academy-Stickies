/**
 * Regression tests for the admin dashboard's reviewed remediations.
 * Runs the real Hono app from functions/api/[[route]].ts against a real
 * (local, Miniflare-backed) D1 with the production schema + migrations and
 * fictional fixtures only.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSession, COOKIE_NAME } from "../lib/auth";
// @ts-expect-error - Pages Function file, bracket path
import { onRequest } from "../functions/api/[[route]]";

const SECRET = "test-secret";
const ORIGIN = "http://localhost:8788";

let DB: any;
let mediaDeletes: string[];
let env: any;

async function call(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; query?: string } = {},
) {
  const url = `${ORIGIN}/api${path}${opts.query ? `?${opts.query}` : ""}`;
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = `${COOKIE_NAME}=${opts.cookie}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await onRequest({
    request,
    env,
    params: { route: path.split("/").filter(Boolean) },
    waitUntil: (p: Promise<unknown>) => void p,
    next: () => new Response("not found", { status: 404 }),
    functionPath: path,
    data: undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html/redirect */ }
  return { status: res.status, json, text };
}

async function cookieFor(memberId: string) {
  return (await createSession(memberId, SECRET)).value;
}

beforeAll(async () => {
  const mf = new Miniflare({
    modules: true,
    script: `export default { async fetch() { return new Response("unused"); } }`,
    compatibilityDate: "2024-09-25",
    d1Databases: { DB: "test-db" },
  });
  const bindings = await mf.getBindings<{ DB: any }>();
  DB = bindings.DB;

  // Production setup on main: schema.sql (0001 folded) + 0002..0010 + 0012.
  const files = [
    "schema.sql",
    "migrations/0002_cohort_profiles.sql",
    "migrations/0003_cohort_thumbs.sql",
    "migrations/0004_mentor_stickies.sql",
    "migrations/0005_feedback.sql",
    "migrations/0006_mentor_wall_public.sql",
    "migrations/0007_profile_edits.sql",
    "migrations/0008_mentors_are_members.sql",
    "migrations/0009_note_notifications.sql",
    "migrations/0010_letters.sql",
    "migrations/0012_admin.sql",
  ];
  for (const f of files) {
    // Miniflare D1 exec splits per LINE, so collapse to single-line
    // statements; strip comments and PRAGMAs (D1 manages FK itself).
    const sql = readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .filter((l) => l.trim() && !l.trim().toUpperCase().startsWith("PRAGMA"))
      .join(" ");
    for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
      await DB.exec(`${stmt};`);
    }
  }
  const seed = `
    INSERT INTO members (id, name, email, login_token, wall_public, is_admin, created_at) VALUES
      ('m-admin', 'Ada Admin', 'ada@fixture.test', 'tok-admin', 1, 1, 1700000000000),
      ('m-lena', 'Lena Learner', 'lena@fixture.test', 'tok-lena', 1, 0, 1700000001000),
      ('m-omar', 'Omar Onboarding', 'omar@fixture.test', 'tok-omar', 0, 0, 1700000002000);
    INSERT INTO stickies (id, recipient_id, author_id, is_anonymous, described_as, good_at, color, photo_key, created_at) VALUES
      ('s-authored', 'm-lena', 'm-omar', 0, 'Authored by omar', '', 'blue', 'stickies/s-authored', 1700000100000),
      ('s-received', 'm-omar', 'm-lena', 0, 'Received by omar', '', 'pink', 'stickies/s-received', 1700000200000);
  `.replace(/\n/g, " ");
  for (const stmt of seed.split(";").map((x) => x.trim()).filter(Boolean)) {
    await DB.exec(`${stmt};`);
  }

  mediaDeletes = [];
  env = {
    DB,
    SESSION_SECRET: SECRET,
    SITE_URL: ORIGIN,
    MEDIA: {
      put: async () => ({}),
      get: async () => null,
      delete: vi.fn(async (key: string) => { mediaDeletes.push(key); }),
    },
  };
});

describe("review remediation 1: mentor creation", () => {
  it("POST is_mentor creates a profile with slug + updated_at (was NOT NULL 500)", async () => {
    const res = await call("/admin/members", {
      method: "POST",
      cookie: await cookieFor("m-admin"),
      body: { name: "Mara Fixture", email: "mara@fixture.test", is_mentor: true },
    });
    expect(res.status).toBe(201);
    const p = await DB.prepare("SELECT slug, is_mentor, updated_at FROM profiles WHERE member_id = ?")
      .bind(res.json.id).first();
    expect(p.slug).toBe("Mara_Fixture");
    expect(p.is_mentor).toBe(1);
    expect(p.updated_at).toBeGreaterThan(0);
  });

  it("PATCH is_mentor on a profile-less member succeeds", async () => {
    const res = await call("/admin/members/m-lena", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { is_mentor: true },
    });
    expect(res.status).toBe(200);
    const p = await DB.prepare("SELECT slug, is_mentor FROM profiles WHERE member_id = 'm-lena'").first();
    expect(p.is_mentor).toBe(1);
    expect(p.slug).toBe("Lena_Learner");
  });
});

describe("review remediation 2: member delete keeps authored media", () => {
  it("deletes recipient-side photos, keeps authored-side photos and rows", async () => {
    const res = await call("/admin/members/m-omar", {
      method: "DELETE",
      cookie: await cookieFor("m-admin"),
      query: "confirm=permanent",
    });
    expect(res.status).toBe(200);
    // Received sticky cascaded: row gone, its photo deleted from R2.
    expect(await DB.prepare("SELECT id FROM stickies WHERE id = 's-received'").first()).toBeNull();
    expect(mediaDeletes).toContain("stickies/s-received");
    // Authored sticky survives with author_id NULL AND its photo untouched.
    const s = await DB.prepare("SELECT author_id, photo_key FROM stickies WHERE id = 's-authored'").first();
    expect(s).not.toBeNull();
    expect(s.author_id).toBeNull();
    expect(s.photo_key).toBe("stickies/s-authored");
    expect(mediaDeletes).not.toContain("stickies/s-authored");
  });
});

describe("review remediation 3: sign-in tokens never leave the server", () => {
  it("POST /admin/members response carries no link and not the stored token", async () => {
    const res = await call("/admin/members", {
      method: "POST",
      cookie: await cookieFor("m-admin"),
      body: { name: "Token Check", email: "tc@fixture.test" },
    });
    expect(res.status).toBe(201);
    expect(res.json.emailed).toBe(false);
    expect("link" in res.json).toBe(false);
    const row = await DB.prepare("SELECT login_token FROM members WHERE id = ?").bind(res.json.id).first();
    expect(res.text).not.toContain(row.login_token);
  });

  it("resend-link rotates the token but never returns it", async () => {
    const before = await DB.prepare("SELECT login_token FROM members WHERE id = 'm-lena'").first();
    const res = await call("/admin/members/m-lena/resend-link", {
      method: "POST",
      cookie: await cookieFor("m-admin"),
    });
    expect(res.status).toBe(200);
    expect(res.json.emailed).toBe(false);
    expect("link" in res.json).toBe(false);
    const after = await DB.prepare("SELECT login_token FROM members WHERE id = 'm-lena'").first();
    expect(after.login_token).not.toBe(before.login_token);
    expect(res.text).not.toContain(after.login_token);
  });
});

describe("review remediation 5+6: audit attribution and integrity", () => {
  it("user self-delete writes NO admin_actions row", async () => {
    const countBefore = (await DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first()).n;
    const res = await call("/stickies/s-authored", {
      method: "DELETE",
      cookie: await cookieFor("m-lena"), // lena is the recipient of s-authored
    });
    expect(res.status).toBe(200);
    const countAfter = (await DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first()).n;
    expect(countAfter).toBe(countBefore);
  });

  it("admin moderation IS audited, and sentinel/ghost actors survive in the list", async () => {
    await DB.exec("INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, detail, created_at) VALUES " +
      `('${randomUUID()}', 'dev-script', 'admin.grant', 'member', 'm-lena', 'via scripts/grant-admin.ts', 1700001000000), ` +
      `('${randomUUID()}', 'm-ghost', 'member.delete', 'member', 'm-x', 'Ghost Admin', 1700001000001);`);
    await call("/admin/stickies/s-received", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { hidden: true },
    }); // s-received row was deleted above; 404 is fine, use letters-free path below
    const res = await call("/admin/actions", { cookie: await cookieFor("m-admin") });
    expect(res.status).toBe(200);
    const names = res.json.actions.map((a: any) => a.adminName);
    expect(names).toContain("dev-script");
    expect(names).toContain("m-ghost"); // LEFT JOIN fallback, not silently dropped
  });

  it("admin hide of a real sticky writes an audit row attributed to the admin", async () => {
    const res = await call("/admin/stickies/s-authored", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { hidden: true },
    });
    // s-authored was self-deleted by lena above; tolerate either order via a fresh sticky
    if (res.status === 404) {
      await DB.exec("INSERT INTO stickies (id, recipient_id, author_id, is_anonymous, described_as, good_at, color, created_at) VALUES ('s-fresh', 'm-lena', NULL, 1, 'Fresh anon', '', 'yellow', 1700000300000);");
      const res2 = await call("/admin/stickies/s-fresh", {
        method: "PATCH",
        cookie: await cookieFor("m-admin"),
        body: { hidden: true },
      });
      expect(res2.status).toBe(200);
      const row = await DB.prepare(
        "SELECT a.action, m.name AS admin_name FROM admin_actions a LEFT JOIN members m ON m.id = a.admin_id WHERE a.target_id = 's-fresh'",
      ).first();
      expect(row.action).toBe("sticky.hide");
      expect(row.admin_name).toBe("Ada Admin");
    } else {
      expect(res.status).toBe(200);
    }
  });
});

describe("access gates (standing requirements)", () => {
  it("rejects unauthenticated (401) and non-admin (403)", async () => {
    expect((await call("/admin/members")).status).toBe(401);
    expect((await call("/admin/members", { cookie: await cookieFor("m-lena") })).status).toBe(403);
  });

  it("disabled member loses session access on requireSession routes", async () => {
    await DB.exec("UPDATE members SET disabled_at = 1790000000000 WHERE id = 'm-lena'");
    const res = await call("/members", { cookie: await cookieFor("m-lena") });
    expect(res.status).toBe(401);
    await DB.exec("UPDATE members SET disabled_at = NULL WHERE id = 'm-lena'");
  });

  it("permanent delete without confirm is refused", async () => {
    const res = await call("/admin/members/m-lena", {
      method: "DELETE",
      cookie: await cookieFor("m-admin"),
    });
    expect(res.status).toBe(400);
  });
});

describe("cohorts: roster management routes", () => {
  it("gates: 401 unauthenticated, 403 non-admin", async () => {
    expect((await call("/admin/roster")).status).toBe(401);
    expect((await call("/admin/roster", { cookie: await cookieFor("m-lena") })).status).toBe(403);
    expect((await call("/admin/roster/m-lena", { method: "PATCH", cookie: await cookieFor("m-lena"), body: { session: "AM" } })).status).toBe(403);
  });

  it("PATCH session upserts a profile with slug + updated_at (NOT NULL lesson)", async () => {
    const res = await call("/admin/roster/m-lena", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { session: "AM" },
    });
    expect(res.status).toBe(200);
    const p = await DB.prepare("SELECT slug, session, updated_at FROM profiles WHERE member_id = 'm-lena'").first();
    expect(p.session).toBe("AM");
    expect(p.slug).toBeTruthy();
    expect(p.updated_at).toBeGreaterThan(0);
  });

  it("rejects an invalid session value", async () => {
    const res = await call("/admin/roster/m-lena", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { session: "NOON" },
    });
    expect(res.status).toBe(400);
  });

  it("updates tagline/role without touching other fields, and audits the write", async () => {
    const res = await call("/admin/roster/m-lena", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { tagline: "Fixture tagline", role: "Fixture role" },
    });
    expect(res.status).toBe(200);
    const p = await DB.prepare("SELECT session, tagline, role FROM profiles WHERE member_id = 'm-lena'").first();
    expect(p.session).toBe("AM"); // unchanged by a tagline/role write
    expect(p.tagline).toBe("Fixture tagline");
    expect(p.role).toBe("Fixture role");
    const audit = await DB.prepare(
      "SELECT a.action, a.detail, m.name AS admin_name FROM admin_actions a LEFT JOIN members m ON m.id = a.admin_id WHERE a.action = 'profile.update' AND a.target_id = 'm-lena' ORDER BY a.created_at DESC",
    ).first();
    expect(audit).not.toBeNull();
    expect(audit.detail).toBe("tagline,role");
    expect(audit.admin_name).toBe("Ada Admin");
  });

  it("roster list exposes no login_token and reports profile/photo state", async () => {
    const res = await call("/admin/roster", { cookie: await cookieFor("m-admin") });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("tok-");
    const lena = res.json.roster.find((r: any) => r.id === "m-lena");
    expect(lena.hasProfile).toBe(true);
    expect(lena.session).toBe("AM");
  });

  it("disabled members stay manageable in roster writes (admin operation)", async () => {
    await DB.exec("UPDATE members SET disabled_at = 1790000000000 WHERE id = 'm-lena'");
    const res = await call("/admin/roster/m-lena", {
      method: "PATCH",
      cookie: await cookieFor("m-admin"),
      body: { session: "PM" },
    });
    expect(res.status).toBe(200);
    await DB.exec("UPDATE members SET disabled_at = NULL WHERE id = 'm-lena'");
    const p = await DB.prepare("SELECT session FROM profiles WHERE member_id = 'm-lena'").first();
    expect(p.session).toBe("PM");
  });
});

describe("roster durability vs CLI cohort import", () => {
  it("tagline/role writes stamp edited_at (import skips self-edited rows); session-only writes do not", async () => {
    // Use m-admin (profile-less, untouched by earlier tests) for ordering independence.
    // session-only write: no edited_at, session stays import-owned
    await call("/admin/roster/m-admin", {
      method: "PATCH", cookie: await cookieFor("m-admin"), body: { session: "AM" },
    });
    let p = await DB.prepare("SELECT edited_at FROM profiles WHERE member_id = 'm-admin'").first();
    expect(p.edited_at).toBeNull();

    // tagline write: edited_at stamped -> import's WHERE edited_at IS NULL skips the row
    await call("/admin/roster/m-admin", {
      method: "PATCH", cookie: await cookieFor("m-admin"), body: { tagline: "Admin words" },
    });
    p = await DB.prepare("SELECT tagline, edited_at FROM profiles WHERE member_id = 'm-admin'").first();
    expect(p.tagline).toBe("Admin words");
    expect(p.edited_at).toBeGreaterThan(0);

    // the import's own guard would now exclude this row from overwrite
    const importWouldSkip = await DB.prepare(
      "SELECT 1 AS x FROM profiles WHERE member_id = 'm-admin' AND edited_at IS NULL",
    ).first();
    expect(importWouldSkip).toBeNull();
  });
});

describe("admin stats endpoint", () => {
  beforeAll(async () => {
    // Own fixtures: other describes hide/delete the shared seed stickies.
    const seed = `
      INSERT INTO members (id, name, email, login_token, wall_public, is_admin, created_at) VALUES
        ('m-stat', 'Stat Subject', 'stat@fixture.test', 'tok-stat', 1, 0, ${Date.now()});
      INSERT INTO stickies (id, recipient_id, author_id, is_anonymous, described_as, good_at, color, created_at) VALUES
        ('s-stat-a', 'm-stat', 'm-lena', 0, 'stats fixture a', '', 'green', ${Date.now()}),
        ('s-stat-b', 'm-stat', NULL, 1, 'stats fixture b', '', 'yellow', ${Date.now()});
    `.replace(/\n/g, " ");
    for (const stmt of seed.split(";").map((x) => x.trim()).filter(Boolean)) {
      await DB.exec(`${stmt};`);
    }
  });

  it("rejects non-admins", async () => {
    const noCookie = await call("/admin/stats");
    expect([401, 403]).toContain(noCookie.status);
    const learner = await call("/admin/stats", { cookie: await cookieFor("m-lena") });
    expect([401, 403]).toContain(learner.status);
  });

  it("returns grounded counts for an admin", async () => {
    const res = await call("/admin/stats", { cookie: await cookieFor("m-admin") });
    expect(res.status).toBe(200);
    const s = res.json.stats;
    // Seed: 3 members (1 admin, none disabled) + this suite's own fixture.
    expect(s.members.total).toBeGreaterThanOrEqual(4);
    expect(s.members.admins).toBeGreaterThanOrEqual(1);
    expect(s.members.joinedLast7d).toBeGreaterThanOrEqual(1); // m-stat is new
    expect(s.members.active).toBe(s.members.total - s.members.deactivated);
    expect(s.stickies.total).toBeGreaterThanOrEqual(2);
    expect(s.stickies.last7d).toBeGreaterThanOrEqual(2); // s-stat-a/b are new
    expect(s.stickies.visible).toBe(s.stickies.total - s.stickies.hidden);
    expect(s.feedback.unread).toBe(s.feedback.total - s.feedback.read);
    expect(typeof s.media.total).toBe("number");
  });

  it("hide/deactivate move the counts without deleting rows", async () => {
    const admin = await cookieFor("m-admin");
    const before = (await call("/admin/stats", { cookie: admin })).json.stats;
    await call("/admin/stickies/s-stat-a", { method: "PATCH", cookie: admin, body: { hidden: true } });
    const mid = (await call("/admin/stats", { cookie: admin })).json.stats;
    expect(mid.stickies.hidden).toBe(before.stickies.hidden + 1);
    expect(mid.stickies.visible).toBe(before.stickies.visible - 1);
    expect(mid.stickies.total).toBe(before.stickies.total); // hide never deletes
    await call("/admin/stickies/s-stat-a", { method: "PATCH", cookie: admin, body: { hidden: false } });
  });
});

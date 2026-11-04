import { Hono } from "hono";
import type { Context, Next } from "hono";
import { handle } from "hono/cloudflare-pages";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  COOKIE_NAME,
  createSession,
  newId,
  randomToken,
  verifySession,
} from "../../lib/auth";
import {
  emailConfigured,
  sendFeedbackNotification,
  sendLetterNotification,
  sendMagicLink,
  sendStickyNotification,
} from "../../lib/email";
import {
  MAX_AVATAR_BYTES,
  MAX_PHOTO_BYTES,
  validateImage,
} from "../../lib/media";
import { pseudonymFor } from "../../lib/pseudonym";
import { cityById } from "../../shared/cities";
import type { LocationSource, MapPin, MemberLocation } from "../../shared/location";
import { sanitizeProfileInput } from "../../shared/profile";
import {
  LETTER_STYLES,
  MAX_FIELD_LEN,
  MAX_LETTER_BODY_LEN,
  MAX_LETTER_SUBJECT_LEN,
  STICKY_COLORS,
} from "../../shared/types";
import type {
  Letter,
  LetterStyle,
  Me,
  Mentor,
  Profile,
  ProfileLink,
  ProfileSection,
  RosterMember,
  Sticky,
  StickyColor,
  WallResponse,
} from "../../shared/types";

type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  SESSION_SECRET: string;
  SITE_URL?: string;
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  FEEDBACK_NOTIFY_EMAIL?: string;
};

const MAX_FEEDBACK_LEN = 2000;

interface MemberRow {
  id: string;
  name: string;
  email: string;
  avatar_key: string | null;
  login_token: string;
  wall_public: number;
  created_at: number;
  last_login_at: number | null;
  notifications_seen_at: number | null; // watermark for the red notification dot
  photo_key: string | null; // joined from profiles — the cohort photo
  thumb_key: string | null;
  session: string | null; // joined from profiles — AM/PM (learners)
  role: string | null; // joined from profiles — "Tech Mentor" etc. (mentors)
  city: string | null; // joined from profiles — self-reported city-level pin
  country: string | null;
  lat: number | null;
  lon: number | null;
  city_id: number | null;
  location_updated_at: number | null;
  location_source: string | null;
  location_hidden: number;
}

type Variables = { member: MemberRow; memberId: string };
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>().basePath("/api");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function siteOrigin(c: AppContext): string {
  if (c.env.SITE_URL) return c.env.SITE_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

function mediaUrl(key: string | null): string | null {
  return key ? `/api/media/${key}` : null;
}

// Mentors imported without a real email get a `<slug>@no-email.invalid`
// placeholder so the members row is valid; nothing should ever try to mail it.
const NO_EMAIL_DOMAIN = "@no-email.invalid";
function isDeliverable(email: string | null | undefined): boolean {
  return !!email && !email.endsWith(NO_EMAIL_DOMAIN);
}

/** A member's own upload wins; otherwise fall back to their cohort photo. */
function avatarUrl(m: {
  avatar_key: string | null;
  photo_key?: string | null;
}): string | null {
  return mediaUrl(m.avatar_key ?? m.photo_key ?? null);
}

/**
 * Small variant for lists. An uploaded avatar has no thumb (the browser sends a
 * single 512px crop), so it stands in for itself.
 */
function thumbUrl(m: {
  avatar_key: string | null;
  thumb_key?: string | null;
  photo_key?: string | null;
}): string | null {
  return mediaUrl(m.avatar_key ?? m.thumb_key ?? m.photo_key ?? null);
}

/** Profile prose is stored as JSON text in D1; never let a bad row 500 a page. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Received notes newer than the member's own-wall watermark — the red-dot
 *  count. A NULL watermark (never stamped) counts everything, but the 0009
 *  migration stamps every existing member, so in practice it means "since you
 *  last looked". */
async function unreadCountFor(c: AppContext, m: MemberRow): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM stickies
     WHERE recipient_id = ? AND created_at > ?`,
  )
    .bind(m.id, m.notifications_seen_at ?? 0)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function toMe(m: MemberRow, unreadCount: number): Me {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    avatarUrl: avatarUrl(m),
    wallPublic: m.wall_public === 1,
    unreadCount,
    location: memberLocation(m),
  };
}

/** The member's own pin as only they see it — hidden flag included. */
function memberLocation(m: MemberRow): MemberLocation | null {
  if (!m.city || m.lat === null || m.lon === null || m.city_id === null) {
    return null;
  }
  return {
    cityId: m.city_id,
    city: m.city,
    country: m.country ?? "",
    updatedAt: Math.floor((m.location_updated_at ?? 0) / 1000),
    source: (m.location_source === "admin" ? "admin" : "member") as LocationSource,
    hidden: m.location_hidden === 1,
  };
}

/** toMe with its notification count filled in — for the handful of routes that
 *  hand the frontend a fresh Me. */
async function meWithUnread(c: AppContext, m: MemberRow): Promise<Me> {
  return toMe(m, await unreadCountFor(c, m));
}

/**
 * Requires a valid session, and nothing else. The cookie is a signed payload
 * carrying the member id, so establishing *who* is asking costs no database
 * work at all — only routes that need the member's own name, email or avatar
 * key have to go and read the row (see requireAuth).
 *
 * That distinction is worth keeping: a roster page fires two dozen image
 * requests, and under requireAuth each one billed a D1 query before it could
 * hand back a 3KB thumbnail.
 */
async function requireSession(c: AppContext, next: Next) {
  const cookie = getCookie(c, COOKIE_NAME);
  const memberId = cookie
    ? await verifySession(cookie, c.env.SESSION_SECRET)
    : null;
  if (!memberId) return c.json({ error: "unauthorized" }, 401);

  c.set("memberId", memberId);
  await next();
}

/** requireSession, plus the member's own row. For routes that read fields
 *  beyond the id. A member deleted from the roster mid-session lands here. */
async function requireAuth(c: AppContext, next: Next) {
  const cookie = getCookie(c, COOKIE_NAME);
  const memberId = cookie
    ? await verifySession(cookie, c.env.SESSION_SECRET)
    : null;
  if (!memberId) return c.json({ error: "unauthorized" }, 401);

  const member = await c.env.DB.prepare(
    `SELECT m.*, p.photo_key, p.thumb_key, p.session, p.role,
            p.city, p.country, p.lat, p.lon, p.city_id,
            p.location_updated_at, p.location_source, p.location_hidden
     FROM members m LEFT JOIN profiles p ON p.member_id = m.id
     WHERE m.id = ?`,
  )
    .bind(memberId)
    .first<MemberRow>();
  if (!member) return c.json({ error: "unauthorized" }, 401);

  c.set("member", member);
  c.set("memberId", member.id);
  await next();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Magic link: GET /api/auth?token=... -> set cookie -> redirect to app.
app.get("/auth", async (c) => {
  const token = c.req.query("token");
  const origin = siteOrigin(c);
  if (!token) return c.redirect(`${origin}/?error=missing`);

  const member = await c.env.DB.prepare(
    "SELECT * FROM members WHERE login_token = ?",
  )
    .bind(token)
    .first<MemberRow>();
  if (!member) return c.redirect(`${origin}/?error=badlink`);

  const session = await createSession(member.id, c.env.SESSION_SECRET);
  setCookie(c, COOKIE_NAME, session.value, {
    httpOnly: true,
    secure: isHttps(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: session.maxAge,
  });

  await c.env.DB.prepare("UPDATE members SET last_login_at = ? WHERE id = ?")
    .bind(Date.now(), member.id)
    .run();

  return c.redirect(`${origin}/`);
});

app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// Optional self-service resend of a login link.
app.post("/request-link", async (c) => {
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({}) as { email?: string });
  const email = (body.email || "").trim().toLowerCase();
  if (!email) return c.json({ error: "email required" }, 400);

  if (!emailConfigured(c.env)) {
    return c.json({ sent: false, reason: "email-not-configured" });
  }

  const member = await c.env.DB.prepare(
    "SELECT * FROM members WHERE lower(email) = ?",
  )
    .bind(email)
    .first<MemberRow>();

  if (member) {
    const link = `${siteOrigin(c)}/api/auth?token=${member.login_token}`;
    try {
      await sendMagicLink(c.env, member.email, member.name, link);
    } catch (err) {
      console.error("sendMagicLink failed", err);
      return c.json({ sent: false, reason: "send-failed" }, 502);
    }
  }
  // Generic response regardless of whether the email is on the roster.
  return c.json({ sent: true });
});

// ---------------------------------------------------------------------------
// Current member
// ---------------------------------------------------------------------------

app.get("/me", requireAuth, async (c) => {
  return c.json(await meWithUnread(c, c.get("member")));
});

// Stamp "I've seen my wall" — clears the red notification dot. Cheap enough to
// run on requireSession alone; the update needs only the member id.
app.post("/me/seen", requireSession, async (c) => {
  const meId = c.get("memberId");
  await c.env.DB.prepare(
    "UPDATE members SET notifications_seen_at = ? WHERE id = ?",
  )
    .bind(Date.now(), meId)
    .run();
  return c.json({ unreadCount: 0 });
});

app.patch("/me", requireAuth, async (c) => {
  const member = c.get("member");
  const body = await c.req
    .json<{ wallPublic?: boolean }>()
    .catch(() => ({}) as { wallPublic?: boolean });
  if (typeof body.wallPublic !== "boolean") {
    return c.json({ error: "wallPublic (boolean) required" }, 400);
  }
  await c.env.DB.prepare("UPDATE members SET wall_public = ? WHERE id = ?")
    .bind(body.wallPublic ? 1 : 0, member.id)
    .run();
  return c.json({ ...(await meWithUnread(c, member)), wallPublic: body.wallPublic });
});

app.post("/me/avatar", requireAuth, async (c) => {
  const member = c.get("member");
  const body = await c.req.parseBody();
  const file = body["avatar"];
  if (!(file instanceof File)) {
    return c.json({ error: "avatar file required" }, 400);
  }
  const check = validateImage(file, MAX_AVATAR_BYTES);
  if (!check.ok) return c.json({ error: check.error }, 400);

  // Unique key per upload so browsers never serve a stale cached avatar.
  const key = `avatars/${member.id}-${Date.now()}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  // Best-effort cleanup of the previous avatar object.
  if (member.avatar_key) {
    c.executionCtx.waitUntil(
      c.env.MEDIA.delete(member.avatar_key).catch(() => {}),
    );
  }

  await c.env.DB.prepare("UPDATE members SET avatar_key = ? WHERE id = ?")
    .bind(key, member.id)
    .run();

  return c.json({ avatarUrl: `/api/media/${key}` });
});

/** A slug for a member who has no profile row yet (on the roster but absent
 *  from the Cohort/ import). Matches the import's fallback: whitespace → "_",
 *  then anything unsafe for a key stripped. profiles.slug is NOT NULL. */
function slugFromName(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "member";
}

// Members edit their own profile — name, tagline, intro, sections, links. The
// AM/PM session and cohort photo are roster facts, not self-description, so the
// upsert leaves them (and the slug) alone. Sanitizing is the server's job: it
// is the authority regardless of what the editor sent.
app.put("/me/profile", requireAuth, async (c) => {
  const member = c.get("member");
  const raw = await c.req.json().catch(() => ({}));
  const result = sanitizeProfileInput(raw);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const { name, tagline, intro, sections, links } = result.value;

  const now = Date.now();
  const sectionsJson = JSON.stringify(sections);
  const linksJson = JSON.stringify(links);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(
      name,
      member.id,
    ),
    // INSERT fires only for a member with no profile row; the ON CONFLICT branch
    // updates the prose and stamps edited_at (which stops a later cohort
    // re-import from overwriting these words) while leaving slug/session/photo.
    c.env.DB.prepare(
      `INSERT INTO profiles
         (member_id, slug, tagline, intro, sections, links, updated_at, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         tagline = excluded.tagline, intro = excluded.intro,
         sections = excluded.sections, links = excluded.links,
         updated_at = excluded.updated_at, edited_at = excluded.edited_at`,
    ).bind(
      member.id,
      slugFromName(name),
      tagline,
      intro,
      sectionsJson,
      linksJson,
      now,
      now,
    ),
  ]);

  const me: Me = { ...(await meWithUnread(c, member)), name };
  const profile: Profile = {
    session: member.session ?? null,
    role: member.role ?? null,
    tagline,
    intro,
    sections,
    links,
  };
  return c.json({ me, profile });
});


// A member pins themselves to a city from the bundled dataset — never raw
// coordinates, so no precise location can be stored even if a client sends it.
// The server re-resolves the id against the dataset and is the authority on
// what lands in D1. Saving a city never changes the hide-from-map opt-out.
app.put("/me/location", requireAuth, async (c) => {
  const member = c.get("member");
  const body = await c.req.json().catch(() => ({}));
  const cityId = Number((body as { cityId?: unknown }).cityId);
  if (!Number.isInteger(cityId)) {
    return c.json({ error: "cityId required" }, 400);
  }
  const city = cityById(cityId);
  if (!city) return c.json({ error: "unknown city" }, 400);

  // Upsert: seeded members can exist without a profile row (profiles is
  // LEFT JOINed in requireAuth), and an UPDATE-only write silently dropped
  // their saved city. The slug placeholder is the member id - profile-less
  // members have no roster card, so it is never rendered.
  await c.env.DB.prepare(
    `INSERT INTO profiles
       (member_id, slug, city, country, lat, lon, city_id, location_updated_at, location_source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'member', ?)
     ON CONFLICT(member_id) DO UPDATE SET
       city = excluded.city, country = excluded.country, lat = excluded.lat,
       lon = excluded.lon, city_id = excluded.city_id,
       location_updated_at = excluded.location_updated_at,
       location_source = 'member'`,
  )
    .bind(member.id, member.id, city.name, city.country, city.lat, city.lon, city.id, Date.now(), Date.now())
    .run();

  return c.json(await meWithUnread(c, { ...member, city: city.name, country: city.country, lat: city.lat, lon: city.lon, city_id: city.id, location_updated_at: Date.now(), location_source: "member" } as MemberRow));
});

// Remove the pin entirely. The geo fields clear, but location_source stays
// 'member': the removal IS the member's location choice, and the admin
// initializer (ADMIN_PIN_FILTER_SQL) only touches rows with no choice at all,
// so a rerun can never re-pin someone who took their pin down. The hide flag
// stays as the member left it, so re-adding a city later doesn't surprise
// them by showing it again.
app.delete("/me/location", requireAuth, async (c) => {
  const member = c.get("member");
  const now = Date.now();
  // Upsert: the removal tombstone (location_source='member', no city) must
  // persist even for a member without a profile row, or a later admin
  // initializer rerun could pin someone who took their pin down.
  await c.env.DB.prepare(
    `INSERT INTO profiles
       (member_id, slug, city, country, lat, lon, city_id, location_updated_at, location_source, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, 'member', ?)
     ON CONFLICT(member_id) DO UPDATE SET
       city = NULL, country = NULL, lat = NULL, lon = NULL, city_id = NULL,
       location_updated_at = excluded.location_updated_at,
       location_source = 'member'`,
  )
    .bind(member.id, member.id, now, now)
    .run();
  return c.json(await meWithUnread(c, { ...member, city: null, country: null, lat: null, lon: null, city_id: null, location_updated_at: now, location_source: "member" } as MemberRow));
});

// The opt-out: hidden pins never leave this query or the map endpoint. A
// hidden member keeps their saved city — only its visibility changes.
app.put("/me/location-visibility", requireAuth, async (c) => {
  const member = c.get("member");
  // Strict body: a malformed or missing payload must never WRITE - the old
  // catch-all read it as hidden=false and silently re-exposed a hidden city.
  const body = await c.req.json().catch(() => null);
  const hiddenRaw = (body as { hidden?: unknown } | null)?.hidden;
  if (typeof hiddenRaw !== "boolean") {
    return c.json({ error: "hidden must be a boolean" }, 400);
  }
  const hidden = hiddenRaw;
  await c.env.DB.prepare(
    `INSERT INTO profiles (member_id, slug, location_hidden, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       location_hidden = excluded.location_hidden`,
  )
    .bind(member.id, member.id, hidden ? 1 : 0, Date.now())
    .run();
  return c.json(
    await meWithUnread(c, { ...member, location_hidden: hidden ? 1 : 0 } as MemberRow),
  );
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

interface MapRow {
  id: string;
  name: string;
  avatar_key: string | null;
  photo_key: string | null;
  thumb_key: string | null;
  is_mentor: number;
  city: string;
  country: string;
  lat: number;
  lon: number;
  location_updated_at: number;
  location_source: string;
}

// Every member who has a pin and hasn't hidden it. Mentors are members too
// (0008), so they appear here with isMentor set; hidden rows are filtered in
// SQL so they never reach the client at all.
app.get("/map/members", requireSession, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.avatar_key, p.photo_key, p.thumb_key, p.is_mentor,
            p.city, p.country, p.lat, p.lon,
            p.location_updated_at, p.location_source
     FROM members m
     JOIN profiles p ON p.member_id = m.id
     WHERE p.city IS NOT NULL AND p.location_hidden = 0
     ORDER BY m.name`,
  ).all<MapRow>();
  const pins: MapPin[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    avatarUrl: avatarUrl(r),
    thumbUrl: thumbUrl(r),
    city: r.city,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    updatedAt: Math.floor(r.location_updated_at / 1000),
    source: (r.location_source === "admin" ? "admin" : "member") as LocationSource,
    isMentor: r.is_mentor === 1,
  }));
  return c.json({ pins });
});

// ---------------------------------------------------------------------------
// Roster + walls
// ---------------------------------------------------------------------------

interface RosterRow {
  id: string;
  name: string;
  avatar_key: string | null;
  wall_public: number;
  received_count: number;
  photo_key: string | null;
  thumb_key: string | null;
  session: string | null;
  tagline: string | null;
}

/** A roster row plus the prose only a single wall needs. */
interface ProfileRow extends RosterRow {
  intro: string | null;
  sections: string | null;
  links: string | null;
  role: string | null;
  is_mentor: number | null;
}

interface StickyRow {
  id: string;
  author_id: string | null;
  is_anonymous: number;
  described_as: string;
  good_at: string;
  color: string;
  photo_key: string | null;
  created_at: number;
  anon_name: string | null;
  anon_color: string | null;
  author_name: string | null;
}

interface LetterRow {
  id: string;
  recipient_id: string;
  author_id: string | null;
  is_anonymous: number;
  subject: string;
  body: string;
  paper_style: string;
  photo_key: string | null;
  is_opened: number;
  opened_at: number | null;
  created_at: number;
  anon_name: string | null;
  anon_color: string | null;
  author_name: string | null;
}

function toRosterMember(r: RosterRow, meId: string): RosterMember {
  return {
    id: r.id,
    name: r.name,
    avatarUrl: avatarUrl(r),
    thumbUrl: thumbUrl(r),
    wallPublic: r.wall_public === 1,
    isSelf: r.id === meId,
    receivedCount: r.received_count,
    session: r.session,
    tagline: r.tagline,
  };
}

// The roster deliberately carries only the card-sized bits of a profile
// (photo, session, tagline). The prose is fetched per member.
app.get("/members", requireSession, async (c) => {
  const meId = c.get("memberId");
  // Mentors are members too, but they have their own directory (/mentors), so
  // the learner roster leaves them out to avoid listing everyone twice.
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.avatar_key, m.wall_public,
            p.photo_key, p.thumb_key, p.session, p.tagline,
            (SELECT COUNT(*) FROM stickies s WHERE s.recipient_id = m.id) AS received_count
     FROM members m
     LEFT JOIN profiles p ON p.member_id = m.id
     WHERE COALESCE(p.is_mentor, 0) = 0
     ORDER BY m.name COLLATE NOCASE ASC`,
  ).all<RosterRow>();

  const members = (rows.results ?? []).map((r) => toRosterMember(r, meId));
  return c.json({ members });
});

// The mentor directory. Mentors are members flagged is_mentor = 1; the cards
// carry the role/skills this grid and its search show. A mentor's wall and
// notes are fetched per mentor by /members/:id — the same route learners use.
app.get("/mentors", requireSession, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.avatar_key, m.name,
            p.slug, p.nickname, p.role, p.skills, p.tagline, p.photo_key, p.thumb_key, p.intro, p.sections, p.links
     FROM members m
     JOIN profiles p ON p.member_id = m.id
     WHERE p.is_mentor = 1
     ORDER BY COALESCE(p.sort_order, 2147483647) ASC, m.name COLLATE NOCASE ASC`,
  ).all<{
    id: string;
    avatar_key: string | null;
    name: string;
    slug: string;
    nickname: string | null;
    role: string | null;
    skills: string;
    tagline: string | null;
    photo_key: string | null;
    thumb_key: string | null;
    intro: string | null;
    sections: string;
    links: string;
  }>();

  const mentors: Mentor[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    nickname: r.nickname,
    role: r.role,
    skills: parseJson<string[]>(r.skills, []),
    tagline: r.tagline,
    // A mentor who has uploaded their own avatar overrides the cohort photo.
    photoUrl: avatarUrl(r),
    thumbUrl: thumbUrl(r),
    intro: r.intro ?? "",
    sections: parseJson<ProfileSection[]>(r.sections, []),
    links: parseJson<ProfileLink[]>(r.links, []),
  }));
  return c.json({ mentors });
});

app.get("/members/:id", requireSession, async (c) => {
  const meId = c.get("memberId");
  const id = c.req.param("id");

  // The wall's two reads — whose wall it is, and what's on it — go out in one
  // batch. They aren't dependent (the visibility check only gates whether the
  // notes are *returned*), and a wall used to cost three serial D1 round trips
  // before it could paint. Fetching notes for a wall that turns out to be
  // private wastes one cheap indexed read; a second round trip cost more.
  const [memberRes, stickyRes, letterRes] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT m.id, m.name, m.avatar_key, m.wall_public,
              p.photo_key, p.thumb_key, p.session, p.role, p.is_mentor, p.tagline, p.intro, p.sections, p.links,
              (SELECT COUNT(*) FROM stickies s WHERE s.recipient_id = m.id) AS received_count
       FROM members m
       LEFT JOIN profiles p ON p.member_id = m.id
       WHERE m.id = ?`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT s.id, s.author_id, s.is_anonymous, s.described_as, s.good_at,
              s.color, s.photo_key, s.created_at, s.anon_name, s.anon_color,
              a.name AS author_name
       FROM stickies s
       LEFT JOIN members a ON a.id = s.author_id
       WHERE s.recipient_id = ?
       ORDER BY s.created_at DESC`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT l.id, l.recipient_id, l.author_id, l.is_anonymous, l.subject, l.body,
              l.paper_style, l.photo_key, l.is_opened, l.opened_at, l.created_at,
              l.anon_name, l.anon_color, a.name AS author_name
       FROM letters l
       LEFT JOIN members a ON a.id = l.author_id
       WHERE l.recipient_id = ? AND (l.recipient_id = ? OR l.author_id = ?)
       ORDER BY l.created_at DESC`,
    ).bind(id, meId, meId),
  ]);

  const member = (memberRes.results?.[0] ?? null) as unknown as ProfileRow | null;
  if (!member) return c.json({ error: "not found" }, 404);

  // Mentors are members; the flag only steers presentation (the Mentors
  // directory, the wall's Back button), never access.
  const isMentor = member.is_mentor === 1;

  const isSelf = member.id === meId;
  // A wall is private until its owner publishes it — the same for everyone.
  const visible = isSelf || member.wall_public === 1;
  const rosterMember = toRosterMember(member, meId);

  // A profile introduces someone to the cohort, so it stays readable even when
  // they keep their sticky wall private. Members without a profile get null.
  const profile: Profile | null = member.sections
    ? {
        session: member.session,
        role: member.role,
        tagline: member.tagline,
        intro: member.intro ?? "",
        sections: parseJson<ProfileSection[]>(member.sections, []),
        links: parseJson<ProfileLink[]>(member.links, []),
      }
    : null;

  const stickyRows = (stickyRes.results ?? []) as unknown as StickyRow[];

  const toSticky = (r: StickyRow): Sticky => ({
    id: r.id,
    authorName:
      r.is_anonymous === 1 ? (r.anon_name ?? "Anonymous") : r.author_name,
    authorColor: r.is_anonymous === 1 ? r.anon_color : null,
    isAnonymous: r.is_anonymous === 1,
    mine: r.is_anonymous === 0 && r.author_id === meId,
    describedAs: r.described_as,
    goodAt: r.good_at,
    color: (STICKY_COLORS as readonly string[]).includes(r.color)
      ? (r.color as StickyColor)
      : "yellow",
    photoUrl: r.photo_key ? `/api/media/${r.photo_key}` : null,
    createdAt: r.created_at,
  });

  const letterRows = (letterRes.results ?? []) as unknown as LetterRow[];
  const toLetter = (r: LetterRow): Letter => ({
    id: r.id,
    recipientId: r.recipient_id,
    authorName:
      r.is_anonymous === 1 ? (r.anon_name ?? "Anonymous") : r.author_name,
    authorColor: r.is_anonymous === 1 ? r.anon_color : null,
    isAnonymous: r.is_anonymous === 1,
    mine: r.is_anonymous === 0 && r.author_id === meId,
    subject: r.subject,
    body: r.body,
    paperStyle: (LETTER_STYLES as readonly string[]).includes(r.paper_style)
      ? (r.paper_style as LetterStyle)
      : "classic",
    photoUrl: r.photo_key ? `/api/media/${r.photo_key}` : null,
    isOpened: r.is_opened === 1,
    openedAt: r.opened_at,
    createdAt: r.created_at,
  });

  const letters: Letter[] = letterRows.map(toLetter);

  // A private wall hides the cohort's notes — but not the ones the viewer wrote
  // themselves. A note you gave someone is yours to keep seeing even after they
  // make their wall private. Anonymous notes store no author_id (anonymity is
  // guaranteed by storage), so only signed notes can be traced back to you.
  if (!visible) {
    const mine = stickyRows.filter((r) => r.author_id === meId).map(toSticky);
    const res: WallResponse = {
      member: rosterMember,
      isSelf,
      isMentor,
      visible: false,
      stickies: mine,
      letters,
      profile,
    };
    return c.json(res);
  }

  const stickies: Sticky[] = stickyRows.map(toSticky);

  const res: WallResponse = {
    member: rosterMember,
    isSelf,
    isMentor,
    visible: true,
    stickies,
    letters,
    profile,
  };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// Stickies
// ---------------------------------------------------------------------------

app.post("/stickies", requireAuth, async (c) => {
  const me = c.get("member");
  const body = await c.req.parseBody();

  const recipientId = String(body["recipient_id"] ?? "");
  const describedAs = String(body["described_as"] ?? "").trim().slice(0, MAX_FIELD_LEN);
  const goodAt = String(body["good_at"] ?? "").trim().slice(0, MAX_FIELD_LEN);
  const isAnonymous = String(body["is_anonymous"] ?? "") === "true";
  const colorRaw = String(body["color"] ?? "yellow");
  const color = (STICKY_COLORS as readonly string[]).includes(colorRaw)
    ? colorRaw
    : "yellow";

  if (!recipientId) return c.json({ error: "recipient_id required" }, 400);
  if (recipientId === me.id) {
    return c.json({ error: "You can't give yourself a sticky." }, 400);
  }
  if (!describedAs && !goodAt) {
    return c.json({ error: "Write at least one of the two fields." }, 400);
  }

  // Mentors are members now, so recipients — learner or mentor — are one lookup.
  const recipient = await c.env.DB.prepare(
    "SELECT id, name, email FROM members WHERE id = ?",
  )
    .bind(recipientId)
    .first<{ id: string; name: string; email: string }>();
  if (!recipient) return c.json({ error: "recipient not found" }, 404);

  const stickyId = newId();

  // Anonymous stickies get a random codename (e.g. "Pink Leopard").
  const pseudo = isAnonymous
    ? pseudonymFor()
    : null;

  // Optional photo attachment.
  let photoKey: string | null = null;
  const photo = body["photo"];
  if (photo instanceof File && photo.size > 0) {
    const check = validateImage(photo, MAX_PHOTO_BYTES);
    if (!check.ok) return c.json({ error: check.error }, 400);
    photoKey = `stickies/${stickyId}`;
    await c.env.MEDIA.put(photoKey, await photo.arrayBuffer(), {
      httpMetadata: { contentType: photo.type },
    });
  }

  const createdAt = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO stickies
       (id, recipient_id, author_id, is_anonymous, described_as, good_at, color, photo_key, created_at, anon_name, anon_color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      stickyId,
      recipientId,
      isAnonymous ? null : me.id, // anonymity is guaranteed by storage
      isAnonymous ? 1 : 0,
      describedAs,
      goodAt,
      color,
      photoKey,
      createdAt,
      pseudo?.name ?? null,
      isAnonymous ? pseudo?.color ?? null : null,
    )
    .run();

  // Send an email notification asynchronously if configured (skip mentors who
  // were imported without a real address — their placeholder can't be mailed).
  if (isDeliverable(recipient.email)) {
    const authorNameForEmail = isAnonymous ? (pseudo?.name ?? "Someone") : me.name;
    const link = `${c.env.SITE_URL || "https://academy-stickies.pages.dev"}/me`;
    c.executionCtx.waitUntil(
      sendStickyNotification(
        c.env,
        recipient.email,
        recipient.name,
        authorNameForEmail,
        link
      ).catch(console.error)
    );
  }

  const sticky: Sticky = {
    id: stickyId,
    authorName: isAnonymous ? (pseudo?.name ?? "Anonymous") : me.name,
    authorColor: pseudo?.color ?? null,
    isAnonymous,
    mine: !isAnonymous,
    describedAs,
    goodAt,
    color: color as StickyColor,
    photoUrl: photoKey ? `/api/media/${photoKey}` : null,
    createdAt,
  };
  return c.json({ sticky }, 201);
});

// Either end of a note can take it down: the recipient clears their own wall,
// and the author retracts a note they gave. Anonymous notes store no author_id,
// so only the recipient can remove those.
app.delete("/stickies/:id", requireSession, async (c) => {
  const meId = c.get("memberId");
  const id = c.req.param("id");

  const sticky = await c.env.DB.prepare(
    "SELECT id, recipient_id, author_id, photo_key FROM stickies WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      recipient_id: string;
      author_id: string | null;
      photo_key: string | null;
    }>();
  if (!sticky) return c.json({ error: "not found" }, 404);
  if (sticky.recipient_id !== meId && sticky.author_id !== meId) {
    return c.json(
      { error: "You can only remove notes you gave or received." },
      403,
    );
  }

  await c.env.DB.prepare("DELETE FROM stickies WHERE id = ?").bind(id).run();
  if (sticky.photo_key) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(sticky.photo_key).catch(() => {}));
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Envelope Letters
// ---------------------------------------------------------------------------

app.post("/letters", requireAuth, async (c) => {
  const me = c.get("member");
  const body = await c.req.parseBody();

  const recipientId = String(body["recipient_id"] ?? "");
  const subject = String(body["subject"] ?? "").trim().slice(0, MAX_LETTER_SUBJECT_LEN);
  const letterBody = String(body["body"] ?? "").trim().slice(0, MAX_LETTER_BODY_LEN);
  const isAnonymous = String(body["is_anonymous"] ?? "") === "true";
  const paperStyleRaw = String(body["paper_style"] ?? "classic");
  const paperStyle = (LETTER_STYLES as readonly string[]).includes(paperStyleRaw)
    ? paperStyleRaw
    : "classic";

  if (!recipientId) return c.json({ error: "recipient_id required" }, 400);
  if (recipientId === me.id) {
    return c.json({ error: "You can't send a letter to yourself." }, 400);
  }
  if (!letterBody) {
    return c.json({ error: "Write something in your letter first." }, 400);
  }

  const recipient = await c.env.DB.prepare(
    "SELECT id, name, email FROM members WHERE id = ?",
  )
    .bind(recipientId)
    .first<{ id: string; name: string; email: string }>();
  if (!recipient) return c.json({ error: "recipient not found" }, 404);

  const letterId = newId();
  const pseudo = isAnonymous ? pseudonymFor() : null;

  let photoKey: string | null = null;
  const photo = body["photo"];
  if (photo instanceof File && photo.size > 0) {
    const check = validateImage(photo, MAX_PHOTO_BYTES);
    if (!check.ok) return c.json({ error: check.error }, 400);
    photoKey = `letters/${letterId}`;
    await c.env.MEDIA.put(photoKey, await photo.arrayBuffer(), {
      httpMetadata: { contentType: photo.type },
    });
  }

  const createdAt = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO letters
       (id, recipient_id, author_id, is_anonymous, subject, body, paper_style, photo_key, created_at, anon_name, anon_color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      letterId,
      recipientId,
      isAnonymous ? null : me.id,
      isAnonymous ? 1 : 0,
      subject,
      letterBody,
      paperStyle,
      photoKey,
      createdAt,
      pseudo?.name ?? null,
      isAnonymous ? pseudo?.color ?? null : null,
    )
    .run();

  if (isDeliverable(recipient.email)) {
    const authorNameForEmail = isAnonymous ? (pseudo?.name ?? "Someone") : me.name;
    const link = `${c.env.SITE_URL || "https://academy-stickies.pages.dev"}/me`;
    c.executionCtx.waitUntil(
      sendLetterNotification(
        c.env,
        recipient.email,
        recipient.name,
        authorNameForEmail,
        link,
      ).catch(console.error),
    );
  }

  const letter: Letter = {
    id: letterId,
    recipientId,
    authorName: isAnonymous ? (pseudo?.name ?? "Anonymous") : me.name,
    authorColor: pseudo?.color ?? null,
    isAnonymous,
    mine: !isAnonymous,
    subject,
    body: letterBody,
    paperStyle: paperStyle as LetterStyle,
    photoUrl: photoKey ? `/api/media/${photoKey}` : null,
    isOpened: false,
    openedAt: null,
    createdAt,
  };
  return c.json({ letter }, 201);
});

app.post("/letters/:id/open", requireSession, async (c) => {
  const meId = c.get("memberId");
  const id = c.req.param("id");

  const letter = await c.env.DB.prepare(
    "SELECT id, recipient_id, is_opened, opened_at FROM letters WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; recipient_id: string; is_opened: number; opened_at: number | null }>();

  if (!letter) return c.json({ error: "not found" }, 404);
  if (letter.recipient_id !== meId) {
    return c.json({ error: "Only the recipient can open this letter." }, 403);
  }

  const now = Date.now();
  if (letter.is_opened === 0) {
    await c.env.DB.prepare(
      "UPDATE letters SET is_opened = 1, opened_at = ? WHERE id = ?",
    )
      .bind(now, id)
      .run();
  }

  return c.json({ ok: true, isOpened: true, openedAt: letter.opened_at ?? now });
});

app.delete("/letters/:id", requireSession, async (c) => {
  const meId = c.get("memberId");
  const id = c.req.param("id");

  const letter = await c.env.DB.prepare(
    "SELECT id, recipient_id, author_id, photo_key FROM letters WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      recipient_id: string;
      author_id: string | null;
      photo_key: string | null;
    }>();
  if (!letter) return c.json({ error: "not found" }, 404);
  if (letter.recipient_id !== meId && letter.author_id !== meId) {
    return c.json(
      { error: "You can only delete letters you sent or received." },
      403,
    );
  }

  await c.env.DB.prepare("DELETE FROM letters WHERE id = ?").bind(id).run();
  if (letter.photo_key) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(letter.photo_key).catch(() => {}));
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

app.post("/feedback", requireAuth, async (c) => {
  const me = c.get("member");
  const body = await c.req
    .json<{ message?: string }>()
    .catch(() => ({}) as { message?: string });
  const message = String(body.message ?? "").trim().slice(0, MAX_FEEDBACK_LEN);
  if (!message) return c.json({ error: "Write something first." }, 400);

  const id = newId();
  const createdAt = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO feedback (id, member_id, message, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, me.id, message, createdAt)
    .run();

  if (c.env.FEEDBACK_NOTIFY_EMAIL) {
    c.executionCtx.waitUntil(
      sendFeedbackNotification(c.env, c.env.FEEDBACK_NOTIFY_EMAIL, me.name, message).catch(
        console.error,
      ),
    );
  }

  return c.json({ ok: true }, 201);
});

// ---------------------------------------------------------------------------
// Media (auth-gated). Avatars and cohort photos (learners/, mentors/) are open
// to any signed-in member; sticky photos follow the same visibility rule as
// their wall. Nothing here is reachable without a session — these are real
// people's faces, so there is no public path to them.
// ---------------------------------------------------------------------------

const OPEN_MEDIA_PREFIXES = ["avatars/", "learners/", "mentors/"];

app.get("/media/*", requireSession, async (c) => {
  const meId = c.get("memberId");
  const key = decodeURIComponent(c.req.path.slice("/api/media/".length));
  if (!key) return c.json({ error: "not found" }, 404);

  if (key.startsWith("stickies/")) {
    const stickyId = key.slice("stickies/".length);
    // A sticky's recipient — learner or mentor — is a member, so its wall's
    // visibility is one lookup.
    const row = await c.env.DB.prepare(
      `SELECT s.author_id, s.recipient_id, m.wall_public
       FROM stickies s
       LEFT JOIN members m ON m.id = s.recipient_id
       WHERE s.id = ?`,
    )
      .bind(stickyId)
      .first<{ author_id: string | null; recipient_id: string; wall_public: number | null }>();
    if (!row) return c.json({ error: "not found" }, 404);
    const allowed =
      row.recipient_id === meId ||
      row.author_id === meId ||
      row.wall_public === 1;
    if (!allowed) return c.json({ error: "forbidden" }, 403);
  } else if (key.startsWith("letters/")) {
    const letterId = key.slice("letters/".length);
    const row = await c.env.DB.prepare(
      `SELECT author_id, recipient_id FROM letters WHERE id = ?`,
    )
      .bind(letterId)
      .first<{ author_id: string | null; recipient_id: string }>();
    if (!row) return c.json({ error: "not found" }, 404);
    const allowed = row.recipient_id === meId || row.author_id === meId;
    if (!allowed) return c.json({ error: "forbidden" }, 403);
  } else if (!OPEN_MEDIA_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await c.env.MEDIA.get(key);
  if (!object) return c.json({ error: "not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Nothing here is ever rewritten under the same key — cohort photos are
  // keyed by name, and an avatar upload mints a fresh key each time — so faces
  // can be cached hard and never revalidated. Sticky photos are the exception:
  // their key is stable, but the wall around them can turn private, and a long
  // cache would keep serving a photo the viewer has since lost access to.
  const rewritable = key.startsWith("stickies/");
  headers.set(
    "Cache-Control",
    rewritable
      ? "private, max-age=600"
      : "private, max-age=31536000, immutable",
  );
  return new Response(object.body, { headers });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export const onRequest = handle(app);

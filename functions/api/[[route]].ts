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
import { sanitizeProfileInput } from "../../shared/profile";
import {
  LETTER_STYLES,
  MAX_FIELD_LEN,
  MAX_LETTER_BODY_LEN,
  MAX_LETTER_SUBJECT_LEN,
  STICKY_COLORS,
} from "../../shared/types";
import type {
  AdminRosterEntry,
  AdminStats,
  AdminFeedbackItem,
  AdminLetter,
  AdminMediaItem,
  AdminMember,
  AdminSticky,
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
  is_admin: number;
  disabled_at: number | null;
  created_at: number;
  last_login_at: number | null;
  notifications_seen_at: number | null; // watermark for the red notification dot
  photo_key: string | null; // joined from profiles — the cohort photo
  thumb_key: string | null;
  session: string | null; // joined from profiles — AM/PM (learners)
  role: string | null; // joined from profiles — "Tech Mentor" etc. (mentors)
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
     WHERE recipient_id = ? AND created_at > ? AND hidden_at IS NULL`,
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
    isAdmin: m.is_admin === 1,
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

  // Disabled members keep no session access at all (one indexed read).
  const row = await c.env.DB.prepare(
    "SELECT disabled_at FROM members WHERE id = ?",
  )
    .bind(memberId)
    .first<{ disabled_at: number | null }>();
  if (!row || row.disabled_at) return c.json({ error: "unauthorized" }, 401);

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
    `SELECT m.*, p.photo_key, p.thumb_key, p.session, p.role
     FROM members m LEFT JOIN profiles p ON p.member_id = m.id
     WHERE m.id = ?`,
  )
    .bind(memberId)
    .first<MemberRow>();
  if (!member || member.disabled_at) return c.json({ error: "unauthorized" }, 401);

  c.set("member", member);
  c.set("memberId", member.id);
  await next();
}

/** requireAuth, plus the staff flag. Every /admin route hangs off this; the
 *  frontend hides its Admin entry for non-admins too, but this check is the
 *  one that matters. */
async function requireAdmin(c: AppContext, next: Next) {
  const cookie = getCookie(c, COOKIE_NAME);
  const memberId = cookie
    ? await verifySession(cookie, c.env.SESSION_SECRET)
    : null;
  if (!memberId) return c.json({ error: "unauthorized" }, 401);

  // Same column set as requireAuth — anything PR-branch-only would break here.
  const member = await c.env.DB.prepare(
    `SELECT m.*, p.photo_key, p.thumb_key, p.session, p.role
     FROM members m LEFT JOIN profiles p ON p.member_id = m.id
     WHERE m.id = ?`,
  )
    .bind(memberId)
    .first<MemberRow>();
  if (!member || member.disabled_at) return c.json({ error: "unauthorized" }, 401);
  if (member.is_admin !== 1) return c.json({ error: "admins only" }, 403);

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
  if (member.disabled_at) return c.redirect(`${origin}/?error=disabled`);

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
            (SELECT COUNT(*) FROM stickies s WHERE s.recipient_id = m.id AND s.hidden_at IS NULL) AS received_count
     FROM members m
     LEFT JOIN profiles p ON p.member_id = m.id
     WHERE COALESCE(p.is_mentor, 0) = 0 AND m.disabled_at IS NULL
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
     WHERE p.is_mentor = 1 AND m.disabled_at IS NULL
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
              (SELECT COUNT(*) FROM stickies s WHERE s.recipient_id = m.id AND s.hidden_at IS NULL) AS received_count
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
       WHERE s.recipient_id = ? AND s.hidden_at IS NULL
       ORDER BY s.created_at DESC`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT l.id, l.recipient_id, l.author_id, l.is_anonymous, l.subject, l.body,
              l.paper_style, l.photo_key, l.is_opened, l.opened_at, l.created_at,
              l.anon_name, l.anon_color, a.name AS author_name
       FROM letters l
       LEFT JOIN members a ON a.id = l.author_id
       WHERE l.recipient_id = ? AND l.hidden_at IS NULL AND (l.recipient_id = ? OR l.author_id = ?)
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
       WHERE s.id = ? AND s.hidden_at IS NULL`,
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
      `SELECT author_id, recipient_id FROM letters WHERE id = ? AND hidden_at IS NULL`,
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


async function logAdminAction(
  c: AppContext,
  action: string,
  targetType: string,
  targetId: string | undefined,
  detail = "",
): Promise<void> {
  await c.env.DB.prepare(
    "INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(newId(), c.get("memberId"), action, targetType, targetId ?? "", detail, Date.now()).run();
}

// ---------------------------------------------------------------------------
// Admin dashboard — every route behind requireAdmin.
//
// Moderation is non-destructive by default: hide sets hidden_at/hidden_by and
// member-facing queries filter it out; restore clears them. Permanent deletion
// is a separate action that requires the explicit ?confirm=permanent marker.
// Hiding NEVER touches R2 media or removes database rows, so a restore always
// brings the content back exactly as it was. Granting the admin flag itself is
// deliberately NOT here — that is a developer operation (scripts/grant-admin.ts).
// ---------------------------------------------------------------------------

app.get("/admin/stats", requireAdmin, async (c) => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - week;
  const one = async (sql: string, ...bind: unknown[]) => {
    const row = await c.env.DB.prepare(sql).bind(...bind).first<{ n: number }>();
    return row?.n ?? 0;
  };
  // COUNT-only, read-only; no member-identifying data leaves this endpoint.
  const [
    mTotal, mDeactivated, mAdmins, mJoined7,
    pProfiles, pMentors, pAm, pPm,
    sTotal, sHidden, sLast7,
    lTotal, lHidden,
    fTotal, fRead,
    mediaTotal,
  ] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM members"),
    one("SELECT COUNT(*) AS n FROM members WHERE disabled_at IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM members WHERE is_admin = 1"),
    one("SELECT COUNT(*) AS n FROM members WHERE created_at >= ?", since),
    one("SELECT COUNT(*) AS n FROM profiles"),
    one("SELECT COUNT(*) AS n FROM profiles WHERE is_mentor = 1"),
    one("SELECT COUNT(*) AS n FROM profiles WHERE session = 'AM'"),
    one("SELECT COUNT(*) AS n FROM profiles WHERE session = 'PM'"),
    one("SELECT COUNT(*) AS n FROM stickies"),
    one("SELECT COUNT(*) AS n FROM stickies WHERE hidden_at IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM stickies WHERE created_at >= ?", since),
    one("SELECT COUNT(*) AS n FROM letters"),
    one("SELECT COUNT(*) AS n FROM letters WHERE hidden_at IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM feedback"),
    one("SELECT COUNT(*) AS n FROM feedback WHERE read_at IS NOT NULL"),
    one(`SELECT COUNT(*) AS n FROM (
          SELECT avatar_key AS key FROM members WHERE avatar_key IS NOT NULL
          UNION ALL SELECT photo_key FROM profiles WHERE photo_key IS NOT NULL
          UNION ALL SELECT thumb_key FROM profiles WHERE thumb_key IS NOT NULL
          UNION ALL SELECT photo_key FROM stickies WHERE photo_key IS NOT NULL
          UNION ALL SELECT photo_key FROM letters WHERE photo_key IS NOT NULL)`),
  ]);
  const stats: AdminStats = {
    members: { total: mTotal, active: mTotal - mDeactivated, deactivated: mDeactivated, admins: mAdmins, joinedLast7d: mJoined7 },
    roster: { profiles: pProfiles, mentors: pMentors, learners: pProfiles - pMentors, sessionAm: pAm, sessionPm: pPm },
    stickies: { total: sTotal, hidden: sHidden, visible: sTotal - sHidden, last7d: sLast7 },
    letters: { total: lTotal, hidden: lHidden, visible: lTotal - lHidden },
    feedback: { total: fTotal, read: fRead, unread: fTotal - fRead },
    media: { total: mediaTotal },
  };
  return c.json({ stats });
});

app.get("/admin/members", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.email, m.avatar_key, m.wall_public, m.is_admin, m.disabled_at,
            m.created_at, m.last_login_at,
            COALESCE(p.is_mentor, 0) AS is_mentor,
            (SELECT COUNT(*) FROM stickies s WHERE s.recipient_id = m.id AND s.hidden_at IS NULL) AS received_count
     FROM members m
     LEFT JOIN profiles p ON p.member_id = m.id
     ORDER BY m.name COLLATE NOCASE ASC`,
  ).all<Record<string, unknown>>();

  const members: AdminMember[] = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    avatarUrl: avatarUrl(r as { avatar_key: string | null; photo_key?: string | null }),
    isMentor: (r.is_mentor as number) === 1,
    isAdmin: (r.is_admin as number) === 1,
    disabledAt: (r.disabled_at as number | null) ?? null,
    wallPublic: (r.wall_public as number) === 1,
    createdAt: r.created_at as number,
    lastLoginAt: (r.last_login_at as number | null) ?? null,
    receivedCount: (r.received_count as number) ?? 0,
  }));
  return c.json({ members });
});

app.post("/admin/members", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ name?: string; email?: string; is_mentor?: boolean }>()
    .catch(() => ({} as { name?: string; email?: string; is_mentor?: boolean }));
  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  if (!name || !email || !email.includes("@")) {
    return c.json({ error: "Name and a valid email are required." }, 400);
  }
  const existing = await c.env.DB.prepare(
    "SELECT id FROM members WHERE lower(email) = ?",
  ).bind(email).first();
  if (existing) return c.json({ error: "A member with that email already exists." }, 409);

  const id = newId();
  const loginToken = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO members (id, name, email, login_token, wall_public, is_admin, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
  ).bind(id, name, email, loginToken, Date.now()).run();

  if (body.is_mentor) {
    await c.env.DB.prepare(
      "INSERT INTO profiles (member_id, slug, is_mentor, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(member_id) DO UPDATE SET is_mentor = 1",
    ).bind(id, slugFromName(name), Date.now()).run();
  }
  await logAdminAction(c, "member.add", "member", id, email);
  // Another member's sign-in token never leaves the server in an API
  // response: it goes to their inbox, or (dev without Brevo) a dev pulls it
  // from D1 with scripts/get-login-link.ts.
  if (emailConfigured(c.env)) {
    const link = `${siteOrigin(c)}/api/auth?token=${loginToken}`;
    try {
      await sendMagicLink(c.env, email, name, link);
      return c.json({ ok: true, id, emailed: true }, 201);
    } catch (err) {
      // The member and audit row already exist: report success with
      // emailed:false so the admin uses "Resend link" instead of retrying
      // the add and hitting a confusing 409.
      console.error("sendMagicLink failed after member.add", err);
      return c.json({ ok: true, id, emailed: false }, 201);
    }
  }
  return c.json({ ok: true, id, emailed: false }, 201);
});

app.patch("/admin/members/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const target = await c.env.DB.prepare(
    "SELECT id, name FROM members WHERE id = ?",
  ).bind(id).first<{ id: string; name: string }>();
  if (!target) return c.json({ error: "not found" }, 404);

  const body = await c.req
    .json<{ name?: string; email?: string; is_mentor?: boolean }>()
    .catch(() => ({} as { name?: string; email?: string; is_mentor?: boolean }));

  // Validate every field before the first write: a rejected update must
  // leave the row untouched and write no audit entry.
  const name = body.name === undefined ? undefined : String(body.name).trim().slice(0, 120);
  if (name !== undefined && !name) return c.json({ error: "Name cannot be empty." }, 400);
  const email = body.email === undefined ? undefined : String(body.email).trim().toLowerCase().slice(0, 200);
  if (email !== undefined) {
    if (!email.includes("@")) return c.json({ error: "A valid email is required." }, 400);
    const dupe = await c.env.DB.prepare(
      "SELECT id FROM members WHERE lower(email) = ? AND id != ?",
    ).bind(email, id).first();
    if (dupe) return c.json({ error: "Another member already uses that email." }, 409);
  }
  if (name !== undefined) {
    await c.env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(name, id).run();
  }
  if (email !== undefined) {
    await c.env.DB.prepare("UPDATE members SET email = ? WHERE id = ?").bind(email, id).run();
  }
  if (body.is_mentor !== undefined) {
    const slugName = name ?? target.name;
    await c.env.DB.prepare(
      "INSERT INTO profiles (member_id, slug, is_mentor, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET is_mentor = excluded.is_mentor",
    ).bind(id, slugFromName(slugName), body.is_mentor ? 1 : 0, Date.now()).run();
  }
  await logAdminAction(c, "member.update", "member", id,
    Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined).join(","));
  return c.json({ ok: true });
});

// Deactivate is the default way to remove access: login links stop working,
// existing sessions die on the next requireAuth, and the member vanishes from
// the roster and mentor directory — but their wall, notes and media all stay
// intact, so reactivate brings everything back untouched.
app.post("/admin/members/:id/disable", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (id === c.get("memberId")) return c.json({ error: "You cannot deactivate your own account." }, 400);
  const target = await c.env.DB.prepare(
    "SELECT is_admin FROM members WHERE id = ?",
  ).bind(id).first<{ is_admin: number }>();
  // Same guard as the delete route: admin revocation stays on the
  // scripts/grant-admin.ts path, so one admin cannot lock out another.
  if (target?.is_admin) {
    return c.json({ error: "Admin accounts are managed with scripts/grant-admin.ts, not the dashboard." }, 400);
  }
  const res = await c.env.DB.prepare(
    "UPDATE members SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL",
  ).bind(Date.now(), id).run();
  if (!res.meta.changes) return c.json({ error: "not found or already deactivated" }, 404);
  await logAdminAction(c, "member.disable", "member", id);
  return c.json({ ok: true });
});

app.post("/admin/members/:id/enable", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare(
    "UPDATE members SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL",
  ).bind(id).run();
  if (!res.meta.changes) return c.json({ error: "not found or not deactivated" }, 404);
  await logAdminAction(c, "member.enable", "member", id);
  return c.json({ ok: true });
});

app.post("/admin/members/:id/resend-link", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const member = await c.env.DB.prepare(
    "SELECT id, name, email FROM members WHERE id = ?",
  ).bind(id).first<{ id: string; name: string; email: string }>();
  if (!member) return c.json({ error: "not found" }, 404);

  // Rotate the token on every resend: an old leaked link dies with the new
  // one. When email is configured, send BEFORE rotating so a Brevo failure
  // leaves the member's existing link alive instead of stranding them.
  const loginToken = randomToken();
  if (emailConfigured(c.env)) {
    const link = `${siteOrigin(c)}/api/auth?token=${loginToken}`;
    try {
      await sendMagicLink(c.env, member.email, member.name, link);
    } catch (err) {
      console.error("sendMagicLink failed", err);
      return c.json({ error: "Could not send the sign-in email. Their existing link still works." }, 502);
    }
  }
  await c.env.DB.prepare("UPDATE members SET login_token = ? WHERE id = ?")
    .bind(loginToken, id).run();
  await logAdminAction(c, "member.resend-link", "member", id);
  if (emailConfigured(c.env)) return c.json({ ok: true, emailed: true });
  // No email configured (local dev): the token stays in D1, never in a
  // response. scripts/get-login-link.ts prints the link instead.
  return c.json({ ok: true, emailed: false });
});

app.delete("/admin/members/:id", requireAdmin, async (c) => {
  if (c.req.query("confirm") !== "permanent") {
    return c.json({ error: "Permanent member deletion requires ?confirm=permanent." }, 400);
  }
  const id = c.req.param("id");
  const meId = c.get("memberId");
  if (id === meId) return c.json({ error: "You cannot delete your own account." }, 400);

  // An admin's account is removed by revoking the flag (dev script) first —
  // never by deleting the member row out from under the role.
  const targetRow = await c.env.DB.prepare(
    "SELECT is_admin, name FROM members WHERE id = ?",
  ).bind(id).first<{ is_admin: number; name: string }>();
  if (!targetRow) return c.json({ error: "not found" }, 404);
  if (targetRow.is_admin === 1) {
    return c.json({ error: "Revoke their admin flag (scripts/grant-admin.ts) before deleting." }, 400);
  }

  // Only media owned by rows that actually disappear: the member's avatar and
  // profile photo/thumb, and photos on notes/letters they RECEIVED (cascade).
  // Content they AUTHORED survives (author_id SET NULL) - its photos must too.
  const media = await c.env.DB.prepare(
    `SELECT avatar_key AS key FROM members WHERE id = ? AND avatar_key IS NOT NULL
     UNION ALL SELECT photo_key FROM profiles WHERE member_id = ? AND photo_key IS NOT NULL
     UNION ALL SELECT thumb_key FROM profiles WHERE member_id = ? AND thumb_key IS NOT NULL
     UNION ALL SELECT photo_key FROM stickies WHERE recipient_id = ? AND photo_key IS NOT NULL
     UNION ALL SELECT photo_key FROM letters WHERE recipient_id = ? AND photo_key IS NOT NULL`,
  ).bind(id, id, id, id, id).all<{ key: string }>();

  // Delete dependent rows explicitly instead of relying on FK cascades:
  // the schema declares them, but making the cleanup explicit keeps the
  // outcome identical in every D1 environment. Authored notes/letters are
  // NOT touched - they survive with author_id SET NULL via their declared
  // FK action (or, where unenforced, stay as-is with the same net effect).
  const res = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM stickies WHERE recipient_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM letters WHERE recipient_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM feedback WHERE member_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM profiles WHERE member_id = ?").bind(id),
    c.env.DB.prepare("UPDATE stickies SET author_id = NULL WHERE author_id = ?").bind(id),
    c.env.DB.prepare("UPDATE letters SET author_id = NULL WHERE author_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id),
  ]);
  if (!res[res.length - 1].meta.changes) return c.json({ error: "not found" }, 404);
  await logAdminAction(c, "member.delete", "member", id, targetRow.name);
  for (const row of media.results ?? []) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(row.key).catch(() => {}));
  }
  return c.json({ ok: true });
});

app.get("/admin/stickies", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.recipient_id, r.name AS recipient_name,
            s.author_id, a.name AS author_name, s.is_anonymous,
            s.described_as, s.good_at, s.color, s.photo_key, s.created_at,
            s.hidden_at, hb.name AS hidden_by_name
     FROM stickies s
     JOIN members r ON r.id = s.recipient_id
     LEFT JOIN members a ON a.id = s.author_id
     LEFT JOIN members hb ON hb.id = s.hidden_by
     ORDER BY s.created_at DESC
     LIMIT 500`,
  ).all<Record<string, unknown>>();

  const stickies: AdminSticky[] = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    recipientId: r.recipient_id as string,
    recipientName: r.recipient_name as string,
    // An anonymous note's author is never re-identified — not even to admins.
    authorId: (r.is_anonymous as number) === 1 ? null : ((r.author_id as string | null) ?? null),
    authorName: (r.is_anonymous as number) === 1 ? null : ((r.author_name as string | null) ?? null),
    isAnonymous: (r.is_anonymous as number) === 1,
    describedAs: r.described_as as string,
    goodAt: r.good_at as string,
    color: r.color as string,
    hasPhoto: r.photo_key != null,
    createdAt: r.created_at as number,
    hiddenAt: (r.hidden_at as number | null) ?? null,
    hiddenBy: (r.hidden_by_name as string | null) ?? null,
  }));
  return c.json({ stickies });
});

app.patch("/admin/stickies/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ hidden?: boolean }>().catch(() => ({} as { hidden?: boolean }));
  if (typeof body.hidden !== "boolean") return c.json({ error: "hidden (boolean) is required." }, 400);
  const res = body.hidden
    ? await c.env.DB.prepare("UPDATE stickies SET hidden_at = ?, hidden_by = ? WHERE id = ?")
        .bind(Date.now(), c.get("memberId"), id).run()
    : await c.env.DB.prepare("UPDATE stickies SET hidden_at = NULL, hidden_by = NULL WHERE id = ?")
        .bind(id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  await logAdminAction(c, body.hidden ? "sticky.hide" : "sticky.restore", "sticky", id);
  return c.json({ ok: true });
});

app.delete("/admin/stickies/:id", requireAdmin, async (c) => {
  if (c.req.query("confirm") !== "permanent") {
    return c.json({ error: "Permanent deletion requires ?confirm=permanent. Use hide for reversible moderation." }, 400);
  }
  const id = c.req.param("id");
  const sticky = await c.env.DB.prepare(
    "SELECT photo_key FROM stickies WHERE id = ?",
  ).bind(id).first<{ photo_key: string | null }>();
  if (!sticky) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM stickies WHERE id = ?").bind(id).run();
  await logAdminAction(c, "sticky.delete", "sticky", id);
  if (sticky.photo_key) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(sticky.photo_key).catch(() => {}));
  }
  return c.json({ ok: true });
});

app.get("/admin/letters", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.recipient_id, r.name AS recipient_name,
            l.author_id, a.name AS author_name, l.is_anonymous,
            l.subject, substr(l.body, 1, 160) AS excerpt, l.is_opened, l.created_at,
            l.hidden_at, hb.name AS hidden_by_name
     FROM letters l
     JOIN members r ON r.id = l.recipient_id
     LEFT JOIN members a ON a.id = l.author_id
     LEFT JOIN members hb ON hb.id = l.hidden_by
     ORDER BY l.created_at DESC
     LIMIT 500`,
  ).all<Record<string, unknown>>();

  const letters: AdminLetter[] = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    recipientId: r.recipient_id as string,
    recipientName: r.recipient_name as string,
    authorId: (r.is_anonymous as number) === 1 ? null : ((r.author_id as string | null) ?? null),
    authorName: (r.is_anonymous as number) === 1 ? null : ((r.author_name as string | null) ?? null),
    isAnonymous: (r.is_anonymous as number) === 1,
    subject: r.subject as string,
    excerpt: r.excerpt as string,
    isOpened: (r.is_opened as number) === 1,
    createdAt: r.created_at as number,
    hiddenAt: (r.hidden_at as number | null) ?? null,
    hiddenBy: (r.hidden_by_name as string | null) ?? null,
  }));
  return c.json({ letters });
});

app.patch("/admin/letters/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ hidden?: boolean }>().catch(() => ({} as { hidden?: boolean }));
  if (typeof body.hidden !== "boolean") return c.json({ error: "hidden (boolean) is required." }, 400);
  const res = body.hidden
    ? await c.env.DB.prepare("UPDATE letters SET hidden_at = ?, hidden_by = ? WHERE id = ?")
        .bind(Date.now(), c.get("memberId"), id).run()
    : await c.env.DB.prepare("UPDATE letters SET hidden_at = NULL, hidden_by = NULL WHERE id = ?")
        .bind(id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  await logAdminAction(c, body.hidden ? "letter.hide" : "letter.restore", "letter", id);
  return c.json({ ok: true });
});

app.delete("/admin/letters/:id", requireAdmin, async (c) => {
  if (c.req.query("confirm") !== "permanent") {
    return c.json({ error: "Permanent deletion requires ?confirm=permanent. Use hide for reversible moderation." }, 400);
  }
  const id = c.req.param("id");
  const letter = await c.env.DB.prepare(
    "SELECT photo_key FROM letters WHERE id = ?",
  ).bind(id).first<{ photo_key: string | null }>();
  if (!letter) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM letters WHERE id = ?").bind(id).run();
  await logAdminAction(c, "letter.delete", "letter", id);
  if (letter.photo_key) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(letter.photo_key).catch(() => {}));
  }
  return c.json({ ok: true });
});

app.get("/admin/feedback", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.member_id, m.name AS member_name, f.message, f.created_at, f.read_at
     FROM feedback f
     JOIN members m ON m.id = f.member_id
     ORDER BY f.created_at DESC
     LIMIT 500`,
  ).all<Record<string, unknown>>();

  const feedback: AdminFeedbackItem[] = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    memberId: r.member_id as string,
    memberName: r.member_name as string,
    message: r.message as string,
    createdAt: r.created_at as number,
    readAt: (r.read_at as number | null) ?? null,
  }));
  return c.json({ feedback });
});

app.patch("/admin/feedback/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ read?: boolean }>().catch(() => ({} as { read?: boolean }));
  if (typeof body.read !== "boolean") return c.json({ error: "read (boolean) is required." }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE feedback SET read_at = ? WHERE id = ?",
  ).bind(body.read ? Date.now() : null, id).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.get("/admin/media", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT avatar_key AS key, 'avatar' AS kind, id AS owner_id, name AS owner_name FROM members WHERE avatar_key IS NOT NULL
     UNION ALL
     SELECT p.photo_key, 'profile-photo', m.id, m.name FROM profiles p JOIN members m ON m.id = p.member_id WHERE p.photo_key IS NOT NULL
     UNION ALL
     SELECT p.thumb_key, 'profile-thumb', m.id, m.name FROM profiles p JOIN members m ON m.id = p.member_id WHERE p.thumb_key IS NOT NULL
     UNION ALL
     SELECT s.photo_key, 'sticky-photo', s.recipient_id, r.name FROM stickies s JOIN members r ON r.id = s.recipient_id WHERE s.photo_key IS NOT NULL
     UNION ALL
     SELECT l.photo_key, 'letter-photo', l.recipient_id, r.name FROM letters l JOIN members r ON r.id = l.recipient_id WHERE l.photo_key IS NOT NULL
     ORDER BY key`,
  ).all<Record<string, unknown>>();

  const media: AdminMediaItem[] = (rows.results ?? []).map((r) => ({
    key: r.key as string,
    kind: r.kind as AdminMediaItem["kind"],
    ownerId: r.owner_id as string,
    ownerName: r.owner_name as string,
  }));
  return c.json({ media });
});

// Wildcard: R2 keys contain slashes ("avatars/<id>", "stickies/<id>").
app.delete("/admin/media/*", requireAdmin, async (c) => {
  if (c.req.query("confirm") !== "permanent") {
    return c.json({ error: "Media deletion requires ?confirm=permanent." }, 400);
  }
  const key = new URL(c.req.url).pathname.split("/admin/media/")[1] ?? "";
  if (!key) return c.json({ error: "not found" }, 404);
  // Clear every DB reference first so nothing dangles, then drop the object.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET avatar_key = NULL WHERE avatar_key = ?").bind(key),
    c.env.DB.prepare("UPDATE profiles SET photo_key = NULL WHERE photo_key = ?").bind(key),
    c.env.DB.prepare("UPDATE profiles SET thumb_key = NULL WHERE thumb_key = ?").bind(key),
    c.env.DB.prepare("UPDATE stickies SET photo_key = NULL WHERE photo_key = ?").bind(key),
    c.env.DB.prepare("UPDATE letters SET photo_key = NULL WHERE photo_key = ?").bind(key),
  ]);
  await c.env.MEDIA.delete(key).catch(() => {});
  await logAdminAction(c, "media.delete", "media", key);
  return c.json({ ok: true });
});


// ---------------------------------------------------------------------------
// Admin: cohort roster management (the app has a single cohort: the imported
// class roster in profiles, filtered by AM/PM session). Fields managed here
// are the ones the CLI cohort import owns day-to-day: session, tagline, role.
// ---------------------------------------------------------------------------

app.get("/admin/roster", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.email, m.disabled_at,
            COALESCE(p.is_mentor, 0) AS is_mentor,
            p.member_id AS profile_id, p.slug, p.session, p.tagline, p.role,
            p.photo_key, p.thumb_key
     FROM members m
     LEFT JOIN profiles p ON p.member_id = m.id
     ORDER BY COALESCE(p.is_mentor, 0) DESC, m.name COLLATE NOCASE`,
  ).all<Record<string, unknown>>();

  const roster: AdminRosterEntry[] = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    isMentor: (r.is_mentor as number) === 1,
    disabledAt: (r.disabled_at as number | null) ?? null,
    hasProfile: r.profile_id != null,
    slug: (r.slug as string | null) ?? null,
    session: (r.session as string | null) ?? null,
    tagline: (r.tagline as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    hasPhoto: r.photo_key != null,
    hasThumb: r.thumb_key != null,
  }));
  return c.json({ roster });
});

app.patch("/admin/roster/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const target = await c.env.DB.prepare(
    "SELECT id, name FROM members WHERE id = ?",
  ).bind(id).first<{ id: string; name: string }>();
  if (!target) return c.json({ error: "not found" }, 404);

  const body = await c.req
    .json<{ session?: string | null; tagline?: string | null; role?: string | null }>()
    .catch(() => ({} as { session?: string | null; tagline?: string | null; role?: string | null }));

  // Explicit field whitelist: only session/tagline/role are writable here.
  const session =
    body.session === undefined ? undefined
    : body.session === null || body.session === "" ? null
    : body.session === "AM" || body.session === "PM" ? body.session
    : undefined;
  if (body.session !== undefined && session === undefined && body.session !== null && body.session !== "") {
    return c.json({ error: "session must be AM, PM, or empty." }, 400);
  }
  const tagline = body.tagline === undefined || body.tagline === null
    ? body.tagline === null ? null : undefined
    : String(body.tagline).trim().slice(0, 200);
  const role = body.role === undefined || body.role === null
    ? body.role === null ? null : undefined
    : String(body.role).trim().slice(0, 120);

  const changed: string[] = [];
  if (session !== undefined) changed.push("session");
  if (tagline !== undefined) changed.push("tagline");
  if (role !== undefined) changed.push("role");
  if (!changed.length) return c.json({ error: "Nothing to update." }, 400);

  // Upsert: profiles.slug and updated_at are NOT NULL (0002), so an insert
  // must supply both - same constraint the review caught on mentor creation.
  // Tagline/role writes stamp edited_at, the same marker member self-edits
  // set: the CLI cohort import skips rows with edited_at, so admin words
  // survive re-imports exactly like a member's own edits. A session-only
  // write does NOT stamp it - session remains owned by the import.
  const stampsEdited = tagline !== undefined || role !== undefined;
  await c.env.DB.prepare(
    `INSERT INTO profiles (member_id, slug, session, tagline, role, updated_at, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       session = CASE WHEN ? THEN excluded.session ELSE profiles.session END,
       tagline = CASE WHEN ? THEN excluded.tagline ELSE profiles.tagline END,
       role = CASE WHEN ? THEN excluded.role ELSE profiles.role END,
       updated_at = excluded.updated_at,
       edited_at = CASE WHEN ? THEN excluded.edited_at ELSE profiles.edited_at END`,
  ).bind(
    id,
    slugFromName(target.name),
    session ?? null,
    tagline ?? null,
    role ?? null,
    Date.now(),
    stampsEdited ? Date.now() : null,
    session !== undefined ? 1 : 0,
    tagline !== undefined ? 1 : 0,
    role !== undefined ? 1 : 0,
    stampsEdited ? 1 : 0,
  ).run();

  await logAdminAction(c, "profile.update", "member", id, changed.join(","));
  return c.json({ ok: true });
});

app.get("/admin/actions", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, a.admin_id,
            m.name AS admin_name
     FROM admin_actions a
     LEFT JOIN members m ON m.id = a.admin_id
     ORDER BY a.created_at DESC
     LIMIT 200`,
  ).all<Record<string, unknown>>();
  const actions = (rows.results ?? []).map((r) => ({
    id: r.id as string,
    action: r.action as string,
    targetType: r.target_type as string,
    targetId: r.target_id as string,
    detail: r.detail as string,
    createdAt: r.created_at as number,
    adminName: (r.admin_name as string | null) ?? (r.admin_id as string),
  }));
  return c.json({ actions });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export const onRequest = handle(app);

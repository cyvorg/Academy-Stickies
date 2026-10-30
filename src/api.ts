import type { ProfileInput } from "../shared/profile";
import type {
  AdminAction,
  AdminFeedbackItem,
  AdminLetter,
  AdminMediaItem,
  AdminMember,
  AdminSticky,
  CreateStickyResult,
  Me,
  Mentor,
  Profile,
  RosterMember,
  WallResponse,
} from "../shared/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/** Returns the current member, or null if not signed in. */
export async function getMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  if (res.status === 401) return null;
  return parse<Me>(res);
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}

/** Mark the current member's received notes as seen — clears the red dot.
 *  Best-effort: a failed stamp just leaves the dot for next time. */
export async function markNotificationsSeen(): Promise<void> {
  await fetch("/api/me/seen", { method: "POST" }).catch(() => {});
}

export async function requestLink(
  email: string,
): Promise<{ sent: boolean; reason?: string }> {
  const res = await fetch("/api/request-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return parse(res);
}

/**
 * The full roster, fetched once per page load and shared.
 *
 * Two callers want it on the landing page — the grid and the footer credits —
 * and they used to issue one request each for the same couple of hundred
 * members. Cleared on failure so a retry isn't stuck with the rejection, and
 * on refresh so a new sticky shows up in the counts.
 */
let rosterCache: Promise<RosterMember[]> | null = null;

export function getMembers(): Promise<RosterMember[]> {
  if (rosterCache) return rosterCache;

  const pending = fetch("/api/members")
    .then((res) => parse<{ members: RosterMember[] }>(res))
    .then((data) => data.members)
    .catch((err: unknown) => {
      if (rosterCache === pending) rosterCache = null;
      throw err;
    });

  rosterCache = pending;
  return pending;
}

/** Drops the shared roster so the next read goes back to the server. */
export function invalidateMembers(): void {
  rosterCache = null;
}

async function requestWall(id: string): Promise<WallResponse> {
  return parse<WallResponse>(await fetch(`/api/members/${id}`));
}

/** A wall request started by prefetchRoute() before <Wall> mounted. Consumed
 *  once: every later load — a refresh, a new sticky — must hit the server. */
let wallPrefetch: { id: string; promise: Promise<WallResponse> } | null = null;

export function getWall(id: string): Promise<WallResponse> {
  if (wallPrefetch?.id === id) {
    const { promise } = wallPrefetch;
    wallPrefetch = null;
    return promise;
  }
  return requestWall(id);
}

/**
 * Starts the first view's data request at boot, in parallel with /api/me.
 *
 * Loading a wall was four serial round trips before anything appeared: the
 * HTML, then the JS, then /api/me, then — once <App> had a member and could
 * finally mount <Wall> — the wall itself. The last two don't depend on each
 * other, so this overlaps them.
 *
 * Only for routes whose URL the hash alone determines. "#/me" is a member id
 * the server hasn't sent us yet, so it keeps waiting.
 */
export function prefetchRoute(hash: string): void {
  const path = hash.replace(/^#/, "");
  const wall = path.match(/^\/m\/([^/?]+)/);

  if (wall) {
    const id = decodeURIComponent(wall[1]);
    const promise = requestWall(id);
    // A prefetch nobody ends up consuming — a signed-out visitor, a bad id —
    // must not surface as an unhandled rejection.
    promise.catch(() => {});
    wallPrefetch = { id, promise };
  } else if (path === "" || path === "/") {
    getMembers().catch(() => {});
  }
}

export async function getMentors(): Promise<Mentor[]> {
  const data = await parse<{ mentors: Mentor[] }>(await fetch("/api/mentors"));
  return data.mentors;
}

export async function setWallPublic(wallPublic: boolean): Promise<Me> {
  const res = await fetch("/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallPublic }),
  });
  return parse<Me>(res);
}

/**
 * Save the current member's own profile. Invalidates the roster cache on
 * success: name and tagline both show on the roster card, and the grid + footer
 * credits would otherwise keep serving the stale ones until a reload.
 */
export async function saveProfile(
  input: ProfileInput,
): Promise<{ me: Me; profile: Profile }> {
  const res = await fetch("/api/me/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parse<{ me: Me; profile: Profile }>(res);
  invalidateMembers();
  return data;
}

export async function uploadAvatar(file: Blob): Promise<{ avatarUrl: string }> {
  const fd = new FormData();
  fd.append("avatar", file, "avatar.webp");
  return parse(await fetch("/api/me/avatar", { method: "POST", body: fd }));
}

export interface NewSticky {
  recipientId: string;
  describedAs: string;
  goodAt: string;
  isAnonymous: boolean;
  color: string;
  photo?: Blob | null;
}

export async function createSticky(input: NewSticky): Promise<CreateStickyResult> {
  const fd = new FormData();
  fd.append("recipient_id", input.recipientId);
  fd.append("described_as", input.describedAs);
  fd.append("good_at", input.goodAt);
  fd.append("is_anonymous", String(input.isAnonymous));
  fd.append("color", input.color);
  if (input.photo) fd.append("photo", input.photo, "photo.webp");
  return parse<CreateStickyResult>(
    await fetch("/api/stickies", { method: "POST", body: fd }),
  );
}

export async function deleteSticky(id: string): Promise<void> {
  await parse(await fetch(`/api/stickies/${id}`, { method: "DELETE" }));
}

export async function sendFeedback(message: string): Promise<{ ok: true }> {
  return parse(
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
}

export interface NewLetter {
  recipientId: string;
  subject: string;
  body: string;
  paperStyle: string;
  isAnonymous: boolean;
  photo?: Blob | null;
}

export async function createLetter(input: NewLetter) {
  const fd = new FormData();
  fd.append("recipient_id", input.recipientId);
  fd.append("subject", input.subject);
  fd.append("body", input.body);
  fd.append("paper_style", input.paperStyle);
  fd.append("is_anonymous", String(input.isAnonymous));
  if (input.photo) fd.append("photo", input.photo, "photo.webp");
  return parse<{ letter: any }>(
    await fetch("/api/letters", { method: "POST", body: fd }),
  );
}

export async function markLetterOpened(id: string): Promise<{ ok: true; isOpened: boolean; openedAt: number }> {
  return parse(await fetch(`/api/letters/${id}/open`, { method: "POST" }));
}

export async function deleteLetter(id: string): Promise<void> {
  await parse(await fetch(`/api/letters/${id}`, { method: "DELETE" }));
}


/* ------------------------------------------------------------------ */
/* Admin dashboard (every call 403s unless the session is staff)       */
/* ------------------------------------------------------------------ */

async function adminSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export const admin = {
  listMembers: () => adminSend<{ members: AdminMember[] }>("/admin/members", "GET"),
  addMember: (input: { name: string; email: string; is_mentor?: boolean }) =>
    adminSend<{ ok: true; id: string; link: string }>("/admin/members", "POST", input),
  updateMember: (id: string, input: { name?: string; email?: string; is_mentor?: boolean }) =>
    adminSend<{ ok: true }>(`/admin/members/${encodeURIComponent(id)}`, "PATCH", input),
  resendLink: (id: string) =>
    adminSend<{ ok: true; emailed: boolean; link?: string }>(
      `/admin/members/${encodeURIComponent(id)}/resend-link`, "POST"),
  deleteMember: (id: string) =>
    adminSend<{ ok: true }>(`/admin/members/${encodeURIComponent(id)}?confirm=permanent`, "DELETE"),
  disableMember: (id: string) =>
    adminSend<{ ok: true }>(`/admin/members/${encodeURIComponent(id)}/disable`, "POST"),
  enableMember: (id: string) =>
    adminSend<{ ok: true }>(`/admin/members/${encodeURIComponent(id)}/enable`, "POST"),
  listActions: () => adminSend<{ actions: AdminAction[] }>("/admin/actions", "GET"),

  listStickies: () => adminSend<{ stickies: AdminSticky[] }>("/admin/stickies", "GET"),
  setStickyHidden: (id: string, hidden: boolean) =>
    adminSend<{ ok: true }>(`/admin/stickies/${encodeURIComponent(id)}`, "PATCH", { hidden }),
  deleteSticky: (id: string) =>
    adminSend<{ ok: true }>(`/admin/stickies/${encodeURIComponent(id)}?confirm=permanent`, "DELETE"),

  listLetters: () => adminSend<{ letters: AdminLetter[] }>("/admin/letters", "GET"),
  setLetterHidden: (id: string, hidden: boolean) =>
    adminSend<{ ok: true }>(`/admin/letters/${encodeURIComponent(id)}`, "PATCH", { hidden }),
  deleteLetter: (id: string) =>
    adminSend<{ ok: true }>(`/admin/letters/${encodeURIComponent(id)}?confirm=permanent`, "DELETE"),

  listFeedback: () => adminSend<{ feedback: AdminFeedbackItem[] }>("/admin/feedback", "GET"),
  setFeedbackRead: (id: string, read: boolean) =>
    adminSend<{ ok: true }>(`/admin/feedback/${encodeURIComponent(id)}`, "PATCH", { read }),

  listMedia: () => adminSend<{ media: AdminMediaItem[] }>("/admin/media", "GET"),
  deleteMedia: (key: string) =>
    adminSend<{ ok: true }>(`/admin/media/${key.split("/").map(encodeURIComponent).join("/")}?confirm=permanent`, "DELETE"),
};

// Shared types used by both the Pages Functions API and the Preact frontend.

export const STICKY_COLORS = [
  "yellow",
  "blue",
  "green",
  "pink",
  "purple",
  "gray",
] as const;

export type StickyColor = (typeof STICKY_COLORS)[number];

export interface Me {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  wallPublic: boolean;
  /** Notes received since this member last opened their own wall — drives the
   *  red notification dot. Cleared to 0 by viewing your wall. */
  unreadCount: number;
  /** Staff flag. The nav shows the Admin entry when set; every /admin route
   *  re-checks it server-side regardless of what the frontend renders. */
  isAdmin: boolean;
}

/** One "## About Me"-style block from a cohort profile. Body is Markdown. */
export interface ProfileSection {
  title: string;
  body: string;
}

export interface ProfileLink {
  label: string;
  url: string;
}

/** A member's academy profile. Visible to any signed-in member: it introduces
 *  them to the cohort, and is deliberately independent of wall visibility. */
export interface Profile {
  session: string | null; // "AM" | "PM" (learners)
  role: string | null; // "Tech Mentor" etc. (mentors); null for learners
  tagline: string | null;
  intro: string;
  sections: ProfileSection[];
  links: ProfileLink[];
}

/** A senior/mentor card for the Mentors directory. Mentors are full members now
 *  (they sign in, own a wall, receive stickies) — this is just the directory
 *  shape, carrying the role/skills the mentor grid and search show. */
export interface Mentor {
  id: string;
  slug: string;
  name: string;
  nickname: string | null;
  role: string | null;
  skills: string[];
  tagline: string | null;
  photoUrl: string | null;
  thumbUrl: string | null;
  intro: string;
  sections: ProfileSection[];
  links: ProfileLink[];
}

export interface RosterMember {
  id: string;
  name: string;
  /** Full-size (400px) — for profile headers. */
  avatarUrl: string | null;
  /** 144px variant — for the roster grid and pickers. Falls back to avatarUrl. */
  thumbUrl: string | null;
  wallPublic: boolean;
  isSelf: boolean;
  receivedCount: number;
  session: string | null;
  tagline: string | null;
}

export interface Sticky {
  id: string;
  authorName: string | null; // codename (e.g. "Pink Leopard") when anonymous
  authorColor: string | null; // accent hex for the codename, else null
  isAnonymous: boolean;
  mine: boolean; // did the current viewer author it (non-anonymous only)
  describedAs: string;
  goodAt: string;
  color: StickyColor;
  photoUrl: string | null;
  createdAt: number;
}

export const LETTER_STYLES = [
  "classic",
  "kraft",
  "rose",
  "midnight",
  "sage",
] as const;

export type LetterStyle = (typeof LETTER_STYLES)[number];

export interface Letter {
  id: string;
  recipientId: string;
  authorName: string | null;
  authorColor: string | null;
  isAnonymous: boolean;
  mine: boolean;
  subject: string;
  body: string;
  paperStyle: LetterStyle;
  photoUrl: string | null;
  isOpened: boolean;
  openedAt: number | null;
  createdAt: number;
}

export interface WallResponse {
  member: RosterMember;
  isSelf: boolean;
  /** Mentors are browsed from their own directory — the wall's Back goes there. */
  isMentor: boolean;
  visible: boolean; // false => private wall the viewer may not see
  stickies: Sticky[];
  letters: Letter[]; // Sealed private letters for recipient or author
  profile: Profile | null; // shown even when the wall itself is private
}

export interface CreateStickyResult {
  sticky: Sticky;
}

export interface CreateLetterResult {
  letter: Letter;
}

export const MAX_FIELD_LEN = 280;
export const MAX_LETTER_BODY_LEN = 4000;
export const MAX_LETTER_SUBJECT_LEN = 120;


/* ------------------------------------------------------------------ */
/* Admin dashboard                                                     */
/* ------------------------------------------------------------------ */

export interface AdminMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isMentor: boolean;
  isAdmin: boolean;
  disabledAt: number | null;
  wallPublic: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  receivedCount: number;
}

export interface AdminSticky {
  id: string;
  recipientId: string;
  recipientName: string;
  authorId: string | null;
  authorName: string | null;
  isAnonymous: boolean;
  describedAs: string;
  goodAt: string;
  color: string;
  hasPhoto: boolean;
  createdAt: number;
  hiddenAt: number | null;
  hiddenBy: string | null;
}

export interface AdminLetter {
  id: string;
  recipientId: string;
  recipientName: string;
  authorId: string | null;
  authorName: string | null;
  isAnonymous: boolean;
  subject: string;
  excerpt: string;
  isOpened: boolean;
  createdAt: number;
  hiddenAt: number | null;
  hiddenBy: string | null;
}

export interface AdminFeedbackItem {
  id: string;
  memberId: string;
  memberName: string;
  message: string;
  createdAt: number;
  readAt: number | null;
}

export interface AdminMediaItem {
  key: string;
  kind: "avatar" | "profile-photo" | "profile-thumb" | "sticky-photo" | "letter-photo";
  ownerId: string;
  ownerName: string;
}

export interface AdminStats {
  members: { total: number; active: number; deactivated: number; admins: number; joinedLast7d: number };
  roster: { profiles: number; mentors: number; learners: number; sessionAm: number; sessionPm: number };
  stickies: { total: number; hidden: number; visible: number; last7d: number };
  letters: { total: number; hidden: number; visible: number };
  feedback: { total: number; read: number; unread: number };
  media: { total: number };
}

export interface AdminAction {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  createdAt: number;
  adminName: string;
}

export interface AdminRosterEntry {
  id: string;
  name: string;
  email: string;
  isMentor: boolean;
  disabledAt: number | null;
  hasProfile: boolean;
  slug: string | null;
  session: string | null;
  tagline: string | null;
  role: string | null;
  hasPhoto: boolean;
  hasThumb: boolean;
}

/** Where a pin came from: the member themselves, or the admin-set initial
 *  cohort placement. The map labels these differently and never lets an admin
 *  stamp read as member-confirmed. */
export type LocationSource = "member" | "admin";

/** One pin on the academy map. */
export interface MapPin {
  id: string;
  name: string;
  avatarUrl: string | null;
  thumbUrl: string | null;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** Seconds since epoch. */
  updatedAt: number;
  source: LocationSource;
  isMentor: boolean;
}

/** A member's own location as the editor sees it (includes the opt-out flag,
 *  which never leaves the server for other members). */
export interface MemberLocation {
  cityId: number;
  city: string;
  country: string;
  updatedAt: number;
  source: LocationSource;
  hidden: boolean;
}

/**
 * The label under a pin. Member-set locations are confirmed as of their save
 * date. Admin-set pins carry no visible stamp: the member never chose them,
 * and the UI must not read as if they did - so it says nothing at all. The
 * provenance itself (location_source) is unchanged and still drives the
 * admin initializer safeguards.
 */
export function locationStamp(pin: {
  updatedAt: number;
  source: LocationSource;
}): string | null {
  if (pin.source === "admin") return null;
  const date = new Date(pin.updatedAt * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `Confirmed ${date}`;
}

/**
 * Which rows the admin's initial cohort placement may pin: learners who have
 * never made any location choice. A member who REMOVED their city still has
 * location_source='member' - the removal is itself the choice, and a rerun
 * must not resurrect a pin they took down. Hidden members are excluded too:
 * hiding is an explicit opt-out, so even a hidden member with no city (only
 * reachable via the raw API, never the UI) must not receive an admin pin.
 */
export const ADMIN_PIN_FILTER_SQL =
  "COALESCE(is_mentor, 0) = 0 AND city IS NULL AND location_source IS NULL AND COALESCE(location_hidden, 0) = 0";

/**
 * One-time cohort placement: pin every learner who has never chosen a city to
 * Kuta, Bali, stamped location_source='admin' so the map labels those pins as
 * admin-set rather than member-confirmed.
 *
 * Safe to re-run: the WHERE clause (ADMIN_PIN_FILTER_SQL) skips anyone who
 * has EVER made a location choice - setting their own city, and also removing
 * one: a removed city keeps location_source='member', so a rerun never
 * re-pins a member who took their pin down. Mentors are excluded - the
 * initial cohort is the learners.
 *
 *   npm run set-locations:kuta -- --dry-run    # count who would be pinned
 *   npm run set-locations:kuta                 # local D1
 *   npm run set-locations:kuta:remote          # production D1 - only John decides when/if this runs
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { KUTA } from "../shared/cities";
import { ADMIN_PIN_FILTER_SQL, ADMIN_PIN_INSERT_SQL } from "../shared/location";
import { d1ExecFile, d1Query, isRemote, sqlQuote } from "./util";

async function main() {
  const remote = isRemote();
  const dryRun = process.argv.includes("--dry-run");

  // Existing profile rows matching the filter, plus members with no profile
  // row at all (seeded roster members who never touched their location).
  const [{ n }] = d1Query<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM profiles p WHERE ${ADMIN_PIN_FILTER_SQL}) +
       (SELECT COUNT(*) FROM members m LEFT JOIN profiles p2 ON p2.member_id = m.id
        WHERE p2.member_id IS NULL) AS n`,
    remote,
  );
  console.log(
    `${n} learner${n === 1 ? "" : "s"} would be pinned to ${KUTA.name}, ${KUTA.country}.`,
  );
  if (dryRun) return;
  if (n === 0) return;

  const now = Date.now();
  const file = `.tmp-set-locations-kuta-${now}.sql`;
  const insertSql = ADMIN_PIN_INSERT_SQL.replace(":city", sqlQuote(KUTA.name))
    .replace(":country", sqlQuote(KUTA.country))
    .replace(":lat", String(KUTA.lat))
    .replace(":lon", String(KUTA.lon))
    .replace(":city_id", String(KUTA.id))
    .replace(/:now/g, String(now));
  writeFileSync(
    file,
    `UPDATE profiles SET
       city = ${sqlQuote(KUTA.name)},
       country = ${sqlQuote(KUTA.country)},
       lat = ${KUTA.lat},
       lon = ${KUTA.lon},
       city_id = ${KUTA.id},
       location_updated_at = ${now},
       location_source = 'admin'
     WHERE ${ADMIN_PIN_FILTER_SQL};
${insertSql};\n`,
  );
  try {
    d1ExecFile(file, remote);
    console.log(`Pinned ${n} learners to ${KUTA.name} (source: admin).`);
  } finally {
    unlinkSync(file);
  }
}

main();

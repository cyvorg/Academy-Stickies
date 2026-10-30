/**
 * Grant (or revoke) the admin flag on a member, by email.
 *
 * Admins get the in-app Admin dashboard (members, moderation, feedback,
 * media). There is deliberately no UI for granting admin: it is a developer
 * operation, run by someone who already holds the D1 credentials.
 *
 *   npm run grant-admin -- --email=dev@example.com            # local D1
 *   npm run grant-admin:remote -- --email=dev@example.com     # production
 *   npm run grant-admin -- --email=dev@example.com --revoke
 */
import { randomBytes, randomUUID } from "node:crypto";
import { d1Query, isRemote, loadDevVars, siteUrl, sqlQuote } from "./util";
import { execFileSync } from "node:child_process";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

function main() {
  const email = (arg("email") ?? "").trim().toLowerCase();
  const revoke = process.argv.includes("--revoke");
  if (!email || !email.includes("@")) {
    console.error("Usage: grant-admin --email=<member email> [--revoke] [--remote]");
    process.exit(1);
  }

  const remote = isRemote();
  const rows = d1Query<{ id: string; name: string; is_admin: number }>(
    `SELECT id, name, is_admin FROM members WHERE lower(email) = ${sqlQuote(email)}`,
    remote,
  );
  const member = rows[0];
  if (!member) {
    console.error(`No member with email ${email}. Add them first (seed or the admin dashboard).`);
    process.exit(1);
  }

  const flag = revoke ? 0 : 1;
  if (member.is_admin === flag) {
    console.log(`${member.name} <${email}> is already ${revoke ? "not an admin" : "an admin"}.`);
    return;
  }

  // Granting admin also ROTATES the member's magic-link token: their
  // pre-existing, possibly emailed or printed, never-expiring link must not
  // silently become an admin credential. Audit rows are attributed to the
  // 'dev-script' sentinel (admin_id has no FK by design), never to the
  // target - the log must not claim members granted themselves admin.
  const freshToken = randomBytes(24).toString("base64url");
  execFileSync(
    "npx",
    [
      "wrangler", "d1", "execute", "stickies-db",
      remote ? "--remote" : "--local",
      "--command",
      `UPDATE members SET is_admin = ${flag}` +
      (revoke ? "" : `, login_token = '${freshToken}'`) +
      ` WHERE id = ${sqlQuote(member.id)}; ` +
      `INSERT INTO admin_actions (id, admin_id, action, target_type, target_id, detail, created_at) ` +
      `VALUES ('${randomUUID()}', 'dev-script', '${revoke ? "admin.revoke" : "admin.grant"}', ` +
      `'member', ${sqlQuote(member.id)}, 'via scripts/grant-admin.ts', ${Date.now()});`,
    ],
    { stdio: "inherit" },
  );
  console.log(`${revoke ? "Revoked" : "Granted"} admin for ${member.name} <${email}> (${remote ? "remote" : "local"} D1).`);
  if (!revoke) {
    console.log("Their sign-in token was rotated; any old magic link is dead.");
    if (process.argv.includes("--print-link")) {
      loadDevVars();
      console.log(`${siteUrl()}/api/auth?token=${freshToken}`);
    } else {
      console.log("Print the fresh link with: npm run login-link" + (remote ? ":remote" : "") + ` -- --email=${email}`);
    }
  }
}

main();

/**
 * Print a member's magic sign-in link, by email.
 *
 * The admin dashboard never returns sign-in tokens in API responses: with
 * email configured the link goes to the member's inbox, and without it
 * (local development) a developer runs this against D1. Treat the output
 * like a password: it signs in as that member.
 *
 *   npm run login-link -- --email=dev@example.com            # local D1
 *   npm run login-link:remote -- --email=dev@example.com     # production
 */
import { d1Query, isRemote, loadDevVars, siteUrl, sqlQuote } from "./util";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

function main() {
  const email = (arg("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Usage: login-link --email=<member email> [--remote]");
    process.exit(1);
  }

  loadDevVars();
  const remote = isRemote();
  const rows = d1Query<{ name: string; login_token: string; disabled_at: number | null }>(
    `SELECT name, login_token, disabled_at FROM members WHERE lower(email) = ${sqlQuote(email)}`,
    remote,
  );
  const member = rows[0];
  if (!member) {
    console.error(`No member with email ${email}.`);
    process.exit(1);
  }
  if (member.disabled_at) {
    console.error(`${member.name} is deactivated; re-enable them before sharing a link.`);
    process.exit(1);
  }

  console.log(`${siteUrl()}/api/auth?token=${member.login_token}`);
}

main();

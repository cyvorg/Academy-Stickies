import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function isRemote(): boolean {
  return process.argv.includes("--remote");
}

/** Load `.dev.vars` (KEY="value" lines) into process.env if not already set. */
export function loadDevVars(): void {
  if (!existsSync(".dev.vars")) return;
  const text = readFileSync(".dev.vars", "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Site origin for REMOTE sign-in links: never falls back to localhost,
 * because a localhost URL carrying a production token is a broken, confusing
 * link. Requires --site=... or SITE_URL and exits otherwise. */
export function remoteSiteUrl(): string {
  const arg = process.argv.find((a) => a.startsWith("--site="));
  const url = (arg ? arg.slice("--site=".length) : process.env.SITE_URL) ?? "";
  if (!url) {
    console.error(
      "Refusing to print a remote sign-in link without an explicit site: pass --site=https://<project>.pages.dev or set SITE_URL.",
    );
    process.exit(1);
  }
  if (!url.startsWith("https://")) {
    // The link carries a login token in its query string: plain http would
    // expose it in transit.
    console.error("Refusing a non-https origin for a remote sign-in link.");
    process.exit(1);
  }
  return url.replace(/\/$/, "");
}

export function siteUrl(): string {
  const arg = process.argv.find((a) => a.startsWith("--site="));
  if (arg) return arg.slice("--site=".length).replace(/\/$/, "");
  return (process.env.SITE_URL || "http://localhost:8788").replace(/\/$/, "");
}

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const DB_NAME = "stickies-db";

export interface MemberRow {
  name: string;
  email: string;
  login_token: string;
}

function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON in wrangler output");
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Run a read query against D1 and return its rows. */
export function d1Query<T>(sql: string, remote: boolean): T[] {
  const stdout = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      remote ? "--remote" : "--local",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = extractJson(stdout) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

/** Execute a SQL file against D1. */
export function d1ExecFile(file: string, remote: boolean): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      remote ? "--remote" : "--local",
      "--file",
      file,
    ],
    { stdio: "inherit" },
  );
}

// Suite-wide network guard: no test may make a real outbound request.
// A test that needs a "remote" response stubs globalThis.fetch itself
// (see the email-failure test in admin.test.ts) and restores it after;
// restoring lands back on this guard.
// The message carries origin + path only: query strings can hold
// sign-in tokens, and headers/bodies never belong in a test failure.
function where(input: unknown): string {
  try {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(unparseable request target)";
  }
}
globalThis.fetch = (async (input: unknown) => {
  throw new Error(
    `Test attempted a real network request to ${where(input)}. ` +
      "Stub globalThis.fetch in the test instead.",
  );
}) as typeof fetch;

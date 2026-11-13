// scripts/managed/desk/github.mjs — the desk's GitHub client (EST-1051).
//
// The desk acts on GitHub as its own GitHub App, `jekyll-desk`, owned by the
// founder's account and installed only on the private request repository
// (`Pathmagic/jekyll-desk`) and the public heartbeat repository
// (`Pathmagic/jekyll-heartbeat`). It signs a short-lived JWT with the App's
// private key, read from the founder's Keychain by desk.sh and handed in on
// stdin, and exchanges it for an installation token — the flow GitHub's
// reference gives ("Create an installation access token for an app",
// POST /app/installations/{installation_id}/access_tokens,
// docs.github.com/en/rest/apps/apps, read 2026-10-27; the JWT signed RS256
// with `iat`, `exp` no more than ten minutes on, and `iss` the App's id).
// The same flow `src/lib/jekyll-github-author.ts` uses for the crons' App.
//
// Node built-ins only: the desk runs on the founder's Mac from a copy
// installed out of GitHub's main, with no npm install.
import { createSign } from "node:crypto";

export const API = "https://api.github.com";

const b64url = (b) =>
  Buffer.from(b)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/** A GitHub App JWT: RS256, issued a minute back, nine minutes long. PURE. */
export function appJwt(appId, privateKeyPem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }),
  );
  const sign = createSign("RSA-SHA256");
  sign.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(sign.sign(privateKeyPem))}`;
}

/**
 * A REST client with `token` as the bearer. A refused call throws an Error
 * carrying the status and GitHub's own message, so no failure is silent.
 *
 * With `cache` (a Map), a GET is asked conditionally (EST-1080): an answer
 * carrying an `etag` is kept under its whole path, query included, and the
 * next GET of that path sends the `etag` as `if-none-match`; a 304 returns a
 * copy of what was kept, and "does not count against your primary rate
 * limit" (docs.github.com/en/rest/using-the-rest-api/best-practices-for-
 * using-the-rest-api). An answer with no `etag` is not kept, so it is read
 * whole every time; a 304 to a GET that was not conditional is refused.
 * `pace()` gives the longest `x-poll-interval` GitHub has asked for, the
 * last `x-ratelimit-remaining` it reported, `counted` (every answer but a
 * 304, starting from `counted`, the run's token) and `fresh` (GETs answered
 * with a body, which GitHub counts); `left()` is what `budget` leaves of the
 * run's reads, the token and the fresh GETs. Writes count with GitHub but not
 * against `budget`: they follow answers and asks, not the clock.
 */
export function client({
  fetchFn = fetch,
  token,
  api = API,
  timeoutMs = 15000,
  cache = null,
  budget = Number.POSITIVE_INFINITY,
  counted = 0,
}) {
  const seen = { pollSec: 0, remaining: null, counted, fresh: 0 };
  async function call(method, path, body) {
    const kept = method === "GET" && cache ? cache.get(path) : undefined;
    const res = await fetchFn(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "jekyll-desk",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(kept ? { "if-none-match": kept.etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const header = (k) => res.headers?.get?.(k) ?? null;
    const poll = Number(header("x-poll-interval"));
    if (Number.isFinite(poll) && poll > seen.pollSec) seen.pollSec = poll;
    const left = header("x-ratelimit-remaining");
    if (left !== null && Number.isFinite(Number(left)))
      seen.remaining = Number(left);
    if (res.status === 304) {
      if (!kept)
        throw new Error(
          `GitHub ${method} ${path} answered 304 to a request that was not conditional`,
        );
      return structuredClone(kept.json);
    }
    seen.counted++;
    if (method === "GET") seen.fresh++;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = new Error(
        `GitHub ${method} ${path} answered ${res.status}: ${String(json?.message ?? text).slice(0, 200)}`,
      );
      e.status = res.status;
      throw e;
    }
    if (method === "GET" && cache) {
      const etag = header("etag");
      if (etag) cache.set(path, { etag, json: structuredClone(json) });
      else cache.delete(path);
    }
    return json;
  }
  return {
    call,
    pace: () => ({ ...seen }),
    left: () => budget - counted - seen.fresh,
    /** Widen the budget by reads bounded elsewhere (the heartbeat's). */
    allow: (n) => {
      budget += Math.max(0, Number(n) || 0);
    },
  };
}

/** The installation token for the desk's App, from its key. */
export async function installationToken({
  fetchFn = fetch,
  appId,
  installationId,
  privateKeyPem,
  api = API,
  now = Date.now(),
}) {
  const app = client({
    fetchFn,
    token: appJwt(appId, privateKeyPem, now),
    api,
  });
  const r = await app.call(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
  );
  if (!r || typeof r.token !== "string" || !r.token)
    throw new Error(
      "GitHub answered the installation token call with no token",
    );
  return r.token;
}

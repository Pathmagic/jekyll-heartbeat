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
 */
export function client({
  fetchFn = fetch,
  token,
  api = API,
  timeoutMs = 15000,
}) {
  async function call(method, path, body) {
    const res = await fetchFn(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "jekyll-desk",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
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
    return json;
  }
  return { call };
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

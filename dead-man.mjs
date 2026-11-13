#!/usr/bin/env node
// scripts/managed/desk/dead-man.mjs — the desk's dead-man (EST-1051; the
// founder, EEV-330 and EEV-340: "a stale heartbeat actually opens the issue
// assigned to me").
//
// Runs in GitHub Actions in the public repository `Pathmagic/jekyll-heartbeat`
// every fifteen minutes (`.github/workflows/dead-man.yml` there, a copy of
// `heartbeat-repo/` beside this file), with that repository's own workflow
// token, so it does not need the Mac or the desk to be up. The workflow hands
// it in as HEARTBEAT_REPO_TOKEN: the name the audit crons' production setting
// carries belongs to that setting (scripts/audit/dependency-manifest.json),
// and this is a different token in a different repository. The desk
// commits `heartbeat.json` there every fifteen minutes. When the newest commit
// to that file is more than 45 minutes old, or cannot be read, it opens an
// issue assigned to the founder that mentions them — GitHub Mobile pushes
// assignments and mentions, not activity on a watched repository
// (docs.github.com, Configuring notifications, read 2026-10-26) — unless one
// is already open. Every thirty days it opens a ready-check issue the founder
// closes from the phone, which proves the push reaches the phone; the desk's
// /start line reads it closed. `PLANT=stale` (workflow_dispatch) treats the
// heartbeat as stale, the real proof that the path opens an assigned issue.
//
// It never closes an issue: the founder does, after reading it.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./github.mjs";

export const STALE_MS = 45 * 60 * 1000;
export const READY_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * EST-1261 (the move into an organisation, EEV-432 and EEV-433): the
 * founder's account, by id (`gh api user`: Pathmagic, 219521933), which a
 * rename keeps; each run asks GitHub for its login and assigns and mentions
 * that, so a renamed account is still the one an alarm reaches.
 */
export const FOUNDER_ID = 219521933;
const STALE_TITLE = "Desk heartbeat stale";
const READY_TITLE = "Desk ready check";

/**
 * What to open, from what was read. `beatAt` the newest heartbeat commit's
 * instant (NaN when unread), `openTitles` the open issues' titles, `lastReady`
 * the newest ready-check issue's creation instant (NaN when none), `login`
 * the founder's login as GitHub gives it for FOUNDER_ID, or null when it
 * could not be had: then each issue is opened assigned to no one and
 * mentioning no one. PURE.
 */
export function decide({
  beatAt,
  now,
  openTitles = [],
  lastReady = Number.NaN,
  plant = "",
  login = null,
}) {
  const issues = [];
  const to = login ? { assignees: [login] } : {};
  const unseen = login
    ? []
    : [
        "",
        `The founder's login could not be looked up from their account id (${FOUNDER_ID}), so this issue is assigned to no one, and this run fails.`,
      ];
  const stale =
    plant === "stale" || !Number.isFinite(beatAt) || now - beatAt > STALE_MS;
  if (stale && !openTitles.some((t) => t.startsWith(STALE_TITLE))) {
    const since = Number.isFinite(beatAt)
      ? new Date(beatAt).toISOString()
      : "unknown (the heartbeat could not be read)";
    issues.push({
      title: `${STALE_TITLE}${plant === "stale" ? " (PLANTED, a proof run)" : ""} — last heartbeat ${since}`,
      body: [
        `${login ? `@${login} the` : "The"} desk's heartbeat has not reached GitHub for more than 45 minutes${plant === "stale" ? " (planted: this run was told to treat it as stale, to prove the path)" : ""}.`,
        "",
        `Last heartbeat: ${since}. Checked: ${new Date(now).toISOString()}.`,
        "",
        "Until it returns, no request reaches your phone and no approval is written. The Mac may be asleep, off, offline or restarted and not logged in, Docker may be stopped, or the desk itself failed: its own record is `~/.config/jekyll/desk-heartbeat.json` at the Mac.",
        "The halt from your phone still works without the desk (an open issue in Pathmagic/jekyll-halt). Close this issue when you have read it.",
        ...unseen,
      ].join("\n"),
      ...to,
    });
  }
  if (!Number.isFinite(lastReady) || now - lastReady > READY_EVERY_MS) {
    issues.push({
      title: `${READY_TITLE} — close this from your phone`,
      body: [
        `${login ? `@${login} close` : "Close"} this issue from your phone. It proves a push from GitHub reaches it; the desk counts as ready only while one of these was closed by you in the last 30 days.`,
        ...unseen,
      ].join("\n"),
      ...to,
    });
  }
  return issues;
}

/** The founder's login as GitHub gives it for FOUNDER_ID, or null. Never throws. */
export async function founderLogin(gh) {
  try {
    const u = await gh.call("GET", `/user/${FOUNDER_ID}`);
    return Number(u?.id) === FOUNDER_ID &&
      typeof u?.login === "string" &&
      u.login
      ? u.login
      : null;
  } catch {
    return null;
  }
}

/** Read, decide, open. Returns `{ opened, login }`: the issues opened, and the founder's login, null when it could not be had. */
export async function run({
  fetchFn = fetch,
  token,
  repo,
  now = Date.now(),
  plant = "",
}) {
  const gh = client({ fetchFn, token });
  const login = await founderLogin(gh);
  let beatAt = Number.NaN;
  try {
    const c = await gh.call(
      "GET",
      `/repos/${repo}/commits?path=heartbeat.json&per_page=1`,
    );
    beatAt = Date.parse(c?.[0]?.commit?.committer?.date);
  } catch {
    beatAt = Number.NaN;
  }
  const open = await gh.call(
    "GET",
    `/repos/${repo}/issues?state=open&per_page=100`,
  );
  const all = await gh.call(
    "GET",
    `/repos/${repo}/issues?state=all&per_page=20&sort=created&direction=desc`,
  );
  const ready = (Array.isArray(all) ? all : []).find((i) =>
    String(i.title).startsWith(READY_TITLE),
  );
  const want = decide({
    beatAt,
    now,
    openTitles: (Array.isArray(open) ? open : []).map((i) => String(i.title)),
    lastReady: ready ? Date.parse(ready.created_at) : Number.NaN,
    plant,
    login,
  });
  const opened = [];
  for (const issue of want)
    opened.push(await gh.call("POST", `/repos/${repo}/issues`, issue));
  return { opened, login };
}

const fail = (cond, why) => {
  if (!cond) throw new Error(why);
};

/** The dead-man's planted cases, for the desk's table and its test. */
export function deadManCases() {
  const NOW = Date.parse("2026-10-27T12:00:00Z");
  const fresh = NOW - 5 * 60 * 1000;
  const old = NOW - 50 * 60 * 1000;
  const readyRecent = NOW - 24 * 60 * 60 * 1000;
  return [
    {
      name: "case 4: a stale heartbeat opens one issue assigned to the founder that mentions them (control: a fresh one opens nothing)",
      async run() {
        const clean = decide({
          beatAt: fresh,
          now: NOW,
          lastReady: readyRecent,
        });
        fail(
          clean.length === 0,
          `a fresh heartbeat opened ${clean.length} issue(s)`,
        );
        // EST-1261: the login GitHub gives for the founder's id, so a renamed
        // account is still the one assigned and mentioned.
        const planted = decide({
          beatAt: old,
          now: NOW,
          lastReady: readyRecent,
          login: "groundsheet",
        });
        fail(
          planted.length === 1,
          `a stale heartbeat opened ${planted.length} issue(s)`,
        );
        fail(
          planted[0].assignees?.includes("groundsheet"),
          `the stale issue is not assigned to the founder's login: ${JSON.stringify(planted[0].assignees)}`,
        );
        fail(
          planted[0].body.includes("@groundsheet"),
          "the stale issue does not mention the founder's login",
        );
        // With no login to be had the issue is still opened, unassigned and
        // mentioning no one, so it names no account that is not theirs.
        const blind = decide({
          beatAt: old,
          now: NOW,
          lastReady: readyRecent,
          login: null,
        });
        fail(
          blind.length === 1 &&
            !blind[0].assignees?.length &&
            !blind[0].body.includes("@"),
          `with no login: ${JSON.stringify(blind)}`,
        );
        const unread = decide({
          beatAt: Number.NaN,
          now: NOW,
          lastReady: readyRecent,
        });
        fail(
          unread.length === 1 && /could not be read/.test(unread[0].title),
          "an unreadable heartbeat did not open the issue",
        );
        const again = decide({
          beatAt: old,
          now: NOW,
          lastReady: readyRecent,
          openTitles: [planted[0].title],
        });
        fail(
          again.length === 0,
          "a second stale issue was opened beside an open one",
        );
      },
    },
    {
      name: "case 4, end to end: the dead-man run against GitHub's answers posts the assigned issue (stand-in at the network boundary)",
      async run() {
        const posted = [];
        const answers = {
          "GET /repos/Pathmagic/jekyll-heartbeat/commits": [
            { commit: { committer: { date: new Date(old).toISOString() } } },
          ],
          "GET /repos/Pathmagic/jekyll-heartbeat/issues": [
            {
              title: "Desk ready check — close this from your phone",
              created_at: new Date(readyRecent).toISOString(),
            },
          ],
          // answer-source: `gh api /user/219521933` answered
          // `{"login":"Pathmagic","id":219521933}` (2026-10-31); here as it
          // would after the rename.
          "GET /user/219521933": { login: "groundsheet", id: 219521933 },
        };
        const fetchFn = async (url, init = {}) => {
          const u = new URL(url);
          const k = `${init.method ?? "GET"} ${u.pathname}`;
          if (k === "POST /repos/Pathmagic/jekyll-heartbeat/issues") {
            posted.push(JSON.parse(init.body));
            return {
              ok: true,
              status: 201,
              text: async () => JSON.stringify({ number: posted.length }),
            };
          }
          const body =
            k.endsWith("/issues") && u.searchParams.get("state") === "open"
              ? []
              : answers[k];
          return body === undefined
            ? {
                ok: false,
                status: 404,
                text: async () => '{"message":"Not Found"}',
              }
            : { ok: true, status: 200, text: async () => JSON.stringify(body) };
        };
        await run({
          fetchFn,
          token: "t",
          repo: "Pathmagic/jekyll-heartbeat",
          now: NOW,
        });
        fail(
          posted.length === 1 && posted[0].assignees?.[0] === "groundsheet",
          `posted ${JSON.stringify(posted)}`,
        );
        // EST-1261: a lookup that does not answer still opens the issue,
        // unassigned, and the run says so, which fails it.
        delete answers["GET /user/219521933"];
        posted.length = 0;
        const r = await run({
          fetchFn,
          token: "t",
          repo: "Pathmagic/jekyll-heartbeat",
          now: NOW,
        });
        fail(
          posted.length === 1 &&
            !posted[0].assignees?.length &&
            r?.login === null,
          `with the lookup refused: posted ${JSON.stringify(posted)}, login ${JSON.stringify(r?.login)}`,
        );
      },
    },
  ];
}

function isMain() {
  return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    let failed = 0;
    for (const c of deadManCases()) {
      try {
        await c.run();
        console.log(`PASS ${c.name}`);
      } catch (e) {
        failed += 1;
        console.log(`FAIL ${c.name} — ${e.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }
  try {
    const { opened, login } = await run({
      token: process.env.HEARTBEAT_REPO_TOKEN,
      repo: process.env.GITHUB_REPOSITORY,
      plant: process.env.PLANT ?? "",
    });
    for (const i of opened) console.log(`opened #${i.number}: ${i.title}`);
    if (!login) {
      console.error(
        `dead-man: the founder's login could not be looked up from their account id (${FOUNDER_ID}), so no issue is assigned to them or mentions them`,
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(`dead-man: ${e.message}`);
    process.exit(1);
  }
}

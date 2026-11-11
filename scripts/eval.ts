/**
 * End-to-end evals against the real model + live web search.
 *
 *   npm run eval              # all scenarios
 *   npm run eval -- crm       # scenarios whose id contains "crm"
 *
 * Each scenario gets its own throwaway memory file. Past history is written in
 * as FIXTURES (backdated turns with known content), so retrieval can be graded
 * exactly. Fixtures never touch the real data/memory.json. Checks are
 * behavioural and read from the agent's event stream: did it call
 * recall_memory with the right dates, mention the right items, search when it
 * should (and not when it shouldn't), cite, finish, and how long it took.
 * Facts change, so the checks don't assert today's prices.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { Store, type Fact, type Source } from "../src/store.ts";
import { localDate } from "../src/time.ts";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY = 86_400_000;
const now = new Date();

/** Most recent past `weekday` (0=Sun) strictly before today, 11:00 local. */
function lastWeekday(weekday: number): Date {
  const d = new Date(now);
  d.setHours(11, 0, 0, 0);
  do d.setTime(d.getTime() - DAY);
  while (d.getDay() !== weekday);
  return d;
}
const daysAgo = (n: number) => {
  const d = new Date(now.getTime() - n * DAY);
  d.setHours(11, 0, 0, 0);
  return d;
};
const spoken = (d: Date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(d);

interface Fixture {
  at: Date;
  question: string;
  answer: string;
  sources?: Source[];
  facts?: Fact[];
  entities?: string[];
  decisions?: string[];
}

function seed(store: Store, f: Fixture) {
  const c = store.createConversation(f.at, f.question.slice(0, 40));
  const at = f.at.toISOString();
  const q = store.addTurn({ conversationId: c.id, role: "user", text: f.question, at, tz });
  store.addTurn({
    conversationId: c.id, role: "assistant", replyTo: q.id, status: "completed", text: f.answer, at, tz,
    sources: f.sources ?? [], facts: f.facts ?? [], entities: f.entities ?? [], decisions: f.decisions ?? [], extraction: "done",
  });
}

interface Run {
  text: string;
  status: string;
  ms: number;
  searches: string[];
  recalls: { from?: string; to?: string; query?: string }[];
  cited: number;
}
type Check = [name: string, ok: (r: Run) => boolean];

interface Scenario {
  id: string;
  history: Fixture[];
  ask: string;
  checks: Check[];
}

// ---- fixtures -----------------------------------------------------------------

const POSTGRES: Omit<Fixture, "at"> = {
  question: "What are the main managed Postgres hosting options and what do the entry-level paid plans cost?",
  answer: "Neon Launch: $19/mo [1]. Supabase Pro: $25/mo [2]. Render Postgres Basic: from $6/mo [3]. AWS RDS: usage-based.",
  sources: [
    { url: "https://neon.com/pricing", title: "Neon pricing" },
    { url: "https://supabase.com/pricing", title: "Supabase pricing" },
    { url: "https://render.com/pricing", title: "Render pricing" },
  ],
  entities: ["Neon", "Supabase", "Render", "AWS RDS"],
  facts: [
    { subject: "Neon", attribute: "Launch plan price", value: "$19/mo", sourceUrl: "https://neon.com/pricing" },
    { subject: "Supabase", attribute: "Pro plan price", value: "$25/mo", sourceUrl: "https://supabase.com/pricing" },
    { subject: "Render", attribute: "Postgres Basic price", value: "from $6/mo", sourceUrl: "https://render.com/pricing" },
  ],
};
const CRMS = ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Attio"];
const CRM: Omit<Fixture, "at"> = {
  question: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing.",
  answer: "Shortlist: HubSpot Sales Hub Pro, Pipedrive, Salesforce Sales Cloud, Zoho CRM, Attio. (per-seat prices in the table)",
  entities: CRMS,
  decisions: ["Shortlisted HubSpot, Pipedrive, Salesforce, Zoho CRM and Attio for a 20-person sales team"],
};

// ---- helpers for checks -------------------------------------------------------

const covers = (date: Date) => (r: Run) => {
  const d = localDate(date, tz);
  return r.recalls.some((x) => (!x.from || x.from <= d) && (!x.to || x.to >= d) && (x.from || x.to));
};
const mentions = (names: string[], min = names.length) => (r: Run) =>
  names.filter((n) => r.text.toLowerCase().includes(n.toLowerCase())).length >= min;
const completed: Check = ["completed", (r) => r.status === "completed"];
const searched = (min = 1): Check => [`searched ≥${min}`, (r) => r.searches.length >= min];
const cites: Check = ["cites sources", (r) => r.cited > 0];

const SCENARIOS: Scenario[] = [
  {
    id: "date-recall-and-recheck",
    history: [{ at: daysAgo(8), ...POSTGRES }],
    ask: `What did I ask you on ${spoken(daysAgo(8))}? Is your answer still correct today?`,
    checks: [
      ["recall covers that date", covers(daysAgo(8))],
      ["restates the question", mentions(["Postgres"])],
      ["re-checks named providers", mentions(["Neon", "Supabase"])],
      searched(1), cites, completed,
    ],
  },
  {
    id: "relative-weekday-pricing-diff",
    history: [{ at: lastWeekday(2), ...POSTGRES }],
    ask: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: [
      ["recall covers last Tuesday", covers(lastWeekday(2))],
      ["discusses the providers from memory", mentions(["Neon", "Supabase", "Render"], 2)],
      searched(2), cites, completed,
    ],
  },
  {
    id: "crm-shortlist-changes",
    history: [{ at: lastWeekday(1), ...CRM }],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: [
      ["recall covers Monday", covers(lastWeekday(1))],
      ["recovers the shortlist (≥4 of 5)", mentions(CRMS, 4)],
      ["doesn't ask which tools", (r) => !/which (5|five)? ?(crm|tools)/i.test(r.text)],
      searched(3), cites, completed,
    ],
  },
  {
    id: "no-history-is-honest",
    history: [],
    ask: "What did I ask you on 2 October? Is your answer still correct?",
    checks: [
      ["says there is no record", (r) => /no (record|conversation|history)|don'?t have|can'?t find|nothing (from|on)|not find/i.test(r.text)],
      ["doesn't search the web", (r) => r.searches.length === 0],
      completed,
    ],
  },
  {
    id: "wrong-date-reports-what-exists",
    history: [{ at: daysAgo(2), ...POSTGRES }],
    ask: `What did I ask you on ${spoken(daysAgo(5))}?`,
    checks: [
      ["says nothing on that date", (r) => /no (record|conversation)|didn'?t|nothing|don'?t (see|have)/i.test(r.text)],
      ["points to what does exist", mentions(["Postgres"])],
      completed,
    ],
  },
  {
    id: "current-fact-needs-search",
    history: [],
    ask: "What's the latest stable release of Node.js and what's new in it?",
    checks: [searched(1), cites, completed, ["answers under 45s", (r) => r.ms < 45_000]],
  },
  {
    id: "small-talk-is-fast",
    history: [],
    ask: "thanks, that was helpful!",
    checks: [["no search", (r) => r.searches.length === 0], ["no recall", (r) => r.recalls.length === 0], ["under 10s", (r) => r.ms < 10_000], completed],
  },
];

// ---- runner -------------------------------------------------------------------

async function run(s: Scenario): Promise<Run> {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "eval-")), "m.json"));
  s.history.forEach((f) => seed(store, f));
  const agent = new Agent(new Anthropic(), store);
  const r: Run = { text: "", status: "?", ms: 0, searches: [], recalls: [], cited: 0 };
  await agent.runTurn({ message: s.ask, tz, now }, (e: AgentEvent) => {
    if (e.type === "text") r.text += e.text;
    else if (e.type === "reset") r.text = "";
    else if (e.type === "status" && e.kind === "search") r.searches.push(e.query);
    else if (e.type === "status" && e.kind === "recall") r.recalls.push(e.args as Run["recalls"][number]);
    else if (e.type === "sources") r.cited = e.cited.length;
    else if (e.type === "done") Object.assign(r, { status: e.status, ms: e.ms });
    else if (e.type === "error") r.text += `\n[error] ${e.message}`;
  });
  return r;
}

const filter = process.argv[2];
const selected = SCENARIOS.filter((s) => !filter || s.id.includes(filter));
const results = [];
let passed = 0, total = 0;
for (const s of selected) {
  process.stdout.write(`\n▶ ${s.id}\n  Q: ${s.ask}\n`);
  const r = await run(s);
  const checks = s.checks.map(([name, ok]) => ({ name, ok: ok(r) }));
  for (const c of checks) {
    total++;
    if (c.ok) passed++;
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}`);
  }
  console.log(`  ${(r.ms / 1000).toFixed(1)}s · ${r.searches.length} searches · ${r.recalls.length} recalls · ${r.cited} cited · ${r.status}`);
  results.push({ id: s.id, ask: s.ask, checks, ...r });
}
console.log(`\n${passed}/${total} checks passed across ${selected.length} scenarios`);
const out = join("data", `eval-${now.toISOString().slice(0, 19).replace(/:/g, "")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`Full transcripts: ${out}`);

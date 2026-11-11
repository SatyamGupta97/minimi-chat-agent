import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refersToPast, resolveDates } from "../src/dates.ts";
import { lookupMemory } from "../src/memory-context.ts";
import { Store } from "../src/store.ts";

const tz = "Asia/Kolkata";
// Wednesday 11 November 2026, 10:00 in India.
const now = new Date("2026-11-11T04:30:00Z");
const ranges = (msg: string) => resolveDates(msg, now, tz).map((r) => (r.from === r.to ? r.from : `${r.from}..${r.to}`));

test("relative days", () => {
  assert.deepEqual(ranges("what did I ask yesterday?"), ["2026-11-10"]);
  assert.deepEqual(ranges("the day before yesterday"), ["2026-11-09"]);
  assert.deepEqual(ranges("earlier today you said"), ["2026-11-11"]);
  assert.deepEqual(ranges("what did I ask you today?"), ["2026-11-11"]);
  // "today" meaning "now" next to a real date is not a second lookup.
  assert.deepEqual(ranges("What did I ask on 3 November? Is it still correct today?"), ["2026-11-03"]);
  assert.deepEqual(ranges("3 days ago"), ["2026-11-08"]);
  assert.deepEqual(ranges("a few days ago"), ["2026-11-06..2026-11-09"]);
});

test("weekdays: plain means most recent; 'last' this week also offers the week before", () => {
  assert.deepEqual(ranges("On Monday we shortlisted 5 CRM tools"), ["2026-11-09"]);
  // Today is Wednesday: "last Tuesday" is yesterday or 3 November.
  assert.deepEqual(ranges("Last Tuesday I asked you about Postgres hosting"), ["2026-11-10", "2026-11-03"]);
  // Friday was in the previous week: one reading.
  assert.deepEqual(ranges("last Friday"), ["2026-11-06"]);
  // Today's weekday means the previous one, never today or the future.
  assert.deepEqual(ranges("on Wednesday"), ["2026-11-04"]);
});

test("explicit dates in several formats; future dates mean last year", () => {
  assert.deepEqual(ranges("What did I ask you on 3 November?"), ["2026-11-03"]);
  assert.deepEqual(ranges("on November 3rd"), ["2026-11-03"]);
  assert.deepEqual(ranges("the 3rd of Nov, 2026"), ["2026-11-03"]);
  assert.deepEqual(ranges("on 2026-11-03"), ["2026-11-03"]);
  assert.deepEqual(ranges("on 20 December"), ["2025-12-20"]);
  assert.deepEqual(ranges("on 31 November"), []); // not a date
});

test("weeks and months", () => {
  assert.deepEqual(ranges("last week"), ["2026-11-02..2026-11-08"]);
  assert.deepEqual(ranges("earlier this week"), ["2026-11-09..2026-11-11"]);
  assert.deepEqual(ranges("last month"), ["2026-10-01..2026-10-31"]);
});

test("timezone decides what 'yesterday' is", () => {
  // 23:30 UTC on 10 Nov is already 11 Nov in India, still 10 Nov in New York.
  const late = new Date("2026-11-10T23:30:00Z");
  assert.equal(resolveDates("yesterday", late, "Asia/Kolkata")[0].from, "2026-11-10");
  assert.equal(resolveDates("yesterday", late, "America/New_York")[0].from, "2026-11-09");
});

test("past references without dates are detected; ordinary questions are not", () => {
  assert.ok(refersToPast("You said Neon was cheaper, right?"));
  assert.ok(refersToPast("the tools we shortlisted"));
  assert.ok(!refersToPast("What is the cheapest Postgres host?"));
  assert.ok(!refersToPast("Should I check pricing before I buy?"));
});

function storeWith(at: string, q: string, a: string) {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "lk-")), "m.json"));
  const c = s.createConversation(new Date(at), q);
  const u = s.addTurn({ conversationId: c.id, role: "user", text: q, at, tz });
  s.addTurn({ conversationId: c.id, role: "assistant", replyTo: u.id, status: "completed", text: a, at, tz });
  return s;
}
const opts = { currentConversationId: "current", excludeTurnIds: new Set<string>() };

test("lookup: a dated question finds that day's exchange before the model runs", () => {
  const s = storeWith("2026-11-03T06:00:00Z", "Postgres hosting prices?", "Neon Launch is $19/mo.");
  const m = lookupMemory(s, "What did I ask you on 3 November?", now, tz, opts);
  assert.deepEqual(m.queries.map((q) => [q.from, q.to]), [["2026-11-03", "2026-11-03"]]);
  assert.match(m.text, /Postgres hosting prices\?/);
});

test("lookup: nothing on that date still reports what memory exists", () => {
  const s = storeWith("2026-11-09T06:00:00Z", "Postgres hosting prices?", "Neon.");
  const m = lookupMemory(s, "What did I ask you on 3 November?", now, tz, opts);
  assert.match(m.text, /no conversations found/);
  assert.match(m.text, /"days_with_conversations":\["2026-11-09"\]/);
});

test("lookup: ordinary questions trigger no lookup", () => {
  const s = storeWith("2026-11-09T06:00:00Z", "Postgres hosting prices?", "Neon.");
  assert.deepEqual(lookupMemory(s, "What's new in Node 26?", now, tz, opts), { queries: [], text: "" });
});

test("memory lookup only when the message refers to our past (regression table)", () => {
  const s = storeWith("2026-11-09T06:00:00Z", "Shortlist 5 CRMs", "HubSpot, Pipedrive, Salesforce, Zoho, Attio.");
  const kind = (msg: string) => {
    const q = lookupMemory(s, msg, now, tz, opts).queries;
    return q.length === 0 ? "none" : q[0].from ? `date×${q.length}` : "topic";
  };
  assert.equal(kind("On Monday we shortlisted five CRMs"), "date×1");
  assert.equal(kind("What did I ask on 3 November?"), "date×1");
  assert.equal(kind("Last Tuesday I asked about Postgres"), "date×2");
  assert.equal(kind("You said Neon was cheaper"), "topic");
  assert.equal(kind("What's the weather on Monday?"), "none");
  assert.equal(kind("Is Monday.com good for CRM?"), "none");
  assert.equal(kind("What's happening next Tuesday?"), "none");
  assert.equal(kind("Compare Monday.com and HubSpot"), "none");
});

test("weekday false positives: product names and future weekdays are not dates", () => {
  assert.deepEqual(ranges("we picked monday.com last week"), ["2026-11-02..2026-11-08"]);
  assert.deepEqual(ranges("next Tuesday"), []);
  assert.deepEqual(ranges("this coming Friday"), []);
  assert.deepEqual(ranges("on Monday."), ["2026-11-09"]); // sentence end is still a date
});

test("the week before last, and 'previous' like 'last'", () => {
  assert.deepEqual(ranges("the week before last"), ["2026-10-26..2026-11-01"]);
  assert.deepEqual(ranges("the previous Tuesday"), ["2026-11-10", "2026-11-03"]);
});

test("more ways of pointing at earlier chats", () => {
  assert.ok(refersToPast("what was my last question?"));
  assert.ok(refersToPast("in the other chat I told you something"));
  assert.ok(refersToPast("what did we talk about in our previous conversation?"));
  assert.ok(!refersToPast("what is my name?")); // answered from the profile, not a lookup
});

function store2() {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "rel-")), "m.json"));
  const add = (conv: string, at: string, q: string, a: string, extra: Record<string, unknown> = {}, status: "completed" | "failed" = "completed") => {
    const c = s.getConversation(conv) ?? s.createConversation(new Date(at), q.slice(0, 30), conv);
    const u = s.addTurn({ conversationId: c.id, role: "user", text: q, at, tz });
    s.addTurn({ conversationId: c.id, role: "assistant", replyTo: u.id, status, text: a, at, tz, ...extra });
  };
  add("crm", "2026-11-09T06:00:00Z", "Shortlist 5 CRM tools for my sales team", "HubSpot, Pipedrive, Salesforce, Zoho, Attio.", { entities: ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Attio"] });
  add("trip", "2026-11-10T06:00:00Z", "Plan a Goa trip in December for 4 friends", "Book flights early; North Goa for nightlife.");
  add("broken", "2026-11-10T07:00:00Z", "Kubernetes autoscaling question", "", {}, "failed");
  return s;
}

test("related past chats come along automatically, without asking about the past", () => {
  const s = store2();
  const m = lookupMemory(s, "Which CRM should my team pick, and is Attio any good?", now, tz, { currentConversationId: "new", excludeTurnIds: new Set() });
  assert.equal(m.queries[0]?.phrase, "related past chats");
  assert.match(m.text, /HubSpot/);
  assert.doesNotMatch(m.text, /Goa/); // unrelated chat not dragged in
});

test("automatic recall stays quiet for chit-chat, the current chat, and failed answers", () => {
  const s = store2();
  const o = (current: string) => ({ currentConversationId: current, excludeTurnIds: new Set<string>() });
  assert.deepEqual(lookupMemory(s, "thanks, that was helpful!", now, tz, o("new")).queries, []);
  assert.deepEqual(lookupMemory(s, "more CRM ideas please", now, tz, o("crm")).queries, []); // already in this chat's history
  assert.deepEqual(lookupMemory(s, "how does Kubernetes autoscaling work?", now, tz, o("new")).queries, []); // only a failed answer exists
});

test("recent activity shows the latest exchanges from other chats, newest first", async () => {
  const { recentActivity } = await import("../src/recall.ts");
  const r = recentActivity(store2(), tz, "trip");
  assert.match(r, /recalled_conversations kind="recent"/);
  assert.match(r, /Shortlist 5 CRM tools/);
  assert.doesNotMatch(r, /Goa/); // the current chat
  assert.doesNotMatch(r, /Kubernetes/); // failed answers are not memory
});

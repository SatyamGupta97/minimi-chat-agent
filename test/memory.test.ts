import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryDigest, recall } from "../src/recall.ts";
import { Store } from "../src/store.ts";
import { localDate, temporalContext } from "../src/time.ts";

const tz = "Asia/Kolkata";
const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), "mem-")), "m.json"));

function exchange(store: Store, at: string, q: string, a: string) {
  const c = store.createConversation(new Date(at), q.slice(0, 30));
  store.addTurn({ conversationId: c.id, role: "user", text: q, at, tz });
  store.addTurn({ conversationId: c.id, role: "assistant", text: a, at, tz,
    sources: [{ url: "https://neon.com/pricing", title: "Neon pricing" }] });
  return c;
}

test("local dates use the user's timezone, not UTC", () => {
  // 20:00 UTC on 2 Nov is already 3 Nov in India.
  assert.equal(localDate(new Date("2026-11-02T20:00:00Z"), tz), "2026-11-03");
  assert.equal(localDate(new Date("2026-11-02T20:00:00Z"), "America/New_York"), "2026-11-02");
});

test("calendar labels weekdays so the model never does date arithmetic", () => {
  const ctx = temporalContext(new Date("2026-11-11T05:00:00Z"), tz);
  assert.match(ctx, /2026-11-11: Wednesday, 11 November 2026 \(today\)/);
  assert.match(ctx, /2026-11-10: Tuesday, 10 November 2026 \(yesterday\)/);
  assert.match(ctx, /2026-11-03: Tuesday, 3 November 2026/);
});

test("recall by date range in the user's timezone", () => {
  const s = fresh();
  exchange(s, "2026-11-02T20:00:00Z", "Best Postgres hosting?", "Neon Launch is $19/mo.");
  exchange(s, "2026-11-05T10:00:00Z", "Tell me a joke", "Why did...");
  const r = recall(s, { from: "2026-11-03", to: "2026-11-03" }, tz);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].you_asked, "Best Postgres hosting?");
  assert.equal(r.matches[0].date, "2026-11-03");
});

test("recall by topic matches word variants and ranks relevant first", () => {
  const s = fresh();
  exchange(s, "2026-11-01T10:00:00Z", "Which CRM for a 20 person sales team?", "HubSpot, Pipedrive, Salesforce, Zoho, Close.");
  exchange(s, "2026-11-03T10:00:00Z", "Postgres hosting pricing?", "Neon, Supabase, RDS.");
  exchange(s, "2026-11-04T10:00:00Z", "Weather in Pune", "Sunny.");
  const r = recall(s, { query: "postgresql price" }, tz);
  assert.equal(r.matches[0].you_asked, "Postgres hosting pricing?");
  assert.equal(r.total_matches, 1);
});

test("empty recall still reports what memory exists, so the agent can be specific", () => {
  const s = fresh();
  exchange(s, "2026-11-09T10:00:00Z", "Q", "A");
  const r = recall(s, { from: "2026-11-03", to: "2026-11-03" }, tz);
  assert.equal(r.matches.length, 0);
  assert.equal(r.memory_overview.total_past_questions, 1);
  assert.deepEqual(r.memory_overview.days_with_conversations, ["2026-11-09"]);
});

test("the in-flight question is excluded from recall", () => {
  const s = fresh();
  const c = s.createConversation(new Date());
  const t = s.addTurn({ conversationId: c.id, role: "user", text: "what did I ask today?", at: new Date().toISOString(), tz });
  const r = recall(s, {}, tz, { excludeTurnIds: new Set([t.id]) });
  assert.equal(r.matches.length, 0);
});

test("digest says explicitly when there is no history", () => {
  const s = fresh();
  assert.match(memoryDigest(s, tz, "x"), /NO previous conversations/);
});

test("store persists atomically and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const a = new Store(join(dir, "m.json"));
  exchange(a, "2026-11-01T10:00:00Z", "persist me", "ok");
  const b = new Store(join(dir, "m.json"));
  assert.equal(b.allTurns().length, 2);
});

test("user profile: facts the user stated in one chat are available in every chat", async () => {
  const { userProfile } = await import("../src/recall.ts");
  const s = fresh();
  assert.equal(userProfile(s), ""); // nothing known yet: no block at all
  const a = s.createConversation(new Date("2026-11-11T05:00:00Z"));
  const q = s.addTurn({ conversationId: a.id, role: "user", text: "My name is Satyam", at: "2026-11-11T05:00:00Z", tz });
  s.addTurn({ conversationId: a.id, role: "assistant", replyTo: q.id, status: "completed", text: "Nice to meet you!", at: "2026-11-11T05:00:00Z", tz,
    aboutUser: ["The user's name is Satyam.", "The user runs a 20-person sales team."] });
  // A failed answer's extraction never feeds the profile.
  s.addTurn({ conversationId: a.id, role: "assistant", status: "failed", text: "", at: "2026-11-11T05:01:00Z", tz, aboutUser: ["junk"] });
  const p = userProfile(s);
  assert.match(p, /<user_profile/);
  assert.match(p, /The user's name is Satyam\./);
  assert.match(p, /20-person sales team/);
  assert.doesNotMatch(p, /junk/);
});

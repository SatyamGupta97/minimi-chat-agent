import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Provider } from "../src/providers/types.ts";
import { Agent } from "../src/agent.ts";
import { exchanges, recall } from "../src/recall.ts";
import { Store } from "../src/store.ts";
import { temporalContext } from "../src/time.ts";

const tz = "Asia/Kolkata";
const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), "mem-")), "m.json"));

test("calendar has 21 unique consecutive dates across DST transitions", () => {
  const zones = ["America/New_York", "Europe/London", "Australia/Sydney"];
  // Instants around the 2026 transitions (US: 8 Mar / 1 Nov; EU: 29 Mar / 25 Oct; AU: 5 Apr / 4 Oct).
  const starts = ["2026-03-09", "2026-03-30", "2026-04-06", "2026-10-05", "2026-10-26", "2026-11-02"];
  for (const zone of zones)
    for (const day of starts)
      for (let h = 0; h < 24; h += 1) {
        const now = new Date(`${day}T${String(h).padStart(2, "0")}:30:00Z`);
        const dates = [...temporalContext(now, zone).matchAll(/^- (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
        assert.equal(dates.length, 21);
        for (let i = 1; i < dates.length; i++) {
          const gap = (Date.parse(dates[i - 1]) - Date.parse(dates[i])) / 86_400_000;
          assert.equal(gap, 1, `${zone} ${now.toISOString()}: ${dates[i - 1]} -> ${dates[i]}`);
        }
      }
});

test("answers are linked to questions by replyTo, not by order", () => {
  const s = fresh();
  const c = s.createConversation(new Date("2026-11-03T10:00:00Z"));
  const at = "2026-11-03T10:00:00Z";
  // Two questions arrive before either answer; the answers land in reverse order.
  const q1 = s.addTurn({ conversationId: c.id, role: "user", text: "Neon pricing?", at, tz });
  const q2 = s.addTurn({ conversationId: c.id, role: "user", text: "Supabase pricing?", at, tz });
  s.addTurn({ conversationId: c.id, role: "assistant", replyTo: q2.id, status: "completed", text: "Supabase Pro is $25", at, tz });
  s.addTurn({ conversationId: c.id, role: "assistant", replyTo: q1.id, status: "completed", text: "Neon Launch is $19", at, tz });
  const ex = exchanges(s);
  assert.equal(ex.find((e) => e.question.id === q1.id)?.answer?.text, "Neon Launch is $19");
  assert.equal(ex.find((e) => e.question.id === q2.id)?.answer?.text, "Supabase Pro is $25");
});

test("incomplete answers are flagged in recall, completed ones are not", () => {
  const s = fresh();
  const c = s.createConversation(new Date());
  const at = "2026-11-03T10:00:00Z";
  const q = s.addTurn({ conversationId: c.id, role: "user", text: "CRM pricing", at, tz });
  s.addTurn({ conversationId: c.id, role: "assistant", replyTo: q.id, status: "failed", text: "HubSpot is", at, tz });
  const q2 = s.addTurn({ conversationId: c.id, role: "user", text: "CRM pricing again", at, tz });
  s.addTurn({ conversationId: c.id, role: "assistant", replyTo: q2.id, status: "completed", text: "HubSpot is $20", at, tz });
  const hits = recall(s, { query: "crm" }, tz).matches;
  assert.equal(hits.find((h) => h.you_asked === "CRM pricing")?.answer_status, "failed");
  assert.equal(hits.find((h) => h.you_asked === "CRM pricing again")?.answer_status, undefined);
});

/** A provider whose structured-JSON call returns `json()`'s result; nothing else is used by extraction. */
function fakeClient(json: () => Promise<unknown>): Provider {
  return { json: async (_p: string, schema: { parse(x: unknown): unknown }) => schema.parse(await json()), describeError: () => undefined } as unknown as Provider;
}

function pendingTurn(s: Store) {
  const c = s.createConversation(new Date(), "Which Postgres host?");
  const at = new Date().toISOString();
  const q = s.addTurn({ conversationId: c.id, role: "user", text: "Which Postgres host?", at, tz });
  return s.addTurn({ conversationId: c.id, role: "assistant", replyTo: q.id, status: "completed", text: "Neon Launch is $19/mo [1]", at, tz, extraction: "pending",
    sources: [{ url: "https://neon.com/pricing", title: "neon.com" }] });
}

test("pending extractions are recovered on startup", async () => {
  const s = fresh();
  const a = pendingTurn(s);
  const agent = new Agent(
    fakeClient(async () => ({
      title: "Postgres hosting",
      entities: ["Neon"],
      decisions: [],
      facts: [
        { subject: "Neon", attribute: "Launch price", value: "$19/mo", as_of: null, source_number: 1 },
        // A source the answer never cited must not become a URL.
        { subject: "Neon", attribute: "Scale price", value: "$69/mo", as_of: null, source_number: 7 },
      ],
    })),
    s,
  );
  assert.deepEqual(await agent.recoverPendingExtractions(), { attempted: 1, succeeded: 1 });
  const t = s.allTurns().find((x) => x.id === a.id)!;
  assert.equal(t.extraction, "done");
  assert.equal(t.facts?.[0].value, "$19/mo");
  assert.equal(t.facts?.[0].sourceUrl, "https://neon.com/pricing");
  assert.equal(t.facts?.[1].sourceUrl, null);
  assert.equal(s.getConversation(t.conversationId)?.title, "Postgres hosting");
});

test("extraction retries, then gives up after 3 attempts", async () => {
  const s = fresh();
  const a = pendingTurn(s);
  const agent = new Agent(fakeClient(async () => { throw new Error("boom"); }), s);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await agent.recoverPendingExtractions();
    assert.equal(s.allTurns().find((x) => x.id === a.id)!.extraction, "pending");
    await agent.recoverPendingExtractions();
    await agent.recoverPendingExtractions();
    assert.equal(s.allTurns().find((x) => x.id === a.id)!.extraction, "failed");
    assert.deepEqual(await agent.recoverPendingExtractions(), { attempted: 0, succeeded: 0 });
  } finally {
    console.warn = warn;
  }
});

test("citations are placed after grounded segments, numbered stably across responses", async () => {
  const { placeCitations } = await import("../src/providers/gemini.ts");
  const cited: { url: string; title: string }[] = [];
  const citations = { cite: (s: { url: string; title: string }) => (cited.findIndex((c) => c.url === s.url) + 1 || cited.push(s)) };
  const text = "Neon costs €19/mo. Supabase costs $25/mo.";
  const meta = {
    groundingChunks: [{ web: { uri: "https://a", title: "neon.com" } }, { web: { uri: "https://b", title: "supabase.com" } }],
    groundingSupports: [
      // By segment text.
      { segment: { text: "Neon costs €19/mo." }, groundingChunkIndices: [0] },
      // By UTF-8 byte offset only ("€" is 3 bytes, so char and byte offsets differ).
      { segment: { endIndex: Buffer.byteLength(text) }, groundingChunkIndices: [1, 0] },
    ],
  };
  assert.equal(placeCitations(text, meta, citations), "Neon costs €19/mo.[1] Supabase costs $25/mo.[2][1]");
  // A later response reuses numbers for sources already cited.
  const meta2 = { groundingChunks: [{ web: { uri: "https://b", title: "supabase.com" } }], groundingSupports: [{ segment: { text: "Still $25." }, groundingChunkIndices: [0] }] };
  assert.equal(placeCitations("Still $25.", meta2, citations), "Still $25.[2]");
  assert.equal(cited.length, 2);
});

test("a repeated sentence keeps its citation on the later occurrence", async () => {
  const { placeCitations } = await import("../src/providers/gemini.ts");
  const cited: { url: string; title: string }[] = [];
  const citations = { cite: (s: { url: string; title: string }) => cited.findIndex((c) => c.url === s.url) + 1 || cited.push(s) };
  const text = "Neon costs $19. Supabase costs $25. Neon costs $19.";
  const meta = {
    groundingChunks: [{ web: { uri: "https://a", title: "a" } }, { web: { uri: "https://b", title: "b" } }],
    groundingSupports: [
      { segment: { text: "Supabase costs $25.", endIndex: 35 }, groundingChunkIndices: [0] },
      { segment: { text: "Neon costs $19.", endIndex: 51 }, groundingChunkIndices: [1] },
    ],
  };
  assert.equal(placeCitations(text, meta, citations), "Neon costs $19. Supabase costs $25.[1] Neon costs $19.[2]");
});

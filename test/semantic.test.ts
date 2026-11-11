import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lookupMemory } from "../src/memory-context.ts";
import { placeUrlCitations } from "../src/providers/openai.ts";
import type { Provider } from "../src/providers/types.ts";
import { embedMissing, queryVector } from "../src/semantic.ts";
import { Store } from "../src/store.ts";

const tz = "UTC";
const now = new Date("2026-11-11T10:00:00Z");
const MODEL = "toy@3";
// A toy embedding: 3 "meaning" axes [travel, crm, cooking], normalized.
const AXES: Record<string, number[]> = { travel: [1, 0, 0], crm: [0, 1, 0], cooking: [0, 0, 1] };
const toyVector = (text: string) => {
  const t = text.toLowerCase();
  const v = [0, 0, 0];
  if (/trip|goa|vacation|holiday|beach|flight/.test(t)) v[0] += 1;
  if (/crm|hubspot|pipedrive|sales/.test(t)) v[1] += 1;
  if (/recipe|pasta|cook/.test(t)) v[2] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const toyProvider = (calls = { n: 0 }, model = MODEL) =>
  ({ embeddingModel: model, embed: async (texts: string[]) => (calls.n++, texts.map(toyVector)) }) as unknown as Provider;

function storeWithChats() {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "sem-")), "m.json"));
  const chat = (id: string, q: string, a: string, status: "completed" | "failed" = "completed") => {
    const c = s.createConversation(now, q.slice(0, 30), id);
    const u = s.addTurn({ conversationId: c.id, role: "user", text: q, at: "2026-11-10T10:00:00Z", tz });
    s.addTurn({ conversationId: c.id, role: "assistant", replyTo: u.id, status, text: a, at: "2026-11-10T10:00:00Z", tz });
  };
  chat("goa", "Plan a Goa trip in December for 4 friends", "North Goa for nightlife, book flights early.");
  chat("crm", "Shortlist CRM tools for my sales team", "HubSpot, Pipedrive, Attio.");
  chat("broken", "Best pasta recipe?", "", "failed");
  return s;
}
const opts = (q?: { model: string; vector: number[] }) => ({ currentConversationId: "new", excludeTurnIds: new Set<string>(), queryVector: q });

test("embedMissing embeds completed exchanges once, and again after a model switch", async () => {
  const s = storeWithChats();
  const calls = { n: 0 };
  assert.equal(await embedMissing(toyProvider(calls), s), 2); // the failed answer is not memory
  assert.equal(await embedMissing(toyProvider(calls), s), 0); // already embedded with this model
  assert.equal(await embedMissing(toyProvider(calls, "other@3"), s), 2); // a different model can't reuse old vectors
  assert.equal(calls.n, 2);
});

test("meaning finds a past chat that shares no keyword with the message", async () => {
  const s = storeWithChats();
  await embedMissing(toyProvider(), s);
  const msg = "Any packing tips for my vacation?"; // no word in common with "Goa trip in December"
  assert.deepEqual(lookupMemory(s, msg, now, tz, opts()).queries, []); // keywords alone: nothing
  const m = lookupMemory(s, msg, now, tz, opts({ model: MODEL, vector: toyVector(msg) }));
  assert.match(m.text, /Goa/);
  assert.doesNotMatch(m.text, /HubSpot/); // unrelated chat stays out
  assert.match(m.text, /"similarity": 1/);
});

test("vectors from another model are never compared", async () => {
  const s = storeWithChats();
  await embedMissing(toyProvider(), s);
  const msg = "Any packing tips for my vacation?";
  assert.deepEqual(lookupMemory(s, msg, now, tz, opts({ model: "other@3", vector: toyVector(msg) })).queries, []);
});

test("queryVector: skipped when nothing is embedded, the vendor has no embeddings, or the call is slow", async () => {
  const s = storeWithChats();
  assert.equal(await queryVector(toyProvider(), s, "hi"), undefined); // nothing embedded yet: no call
  await embedMissing(toyProvider(), s);
  assert.ok(await queryVector(toyProvider(), s, "trip"));
  assert.equal(await queryVector({} as Provider, s, "trip"), undefined);
  const slow = { embeddingModel: MODEL, embed: () => new Promise(() => {}) } as unknown as Provider;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await queryVector(slow, s, "trip", 50), undefined);
  } finally {
    console.warn = warn;
  }
});

test("OpenAI citations: inline links become [n]; bare annotations get [n] at their end", () => {
  const cited: string[] = [];
  const citations = { cite: (s: { url: string }) => cited.indexOf(s.url) + 1 || cited.push(s.url) };
  const text = "Neon Launch is $19/mo ([neon.com](https://neon.com/pricing?utm_source=openai)). Supabase Pro is $25/mo.";
  const end = text.length;
  const out = placeUrlCitations(
    {
      text,
      annotations: [
        { type: "url_citation", url: "https://neon.com/pricing?utm_source=openai", title: "Neon pricing", start_index: 23, end_index: 81 },
        { type: "url_citation", url: "https://supabase.com/pricing", title: "Supabase", start_index: 82, end_index: end },
      ],
    },
    citations,
  );
  assert.equal(out, "Neon Launch is $19/mo[1]. Supabase Pro is $25/mo.[2]");
});

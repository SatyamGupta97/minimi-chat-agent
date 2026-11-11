import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileProfile } from "../src/profile.ts";
import type { Provider } from "../src/providers/types.ts";
import { userProfile } from "../src/recall.ts";
import { Store } from "../src/store.ts";

const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), "prof-")), "m.json"));
const at = "2026-11-11T05:00:00Z";
/** A provider whose JSON call returns `decide(prompt)`; records prompts. */
const fake = (decide: (prompt: string) => unknown, prompts: string[] = []) =>
  ({ json: async (p: string, schema: { parse(x: unknown): unknown }) => (prompts.push(p), schema.parse(decide(p))) }) as unknown as Provider;
const texts = (s: Store) => s.profileFacts().map((f) => f.text);

test("first facts are added without a model call", async () => {
  const s = fresh();
  const prompts: string[] = [];
  await reconcileProfile(fake(() => ({ ops: [] }), prompts), s, ["The user's name is Satyam.", "The user lives in Delhi."], at);
  assert.deepEqual(texts(s), ["The user's name is Satyam.", "The user lives in Delhi."]);
  assert.equal(prompts.length, 0);
});

test("a changed fact replaces the old one instead of piling up", async () => {
  const s = fresh();
  await reconcileProfile(fake(() => ({ ops: [] })), s, ["The user's name is Satyam.", "The user lives in Delhi."], at);
  const delhi = s.profileFacts().find((f) => f.text.includes("Delhi"))!;
  const prompts: string[] = [];
  await reconcileProfile(fake(() => ({ ops: [{ op: "update", id: delhi.id, text: "The user lives in Pune." }] }), prompts), s, ["The user moved to Pune."], "2026-11-12T05:00:00Z");
  assert.deepEqual(texts(s), ["The user's name is Satyam.", "The user lives in Pune."]);
  assert.match(prompts[0], new RegExp(`${delhi.id}: The user lives in Delhi\\.`)); // the model saw ids to target
  assert.match(userProfile(s), /Pune/);
  assert.doesNotMatch(userProfile(s), /Delhi/);
});

test("a retraction deletes; a repeat changes nothing; unknown ids are ignored", async () => {
  const s = fresh();
  await reconcileProfile(fake(() => ({ ops: [] })), s, ["The user's budget is 20k.", "The user's name is Satyam."], at);
  const budget = s.profileFacts().find((f) => f.text.includes("budget"))!;
  await reconcileProfile(
    fake(() => ({ ops: [{ op: "delete", id: budget.id, text: null }, { op: "none", id: null, text: null }, { op: "update", id: "no-such-id", text: "x" }] })),
    s,
    ["The user asked to forget their budget.", "The user's name is Satyam."],
    at,
  );
  assert.deepEqual(texts(s), ["The user's name is Satyam."]);
});

test("if the reconcile call fails, only genuinely new statements are added", async () => {
  const s = fresh();
  await reconcileProfile(fake(() => ({ ops: [] })), s, ["The user's name is Satyam."], at);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await reconcileProfile(fake(() => { throw new Error("rate limited"); }), s, ["The user's name is Satyam.", "The user likes TypeScript."], at);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(texts(s), ["The user's name is Satyam.", "The user likes TypeScript."]);
});

test("existing memory files get a profile built from earlier extractions", () => {
  const f = join(mkdtempSync(join(tmpdir(), "prof-")), "m.json");
  const turn = (id: string, aboutUser: string[]) => ({ id, conversationId: "c", role: "assistant", status: "completed", text: "ok", at, tz: "UTC", aboutUser });
  writeFileSync(f, JSON.stringify({ version: 2, conversations: [], turns: [turn("a", ["The user's name is Satyam."]), turn("b", ["the user's name is satyam.", "The user leads a sales team."])] }));
  assert.deepEqual(texts(new Store(f)), ["the user's name is satyam.", "The user leads a sales team."]);
});

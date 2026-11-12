import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exchanges } from "../src/recall.ts";
import { CorruptMemoryError, Store } from "../src/store.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "store-")), "m.json");
const at = "2026-11-03T10:00:00Z";
const tz = "UTC";

test("missing file starts empty", () => {
  assert.equal(new Store(file()).allTurns().length, 0);
});

test("corrupt file stops startup and is left untouched", () => {
  const f = file();
  writeFileSync(f, '{"version":2,"turns":[');
  assert.throws(() => new Store(f), CorruptMemoryError);
  assert.equal(readFileSync(f, "utf8"), '{"version":2,"turns":['); // not overwritten
});

test("unknown version stops startup", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ version: 99, conversations: [], turns: [] }));
  assert.throws(() => new Store(f), /unknown version 99/);
});

test("v1 memory migrates to v2: unambiguous pairs linked and marked inferred, original backed up", () => {
  const f = file();
  const conv = { id: "c", title: "t", createdAt: at, updatedAt: at };
  const turn = (id: string, role: string, text: string) => ({ id, conversationId: "c", role, text, at, tz });
  writeFileSync(
    f,
    JSON.stringify({
      version: 1,
      conversations: [conv],
      turns: [
        turn("q1", "user", "Neon price?"),
        turn("a1", "assistant", "Neon Launch is $19"),
        // Two questions before one answer: ambiguous, must NOT be linked.
        turn("q2", "user", "Supabase?"),
        turn("q3", "user", "Render?"),
        turn("a2", "assistant", "Render is $7"),
        turn("q4", "user", "hi"),
        turn("a3", "assistant", "_(error: boom)_"),
      ],
    }),
  );
  const s = new Store(f);
  assert.ok(existsSync(`${f}.v1.bak`));
  assert.equal(JSON.parse(readFileSync(f, "utf8")).version, 2);
  const byId = Object.fromEntries(s.allTurns().map((t) => [t.id, t]));
  assert.equal(byId.a1.replyTo, "q1");
  assert.equal(byId.a1.replyToInferred, true);
  assert.equal(byId.a1.status, "completed");
  assert.equal(byId.a2.replyTo, undefined);
  assert.equal(byId.a3.status, "failed");
  const ex = exchanges(s);
  assert.equal(ex.find((e) => e.question.id === "q1")?.answer?.id, "a1");
  assert.equal(ex.find((e) => e.question.id === "q3")?.answer, undefined);
});

test("deleting a chat forgets what was learned only from it", () => {
  const s = new Store(file());
  const a = s.createConversation(new Date(at), "chat A", "A");
  const b = s.createConversation(new Date(at), "chat B", "B");
  const qa = s.addTurn({ conversationId: "A", role: "user", text: "I live in Delhi", at, tz });
  const ra = s.addTurn({ conversationId: "A", role: "assistant", replyTo: qa.id, status: "completed", text: "ok", at, tz });
  const qb = s.addTurn({ conversationId: "B", role: "user", text: "My name is Satyam", at, tz });
  const rb = s.addTurn({ conversationId: "B", role: "assistant", replyTo: qb.id, status: "completed", text: "hi", at, tz });
  s.applyProfileOps([{ op: "add", text: "The user lives in Delhi." }], at, ra.id);
  s.applyProfileOps([{ op: "add", text: "The user's name is Satyam." }], at, rb.id);
  assert.deepEqual(s.deleteConversation(a.id), { turns: 2, profileFacts: 1 });
  assert.equal(s.getConversation(a.id), undefined);
  assert.deepEqual(s.allTurns().map((t) => t.conversationId), ["B", "B"]);
  assert.deepEqual(s.profileFacts().map((f) => f.text), ["The user's name is Satyam."]); // learned in chat B: kept
  assert.ok(s.getConversation(b.id));
});

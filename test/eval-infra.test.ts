import assert from "node:assert/strict";
import { test } from "node:test";
import { daysAgo, lastWeekday } from "../scripts/fixtures.ts";
import { type Recording, RecordingProvider, ReplayProvider, StaleRecordingError } from "../src/providers/replay.ts";
import type { Provider, StepResult, TurnSetup } from "../src/providers/types.ts";
import { localDate, zonedTime } from "../src/time.ts";

test("zonedTime gives the requested wall-clock time in any timezone, across DST", () => {
  assert.equal(zonedTime("2026-11-03", 11, "Asia/Kolkata").toISOString(), "2026-11-03T05:30:00.000Z");
  assert.equal(zonedTime("2026-11-03", 11, "America/New_York").toISOString(), "2026-11-03T16:00:00.000Z"); // EST
  assert.equal(zonedTime("2026-10-30", 11, "America/New_York").toISOString(), "2026-10-30T15:00:00.000Z"); // EDT
});

test("fixture dates are computed in the scenario's timezone, not the machine's", () => {
  // 23:30 UTC on 10 Nov: already Wednesday 11 Nov in Kolkata, still Tuesday 10 Nov in New York.
  const now = new Date("2026-11-10T23:30:00Z");
  assert.equal(localDate(daysAgo(1, now, 11, "Asia/Kolkata"), "Asia/Kolkata"), "2026-11-10");
  assert.equal(localDate(daysAgo(1, now, 11, "America/New_York"), "America/New_York"), "2026-11-09");
  assert.equal(localDate(lastWeekday(2, now, 11, "Asia/Kolkata"), "Asia/Kolkata"), "2026-11-10"); // last Tuesday
  assert.equal(localDate(lastWeekday(2, now, 11, "America/New_York"), "America/New_York"), "2026-11-03");
});

const setup = (system: string, cited: string[] = []): TurnSetup => ({
  system,
  history: [],
  context: "ctx",
  message: "hi",
  sink: { text: () => {}, search: () => {}, read: () => {}, suggestions: () => {} },
  citations: { cite: (s) => cited.push(s.url) },
});

function fakeLive(calls: { n: number }): Provider {
  return {
    name: "fake", chatModel: "m", webSearch: true,
    missingConfig: () => null,
    describeError: () => undefined,
    async answer(s: TurnSetup): Promise<StepResult> {
      calls.n++;
      s.sink.text("Neon is $19");
      s.citations.cite({ url: "https://neon.com/pricing", title: "neon" });
      return { text: "Neon is $19[1]", finish: "stop" };
    },
    async json<T>(): Promise<T> { calls.n++; return { ok: true } as T; },
  };
}

test("replay reproduces the run, and refuses when the model's input changed", async () => {
  const calls = { n: 0 };
  const rec = new RecordingProvider(fakeLive(calls));
  rec.begin("s1", new Date(), "UTC");
  await rec.answer(setup("PROMPT v1"));
  const recording = JSON.parse(JSON.stringify(rec.recording)) as Recording;

  const replay = new ReplayProvider(recording);
  replay.begin("s1");
  const cited: string[] = [];
  assert.deepEqual(await replay.answer(setup("PROMPT v1", cited)), { text: "Neon is $19[1]", finish: "stop" });
  assert.deepEqual(cited, ["https://neon.com/pricing"]);
  await assert.rejects(replay.answer(setup("PROMPT v2 (edited)")), StaleRecordingError);
});

test("resuming re-uses a recorded answer for the same input; only missing outputs cost a call", async () => {
  const calls = { n: 0 };
  const first = new RecordingProvider(fakeLive(calls));
  first.begin("s1", new Date(), "UTC");
  await first.answer(setup("P"));
  assert.equal(calls.n, 1);

  const resumed = new RecordingProvider(fakeLive(calls), JSON.parse(JSON.stringify(first.recording)));
  resumed.begin("s1", new Date(), "UTC");
  await resumed.answer(setup("P")); // same input: replayed, no call
  assert.equal(calls.n, 1);
  await resumed.json("grade it", { parse: (x: unknown) => x } as never); // missing grade: one call
  await resumed.json("grade it", { parse: (x: unknown) => x } as never); // now cached
  assert.equal(calls.n, 2);
  await resumed.answer(setup("P changed")); // input changed: answered live again
  assert.equal(calls.n, 3);
});

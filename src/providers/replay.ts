import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { Source } from "../store.ts";
import type { Provider, StepResult, TurnSetup } from "./types.ts";

/**
 * Record a live eval run, then replay it with no API key.
 *
 * A recording keeps, per scenario, everything the model did through the
 * Provider interface (streamed text, searches, pages read, citations in the
 * order they were made, the final result or error) plus every structured-JSON
 * output (judge verdicts), keyed by a hash of the prompt.
 *
 * Replaying feeds those back through the REAL app code: date resolution,
 * memory lookup, citation numbering, turn status, persistence and every eval
 * check all run for real. Only the model is canned.
 *
 * Staleness is enforced, not just documented: each scenario stores a hash of
 * the model's complete input (system prompt, history, context incl. memory
 * lookup, message). If the app would now send the model anything different
 * (prompt edited, context format changed, lookup results changed), replay
 * refuses instead of passing old answers off as new results.
 */

type Event =
  | { t: "text"; s: string }
  | { t: "search"; q: string }
  | { t: "read"; src: Source }
  | { t: "cite"; src: Source }
  | { t: "suggestions"; html: string };

export interface ScenarioRecording {
  /** The clock and timezone it ran with, so fixture dates and lookups match on replay. */
  now: string;
  tz: string;
  /** Hash of everything the model was given; replay requires an exact match. */
  inputHash?: string;
  events: Event[];
  result?: StepResult;
  error?: string;
  /** Set once the judge's verdict is recorded too (for judged scenarios). */
  graded?: boolean;
}

export interface Recording {
  provider: string;
  model: string;
  webSearch: boolean;
  scenarios: Record<string, ScenarioRecording>;
  json: Record<string, unknown>;
}

export class StaleRecordingError extends Error {}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const inputHash = (setup: TurnSetup) => hash(JSON.stringify([setup.system, setup.history, setup.context, setup.message]));

function replayEvents(rec: ScenarioRecording, setup: TurnSetup): StepResult {
  for (const e of rec.events) {
    if (e.t === "text") setup.sink.text(e.s);
    else if (e.t === "search") setup.sink.search(e.q);
    else if (e.t === "read") setup.sink.read(e.src);
    else if (e.t === "cite") setup.citations.cite(e.src); // same order as live, so [n] numbering matches
    else setup.sink.suggestions(e.html);
  }
  if (rec.error) throw new Error(rec.error);
  return rec.result!;
}

export class RecordingProvider implements Provider {
  readonly recording: Recording;
  private scenario = "";

  /** Starts from `previous` (same provider/model) so scenarios can be recorded across several quota windows. */
  constructor(
    private inner: Provider,
    previous?: Recording,
  ) {
    this.recording =
      previous?.provider === inner.name && previous.model === inner.chatModel
        ? previous
        : { provider: inner.name, model: inner.chatModel, webSearch: inner.webSearch, scenarios: {}, json: {} };
  }

  get name() { return this.inner.name; }
  get chatModel() { return this.inner.chatModel; }
  get webSearch() { return this.inner.webSearch; }

  /** Keeps an existing successful answer for this scenario (re-used if the input is unchanged). */
  begin(scenario: string, now: Date, tz: string): void {
    this.scenario = scenario;
    const prev = this.recording.scenarios[scenario];
    if (!(prev?.result && !prev.error)) this.recording.scenarios[scenario] = { now: now.toISOString(), tz, events: [] };
  }

  markGraded(scenario: string): void {
    const rec = this.recording.scenarios[scenario];
    if (rec) rec.graded = true;
  }

  missingConfig() {
    return this.inner.missingConfig();
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
    const rec = this.recording.scenarios[this.scenario];
    const h = inputHash(setup);
    // Resuming: the answer was already recorded for this exact input; only grading is missing. Don't pay for it twice.
    if (rec.result && !rec.error) {
      if (!rec.inputHash) rec.inputHash = h; // recorded before fingerprints existed, earlier in this same recording session
      if (rec.inputHash === h) return replayEvents(rec, setup);
    }
    rec.events = [];
    delete rec.result;
    delete rec.error;
    delete rec.graded;
    rec.inputHash = h;
    const log = (e: Event) => rec.events.push(e);
    const sink = setup.sink;
    try {
      rec.result = await this.inner.answer(
        {
          ...setup,
          sink: {
            text: (s) => (log({ t: "text", s }), sink.text(s)),
            search: (q) => (log({ t: "search", q }), sink.search(q)),
            read: (src) => (log({ t: "read", src }), sink.read(src)),
            suggestions: (html) => (log({ t: "suggestions", html }), sink.suggestions(html)),
          },
          citations: { cite: (src) => (log({ t: "cite", src }), setup.citations.cite(src)) },
        },
        signal,
      );
      return rec.result;
    } catch (err) {
      rec.error = this.inner.describeError(err) ?? (err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const cached = this.recording.json[hash(prompt)];
    if (cached !== undefined) return schema.parse(cached);
    const out = await this.inner.json(prompt, schema, opts);
    this.recording.json[hash(prompt)] = out;
    return out;
  }

  describeError(err: unknown) {
    return this.inner.describeError(err);
  }

  retryAfterMs(err: unknown) {
    return this.inner.retryAfterMs?.(err);
  }
}

export class ReplayProvider implements Provider {
  readonly name: string;
  readonly chatModel: string;
  readonly webSearch: boolean;
  private scenario = "";

  constructor(private recording: Recording) {
    this.name = `replay:${recording.provider}`;
    this.chatModel = recording.model;
    this.webSearch = recording.webSearch;
  }

  begin(scenario: string): void {
    this.scenario = scenario;
  }

  missingConfig() {
    return null;
  }

  async answer(setup: TurnSetup): Promise<StepResult> {
    const rec = this.recording.scenarios[this.scenario];
    if (!rec) throw new StaleRecordingError(`No recording for scenario "${this.scenario}". Run npm run eval:live to record it.`);
    if (rec.inputHash !== inputHash(setup)) {
      throw new StaleRecordingError(
        "Recording is stale: the model's input changed since it was recorded (system prompt, context format, memory lookup or scenario). Run npm run eval:live -- --fresh to re-record.",
      );
    }
    return replayEvents(rec, setup);
  }

  async json<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    const out = this.recording.json[hash(prompt)];
    if (out === undefined) throw new StaleRecordingError("No recorded judge output for this answer. Run npm run eval:live to record it.");
    return schema.parse(out);
  }

  describeError(err: unknown) {
    return err instanceof Error ? err.message : undefined;
  }
}

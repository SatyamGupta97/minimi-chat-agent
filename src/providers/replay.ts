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
 * check all run for real. Only the model is canned. So a replay catches
 * regressions in the app, never changes in model behaviour, and a prompt
 * change needs a fresh live recording.
 */

type Event =
  | { t: "text"; s: string }
  | { t: "search"; q: string }
  | { t: "read"; src: Source }
  | { t: "cite"; src: Source }
  | { t: "suggestions"; html: string };

export interface Recording {
  provider: string;
  model: string;
  webSearch: boolean;
  /** Per scenario: the clock and timezone it ran with (so fixture dates and lookups match on replay), and what the model did. */
  scenarios: Record<string, { now: string; tz: string; events: Event[]; result?: StepResult; error?: string }>;
  json: Record<string, unknown>;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class RecordingProvider implements Provider {
  readonly recording: Recording;
  private scenario = "";

  /** Starts from `previous` (same provider) so scenarios can be recorded across several quota windows. */
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

  begin(scenario: string, now: Date, tz: string): void {
    this.scenario = scenario;
    this.recording.scenarios[scenario] = { now: now.toISOString(), tz, events: [] };
  }

  missingConfig() {
    return this.inner.missingConfig();
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
    const rec = this.recording.scenarios[this.scenario];
    rec.events = []; // a retry replaces the failed attempt
    delete rec.error;
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
    const out = await this.inner.json(prompt, schema, opts);
    this.recording.json[hash(prompt)] = out;
    return out;
  }

  describeError(err: unknown) {
    return this.inner.describeError(err);
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
    if (!rec) throw new Error(`No recording for scenario "${this.scenario}". Re-record with: npm run eval:live`);
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

  async json<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    const out = this.recording.json[hash(prompt)];
    if (out === undefined) throw new Error("No recorded output for this prompt (the app's prompt changed since recording). Re-record with: npm run eval:live");
    return schema.parse(out);
  }

  describeError() {
    return undefined;
  }
}

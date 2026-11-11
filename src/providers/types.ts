import type { ZodType } from "zod";
import type { Source } from "../store.ts";

/**
 * The seam between the agent and a model vendor.
 *
 * Everything that makes this agent good (temporal memory, recall, turn status,
 * evidence rules, persistence, evals) is vendor-neutral and lives in agent.ts.
 * An adapter only has to: run one streamed model call whose only tool is the
 * vendor's built-in web search, report what it searched/read, turn the vendor's
 * citation format into stable [n] markers, and do one structured-JSON call.
 */

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

/** Shared across all steps of one turn so citation numbers stay stable. */
export interface Citations {
  /** Returns the 1-based marker number for a source, adding it if new. */
  cite(source: Source): number;
}

/** Live events from inside a step. */
export interface StepSink {
  /** Displayable answer text, citation markers already converted to [n]. */
  text(delta: string): void;
  search(query: string): void;
  /** A page the search returned or opened (context, not evidence). */
  read(source: Source): void;
  /** Vendor UI that must be shown with grounded answers (Gemini's Search Suggestions). */
  suggestions(html: string): void;
}

export interface StepResult {
  /** Final answer text with [n] markers (may differ from the streamed text when markers are placed at the end). */
  text: string;
  /**
   * "stop" ONLY when the vendor explicitly reported a normal end. A stream that
   * ends without saying why is "other", so a truncated answer can never be
   * stored as a completed (trusted) one.
   */
  finish: "stop" | "length" | "blocked" | "other";
}

export interface TurnSetup {
  system: string;
  history: HistoryItem[];
  /** App-supplied context for this turn (clock, calendar, memory index). */
  context: string;
  /** The user's message, already stamped with its send time. */
  message: string;
  sink: StepSink;
  citations: Citations;
}

export interface Provider {
  readonly name: string;
  readonly chatModel: string;
  /** Whether answers can use built-in web search (false for local models). */
  readonly webSearch: boolean;
  /** Null when usable, else a message explaining what's missing. */
  missingConfig(): string | null;
  /** Run one streamed answer for this turn. */
  answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult>;
  /** Non-streamed structured output, validated against `schema`. `strong` uses the chat model instead of the small one. */
  json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T>;
  /** Friendly message for a vendor error, or undefined to fall back to the raw message. */
  describeError(err: unknown): string | undefined;
}

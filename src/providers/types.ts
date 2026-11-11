import type { ZodType } from "zod";
import type { Source } from "../store.ts";

/**
 * The seam between the agent and a model vendor.
 *
 * Everything that makes this agent good (temporal memory, recall, turn status,
 * evidence rules, persistence, evals) is vendor-neutral and lives in agent.ts.
 * An adapter only has to: run one streamed model step with built-in web search
 * plus our function tools, report what it searched/read, turn the vendor's
 * citation format into stable [n] markers, and do one structured-JSON call.
 */

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
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
  /** This step's final text with [n] markers (may differ from the streamed text when markers are placed at the end). */
  text: string;
  calls: ToolCall[];
  finish: "stop" | "length" | "blocked" | "tool_calls" | "other";
}

/** One turn's conversation with the model; owns the vendor-specific message format. */
export interface ChatSession {
  step(signal?: AbortSignal): Promise<StepResult>;
  addToolResults(results: { call: ToolCall; output: unknown }[]): void;
}

export interface TurnSetup {
  system: string;
  history: HistoryItem[];
  /** App-supplied context for this turn (clock, calendar, memory index). */
  context: string;
  /** The user's message, already stamped with its send time. */
  message: string;
  tools: ToolSpec[];
  sink: StepSink;
  citations: Citations;
}

export interface Provider {
  readonly name: string;
  readonly chatModel: string;
  /** Null when usable, else a message explaining what's missing. */
  missingConfig(): string | null;
  startTurn(setup: TurnSetup): ChatSession;
  /** Non-streamed structured output, validated against `schema`. `strong` uses the chat model instead of the small one. */
  json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T>;
  /** Friendly message for a vendor error, or undefined to fall back to the raw message. */
  describeError(err: unknown): string | undefined;
}

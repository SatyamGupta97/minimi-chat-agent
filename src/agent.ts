import {
  ApiError,
  type Content,
  FinishReason,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type GoogleGenAI,
  type GroundingMetadata,
  type Part,
} from "@google/genai";
import { z } from "zod";
import { config, MissingKeyError } from "./config.ts";
import { extractFacts } from "./extract.ts";
import { SYSTEM_PROMPT, turnContext } from "./prompt.ts";
import { memoryDigest, recall } from "./recall.ts";
import type { Source, Store, Turn, TurnStatus } from "./store.ts";
import { humanDateTime, temporalContext } from "./time.ts";

/** Events streamed to the UI (and printed by the CLI). */
export type AgentEvent =
  | { type: "meta"; conversationId: string; title: string }
  | { type: "status"; kind: "search"; query: string }
  | { type: "status"; kind: "recall"; detail: string; args: unknown }
  | { type: "text"; text: string }
  /** Authoritative full answer (with citation markers placed); replaces the streamed text. */
  | { type: "final"; text: string }
  | { type: "sources"; cited: Source[]; retrieved: Source[] }
  /** Google Search Suggestions HTML, which must be shown with grounded answers. */
  | { type: "suggestions"; html: string }
  | { type: "done"; turnId: string; status: TurnStatus; ms: number; searches: number }
  | { type: "error"; message: string };

export interface TurnInput {
  conversationId?: string;
  message: string;
  tz: string;
  /** Override the clock (used by the seed script and evals to create backdated history). */
  now?: Date;
  signal?: AbortSignal;
}

const MAX_EXTRACTION_ATTEMPTS = 3;

const RecallInput = z.object({
  query: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const RECALL_TOOL: FunctionDeclaration = {
  name: "recall_memory",
  description:
    "Search the user's past conversations with you. Returns matching exchanges (when, what they asked, what you answered, what it was about, what the user decided, the facts you stated, the sources you cited) plus an overview of what memory exists. Give a date range (inclusive, user's local dates) when the user refers to a time, a topic query when they refer to a subject, or both. Results already in the current conversation are flagged. Answers with answer_status other than 'completed' were cut off and are not a reliable baseline.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Topic keywords, e.g. 'postgres hosting pricing'. Omit to list everything in the date range." },
      from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
      to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
      limit: { type: "integer", description: "Max exchanges to return (default 8, max 20)" },
    },
    additionalProperties: false,
  },
};

const INTERRUPTED_NOTE: Record<Exclude<TurnStatus, "completed">, string> = {
  incomplete: "(My previous answer was cut off before it finished.)",
  failed: "(My previous answer failed with an error before it finished.)",
  cancelled: "(The user stopped my previous answer before it finished.)",
};

/**
 * Prior turns of the current conversation, replayed as plain text.
 *
 * Raw grounding results and thought parts from earlier turns are NOT replayed:
 * they're large, stale by the next turn, and only needed within the turn that
 * produced them. Each completed answer keeps the sources it cited, so follow-ups
 * can refer to them. An answer that didn't complete is replaced by a note, so a
 * half-answer is never treated as something the assistant stands behind. Each
 * user turn carries the time it was sent, so "since then" in a chat resumed
 * three days later means three days.
 */
function historyContents(turns: Turn[], tz: string): Content[] {
  const out: Content[] = [];
  const push = (role: "user" | "model", text: string) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.parts!.push({ text }); // Gemini wants alternating roles
    else out.push({ role, parts: [{ text }] });
  };
  for (const t of turns.slice(-config.historyTurns)) {
    if (t.role === "user") push("user", `[sent ${humanDateTime(new Date(t.at), t.tz || tz)}]\n${t.text}`);
    else if (t.status && t.status !== "completed") push("model", INTERRUPTED_NOTE[t.status]);
    else if (t.text.trim()) {
      const src = (t.sources ?? []).slice(0, 8).map((s, i) => `[${i + 1}] ${s.title}`);
      push("model", t.text + (src.length ? `\n\nSources:\n${src.join("\n")}` : ""));
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** UTF-8 byte offset -> JS string index (grounding segments are measured in bytes). */
function byteToCharIndex(s: string, bytes: number): number {
  return Buffer.from(s, "utf8").subarray(0, bytes).toString("utf8").length;
}

/**
 * Place [n] markers after each grounded segment of one response's text.
 * `cited` is shared across the turn so numbering is stable; the index into it
 * (plus one) is the marker number.
 */
export function placeCitations(text: string, meta: GroundingMetadata | undefined, cited: Source[]): string {
  const chunks = meta?.groundingChunks ?? [];
  const inserts: { at: number; nums: number[] }[] = [];
  let cursor = 0;
  const supports = [...(meta?.groundingSupports ?? [])].sort((a, b) => (a.segment?.endIndex ?? 0) - (b.segment?.endIndex ?? 0));
  for (const sup of supports) {
    const seg = sup.segment;
    if (!seg) continue;
    // Prefer matching the segment text (robust to how parts were split while
    // streaming); fall back to the byte offset.
    let at = seg.text ? text.indexOf(seg.text, Math.max(0, cursor - seg.text.length)) : -1;
    at = at >= 0 ? at + seg.text!.length : seg.endIndex != null ? byteToCharIndex(text, seg.endIndex) : -1;
    if (at < 0) continue;
    cursor = at;
    const nums: number[] = [];
    for (const ci of sup.groundingChunkIndices ?? []) {
      const web = chunks[ci]?.web;
      if (!web?.uri) continue;
      let idx = cited.findIndex((s) => s.url === web.uri);
      if (idx < 0) {
        cited.push({ url: web.uri, title: web.title ?? web.uri });
        idx = cited.length - 1;
      }
      if (!nums.includes(idx + 1)) nums.push(idx + 1);
    }
    if (nums.length) inserts.push({ at, nums });
  }
  let out = text;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.nums.map((n) => `[${n}]`).join("") + out.slice(ins.at);
  }
  return out;
}

/** Search queries from a server-side tool call part (args shape varies by tool version). */
function queriesOf(args: Record<string, unknown> | undefined): string[] {
  const q = args?.queries ?? args?.query ?? args?.q;
  return (Array.isArray(q) ? q : [q]).filter((x): x is string => typeof x === "string" && x.length > 0);
}

export class Agent {
  constructor(
    private client: GoogleGenAI,
    private store: Store,
  ) {}

  async runTurn(input: TurnInput, emit: (e: AgentEvent) => void): Promise<void> {
    const started = Date.now();
    const now = input.now ?? new Date();
    const tz = input.tz;

    let conv = input.conversationId ? this.store.getConversation(input.conversationId) : undefined;
    const isNew = !conv;
    conv ??= this.store.createConversation(now, input.message.slice(0, 60));
    const convId = conv.id;
    emit({ type: "meta", conversationId: convId, title: conv.title });

    const prior = this.store.turns(convId);
    // Persist the question first: it's part of memory even if the answer fails.
    const userTurn = this.store.addTurn({ conversationId: convId, role: "user", text: input.message, at: now.toISOString(), tz });

    // Per-turn context (clock, calendar, memory index) rides in the newest user
    // message, marked as coming from the app. Everything before it stays
    // byte-identical between turns, which keeps Gemini's implicit prefix cache warm.
    const context = turnContext(temporalContext(now, tz), memoryDigest(this.store, tz, convId));
    const contents: Content[] = historyContents(prior, tz);
    const newParts: Part[] = [
      { text: `<context source="app, not the user">\n${context}\n</context>` },
      { text: `[sent ${humanDateTime(now, tz)}]\n${input.message}` },
    ];
    const last = contents[contents.length - 1];
    if (last?.role === "user") last.parts!.push(...newParts);
    else contents.push({ role: "user", parts: newParts });

    const cited: Source[] = []; // in order of first citation; index+1 = marker number
    const read = new Map<string, Source>(); // every grounding chunk seen, by URL
    const searches: string[] = [];
    let answer = ""; // authoritative text, with citation markers
    let suggestions = "";
    let status: TurnStatus = "incomplete"; // proven "completed" only by a clean STOP
    let note = "";

    const search = (q: string) => {
      if (searches.includes(q)) return;
      searches.push(q);
      emit({ type: "status", kind: "search", query: q });
    };

    try {
      if (!config.apiKey) throw new MissingKeyError();
      let finished = false;
      for (let iter = 0; iter < config.maxIterations && !finished; iter++) {
        const stream = await this.client.models.generateContentStream({
          model: config.chatModel,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            // Google Search (server-side, runs inside this call) + our memory tool (client-side).
            tools: [{ googleSearch: {} }, { functionDeclarations: [RECALL_TOOL] }],
            toolConfig: {
              // Surface the server-side search calls so the UI can show what's being searched.
              includeServerSideToolInvocations: true,
              // Combining built-in tools with functions requires VALIDATED mode.
              functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED },
            },
            thinkingConfig: { thinkingLevel: config.chatThinking },
            maxOutputTokens: 32_000,
            abortSignal: input.signal,
          },
        });

        const parts: Part[] = []; // the model's turn, kept verbatim (thought signatures included)
        let text = "";
        let meta: GroundingMetadata | undefined;
        let finish: FinishReason | undefined;
        let blocked = false;

        if (answer && !answer.endsWith("\n")) {
          answer += "\n\n";
          emit({ type: "text", text: "\n\n" });
        }

        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) blocked = true;
          const cand = chunk.candidates?.[0];
          if (!cand) continue;
          for (const p of cand.content?.parts ?? []) {
            parts.push(p);
            if (p.text && !p.thought) {
              text += p.text;
              emit({ type: "text", text: p.text });
            }
            if (p.toolCall) queriesOf(p.toolCall.args).forEach(search);
            if (p.functionCall?.name === "recall_memory") {
              emit({ type: "status", kind: "recall", detail: describeRecall(p.functionCall.args), args: p.functionCall.args });
            }
          }
          if (cand.groundingMetadata) meta = cand.groundingMetadata;
          if (cand.finishReason) finish = cand.finishReason;
        }

        // Grounding arrives with the end of the response: record queries/sources, place citations.
        (meta?.webSearchQueries ?? []).forEach(search);
        for (const c of meta?.groundingChunks ?? []) {
          if (c.web?.uri && !read.has(c.web.uri)) read.set(c.web.uri, { url: c.web.uri, title: c.web.title ?? c.web.uri });
        }
        if (meta?.searchEntryPoint?.renderedContent) suggestions = meta.searchEntryPoint.renderedContent;
        answer += placeCitations(text, meta, cited);

        const calls = parts.filter((p) => p.functionCall);
        if (calls.length) {
          contents.push({ role: "model", parts });
          contents.push({ role: "user", parts: calls.map((p) => this.runTool(p, tz, convId, userTurn.id)) });
          continue;
        }

        finished = true;
        if (blocked || finish === FinishReason.SAFETY || finish === FinishReason.PROHIBITED_CONTENT || finish === FinishReason.BLOCKLIST) {
          if (!answer.trim()) answer = "Sorry, I can't help with that one.";
        } else if (finish === FinishReason.MAX_TOKENS) {
          note = "\n\n_(Cut off at the length limit. Ask me to continue.)_";
        } else if (finish === FinishReason.STOP || finish === undefined) {
          status = text.trim() || answer.trim() ? "completed" : "incomplete";
        }
      }
      if (!finished) note = "\n\n_(I hit my step limit for one answer before finishing. Ask me to continue.)_";
    } catch (err) {
      if (input.signal?.aborted) {
        status = "cancelled";
        note = "\n\n_(stopped)_";
      } else {
        status = "failed";
        emit({ type: "error", message: errorMessage(err) });
      }
    }

    answer += note;
    emit({ type: "final", text: answer });

    // Only what the answer cited counts as evidence; what was merely read is kept apart.
    const citedUrls = new Set(cited.map((s) => s.url));
    const retrieved = [...read.values()].filter((s) => !citedUrls.has(s.url)).slice(0, 10);
    if (cited.length || retrieved.length) emit({ type: "sources", cited, retrieved });
    if (suggestions) emit({ type: "suggestions", html: suggestions });

    const assistantTurn = this.store.addTurn({
      conversationId: convId,
      role: "assistant",
      replyTo: userTurn.id,
      status,
      text: answer,
      at: new Date(now.getTime() + (Date.now() - started)).toISOString(),
      tz,
      sources: cited,
      retrieved,
      searches,
      searchSuggestions: suggestions || undefined,
      // Only completed answers become baselines for "has anything changed?".
      extraction: status === "completed" ? "pending" : undefined,
    });
    emit({ type: "done", turnId: assistantTurn.id, status, ms: Date.now() - started, searches: searches.length });

    // Off the latency path: distill facts for future "has it changed?" questions.
    if (assistantTurn.extraction === "pending") void this.extract(assistantTurn.id, isNew);
  }

  private runTool(part: Part, tz: string, convId: string, userTurnId: string): Part {
    const call = part.functionCall!;
    const reply = (response: Record<string, unknown>): Part => ({ functionResponse: { id: call.id, name: call.name, response } });
    if (call.name !== "recall_memory") return reply({ error: `Unknown tool ${call.name}` });
    const parsed = RecallInput.safeParse(call.args ?? {});
    if (!parsed.success) return reply({ error: `Invalid input: ${parsed.error.message}` });
    return reply({
      output: recall(this.store, parsed.data, tz, { currentConversationId: convId, excludeTurnIds: new Set([userTurnId]) }),
    });
  }

  /**
   * Extract facts for one answer. The pending state is persisted before this
   * runs, so a crash or restart mid-extraction is recovered by
   * recoverPendingExtractions() on the next start.
   */
  async extract(turnId: string, setTitle = false): Promise<void> {
    const turn = this.store.allTurns().find((t) => t.id === turnId);
    const question = turn?.replyTo ? this.store.allTurns().find((t) => t.id === turn.replyTo) : undefined;
    if (!turn || !question) return;
    const attempts = (turn.extractionAttempts ?? 0) + 1;
    try {
      const x = await extractFacts(this.client, question.text, turn.text, turn.sources ?? []);
      this.store.updateTurn(turnId, { facts: x.facts, entities: x.entities, decisions: x.decisions, extraction: "done", extractionAttempts: attempts });
      const conv = this.store.getConversation(turn.conversationId);
      if (x.title && conv && (setTitle || conv.title === question.text.slice(0, 60))) this.store.setTitle(conv.id, x.title);
    } catch (e) {
      const giveUp = attempts >= MAX_EXTRACTION_ATTEMPTS;
      this.store.updateTurn(turnId, { extraction: giveUp ? "failed" : "pending", extractionAttempts: attempts });
      console.warn(`[extract] attempt ${attempts} failed${giveUp ? " (giving up)" : ""}:`, errorMessage(e));
    }
  }

  /** Resume extraction work interrupted by a restart. Sequential: it's background work. */
  async recoverPendingExtractions(): Promise<number> {
    const pending = this.store.allTurns().filter((t) => t.extraction === "pending").map((t) => t.id);
    for (const id of pending) await this.extract(id);
    return pending.length;
  }
}

function describeRecall(input: unknown): string {
  const i = (input ?? {}) as { query?: string; from?: string; to?: string };
  const range = i.from || i.to ? (i.from === i.to ? `on ${i.from}` : `${i.from ?? "…"} → ${i.to ?? "…"}`) : "";
  return [i.query ? `"${i.query}"` : "", range].filter(Boolean).join(" ") || "all conversations";
}

export function errorMessage(err: unknown): string {
  if (err instanceof MissingKeyError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return "Invalid GEMINI_API_KEY.";
    if (err.status === 401 || err.status === 403) return "GEMINI_API_KEY was rejected (invalid key or no access to this model).";
    if (err.status === 429) return "Rate limited by the Gemini API. Try again in a moment.";
    return `Gemini API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

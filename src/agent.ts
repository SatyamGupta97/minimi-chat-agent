import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.ts";
import { extractFacts } from "./extract.ts";
import { SYSTEM_PROMPT, turnContext } from "./prompt.ts";
import { memoryDigest, recall } from "./recall.ts";
import type { Source, Store, Turn, TurnStatus } from "./store.ts";
import { humanDateTime, temporalContext } from "./time.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

/** Events streamed to the UI (and printed by the CLI). */
export type AgentEvent =
  | { type: "meta"; conversationId: string; title: string }
  | { type: "status"; kind: "search"; query: string }
  | { type: "status"; kind: "recall"; detail: string; args: unknown }
  | { type: "status"; kind: "thinking" }
  | { type: "text"; text: string }
  /** Model fallback restarted the answer: discard what was streamed so far. */
  | { type: "reset" }
  | { type: "sources"; cited: Source[]; retrieved: Source[] }
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

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);
// Models that accept mid-conversation `role: "system"` messages. Others get the
// per-turn context as a marked block inside the user message instead.
const SYSTEM_MESSAGE_MODELS = new Set([
  "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-haiku-5-5",
  "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2",
]);
const MAX_EXTRACTION_ATTEMPTS = 3;

const RecallInput = z.object({
  query: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const RECALL_TOOL: Anthropic.Beta.BetaTool = {
  name: "recall_memory",
  description:
    "Search the user's past conversations with you. Returns matching exchanges (when, what they asked, what you answered, what it was about, what the user decided, the facts you stated, the sources you cited) plus an overview of what memory exists. Give a date range (inclusive, user's local dates) when the user refers to a time, a topic query when they refer to a subject, or both. Results already in the current conversation are flagged. Answers with answer_status other than 'completed' were cut off and are not a reliable baseline.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Topic keywords, e.g. 'postgres hosting pricing'. Omit to list everything in the date range." },
      from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
      to: { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
      limit: { type: "integer", description: "Max exchanges to return (default 8, max 20)" },
    },
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

const INTERRUPTED_NOTE: Record<Exclude<TurnStatus, "completed">, string> = {
  incomplete: "(My previous answer was cut off before it finished.)",
  failed: "(My previous answer failed with an error before it finished.)",
  cancelled: "(The user stopped my previous answer before it finished.)",
};

/**
 * Prior turns of the current conversation, replayed as plain text.
 *
 * We deliberately do NOT replay raw web-search result blocks or thinking blocks
 * from earlier turns: they are large (encrypted page content), slow every later
 * request down, and are stale by the next turn anyway. Each completed assistant
 * turn keeps the sources it cited so follow-ups can refer to them; an answer
 * that didn't complete is replaced by a note, so a half-answer is never treated
 * as something the assistant stands behind. Each user turn carries the time it
 * was sent, so "since then" in a chat resumed three days later means three days.
 */
function historyMessages(turns: Turn[], tz: string): MessageParam[] {
  const recent = turns.slice(-config.historyTurns);
  const msgs: MessageParam[] = [];
  for (const t of recent) {
    if (t.role === "user") {
      msgs.push({ role: "user", content: `[sent ${humanDateTime(new Date(t.at), t.tz || tz)}]\n${t.text}` });
    } else if (t.status && t.status !== "completed") {
      msgs.push({ role: "assistant", content: INTERRUPTED_NOTE[t.status] });
    } else if (t.text.trim()) {
      const src = (t.sources ?? []).slice(0, 8).map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`);
      const footer = src.length ? `\n\nSources:\n${src.join("\n")}` : "";
      msgs.push({ role: "assistant", content: t.text + footer });
    }
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

export class Agent {
  constructor(
    private client: Anthropic,
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

    const context = turnContext(temporalContext(now, tz), memoryDigest(this.store, tz, convId));
    const userText = `[sent ${humanDateTime(now, tz)}]\n${input.message}`;
    const messages: MessageParam[] = [...historyMessages(prior, tz)];
    if (SYSTEM_MESSAGE_MODELS.has(config.chatModel)) {
      // Per-turn context as a mid-conversation system message: keeps the cached
      // prefix (system prompt + earlier turns) byte-identical while giving the
      // model fresh operator-level facts (clock, calendar, memory index).
      messages.push({ role: "user", content: userText }, { role: "system", content: context });
    } else {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: `<context source="app, not the user">\n${context}\n</context>` },
          { type: "text", text: userText },
        ],
      });
    }

    const tools: Anthropic.Beta.BetaToolUnion[] = [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: config.maxSearchesPerTurn,
        user_location: { type: "approximate", timezone: tz },
      },
      RECALL_TOOL,
    ];

    const seen = new Map<string, Source>(); // every search result, by URL
    const cited: Source[] = []; // in order of first citation; index+1 = marker number
    const searches: string[] = [];
    let answer = "";
    let status: TurnStatus = "incomplete"; // proven "completed" only by a clean end_turn
    let note = "";

    const citeMarker = (block: Anthropic.Beta.BetaTextBlock): string => {
      const nums = new Set<number>();
      for (const c of block.citations ?? []) {
        if (c.type !== "web_search_result_location") continue;
        let idx = cited.findIndex((s) => s.url === c.url);
        if (idx < 0) {
          cited.push(seen.get(c.url) ?? { url: c.url, title: c.title ?? c.url });
          idx = cited.length - 1;
        }
        nums.add(idx + 1);
      }
      return [...nums].map((n) => `[${n}]`).join("");
    };

    const say = (s: string) => {
      answer += s;
      emit({ type: "text", text: s });
    };

    try {
      let finished = false;
      for (let iter = 0; iter < config.maxIterations && !finished; iter++) {
        if (iter > 0 && answer && !answer.endsWith("\n")) say("\n\n");

        const stream = this.client.beta.messages.stream(
          {
            model: config.chatModel,
            max_tokens: 32000,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: config.chatEffort },
            // Cache the conversation prefix too, so each round-trip in this turn
            // (and the next turn) re-reads it cheaply.
            cache_control: { type: "ephemeral" },
            ...(FALLBACK_MODELS.has(config.chatModel)
              ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
              : {}),
          },
          { signal: input.signal },
        );

        stream.on("streamEvent", (ev, snapshot) => {
          if (ev.type === "content_block_start") {
            if (ev.content_block.type === "thinking" && !answer) emit({ type: "status", kind: "thinking" });
            if (ev.content_block.type === "fallback") {
              answer = "";
              cited.length = 0;
              emit({ type: "reset" });
            }
            return;
          }
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            say(ev.delta.text);
            return;
          }
          if (ev.type !== "content_block_stop") return;
          const block = snapshot.content[ev.index] as ContentBlock | undefined;
          if (!block) return;
          if (block.type === "server_tool_use" && block.name === "web_search") {
            const q = String((block.input as { query?: unknown })?.query ?? "");
            if (q) {
              searches.push(q);
              emit({ type: "status", kind: "search", query: q });
            }
          } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
            for (const r of block.content) {
              if (!seen.has(r.url)) seen.set(r.url, { url: r.url, title: r.title, pageAge: r.page_age });
            }
          } else if (block.type === "text" && block.citations?.length) {
            const marker = citeMarker(block);
            if (marker) say(marker);
          } else if (block.type === "tool_use" && block.name === "recall_memory") {
            emit({ type: "status", kind: "recall", detail: describeRecall(block.input), args: block.input });
          }
        });

        const msg = await stream.finalMessage();

        switch (msg.stop_reason) {
          case "pause_turn":
            // Long server-side search turn: send it back so the server continues.
            messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
            break;
          case "tool_use":
            messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
            messages.push({ role: "user", content: this.runTools(msg.content, tz, convId, userTurn.id) });
            break;
          case "end_turn":
          case "stop_sequence":
            status = "completed";
            finished = true;
            break;
          case "max_tokens":
            note = "\n\n_(Cut off at the length limit. Ask me to continue.)_";
            finished = true;
            break;
          case "refusal":
            if (!answer.trim()) say("Sorry, I can't help with that one.");
            finished = true;
            break;
          default:
            finished = true;
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

    if (note) say(note);

    // Only what the answer cited counts as evidence; what it merely read is kept apart.
    const citedUrls = new Set(cited.map((s) => s.url));
    const retrieved = [...seen.values()].filter((s) => !citedUrls.has(s.url)).slice(0, 10);
    if (cited.length || retrieved.length) emit({ type: "sources", cited, retrieved });

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
      // Only completed answers become baselines for "has anything changed?".
      extraction: status === "completed" && answer.trim() ? "pending" : undefined,
    });
    emit({ type: "done", turnId: assistantTurn.id, status, ms: Date.now() - started, searches: searches.length });

    // Off the latency path: distill facts for future "has it changed?" questions.
    if (assistantTurn.extraction === "pending") void this.extract(assistantTurn.id, isNew);
  }

  private runTools(content: ContentBlock[], tz: string, convId: string, userTurnId: string): Anthropic.Beta.BetaToolResultBlockParam[] {
    const calls = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    return calls.map((call) => {
      if (call.name !== "recall_memory") {
        return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` };
      }
      const parsed = RecallInput.safeParse(call.input);
      if (!parsed.success) {
        return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid input: ${parsed.error.message}` };
      }
      const result = recall(this.store, parsed.data, tz, {
        currentConversationId: convId,
        excludeTurnIds: new Set([userTurnId]),
      });
      return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) };
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
      if (!x) throw new Error("extractor returned no parsed output");
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
  if (err instanceof Anthropic.AuthenticationError) return "Invalid or missing ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the model provider. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return `Model API error ${err.status ?? ""}: ${err.message}`;
  const msg = err instanceof Error ? err.message : String(err);
  if (/authentication method/i.test(msg)) return "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.";
  return msg;
}

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.ts";
import { extractFacts } from "./extract.ts";
import { SYSTEM_PROMPT, turnContext } from "./prompt.ts";
import { memoryDigest, recall } from "./recall.ts";
import type { Source, Store, Turn } from "./store.ts";
import { humanDateTime, temporalContext } from "./time.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

/** Events streamed to the UI (and printed by the CLI). */
export type AgentEvent =
  | { type: "meta"; conversationId: string; title: string }
  | { type: "status"; kind: "search"; query: string }
  | { type: "status"; kind: "recall"; detail: string }
  | { type: "status"; kind: "thinking" }
  | { type: "text"; text: string }
  /** Model fallback restarted the answer: discard what was streamed so far. */
  | { type: "reset" }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; turnId: string; ms: number; searches: number }
  | { type: "error"; message: string };

export interface TurnInput {
  conversationId?: string;
  message: string;
  tz: string;
  /** Override the clock (used by the seed script to create backdated history). */
  now?: Date;
  signal?: AbortSignal;
}

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);

const RecallInput = z.object({
  query: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const RECALL_TOOL: Anthropic.Beta.BetaTool = {
  name: "recall_memory",
  description:
    "Search the user's past conversations with you. Returns matching exchanges (when, what they asked, what you answered, the facts you stated, the sources you used) plus an overview of what memory exists. Give a date range (inclusive, user's local dates) when the user refers to a time, a topic query when they refer to a subject, or both. Results already in the current conversation are flagged.",
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

/**
 * Prior turns of the current conversation, replayed as plain text.
 *
 * We deliberately do NOT replay raw web-search result blocks or thinking blocks
 * from earlier turns: they are large (encrypted page content), slow every later
 * request down, and are stale by the next turn anyway. Each assistant turn
 * keeps a short list of the sources it cited so follow-ups can refer to them.
 * Each user turn carries the time it was sent, so the model knows that "since
 * then" in a chat resumed three days later means three days.
 */
function historyMessages(turns: Turn[], tz: string): MessageParam[] {
  const recent = turns.slice(-config.historyTurns);
  const msgs: MessageParam[] = [];
  for (const t of recent) {
    if (t.role === "user") {
      msgs.push({ role: "user", content: `[sent ${humanDateTime(new Date(t.at), t.tz || tz)}]\n${t.text}` });
    } else if (t.text.trim() && !t.text.startsWith("_(error")) {
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
    emit({ type: "meta", conversationId: conv.id, title: conv.title });

    const prior = this.store.turns(conv.id);
    // Persist the question first: it's part of memory even if the answer fails.
    const userTurn = this.store.addTurn({
      conversationId: conv.id,
      role: "user",
      text: input.message,
      at: now.toISOString(),
      tz,
    });

    const messages: MessageParam[] = [
      ...historyMessages(prior, tz),
      { role: "user", content: `[sent ${humanDateTime(now, tz)}]\n${input.message}` },
      // Per-turn context as a mid-conversation system message: keeps the cached
      // prefix (system prompt + earlier turns) intact while giving fresh facts.
      { role: "system", content: turnContext(temporalContext(now, tz), memoryDigest(this.store, tz, conv.id)) },
    ] as MessageParam[];

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
    let stopNote = "";

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
      for (let iter = 0; iter < config.maxIterations; iter++) {
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
            emit({ type: "status", kind: "recall", detail: describeRecall(block.input) });
          }
        });

        const msg = await stream.finalMessage();

        if (msg.stop_reason === "pause_turn") {
          // Long server-side search turn: send it back so the server continues.
          messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
          continue;
        }

        if (msg.stop_reason === "tool_use") {
          const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((call) => {
            if (call.name !== "recall_memory") {
              return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` };
            }
            const parsed = RecallInput.safeParse(call.input);
            if (!parsed.success) {
              return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid input: ${parsed.error.message}` };
            }
            const result = recall(this.store, parsed.data, tz, {
              currentConversationId: conv.id,
              excludeTurnIds: new Set([userTurn.id]),
            });
            return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) };
          });
          messages.push({ role: "user", content: results });
          continue;
        }

        if (msg.stop_reason === "refusal" && !answer.trim()) say("Sorry, I can't help with that one.");
        if (msg.stop_reason === "max_tokens") stopNote = "\n\n_(Answer cut off: it hit the length limit. Ask me to continue.)_";
        break;
      }
    } catch (err) {
      if (input.signal?.aborted) {
        stopNote = "\n\n_(stopped)_";
      } else {
        const message = errorMessage(err);
        emit({ type: "error", message });
        if (!answer.trim()) {
          answer = `_(error: ${message})_`;
        }
      }
    }

    if (stopNote) say(stopNote);

    // Prefer what was actually cited; fall back to what was read.
    const sources = cited.length ? cited : [...seen.values()].slice(0, 6);
    if (sources.length) emit({ type: "sources", sources });

    const assistantTurn = this.store.addTurn({
      conversationId: conv.id,
      role: "assistant",
      text: answer,
      at: new Date(now.getTime() + (Date.now() - started)).toISOString(),
      tz,
      sources,
      searches,
    });
    emit({ type: "done", turnId: assistantTurn.id, ms: Date.now() - started, searches: searches.length });

    // Off the latency path: distill facts for future "has it changed?" questions.
    if (answer.trim() && !answer.startsWith("_(error")) {
      void extractFacts(this.client, input.message, answer, sources)
        .then((x) => {
          if (!x) return;
          this.store.updateTurn(assistantTurn.id, { facts: x.facts, entities: x.entities, decisions: x.decisions });
          if (isNew && x.title) this.store.setTitle(conv.id, x.title);
        })
        .catch((e) => console.warn("[extract] failed:", errorMessage(e)));
    }
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

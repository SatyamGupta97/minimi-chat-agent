import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import type { Source } from "../store.ts";
import type { Citations, Provider, StepResult, TurnSetup } from "./types.ts";

/**
 * Claude with Anthropic's server-side web search. Search runs inside the API
 * call; results come back as `web_search_tool_result` blocks and answer text
 * carries `web_search_result_location` citations, which map straight onto our
 * [n] markers.
 *
 * Per-turn context goes in a mid-conversation `role: "system"` message after
 * the user's message (on models that support it), so the cached prefix (system
 * prompt + earlier turns) stays byte-identical between turns.
 */

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

// Models that accept mid-conversation system messages / server-side refusal fallbacks.
const SYSTEM_MESSAGE_MODELS = /^claude-(opus-5|opus-4-8|sonnet-5-5|haiku-5-5|fable-5|mythos-5)/;
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);
/** A long server-side search turn can pause; resume it this many times at most. */
const MAX_RESUMES = 4;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly webSearch = true;
  private client: Anthropic;

  constructor(
    private apiKey: string,
    readonly chatModel: string,
    private extractModel: string,
    private effort: "low" | "medium" | "high",
  ) {
    this.client = new Anthropic({ apiKey: apiKey || "missing" });
  }

  missingConfig(): string | null {
    return this.apiKey ? null : "No API key set. Put an OpenAI, Gemini, Claude or Groq key in .env as LLM_API_KEY.";
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
    const messages: BetaMessageParam[] = setup.history.map((h) => ({ role: h.role, content: h.text }));
    if (SYSTEM_MESSAGE_MODELS.test(this.chatModel)) {
      messages.push({ role: "user", content: setup.message }, { role: "system", content: setup.context });
    } else {
      messages.push({ role: "user", content: `<context source="app, not the user">\n${setup.context}\n</context>\n\n${setup.message}` });
    }
    const { sink, citations } = setup;
    let text = "";

    for (let resume = 0; resume <= MAX_RESUMES; resume++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.chatModel,
          max_tokens: 32_000,
          system: [{ type: "text", text: setup.system, cache_control: { type: "ephemeral" } }],
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }], // the agent's only tool
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort },
          cache_control: { type: "ephemeral" },
          ...(FALLBACK_MODELS.has(this.chatModel) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal },
      );

      stream.on("streamEvent", (ev, snapshot) => {
        if (ev.type === "content_block_start" && ev.content_block.type === "fallback") {
          text = ""; // a fallback model restarts the answer; the final text replaces what was streamed
          return;
        }
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          sink.text(ev.delta.text);
          return;
        }
        if (ev.type !== "content_block_stop") return;
        const block = snapshot.content[ev.index] as BetaContentBlock | undefined;
        if (block?.type === "server_tool_use" && block.name === "web_search") {
          const q = (block.input as { query?: unknown })?.query;
          if (typeof q === "string" && q) sink.search(q);
        } else if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) sink.read({ url: r.url, title: r.title, pageAge: r.page_age });
        } else if (block?.type === "text" && block.citations?.length) {
          const marker = markers(block.citations, citations);
          if (marker) {
            text += marker;
            sink.text(marker);
          }
        }
      });

      const msg = await stream.finalMessage();
      switch (msg.stop_reason) {
        case "pause_turn": // long server-side search: send it back so the server continues
          messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
          continue;
        case "end_turn":
        case "stop_sequence":
          return { text, finish: "stop" };
        case "max_tokens":
          return { text, finish: "length" };
        case "refusal":
          return { text, finish: "blocked" };
        default:
          return { text, finish: "other" };
      }
    }
    return { text, finish: "other" }; // still paused after MAX_RESUMES
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const res = await this.client.messages.parse({
      model: opts?.strong ? this.chatModel : this.extractModel,
      max_tokens: 8_000,
      output_config: { format: zodOutputFormat(schema as never), effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    return schema.parse(res.parsed_output);
  }

  describeError(err: unknown): string | undefined {
    if (err instanceof Anthropic.AuthenticationError) return "Your Claude (Anthropic) API key was rejected. Check the key in .env.";
    if (err instanceof Anthropic.PermissionDeniedError) return "This Anthropic key can't use this model or web search (enable web search in the Anthropic Console).";
    if (err instanceof Anthropic.RateLimitError) {
      const wait = this.retryAfterMs(err);
      return `Rate limited by Anthropic${wait ? `; retry in ~${Math.ceil(wait / 1000)}s` : ""}.`;
    }
    if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
    return undefined;
  }

  retryAfterMs(err: unknown): number | undefined {
    if (!(err instanceof Anthropic.RateLimitError)) return undefined;
    const s = Number(err.headers?.get?.("retry-after") ?? NaN);
    return Number.isFinite(s) ? s * 1000 : 60_000;
  }
}

/** Claude's web-search citations → our stable [n] markers (deduplicated per text block). */
function markers(cs: Anthropic.Beta.BetaTextCitation[], citations: Citations): string {
  const nums = new Set<number>();
  for (const c of cs) {
    if (c.type !== "web_search_result_location") continue;
    nums.add(citations.cite({ url: c.url, title: c.title ?? c.url } satisfies Source));
  }
  return [...nums].map((n) => `[${n}]`).join("");
}

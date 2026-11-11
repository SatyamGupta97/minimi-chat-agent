import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputText } from "openai/resources/responses/responses";
import { z, type ZodType } from "zod";
import type { Source } from "../store.ts";
import { strictSchema } from "./schema.ts";
import type { Citations, Provider, StepResult, TurnSetup } from "./types.ts";

/**
 * OpenAI via the Responses API with the built-in `web_search` tool, plus
 * embeddings (text-embedding-3-small) for meaning-based memory search.
 *
 * Citations come back as `url_citation` annotations on the final text. The
 * model usually also writes them inline as markdown links "([site](url))"; we
 * replace each such link with our stable [n] marker (located by URL, which is
 * robust to how start/end indices count characters), or insert [n] at the
 * annotation's end when there's no inline link.
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
/** text-embedding-3 vectors can be shortened server-side and stay normalized; 512 keeps the memory file small. */
const EMBEDDING_DIMENSIONS = 512;

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exported for tests: rewrite one output_text part's annotations into [n] markers. */
export function placeUrlCitations(part: Pick<ResponseOutputText, "text" | "annotations">, citations: Citations): string {
  let text = part.text;
  const anns = part.annotations.filter((a): a is ResponseOutputText.URLCitation => a.type === "url_citation");
  // Number in reading order, then edit from the end so earlier offsets stay valid.
  const numbered = anns
    .sort((a, b) => a.start_index - b.start_index)
    .map((a) => ({ a, n: citations.cite({ url: a.url, title: a.title || domainOf(a.url) } satisfies Source) }));
  for (const { a, n } of numbered.reverse()) {
    // Prefer replacing an inline markdown link to this URL: "([site](url))" or "[site](url)".
    const link = new RegExp(`\\s?\\(?\\[[^\\]]*\\]\\(${escapeRe(a.url)}[^)]*\\)\\)?`);
    const m = link.exec(text);
    if (m) text = text.slice(0, m.index) + `[${n}]` + text.slice(m.index + m[0].length);
    else {
      const at = Math.min(Math.max(a.end_index, 0), text.length);
      text = text.slice(0, at) + `[${n}]` + text.slice(at);
    }
  }
  return text.replace(/(\[\d+\])\1+/g, "$1"); // the same source cited twice in a row reads once
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly webSearch = true;
  readonly embeddingModel = `${EMBEDDING_MODEL}@${EMBEDDING_DIMENSIONS}`;
  private client: OpenAI;

  constructor(
    private apiKey: string,
    readonly chatModel: string,
    private extractModel: string,
    private effort: "low" | "medium" | "high",
  ) {
    this.client = new OpenAI({ apiKey: apiKey || "missing" });
  }

  missingConfig(): string | null {
    return this.apiKey ? null : "No API key set. Put an OpenAI, Gemini, Claude or Groq key in .env as LLM_API_KEY.";
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
    const input: ResponseInputItem[] = [
      { role: "system", content: setup.system },
      ...setup.history.map((h) => ({ role: h.role, content: h.text }) as ResponseInputItem),
      // Per-turn context in the newest user message keeps the earlier prefix identical (prompt caching).
      { role: "user", content: `<context source="app, not the user">\n${setup.context}\n</context>\n\n${setup.message}` },
    ];
    const stream = await this.client.responses.create(
      {
        model: this.chatModel,
        input,
        tools: [{ type: "web_search" }], // the agent's only tool
        include: ["web_search_call.action.sources"],
        reasoning: { effort: this.effort },
        stream: true,
      },
      { signal },
    );

    const { sink, citations } = setup;
    let final: OpenAI.Responses.Response | undefined;
    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") sink.text(ev.delta);
      else if (ev.type === "response.output_item.done" && ev.item.type === "web_search_call") {
        const action = ev.item.action;
        if (action?.type === "search") {
          for (const q of action.queries ?? (action.query ? [action.query] : [])) sink.search(q);
          for (const s of action.sources ?? []) if (s.url) sink.read({ url: s.url, title: domainOf(s.url) });
        }
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") {
        final = ev.response;
      }
    }

    // The authoritative answer: final text with inline links replaced by [n] markers.
    let text = "";
    let refused = false;
    for (const item of final?.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type === "output_text") text += placeUrlCitations(part, citations);
        else if (part.type === "refusal") refused = true;
      }
    }
    if (refused && !text.trim()) return { text, finish: "blocked" };
    if (final?.status === "completed") return { text, finish: "stop" };
    if (final?.incomplete_details?.reason === "max_output_tokens") return { text, finish: "length" };
    if (final?.incomplete_details?.reason === "content_filter") return { text, finish: "blocked" };
    return { text, finish: "other" };
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const res = await this.client.responses.create({
      model: opts?.strong ? this.chatModel : this.extractModel,
      input: [{ role: "user", content: prompt }],
      text: { format: { type: "json_schema", name: "result", strict: true, schema: strictSchema(z.toJSONSchema(schema)) } },
    });
    return schema.parse(JSON.parse(res.output_text));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float" });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  describeError(err: unknown): string | undefined {
    // Out of credit arrives as a 429 or as an in-stream error; either way it's billing, not a rate limit.
    if (isOutOfCredit(err)) return "This OpenAI key has no credits left. Add credits at platform.openai.com → Settings → Billing, or use another key.";
    if (err instanceof OpenAI.AuthenticationError) return "Your OpenAI API key was rejected. Check the key in .env.";
    if (err instanceof OpenAI.PermissionDeniedError) return "This OpenAI key can't use this model or web search.";
    if (err instanceof OpenAI.RateLimitError) {
      const wait = this.retryAfterMs(err);
      return `Rate limited by OpenAI${wait ? `; retry in ~${Math.ceil(wait / 1000)}s` : ""}.`;
    }
    if (err instanceof OpenAI.APIError) return `OpenAI API error ${err.status ?? ""}: ${err.message}`;
    return undefined;
  }

  retryAfterMs(err: unknown): number | undefined {
    if (!(err instanceof OpenAI.RateLimitError) || isOutOfCredit(err)) return undefined; // waiting won't add credit
    const s = Number(err.headers?.get?.("retry-after") ?? NaN);
    return Number.isFinite(s) ? s * 1000 : 60_000;
  }
}

function isOutOfCredit(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return /credit_balance_exhausted|insufficient_quota/.test(String(e?.code ?? "")) || /no credits remaining|exceeded your current quota/i.test(String(e?.message ?? ""));
}

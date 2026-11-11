import Groq from "groq-sdk";
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { z, type ZodType } from "zod";
import type { Source } from "../store.ts";
import type { Citations, ChatSession, Provider, StepResult, StepSink, ToolCall, TurnSetup } from "./types.ts";

// The API also sends `name` ("browser.search", "browser.open", ...); the SDK type omits it.
type ExecutedTool = NonNullable<ChatCompletionChunk.Choice.Delta["executed_tools"]>[number] & { name?: string };

/**
 * Groq's GPT-OSS models browse with a built-in `browser_search` tool (Exa).
 * Each search/open becomes a numbered browser "cursor" (the executed tool's
 * `index`), and the answer cites lines of those pages as 【cursor†Lx-Ly】.
 * We resolve each marker to the exact search result (or opened page) behind
 * those lines, so citations point at real URLs, not just "the search".
 */

/** "L4: text" lines of a browser page. */
function pageLines(output: string | null | undefined): Map<number, string> {
  const lines = new Map<number, string>();
  for (const raw of (output ?? "").split("\n")) {
    const m = raw.match(/^L(\d+): ?(.*)$/);
    if (m) lines.set(Number(m[1]), m[2]);
  }
  return lines;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The sources behind lines [from, to] of the page at a cursor. Exported for tests. */
export function sourcesAt(tool: ExecutedTool | undefined, from: number, to: number): Source[] {
  if (!tool) return [];
  const lines = pageLines(tool.output);
  const results = tool.search_results?.results ?? [];
  if (tool.name === "browser.search") {
    // A results page lists entries as "【k†Title†domain】" followed by snippet
    // lines; every line belongs to the most recent entry above it.
    const out = new Map<number, Source>();
    let current = -1;
    for (const n of [...lines.keys()].sort((a, b) => a - b)) {
      const m = lines.get(n)!.match(/【(\d+)†/);
      if (m) current = Number(m[1]);
      if (n >= from && n <= to && current >= 0 && results[current]?.url) {
        const r = results[current];
        out.set(current, { url: r.url!, title: r.title || domainOf(r.url!) });
      }
    }
    return [...out.values()];
  }
  // An opened page: one source, the page itself.
  const url = results[0]?.url ?? lines.get(1)?.replace(/^URL:\s*/, "");
  if (!url) return [];
  const title = lines.get(2)?.trim() || domainOf(url);
  return [{ url, title }];
}

/**
 * Streaming rewrite of 【c†Lx-Ly】 markers into [n]. Markers can be split
 * across chunks, so text from an unclosed 【 is held back until it closes.
 */
export class MarkerRewriter {
  private pending = "";
  /** Numbers in the run of markers just emitted, so 【1†L6】【1†L9】 renders once as [1]. */
  private run = new Set<number>();
  constructor(
    private resolve: (cursor: number, from: number, to: number) => Source[],
    private citations: Citations,
  ) {}

  feed(delta: string): string {
    let s = this.pending + delta;
    this.pending = "";
    let out = "";
    for (;;) {
      const i = s.indexOf("【");
      if (i < 0) return out + this.plain(s);
      out += this.plain(s.slice(0, i));
      const j = s.indexOf("】", i);
      if (j < 0) {
        // Not closed yet: hold it (bounded, in case a stray 【 never closes).
        if (s.length - i > 120) return out + this.plain(s.slice(i));
        this.pending = s.slice(i);
        return out;
      }
      out += this.rewrite(s.slice(i, j + 1));
      s = s.slice(j + 1);
    }
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }

  private plain(s: string): string {
    if (s) this.run.clear();
    return s;
  }

  private rewrite(marker: string): string {
    const m = marker.match(/^【(\d+)†L(\d+)(?:-L?(\d+))?】$/);
    if (!m) return ""; // other browser markup: drop rather than show raw
    const nums = this.resolve(Number(m[1]), Number(m[2]), Number(m[3] ?? m[2])).map((s) => this.citations.cite(s));
    const fresh = [...new Set(nums)].filter((n) => !this.run.has(n));
    fresh.forEach((n) => this.run.add(n));
    return fresh.map((n) => `[${n}]`).join("");
  }
}

/** Groq's strict structured outputs want every object closed and every property required. */
function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "$schema") s[k] = strictify(v);
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    s.additionalProperties = false;
    s.required = Object.keys(s.properties);
  }
  return s;
}

export class GroqProvider implements Provider {
  readonly name = "groq";
  private client: Groq;

  constructor(
    private apiKey: string,
    readonly chatModel: string,
    private extractModel: string,
    private effort: "low" | "medium" | "high",
  ) {
    this.client = new Groq({ apiKey: apiKey || "missing" });
  }

  missingConfig(): string | null {
    return this.apiKey ? null : "GROQ_API_KEY is not set. Copy .env.example to .env and add your key.";
  }

  startTurn(setup: TurnSetup): ChatSession {
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: setup.system }];
    for (const h of setup.history) messages.push({ role: h.role, content: h.text });
    // Per-turn context in the newest user message keeps the earlier prefix identical.
    messages.push({ role: "user", content: `<context source="app, not the user">\n${setup.context}\n</context>\n\n${setup.message}` });
    const tools: ChatCompletionTool[] = [
      { type: "browser_search" } as unknown as ChatCompletionTool, // built-in; the SDK's tool type only models functions
      ...setup.tools.map((t): ChatCompletionTool => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    ];
    const { client, chatModel, effort } = this;
    const { sink, citations } = setup;

    return {
      async step(signal?: AbortSignal): Promise<StepResult> {
        const stream = await client.chat.completions.create(
          { model: chatModel, messages, tools, stream: true, reasoning_effort: effort, max_completion_tokens: 16_000 },
          { signal },
        );
        const cursors = new Map<number, ExecutedTool>(); // browser cursor -> page (this step only)
        const announced = new Set<number>();
        const rewriter = new MarkerRewriter((c, a, b) => sourcesAt(cursors.get(c), a, b), citations);
        const calls: { id: string; name: string; args: string }[] = [];
        let raw = "";
        let text = "";
        let finish: string | null = null;
        const emit = (s: string) => {
          if (!s) return;
          text += s;
          sink.text(s);
        };

        for await (const chunk of stream) {
          const ch = chunk.choices[0];
          if (!ch) continue;
          for (const t of ch.delta.executed_tools ?? []) onTool(t, cursors, announced, sink);
          for (const tc of ch.delta.tool_calls ?? []) {
            const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name += tc.function.name;
            if (tc.function?.arguments) c.args += tc.function.arguments;
          }
          if (ch.delta.content) {
            raw += ch.delta.content;
            emit(rewriter.feed(ch.delta.content));
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
        emit(rewriter.flush());

        const parsed: ToolCall[] = calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, args: safeJson(c.args) }));
        if (parsed.length) {
          messages.push({
            role: "assistant",
            content: raw || null,
            tool_calls: calls.filter(Boolean).map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
          });
          return { text, calls: parsed, finish: "tool_calls" };
        }
        if (finish === "length") return { text, calls: [], finish: "length" };
        if (finish === "content_filter") return { text, calls: [], finish: "blocked" };
        return { text, calls: [], finish: finish === "stop" || finish === null ? "stop" : "other" };
      },
      addToolResults(results) {
        for (const { call, output } of results) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      },
    };
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const res = await this.client.chat.completions.create({
      model: opts?.strong ? this.chatModel : this.extractModel,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: strictify(z.toJSONSchema(schema)) as Record<string, unknown> } },
      reasoning_effort: "low",
    });
    return schema.parse(JSON.parse(res.choices[0]?.message.content ?? ""));
  }

  describeError(err: unknown): string | undefined {
    if (!(err instanceof Groq.APIError)) return undefined;
    if (err.status === 401) return "GROQ_API_KEY was rejected (invalid key).";
    if (err.status === 413) return "Request too large for this Groq key's tokens-per-minute limit. Try a shorter question or a new chat.";
    if (err.status === 429) {
      const wait = err.headers?.get?.("retry-after");
      return `Rate limited by Groq${wait ? `; retry in ~${wait}s` : ""}. Free-tier keys have low per-minute token limits.`;
    }
    return `Groq API error ${err.status ?? ""}: ${err.message}`;
  }
}

/** Announce searches as they start; collect pages once their output arrives. */
function onTool(t: ExecutedTool, cursors: Map<number, ExecutedTool>, announced: Set<number>, sink: StepSink): void {
  const idx = Number(t.index);
  if (!announced.has(idx) && t.name === "browser.search") {
    announced.add(idx);
    const q = (safeJson(t.arguments ?? "") as { query?: unknown })?.query;
    if (typeof q === "string" && q) sink.search(q);
  }
  if (!t.output) return;
  cursors.set(idx, t);
  if (t.name === "browser.search") {
    for (const r of t.search_results?.results ?? []) if (r.url) sink.read({ url: r.url, title: r.title || domainOf(r.url) });
  } else {
    for (const s of sourcesAt(t, 0, Number.MAX_SAFE_INTEGER)) sink.read(s);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

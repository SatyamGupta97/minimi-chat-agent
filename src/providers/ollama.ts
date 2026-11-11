import { z, type ZodType } from "zod";
import type { Provider, StepResult, TurnSetup } from "./types.ts";

/**
 * A local model through Ollama (no API key, no cost). For integration testing
 * and the memory scenarios only: a local model has no built-in web search, so
 * this provider declares `webSearch: false`, tells the model so, and the eval
 * skips the scenarios that need search. Its answers say nothing about how
 * Groq or Gemini behave.
 */

const NO_SEARCH_NOTE =
  "\n\n# Local mode\nWeb search is NOT available in this session. Never claim to have searched or cite sources. If a question needs current information, say you can't check it right now and answer from memory and context, clearly labelled as unverified.";

interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  readonly webSearch = false;

  constructor(
    private host: string,
    readonly chatModel: string,
    private extractModel: string,
  ) {}

  missingConfig(): string | null {
    return null; // no key; reachability is reported by describeError
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
    const messages = [
      { role: "system", content: setup.system + NO_SEARCH_NOTE },
      ...setup.history.map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: `<context source="app, not the user">\n${setup.context}\n</context>\n\n${setup.message}` },
    ];
    const res = await this.post("/api/chat", { model: this.chatModel, messages, stream: true, think: false }, signal);

    let text = "";
    let doneReason: string | undefined;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as ChatChunk;
        if (chunk.error) throw new OllamaError(chunk.error);
        const piece = chunk.message?.content ?? "";
        if (piece) {
          text += piece;
          setup.sink.text(piece);
        }
        if (chunk.done) doneReason = chunk.done_reason;
      }
    }
    // Some local models (qwen3) reason in the answer text even with think:false and
    // close it with </think>. The returned text replaces what was streamed, so
    // keep only the answer.
    const answer = stripThinking(text);
    if (doneReason === "length") return { text: answer, finish: "length" };
    return { text: answer, finish: doneReason === "stop" ? "stop" : "other" };
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const res = await this.post("/api/chat", {
      model: opts?.strong ? this.chatModel : this.extractModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      format: z.toJSONSchema(schema), // Ollama constrains output to this schema
    });
    const body = (await res.json()) as { message?: { content?: string } };
    return schema.parse(JSON.parse(stripThinking(body.message?.content ?? "")));
  }

  describeError(err: unknown): string | undefined {
    if (err instanceof OllamaError) {
      if (/not found/i.test(err.message)) return `Ollama model not found (${err.message}). Run: ollama pull ${this.chatModel}`;
      return `Ollama error: ${err.message}`;
    }
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) return `Can't reach Ollama at ${this.host}. Start it with: ollama serve`;
    return undefined;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new OllamaError(`${res.status} ${(safeError(detail) ?? detail).slice(0, 200)}`);
    }
    return res;
  }
}

class OllamaError extends Error {}

export function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  return end >= 0 ? text.slice(end + "</think>".length).trim() : text.replace(/^<think>[\s\S]*$/, "").trim() || text;
}

function safeError(s: string): string | undefined {
  try {
    return (JSON.parse(s) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

import {
  ApiError,
  type Content,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type GroundingMetadata,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import { z, type ZodType } from "zod";
import type { Citations, ChatSession, Provider, StepResult, ToolCall, TurnSetup } from "./types.ts";

const LEVEL = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;

/** UTF-8 byte offset -> JS string index (grounding segments are measured in bytes). */
function byteToCharIndex(s: string, bytes: number): number {
  return Buffer.from(s, "utf8").subarray(0, bytes).toString("utf8").length;
}

/**
 * Place [n] markers after each grounded segment of one response's text.
 * Gemini reports grounding only when a response ends, so markers are placed
 * then (the UI swaps in the final text).
 */
export function placeCitations(text: string, meta: GroundingMetadata | undefined, citations: Citations): string {
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
      const n = citations.cite({ url: web.uri, title: web.title ?? web.uri });
      if (!nums.includes(n)) nums.push(n);
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

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  private client: GoogleGenAI;

  constructor(
    private apiKey: string,
    readonly chatModel: string,
    private extractModel: string,
    private effort: keyof typeof LEVEL,
  ) {
    this.client = new GoogleGenAI({ apiKey: apiKey || "missing" });
  }

  missingConfig(): string | null {
    return this.apiKey ? null : "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.";
  }

  startTurn(setup: TurnSetup): ChatSession {
    const contents: Content[] = [];
    const push = (role: "user" | "model", text: string) => {
      const last = contents[contents.length - 1];
      if (last?.role === role) last.parts!.push({ text }); // Gemini wants alternating roles
      else contents.push({ role, parts: [{ text }] });
    };
    for (const h of setup.history) push(h.role === "user" ? "user" : "model", h.text);
    // Per-turn context rides in the newest user message, so everything before it
    // stays byte-identical between turns (keeps the implicit prefix cache warm).
    push("user", `<context source="app, not the user">\n${setup.context}\n</context>`);
    push("user", setup.message);
    const { client, chatModel, effort } = this;
    const { sink, citations } = setup;

    return {
      async step(signal?: AbortSignal): Promise<StepResult> {
        const stream = await client.models.generateContentStream({
          model: chatModel,
          contents,
          config: {
            systemInstruction: setup.system,
            // Google Search (server-side, inside this call) + our function tools (client-side).
            tools: [{ googleSearch: {} }, { functionDeclarations: setup.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
            toolConfig: {
              includeServerSideToolInvocations: true, // surface search calls so the UI can show them
              functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED }, // required to combine built-in tools + functions
            },
            thinkingConfig: { thinkingLevel: LEVEL[effort] },
            maxOutputTokens: 32_000,
            abortSignal: signal,
          },
        });

        const parts: Part[] = []; // the model's turn, kept verbatim (thought signatures included)
        let text = "";
        let meta: GroundingMetadata | undefined;
        let finish: FinishReason | undefined;
        let blocked = false;
        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) blocked = true;
          const cand = chunk.candidates?.[0];
          if (!cand) continue;
          for (const p of cand.content?.parts ?? []) {
            parts.push(p);
            if (p.text && !p.thought) {
              text += p.text;
              sink.text(p.text);
            }
            if (p.toolCall) queriesOf(p.toolCall.args).forEach((q) => sink.search(q));
          }
          if (cand.groundingMetadata) meta = cand.groundingMetadata;
          if (cand.finishReason) finish = cand.finishReason;
        }

        (meta?.webSearchQueries ?? []).forEach((q) => sink.search(q));
        for (const c of meta?.groundingChunks ?? []) if (c.web?.uri) sink.read({ url: c.web.uri, title: c.web.title ?? c.web.uri });
        if (meta?.searchEntryPoint?.renderedContent) sink.suggestions(meta.searchEntryPoint.renderedContent);

        const calls: ToolCall[] = parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({ id: p.functionCall!.id ?? `call_${i}`, name: p.functionCall!.name ?? "", args: p.functionCall!.args ?? {} }));
        if (calls.length) contents.push({ role: "model", parts });

        const out = placeCitations(text, meta, citations);
        if (calls.length) return { text: out, calls, finish: "tool_calls" };
        if (blocked || finish === FinishReason.SAFETY || finish === FinishReason.PROHIBITED_CONTENT || finish === FinishReason.BLOCKLIST) {
          return { text: out, calls, finish: "blocked" };
        }
        if (finish === FinishReason.MAX_TOKENS) return { text: out, calls, finish: "length" };
        return { text: out, calls, finish: finish === FinishReason.STOP || finish === undefined ? "stop" : "other" };
      },
      addToolResults(results) {
        contents.push({
          role: "user",
          parts: results.map(({ call, output }) => ({ functionResponse: { id: call.id, name: call.name, response: { output } } })),
        });
      },
    };
  }

  async json<T>(prompt: string, schema: ZodType<T>, opts?: { strong?: boolean }): Promise<T> {
    const res = await this.client.models.generateContent({
      model: opts?.strong ? this.chatModel : this.extractModel,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(schema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    return schema.parse(JSON.parse(res.text ?? ""));
  }

  describeError(err: unknown): string | undefined {
    if (!(err instanceof ApiError)) return undefined;
    if (err.status === 400 && /api key/i.test(err.message)) return "Invalid GEMINI_API_KEY.";
    if (err.status === 401 || err.status === 403) return "GEMINI_API_KEY was rejected (invalid key or no access to this model).";
    if (err.status === 429 && /quota/i.test(err.message)) {
      return "This Gemini API key has no quota left for this request. Google Search grounding (and Gemini 4) need a billing-enabled project: enable billing for the key's project in Google AI Studio.";
    }
    if (err.status === 429) return "Rate limited by the Gemini API. Try again in a moment.";
    return `Gemini API error ${err.status}: ${err.message}`;
  }
}

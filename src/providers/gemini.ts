import { ApiError, type Content, FinishReason, GoogleGenAI, type GroundingMetadata, ThinkingLevel } from "@google/genai";
import { z, type ZodType } from "zod";
import type { Citations, Provider, StepResult, TurnSetup } from "./types.ts";

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
    // streaming), searching only FORWARD from the previous segment so a repeated
    // sentence never pulls a citation back to its first occurrence. A second
    // support for the segment just placed ends at the cursor. Fall back to the
    // byte offset.
    let at = -1;
    if (seg.text) {
      if (cursor >= seg.text.length && text.slice(cursor - seg.text.length, cursor) === seg.text) at = cursor;
      else {
        const i = text.indexOf(seg.text, cursor);
        if (i >= 0) at = i + seg.text.length;
      }
    }
    if (at < 0 && seg.endIndex != null) at = byteToCharIndex(text, seg.endIndex);
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
  readonly webSearch = true;
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
    return this.apiKey ? null : "No API key set. Put a Groq, Claude or Gemini key in .env as LLM_API_KEY.";
  }

  async answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> {
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
    const { sink, citations } = setup;

    const stream = await this.client.models.generateContentStream({
      model: this.chatModel,
      contents,
      config: {
        systemInstruction: setup.system,
        tools: [{ googleSearch: {} }], // the agent's only tool
        toolConfig: { includeServerSideToolInvocations: true }, // surface search calls so the UI can show them
        thinkingConfig: { thinkingLevel: LEVEL[this.effort] },
        maxOutputTokens: 32_000,
        abortSignal: signal,
      },
    });

    let text = "";
    let meta: GroundingMetadata | undefined;
    let finish: FinishReason | undefined;
    let blocked = false;
    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      for (const p of cand.content?.parts ?? []) {
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

    const out = placeCitations(text, meta, citations);
    if (blocked || finish === FinishReason.SAFETY || finish === FinishReason.PROHIBITED_CONTENT || finish === FinishReason.BLOCKLIST) {
      return { text: out, finish: "blocked" };
    }
    if (finish === FinishReason.MAX_TOKENS) return { text: out, finish: "length" };
    // Only an explicit STOP is a completed answer; a stream that ended without a reason is not.
    return { text: out, finish: finish === FinishReason.STOP ? "stop" : "other" };
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
    if (err.status === 400 && /api key/i.test(err.message)) return "Your Gemini API key was rejected. Check the key in .env.";
    if (err.status === 401 || err.status === 403) return "Your Gemini API key was rejected (invalid key or no access to this model).";
    if (err.status === 429 && /quota/i.test(err.message)) {
      return "This Gemini API key has no quota for this request. On free keys that usually means Google Search grounding: it needs billing enabled on the key's project (Google AI Studio → billing).";
    }
    if (err.status === 429) return "Rate limited by the Gemini API. Try again in a moment.";
    return `Gemini API error ${err.status}: ${err.message}`;
  }
}

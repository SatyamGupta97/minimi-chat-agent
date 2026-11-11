import { config } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider, StepResult, TurnSetup } from "./types.ts";

function chatProvider(): Provider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "groq":
      return new GroqProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "gemini":
      return new GeminiProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "ollama":
      return new OllamaProvider(config.ollamaHost, config.chatModel, config.extractModel, config.ollamaEmbedModel);
  }
}

/** A provider used only for its embed(); its chat/extract models are never called. */
function embeddingProvider(): Provider | undefined {
  const e = config.embedding;
  if (!e) return undefined;
  return e.provider === "gemini"
    ? new GeminiProvider(e.apiKey, "gemini-3.8-flash", "gemini-3.5-flash-lite", "low")
    : new OpenAIProvider(e.apiKey, "gpt-6-luna", "gpt-6-luna", "low");
}

/**
 * Chat on one vendor, embeddings from another (e.g. Groq chat + Gemini
 * embeddings). Everything except embed() goes to the chat provider.
 */
export class WithEmbeddings implements Provider {
  constructor(
    private chat: Provider,
    private embedder: Provider,
  ) {}
  get name() { return this.chat.name; }
  get chatModel() { return this.chat.chatModel; }
  get webSearch() { return this.chat.webSearch; }
  get embeddingModel() { return this.embedder.embeddingModel; }
  missingConfig() { return this.chat.missingConfig(); }
  answer(setup: TurnSetup, signal?: AbortSignal): Promise<StepResult> { return this.chat.answer(setup, signal); }
  json: Provider["json"] = (prompt, schema, opts) => this.chat.json(prompt, schema, opts);
  embed(texts: string[], kind: "query" | "document") { return this.embedder.embed!(texts, kind); }
  describeError(err: unknown) { return this.chat.describeError(err) ?? this.embedder.describeError(err); }
  retryAfterMs(err: unknown) { return this.chat.retryAfterMs?.(err); }
}

export function createProvider(): Provider {
  const chat = chatProvider();
  const embedder = embeddingProvider();
  return embedder ? new WithEmbeddings(chat, embedder) : chat;
}

export type { Provider } from "./types.ts";

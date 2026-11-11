import { config } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export function createProvider(): Provider {
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

export type { Provider } from "./types.ts";

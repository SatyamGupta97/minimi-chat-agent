import { config } from "../config.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import { OllamaProvider } from "./ollama.ts";
import type { Provider } from "./types.ts";

export function createProvider(): Provider {
  switch (config.provider) {
    case "groq":
      return new GroqProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "gemini":
      return new GeminiProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
    case "ollama":
      return new OllamaProvider(config.ollamaHost, config.chatModel, config.extractModel);
  }
}

export type { Provider } from "./types.ts";

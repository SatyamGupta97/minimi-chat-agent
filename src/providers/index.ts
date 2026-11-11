import { config } from "../config.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import type { Provider } from "./types.ts";

export function createProvider(): Provider {
  return config.provider === "groq"
    ? new GroqProvider(config.apiKey, config.chatModel, config.extractModel, config.effort)
    : new GeminiProvider(config.apiKey, config.chatModel, config.extractModel, config.effort);
}

export type { Provider } from "./types.ts";

// Load .env if present (Node >= 20.12 built-in; no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export const config = {
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  /** Main agent model: must support Google Search combined with function calling (Gemini 3+). */
  chatModel: process.env.CHAT_MODEL ?? "gemini-3.8-flash",
  chatThinking: LEVELS[process.env.CHAT_THINKING ?? "medium"] ?? ThinkingLevel.MEDIUM,
  /** Small fast model for background fact extraction. */
  extractModel: process.env.EXTRACT_MODEL ?? "gemini-3.5-flash-lite",
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? "data/memory.json",
  /** Max model round-trips per turn (memory tool calls). Search runs server-side inside one round-trip. */
  maxIterations: 8,
  /** How many prior turns of the *current* conversation are replayed verbatim. */
  historyTurns: 30,
};

export class MissingKeyError extends Error {
  constructor() {
    super("GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
}

export function createClient(): GoogleGenAI {
  // Constructed even without a key so the UI still loads; calls fail with MissingKeyError.
  return new GoogleGenAI({ apiKey: config.apiKey || "missing" });
}

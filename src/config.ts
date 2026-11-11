// Load .env if present (Node >= 20.12 built-in; no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

type Effort = "low" | "medium" | "high";
const effort = (v: string | undefined, d: Effort): Effort => (v === "low" || v === "medium" || v === "high" ? v : d);

const groqKey = process.env.GROQ_API_KEY ?? "";
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";

type ProviderName = "groq" | "gemini" | "ollama";
const PROVIDERS: ProviderName[] = ["groq", "gemini", "ollama"];

/** Explicit LLM_PROVIDER wins; otherwise whichever key is present (Groq first: it works on a free key). */
const provider: ProviderName = PROVIDERS.includes(process.env.LLM_PROVIDER as ProviderName)
  ? (process.env.LLM_PROVIDER as ProviderName)
  : groqKey ? "groq" : "gemini";

const DEFAULTS = {
  groq: { chat: "openai/gpt-oss-120b", extract: "openai/gpt-oss-20b", effort: "low" as Effort },
  gemini: { chat: "gemini-3.8-flash", extract: "gemini-3.5-flash-lite", effort: "medium" as Effort },
  // Local, no key: whatever small model is pulled. qwen3:4b handles tool-free chat and JSON well for its size.
  ollama: { chat: "qwen3:4b", extract: "qwen3:4b", effort: "low" as Effort },
}[provider];

export const config = {
  provider,
  apiKey: provider === "groq" ? groqKey : provider === "gemini" ? geminiKey : "",
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  chatModel: process.env.CHAT_MODEL ?? DEFAULTS.chat,
  extractModel: process.env.EXTRACT_MODEL ?? DEFAULTS.extract,
  /** Reasoning depth for the chat model (Groq reasoning_effort / Gemini thinking level). */
  effort: effort(process.env.CHAT_EFFORT, DEFAULTS.effort),
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? "data/memory.json",
  /** How many prior turns of the *current* conversation are replayed verbatim. */
  historyTurns: 30,
};

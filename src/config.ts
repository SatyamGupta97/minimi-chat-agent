// Load .env if present (Node >= 20.12 built-in; no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

type Effort = "low" | "medium" | "high";
const effort = (v: string | undefined, d: Effort): Effort => (v === "low" || v === "medium" || v === "high" ? v : d);

export type ProviderName = "anthropic" | "gemini" | "groq" | "ollama";
const PROVIDERS: ProviderName[] = ["anthropic", "gemini", "groq", "ollama"];

/** Which vendor issued a key, from its format. */
export function vendorOfKey(key: string): Exclude<ProviderName, "ollama"> | undefined {
  if (/^sk-ant-/.test(key)) return "anthropic";
  if (/^gsk_/.test(key)) return "groq";
  if (/^AIza/.test(key)) return "gemini";
  return undefined;
}

const DEFAULTS: Record<ProviderName, { chat: string; extract: string; effort: Effort }> = {
  anthropic: { chat: "claude-opus-5-5", extract: "claude-haiku-5-5", effort: "medium" },
  gemini: { chat: "gemini-3.8-flash", extract: "gemini-3.5-flash-lite", effort: "medium" },
  groq: { chat: "openai/gpt-oss-120b", extract: "openai/gpt-oss-20b", effort: "low" },
  // Local, no key: whatever small model is pulled. qwen3:4b handles tool-free chat and JSON well for its size.
  ollama: { chat: "qwen3:4b", extract: "qwen3:4b", effort: "low" },
};

/** A model override only applies if it belongs to the selected vendor (a Groq model name sent to Claude would just fail). */
function modelFits(provider: ProviderName, model: string): boolean {
  if (provider === "anthropic") return /^claude-/.test(model);
  if (provider === "gemini") return /^gemini-/.test(model);
  if (provider === "groq") return !/^(claude-|gemini-)/.test(model);
  return true;
}

/**
 * Pick the provider and key from the environment. Paste ANY supported key as
 * LLM_API_KEY and the vendor is detected from its format; vendor-specific
 * variables (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY) work too.
 * LLM_PROVIDER forces a choice (and is the only way to pick local Ollama).
 */
export function selectProvider(env: NodeJS.ProcessEnv): { provider: ProviderName; apiKey: string; problem?: string } {
  const generic = env.LLM_API_KEY?.trim() ?? "";
  const keys: Record<Exclude<ProviderName, "ollama">, string> = {
    anthropic: env.ANTHROPIC_API_KEY ?? "",
    gemini: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "",
    groq: env.GROQ_API_KEY ?? "",
  };
  const genericVendor = generic ? vendorOfKey(generic) : undefined;
  if (genericVendor) keys[genericVendor] ||= generic;

  const forced = PROVIDERS.find((p) => p === env.LLM_PROVIDER);
  if (forced === "ollama") return { provider: "ollama", apiKey: "" };
  if (forced) return { provider: forced, apiKey: keys[forced] || generic };
  if (genericVendor) return { provider: genericVendor, apiKey: generic };
  const found = (["anthropic", "gemini", "groq"] as const).find((p) => keys[p]);
  if (found) return { provider: found, apiKey: keys[found] };
  return {
    provider: "groq",
    apiKey: "",
    problem: generic
      ? "LLM_API_KEY doesn't look like a Claude (sk-ant-…), Gemini (AIza…) or Groq (gsk_…) key. Set LLM_PROVIDER to say which vendor it is."
      : undefined,
  };
}

const selected = selectProvider(process.env);
const defaults = DEFAULTS[selected.provider];
const chatOverride = process.env.CHAT_MODEL;
const extractOverride = process.env.EXTRACT_MODEL;
const ignored = [chatOverride, extractOverride].filter((m): m is string => !!m && !modelFits(selected.provider, m));

export const config = {
  provider: selected.provider,
  apiKey: selected.apiKey,
  /** Shown at startup: a key we couldn't place, or model overrides that belong to another vendor. */
  warnings: [
    selected.problem,
    ignored.length ? `Ignoring ${ignored.join(", ")}: not a ${selected.provider} model (using ${selected.provider} defaults).` : undefined,
  ].filter((w): w is string => !!w),
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  chatModel: chatOverride && modelFits(selected.provider, chatOverride) ? chatOverride : defaults.chat,
  extractModel: extractOverride && modelFits(selected.provider, extractOverride) ? extractOverride : defaults.extract,
  /** Reasoning depth for the chat model (Claude effort / Groq reasoning_effort / Gemini thinking level). */
  effort: effort(process.env.CHAT_EFFORT, defaults.effort),
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? "data/memory.json",
  /** How many prior turns of the *current* conversation are replayed verbatim. */
  historyTurns: 30,
};

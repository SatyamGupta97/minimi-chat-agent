// Load .env if present (Node >= 20.12 built-in; no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

type Effort = "low" | "medium" | "high";

function effort(v: string | undefined): Effort {
  return v === "low" || v === "high" ? v : "medium";
}

export const config = {
  chatModel: process.env.CHAT_MODEL ?? "claude-opus-5-5",
  chatEffort: effort(process.env.CHAT_EFFORT),
  extractModel: process.env.EXTRACT_MODEL ?? "claude-haiku-5-5",
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? "data/memory.json",
  /** Max web searches the model may run in one turn. */
  maxSearchesPerTurn: 8,
  /** Max model round-trips per turn (memory tool calls + pause_turn resumes). */
  maxIterations: 8,
  /** How many prior turns of the *current* conversation are replayed verbatim. */
  historyTurns: 30,
};

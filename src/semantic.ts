import type { Provider } from "./providers/types.ts";
import { type Exchange, exchanges } from "./recall.ts";
import type { Store } from "./store.ts";
export { cosine } from "./vector.ts";

/**
 * Meaning-based memory search, for vendors with an embedding API.
 *
 * Each completed exchange gets one vector, computed in the background after
 * extraction from what the exchange is ABOUT (question, title, entities,
 * decisions, facts, the start of the answer). At question time the message is
 * embedded once and compared by cosine similarity, so "my vacation" finds the
 * chat about "a Goa trip in December" with no shared word.
 *
 * Keyword search stays as the other half of a hybrid: exact names (product
 * names, error codes) are where embeddings are weakest and keywords strongest.
 * Without an embedding API, recall is keyword-only and nothing else changes.
 */

/**
 * Minimum cosine similarity for a past exchange to count as related. Each model
 * has its own scale, so these are per model. They are starting estimates;
 * MEMORY_MIN_SIMILARITY overrides, and the eval is where to tune them.
 */
const MIN_SIMILARITY: Record<string, number> = {
  "text-embedding-3-small@512": 0.4,
  "gemini-embedding-001@768": 0.65,
};
export function minSimilarity(model: string): number {
  const override = Number(process.env.MEMORY_MIN_SIMILARITY);
  return Number.isFinite(override) && override > 0 ? override : (MIN_SIMILARITY[model] ?? 0.6);
}

/** What an exchange is about, as one text to embed. */
export function documentText(e: Exchange): string {
  const a = e.answer;
  return [
    `Chat: ${e.conversation.title}`,
    `Question: ${e.question.text}`,
    a?.entities?.length ? `About: ${a.entities.join(", ")}` : "",
    a?.decisions?.length ? `Decisions: ${a.decisions.join("; ")}` : "",
    a?.facts?.length ? `Facts: ${a.facts.map((f) => `${f.subject} ${f.attribute}: ${f.value}`).join("; ")}` : "",
    `Answer: ${(a?.text ?? "").replace(/\s+/g, " ").slice(0, 600)}`,
  ]
    .filter(Boolean)
    .join("\n");
}


const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5); // ~half the JSON size, no measurable loss

/**
 * Embed every completed exchange that has no vector from the current model
 * (new answers after extraction, and older history after a vendor switch).
 * Batched and sequential: background work.
 */
export async function embedMissing(provider: Provider, store: Store, batch = 32): Promise<number> {
  if (!provider.embed || !provider.embeddingModel) return 0;
  const model = provider.embeddingModel;
  const todo = exchanges(store).filter((e) => e.answer?.status === "completed" && e.answer.embedding?.model !== model);
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vectors = await provider.embed(slice.map(documentText), "document");
    slice.forEach((e, j) => vectors[j] && store.updateTurn(e.answer!.id, { embedding: { model, vector: round(vectors[j]) } }));
  }
  return todo.length;
}

/**
 * The current message as a query vector, or undefined if there's nothing to
 * compare against, the vendor has no embeddings, or the call is slow or fails.
 * Memory must never block or break an answer.
 */
export async function queryVector(provider: Provider, store: Store, message: string, timeoutMs = 2500): Promise<{ model: string; vector: number[] } | undefined> {
  const model = provider.embeddingModel;
  if (!provider.embed || !model) return undefined;
  if (!store.allTurns().some((t) => t.embedding?.model === model)) return undefined; // nothing embedded yet: skip the call
  try {
    const vectors = await Promise.race([
      provider.embed([message], "query"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("embedding timed out")), timeoutMs)),
    ]);
    return vectors[0]?.length ? { model, vector: vectors[0] } : undefined;
  } catch (e) {
    console.warn("[memory] query embedding skipped:", (e as Error).message);
    return undefined;
  }
}

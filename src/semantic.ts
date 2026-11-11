import type { Provider } from "./providers/types.ts";
import { type Exchange, exchanges } from "./recall.ts";
import type { Store } from "./store.ts";
import { cosine } from "./vector.ts";
export { cosine };

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
 * When does a past exchange count as "related" by meaning?
 *
 * Not by a fixed cosine cut-off. On real gemini-embedding-001 vectors (recorded
 * in test/fixtures-gemini-similarity.json), a true paraphrase match ("packing
 * tips for my vacation" vs a "Goa trip in December" chat) scored 0.605, while
 * "thanks, that was helpful!" scored 0.55–0.59 against EVERY chat; the ranges
 * overlap. What separates them is contrast: a real match stands out from the
 * other things the message is compared with; filler matches everything equally.
 *
 * Rule (chosen by searching that data for what classifies every pair correctly):
 * - with ≥4 candidate exchanges: beat their median by 0.07 (the middle of the
 *   0.055–0.09 range that got all 45 labelled pairs right);
 * - with fewer, the median of 1–3 numbers means little, so the baseline also
 *   includes fixed unrelated reference texts, with a 0.04 margin: on every 1–3
 *   chat subset it missed no intended match (87–95% overall; the errors are
 *   extra "possibly related" chats, which the model is told to ignore if
 *   irrelevant, whereas a miss loses the memory). The live 1-chat
 *   "vacation → Goa trip" case had a lift of 0.041;
 * - and be within 0.06 of the best match (stops a loosely related runner-up).
 * MEMORY_SIMILARITY_MARGIN overrides the margin.
 */
const MARGIN_OVERRIDE = Number(process.env.MEMORY_SIMILARITY_MARGIN) > 0 ? Number(process.env.MEMORY_SIMILARITY_MARGIN) : undefined;
export const NEAR_TOP = 0.06;

export const REFERENCE_TEXTS = [
  "Chat: Weather\nQuestion: Will it rain in the city tomorrow?\nAnswer: Light showers expected in the afternoon.",
  "Chat: Recipe\nQuestion: How do I make a simple pasta sauce?\nAnswer: Garlic, olive oil, tomatoes, simmer 20 minutes.",
  "Chat: Football\nQuestion: Who won the match last night?\nAnswer: The home team won 2-1.",
  "Chat: Homework\nQuestion: Solve 3x + 5 = 20.\nAnswer: x = 5.",
  "Chat: Movies\nQuestion: Recommend a good thriller movie.\nAnswer: Try a classic suspense film.",
  "Chat: Bike repair\nQuestion: How do I fix a flat bicycle tire?\nAnswer: Remove the tube, patch it, reinflate.",
];
const referenceCache = new Map<string, Promise<number[][]>>();

/** Reference vectors for a model, embedded once per process. */
function referenceVectors(provider: Provider, model: string): Promise<number[][]> {
  let p = referenceCache.get(model);
  if (!p) {
    p = provider.embed!(REFERENCE_TEXTS, "document");
    p.catch(() => referenceCache.delete(model)); // retry next time
    referenceCache.set(model, p);
  }
  return p;
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/**
 * Which candidates are related, given their similarities to the message and the
 * message's similarities to the reference texts. Exported for tests.
 */
export function relatedByContrast(candidateSims: number[], referenceSims: number[]): boolean[] {
  if (!candidateSims.length) return [];
  const many = candidateSims.length >= 4;
  const base = many ? median(candidateSims) : median([...candidateSims, ...referenceSims]);
  const margin = MARGIN_OVERRIDE ?? (many ? 0.07 : 0.04);
  const top = Math.max(...candidateSims);
  return candidateSims.map((s) => s >= base + margin && s >= top - NEAR_TOP);
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
export async function queryVector(
  provider: Provider,
  store: Store,
  message: string,
  timeoutMs = 2500,
): Promise<{ model: string; vector: number[]; referenceSims: number[] } | undefined> {
  const model = provider.embeddingModel;
  if (!provider.embed || !model) return undefined;
  if (!store.allTurns().some((t) => t.embedding?.model === model)) return undefined; // nothing embedded yet: skip the call
  try {
    const [vectors, refs] = await Promise.race([
      Promise.all([provider.embed([message], "query"), referenceVectors(provider, model)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("embedding timed out")), timeoutMs)),
    ]);
    const v = vectors[0];
    return v?.length ? { model, vector: v, referenceSims: refs.map((r) => cosine(v, r)) } : undefined;
  } catch (e) {
    console.warn("[memory] query embedding skipped:", (e as Error).message);
    return undefined;
  }
}

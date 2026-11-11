import { refersToPast, resolveDates } from "./dates.ts";
import { recall, type RecallQuery, type RecallResult } from "./recall.ts";
import type { Store } from "./store.ts";

/**
 * Memory retrieval is done by the app, before the model runs. The model's
 * only tool is web search, as the brief specifies.
 *
 *   message mentions a date ("on 3 November", "last Tuesday") -> exact date-range lookup per reading
 *   message refers to the past without a date ("you said", "we shortlisted") -> topic lookup
 *   neither -> no lookup (the per-turn index of past chats is still shown)
 *
 * Within a date range the message only re-ranks results (the date is the hard
 * constraint); without one, topic relevance is the filter. Results go into the
 * turn's context block, so a memory question costs no extra model round trip.
 */

export interface MemoryLookup {
  /** Shown as "Checking memory: …" and recorded by evals. */
  queries: (RecallQuery & { phrase?: string })[];
  /** Text for the context block, or "" when no lookup was needed. */
  text: string;
}

const MAX_MATCHES = 5;
const ANSWER_CHARS = 1500; // keep per-turn context small (free-tier token budgets)

export function lookupMemory(
  store: Store,
  message: string,
  now: Date,
  tz: string,
  opts: { currentConversationId: string; excludeTurnIds: Set<string> },
): MemoryLookup {
  const refs = resolveDates(message, now, tz);
  const queries: MemoryLookup["queries"] = refs.length
    ? refs.map((r) => ({ phrase: r.phrase, from: r.from, to: r.to, query: message, limit: MAX_MATCHES }))
    : refersToPast(message)
      ? [{ query: message, limit: MAX_MATCHES }]
      : [];
  if (!queries.length) return { queries, text: "" };

  const sections: string[] = [];
  let overview: RecallResult["memory_overview"] | undefined;
  for (const q of queries) {
    const res = recall(store, q, tz, { ...opts, answerChars: ANSWER_CHARS });
    overview = res.memory_overview;
    const label = q.phrase
      ? `"${q.phrase}" → ${q.from === q.to ? q.from : `${q.from} to ${q.to}`}`
      : `topic search (no date given)`;
    sections.push(
      res.matches.length
        ? `${label}: ${res.matches.length} of ${res.total_matches} match(es)\n${JSON.stringify(res.matches, null, 1)}`
        : `${label}: no conversations found.`,
    );
  }
  const ambiguous = new Set(refs.map((r) => r.phrase)).size < refs.length;
  return {
    queries,
    text: [
      "Memory lookup for this message (run by the app before you answer; these are the only past exchanges available):",
      ...sections,
      ambiguous ? "One phrase had more than one reading; each was looked up. Say which date you used." : "",
      `Memory overview: ${JSON.stringify(overview)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

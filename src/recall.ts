import type { Conversation, Fact, Source, Store, Turn } from "./store.ts";
import { humanDateTime, localDate } from "./time.ts";

/**
 * Memory retrieval over past conversations.
 *
 * Two signals, because users refer to the past in two ways:
 *   - by time  ("on 3 November", "last Tuesday")  -> hard date filter, in the user's tz
 *   - by topic ("the CRM shortlist", "Postgres")  -> lexical relevance (BM25-style)
 * Either or both may be given. Retrieval is deterministic and local (~ms), so the
 * model can call it freely; the model does the fuzzy part (turning "last Tuesday"
 * into a date range using the calendar we give it).
 */

export interface RecallQuery {
  query?: string;
  /** Inclusive YYYY-MM-DD in the user's timezone. */
  from?: string;
  /** Inclusive YYYY-MM-DD in the user's timezone. */
  to?: string;
  limit?: number;
}

export interface Exchange {
  conversation: Conversation;
  question: Turn;
  answer?: Turn;
}

export interface RecallHit {
  when: string;
  date: string;
  conversation: string;
  in_current_conversation: boolean;
  you_asked: string;
  i_answered: string;
  about?: string[];
  user_decisions?: string[];
  facts_stated?: Fact[];
  sources?: Source[];
}

export interface RecallResult {
  matches: RecallHit[];
  total_matches: number;
  /** Always present, so the model can say "I have no record of that" with specifics. */
  memory_overview: {
    total_past_questions: number;
    earliest: string | null;
    latest: string | null;
    days_with_conversations: string[];
  };
}

const STOP = new Set(
  "a an and are as at be by did do does for from has have how i in is it its me my of on or our since so that the their them then there these they this to was we what when which who why will with you your any about any been can could into just more most not now only same some still than very would asked ask tell told".split(
    " ",
  ),
);

/** Crude suffix stripping: "pricing"/"priced"/"prices" -> "pric". Good enough for recall. */
function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w.replace(/(ing|ed|es|s|e)$/, "");
}

/** Same word modulo suffix, or one is a prefix of the other ("postgres"/"postgresql"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  return x.length >= 4 && y.startsWith(x);
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}$€£.%-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

export function exchanges(store: Store): Exchange[] {
  const convById = new Map(store.listConversations().map((c) => [c.id, c]));
  const out: Exchange[] = [];
  const turns = store.allTurns();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "user") continue;
    const conversation = convById.get(t.conversationId);
    if (!conversation) continue;
    // The answer is the next assistant turn in the same conversation.
    let answer: Turn | undefined;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].conversationId !== t.conversationId) continue;
      if (turns[j].role === "assistant") answer = turns[j];
      break;
    }
    out.push({ conversation, question: t, answer });
  }
  return out;
}

function docText(e: Exchange): { strong: string[]; weak: string[] } {
  const facts = (e.answer?.facts ?? []).map((f) => `${f.subject} ${f.attribute} ${f.value}`).join(" ");
  return {
    // Question, title and extracted facts describe what the exchange is *about*.
    strong: tokenize(
      `${e.question.text} ${e.conversation.title} ${facts} ${(e.answer?.entities ?? []).join(" ")} ${(e.answer?.decisions ?? []).join(" ")}`,
    ),
    weak: tokenize(e.answer?.text ?? ""),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [truncated]`;
}

export function recall(
  store: Store,
  q: RecallQuery,
  tz: string,
  opts: { currentConversationId?: string; excludeTurnIds?: Set<string> } = {},
): RecallResult {
  const all = exchanges(store).filter((e) => !opts.excludeTurnIds?.has(e.question.id));
  const dateOf = (e: Exchange) => localDate(new Date(e.question.at), tz);

  let pool = all.filter((e) => {
    const d = dateOf(e);
    return (!q.from || d >= q.from) && (!q.to || d <= q.to);
  });

  const qTerms = [...new Set(tokenize(q.query ?? ""))];
  let scored = pool.map((e) => ({ e, score: 0 }));

  if (qTerms.length) {
    const docs = pool.map(docText);
    const N = docs.length || 1;
    const df = new Map<string, number>();
    for (const term of qTerms) {
      df.set(term, docs.filter((d) => d.strong.some((w) => sameWord(w, term)) || d.weak.some((w) => sameWord(w, term))).length);
    }
    scored = pool.map((e, i) => {
      const d = docs[i];
      let score = 0;
      for (const term of qTerms) {
        const hit = (w: string) => sameWord(w, term);
        const tfStrong = d.strong.filter(hit).length;
        const tfWeak = d.weak.filter(hit).length;
        if (!tfStrong && !tfWeak) continue;
        const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        const tf = 2 * tfStrong + Math.min(tfWeak, 5) * 0.5;
        score += idf * ((tf * 2.2) / (tf + 1.2));
      }
      return { e, score };
    });
    // With a date range, topic only re-ranks (the date is the hard constraint).
    // Without one, topic is the filter.
    if (!q.from && !q.to) scored = scored.filter((s) => s.score > 0);
  }

  scored.sort((a, b) => b.score - a.score || b.e.question.at.localeCompare(a.e.question.at));
  const limit = Math.min(Math.max(q.limit ?? 8, 1), 20);

  const matches: RecallHit[] = scored.slice(0, limit).map(({ e }) => ({
    when: humanDateTime(new Date(e.question.at), tz),
    date: dateOf(e),
    conversation: e.conversation.title,
    in_current_conversation: e.conversation.id === opts.currentConversationId,
    you_asked: e.question.text,
    i_answered: truncate(e.answer?.text ?? "(no answer was recorded)", 2500),
    about: e.answer?.entities?.length ? e.answer.entities : undefined,
    user_decisions: e.answer?.decisions?.length ? e.answer.decisions : undefined,
    facts_stated: e.answer?.facts?.length ? e.answer.facts : undefined,
    sources: e.answer?.sources?.length ? e.answer.sources.slice(0, 6) : undefined,
  }));

  const days = [...new Set(all.map(dateOf))].sort();
  return {
    matches,
    total_matches: scored.length,
    memory_overview: {
      total_past_questions: all.length,
      earliest: all.length ? humanDateTime(new Date(all[0].question.at), tz) : null,
      latest: all.length ? humanDateTime(new Date(all[all.length - 1].question.at), tz) : null,
      days_with_conversations: days.slice(-30),
    },
  };
}

/** Compact index of past conversations, shown to the model every turn. */
export function memoryDigest(store: Store, tz: string, currentConversationId: string, max = 15): string {
  const convs = store.listConversations().filter((c) => c.id !== currentConversationId);
  const withTurns = convs
    .map((c) => ({ c, n: store.turns(c.id).filter((t) => t.role === "user").length }))
    .filter((x) => x.n > 0);
  if (!withTurns.length) {
    return "Memory: there are NO previous conversations with this user. Anything they say you discussed before did not happen with you (or was before memory existed).";
  }
  const lines = withTurns
    .slice(0, max)
    .map(({ c, n }) => `- ${humanDateTime(new Date(c.createdAt), tz)}: "${c.title}" (${n} question${n > 1 ? "s" : ""})`);
  const more = withTurns.length > max ? `\n- …and ${withTurns.length - max} older conversations (use recall_memory)` : "";
  return `Memory: ${withTurns.length} previous conversation(s), most recent first:\n${lines.join("\n")}${more}`;
}

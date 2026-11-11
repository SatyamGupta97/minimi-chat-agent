import { config } from "./config.ts";
import { extractFacts } from "./extract.ts";
import { lookupMemory } from "./memory-context.ts";
import { SYSTEM_PROMPT, turnContext } from "./prompt.ts";
import type { HistoryItem, Provider, TurnSetup } from "./providers/types.ts";
import { memoryDigest, userProfile } from "./recall.ts";
import type { Source, Store, Turn, TurnStatus } from "./store.ts";
import { humanDateTime, temporalContext } from "./time.ts";

/** Events streamed to the UI (and printed by the CLI). */
export type AgentEvent =
  | { type: "meta"; conversationId: string; title: string }
  | { type: "status"; kind: "search"; query: string }
  | { type: "status"; kind: "recall"; detail: string; args: unknown }
  | { type: "text"; text: string }
  /** Authoritative full answer (with citation markers placed); replaces the streamed text. */
  | { type: "final"; text: string }
  | { type: "sources"; cited: Source[]; retrieved: Source[] }
  /** Vendor search UI that must be shown with grounded answers (Gemini only). */
  | { type: "suggestions"; html: string }
  | { type: "done"; turnId: string; status: TurnStatus; ms: number; searches: number }
  /** retryAfterMs is set when the vendor rate-limited the request. */
  | { type: "error"; message: string; retryAfterMs?: number };

export interface TurnInput {
  conversationId?: string;
  message: string;
  tz: string;
  /** Override the clock (used by evals to run against backdated history). */
  now?: Date;
  signal?: AbortSignal;
}

const MAX_EXTRACTION_ATTEMPTS = 3;

const INTERRUPTED_NOTE: Record<Exclude<TurnStatus, "completed">, string> = {
  incomplete: "(My previous answer was cut off before it finished.)",
  failed: "(My previous answer failed with an error before it finished.)",
  cancelled: "(The user stopped my previous answer before it finished.)",
};

/**
 * Prior turns of the current conversation, replayed as plain text.
 *
 * Raw search results and reasoning from earlier turns are NOT replayed: they're
 * large, stale by the next turn, and only needed within the turn that produced
 * them. Each completed answer keeps the sources it cited so follow-ups can refer
 * to them; an answer that didn't complete is replaced by a note, so a half-answer
 * is never treated as something the assistant stands behind. Each user turn
 * carries the time it was sent, so "since then" in a chat resumed three days
 * later means three days.
 */
function history(turns: Turn[], tz: string): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const t of turns.slice(-config.historyTurns)) {
    if (t.role === "user") out.push({ role: "user", text: `[sent ${humanDateTime(new Date(t.at), t.tz || tz)}]\n${t.text}` });
    else if (t.status && t.status !== "completed") out.push({ role: "assistant", text: INTERRUPTED_NOTE[t.status] });
    else if (t.text.trim()) {
      const src = (t.sources ?? []).slice(0, 8).map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`);
      out.push({ role: "assistant", text: t.text + (src.length ? `\n\nSources:\n${src.join("\n")}` : "") });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export class Agent {
  constructor(
    private provider: Provider,
    private store: Store,
    /** `extract: false` skips background fact extraction (evals don't grade it; saves tokens). */
    private options: { extract?: boolean } = {},
  ) {}

  async runTurn(input: TurnInput, emit: (e: AgentEvent) => void): Promise<void> {
    const started = Date.now();
    const now = input.now ?? new Date();
    const tz = input.tz;

    let conv = input.conversationId ? this.store.getConversation(input.conversationId) : undefined;
    const isNew = !conv;
    conv ??= this.store.createConversation(now, input.message.slice(0, 60));
    const convId = conv.id;
    emit({ type: "meta", conversationId: convId, title: conv.title });

    const prior = this.store.turns(convId);
    // Persist the question first: it's part of memory even if the answer fails.
    const userTurn = this.store.addTurn({ conversationId: convId, role: "user", text: input.message, at: now.toISOString(), tz });

    const cited: Source[] = []; // in order of first citation; index+1 = marker number
    const read = new Map<string, Source>(); // every page searched or opened, by URL
    const searches: string[] = [];
    let answer = ""; // authoritative text, with citation markers
    let suggestions = "";
    let status: TurnStatus = "incomplete"; // proven "completed" only by a clean stop
    let note = "";

    // Memory is looked up by the app, before the model runs (web search is the model's only tool).
    const memory = lookupMemory(this.store, input.message, now, tz, { currentConversationId: convId, excludeTurnIds: new Set([userTurn.id]) });
    for (const q of memory.queries) emit({ type: "status", kind: "recall", detail: describeRecall(q), args: q });

    const setup: TurnSetup = {
      system: SYSTEM_PROMPT,
      history: history(prior, tz),
      context: turnContext(temporalContext(now, tz), userProfile(this.store), memoryDigest(this.store, tz, convId), memory.text),
      message: `[sent ${humanDateTime(now, tz)}]\n${input.message}`,
      citations: {
        cite(s) {
          let i = cited.findIndex((c) => c.url === s.url);
          if (i < 0) i = cited.push(read.get(s.url) ?? s) - 1;
          return i + 1;
        },
      },
      sink: {
        text: (t) => emit({ type: "text", text: t }),
        search: (q) => {
          if (searches.includes(q)) return;
          searches.push(q);
          emit({ type: "status", kind: "search", query: q });
        },
        read: (s) => void (read.has(s.url) || read.set(s.url, s)),
        suggestions: (html) => void (suggestions = html),
      },
    };

    try {
      const missing = this.provider.missingConfig();
      if (missing) throw new Error(missing);
      const step = await this.provider.answer(setup, input.signal);
      answer = step.text;
      if (step.finish === "stop") status = answer.trim() ? "completed" : "incomplete";
      else if (step.finish === "length") note = "\n\n_(Cut off at the length limit. Ask me to continue.)_";
      else if (step.finish === "blocked" && !answer.trim()) answer = "Sorry, I can't help with that one.";
      else if (step.finish === "other") note = "\n\n_(The answer ended unexpectedly and may be incomplete.)_";
    } catch (err) {
      if (input.signal?.aborted) {
        status = "cancelled";
        note = "\n\n_(stopped)_";
      } else {
        status = "failed";
        emit({ type: "error", message: this.errorMessage(err), retryAfterMs: this.provider.retryAfterMs?.(err) });
      }
    }

    answer += note;
    emit({ type: "final", text: answer });

    // Only what the answer cited counts as evidence; what was merely read is kept apart.
    const citedUrls = new Set(cited.map((s) => s.url));
    const retrieved = [...read.values()].filter((s) => !citedUrls.has(s.url)).slice(0, 10);
    if (cited.length || retrieved.length) emit({ type: "sources", cited, retrieved });
    if (suggestions) emit({ type: "suggestions", html: suggestions });

    const assistantTurn = this.store.addTurn({
      conversationId: convId,
      role: "assistant",
      replyTo: userTurn.id,
      status,
      text: answer,
      at: new Date(now.getTime() + (Date.now() - started)).toISOString(),
      tz,
      sources: cited,
      retrieved,
      searches,
      searchSuggestions: suggestions || undefined,
      // Only completed answers become baselines for "has anything changed?".
      extraction: status === "completed" ? "pending" : undefined,
    });
    emit({ type: "done", turnId: assistantTurn.id, status, ms: Date.now() - started, searches: searches.length });

    // Off the latency path: distill facts for future "has it changed?" questions.
    if (assistantTurn.extraction === "pending" && this.options.extract !== false) void this.extract(assistantTurn.id, isNew);
  }

  /**
   * Extract facts for one answer. The pending state is persisted before this
   * runs, so a crash or restart mid-extraction is recovered by
   * recoverPendingExtractions() on the next start.
   */
  async extract(turnId: string, setTitle = false): Promise<void> {
    const turn = this.store.allTurns().find((t) => t.id === turnId);
    const question = turn?.replyTo ? this.store.allTurns().find((t) => t.id === turn.replyTo) : undefined;
    if (!turn || !question) return;
    const attempts = (turn.extractionAttempts ?? 0) + 1;
    try {
      const x = await extractFacts(this.provider, question.text, turn.text, turn.sources ?? []);
      this.store.updateTurn(turnId, { facts: x.facts, entities: x.entities, decisions: x.decisions, aboutUser: x.aboutUser, extraction: "done", extractionAttempts: attempts });
      const conv = this.store.getConversation(turn.conversationId);
      if (x.title && conv && (setTitle || conv.title === question.text.slice(0, 60))) this.store.setTitle(conv.id, x.title);
    } catch (e) {
      const giveUp = attempts >= MAX_EXTRACTION_ATTEMPTS;
      this.store.updateTurn(turnId, { extraction: giveUp ? "failed" : "pending", extractionAttempts: attempts });
      console.warn(`[extract] attempt ${attempts} failed${giveUp ? " (giving up)" : ""}:`, this.errorMessage(e));
    }
  }

  /** Resume extraction work interrupted by a restart. Sequential: it's background work. */
  async recoverPendingExtractions(): Promise<{ attempted: number; succeeded: number }> {
    const pending = this.store.allTurns().filter((t) => t.extraction === "pending").map((t) => t.id);
    for (const id of pending) await this.extract(id);
    const succeeded = pending.filter((id) => this.store.allTurns().find((t) => t.id === id)?.extraction === "done").length;
    return { attempted: pending.length, succeeded };
  }

  errorMessage(err: unknown): string {
    return this.provider.describeError(err) ?? (err instanceof Error ? err.message : String(err));
  }
}

function describeRecall(q: { phrase?: string; from?: string; to?: string }): string {
  if (!q.from && !q.to) return "past conversations on this topic";
  const range = q.from === q.to ? (q.from ?? "") : `${q.from ?? "…"} → ${q.to ?? "…"}`;
  return q.phrase ? `"${q.phrase}" → ${range}` : range;
}

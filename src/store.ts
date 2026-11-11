import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable, time-indexed memory of every conversation.
 *
 * Assumes ONE server process owns the file (the app's deployment model). Within
 * that process every mutation is a synchronous write, so writes are serialized
 * by construction; there is no cross-process locking.
 *
 * A single JSON file is deliberate: one local user, thousands of turns at most,
 * zero native dependencies, and `npm install && npm run dev` works on any Node.
 * Writes are atomic (temp file + rename) so a crash can't corrupt history.
 * The interface is narrow enough to swap for SQLite/Postgres without touching
 * the agent.
 */

export interface Source {
  url: string;
  title: string;
  /** Publication/update age as reported by the search engine, e.g. "3 days ago". */
  pageAge?: string | null;
}

/** A checkable claim from an answer, e.g. {Neon, "Launch plan price", "$19/mo"}. */
export interface Fact {
  subject: string;
  attribute: string;
  value: string;
  /** Date the source says the fact applies from, if stated. */
  asOf?: string | null;
  sourceUrl?: string | null;
}

export type TurnStatus =
  /** The model finished its answer normally. Only these become trusted baselines. */
  | "completed"
  /** Cut off: length limit, step limit, or a refusal. */
  | "incomplete"
  /** An error (API, network) ended the turn. */
  | "failed"
  /** The user pressed stop. */
  | "cancelled";

export interface Turn {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant turns: the user turn this answers (explicit, never inferred from order). */
  replyTo?: string;
  /** True when replyTo was inferred from order during the v1 -> v2 migration rather than recorded. */
  replyToInferred?: boolean;
  /** Assistant turns only. */
  status?: TurnStatus;
  /** ISO-8601 instant. */
  at: string;
  /** IANA timezone the user was in when the turn happened. */
  tz: string;
  /** Sources the answer actually cited. These are evidence. */
  sources?: Source[];
  /** Pages the search returned but the answer did not cite. Context only, not evidence. */
  retrieved?: Source[];
  searches?: string[];
  /** Google Search Suggestions HTML shown with a grounded answer (required by the Search grounding terms). */
  searchSuggestions?: string;
  facts?: Fact[];
  /** Products/companies/things the exchange was about, e.g. ["Neon", "Supabase"]. */
  entities?: string[];
  /** What the user decided or told us, e.g. "Shortlisted HubSpot, Pipedrive, ... for a 20-person sales team". */
  decisions?: string[];
  /** Background fact extraction state; "pending" is retried on startup. */
  extraction?: "pending" | "done" | "failed";
  extractionAttempts?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const VERSION = 2;

interface DB {
  version: typeof VERSION;
  conversations: Conversation[];
  turns: Turn[];
}

/** The memory file exists but can't be read as memory. Never overwritten automatically. */
export class CorruptMemoryError extends Error {}

/**
 * v1 (first release) had no replyTo or status on assistant turns. Link each
 * answer to the user turn just before it in the same conversation, but only
 * when that pairing is unambiguous (exactly one unanswered question waiting),
 * and mark it as inferred. Status is derived from the old error marker.
 */
export function migrateV1(db: { conversations: Conversation[]; turns: Turn[] }): DB {
  const waiting = new Map<string, Turn[]>(); // conversationId -> unanswered user turns
  for (const t of db.turns) {
    if (t.role === "user") {
      waiting.set(t.conversationId, [...(waiting.get(t.conversationId) ?? []), t]);
      continue;
    }
    const open = waiting.get(t.conversationId) ?? [];
    if (!t.replyTo && open.length === 1) {
      t.replyTo = open[0].id;
      t.replyToInferred = true;
    }
    waiting.set(t.conversationId, []);
    if (!t.status) t.status = !t.text.trim() || t.text.startsWith("_(error") ? "failed" : "completed";
    // v1 extraction had no persisted state; mark done if it produced anything, else leave unextracted.
    if (!t.extraction && (t.facts || t.entities)) t.extraction = "done";
  }
  return { version: VERSION, conversations: db.conversations, turns: db.turns };
}

export class Store {
  private db: DB;

  constructor(private file: string) {
    this.db = Store.load(file);
  }

  /**
   * A missing file means "no memory yet". Anything else that fails to load
   * (bad JSON, unknown version) stops startup with the file untouched: silently
   * starting empty would overwrite the user's history on the next write.
   */
  private static load(file: string): DB {
    if (!existsSync(file)) return { version: VERSION, conversations: [], turns: [] };
    let raw: { version?: number; conversations?: Conversation[]; turns?: Turn[] };
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new CorruptMemoryError(`Memory file ${file} is not valid JSON (${(e as Error).message}). It was left untouched; fix or move it, then restart.`);
    }
    if (!Array.isArray(raw?.conversations) || !Array.isArray(raw?.turns)) {
      throw new CorruptMemoryError(`Memory file ${file} doesn't look like a memory file. It was left untouched.`);
    }
    if (raw.version === VERSION) return raw as DB;
    if (raw.version === 1) {
      copyFileSync(file, `${file}.v1.bak`); // keep the original before rewriting
      const db = migrateV1({ conversations: raw.conversations, turns: raw.turns });
      Store.write(file, db);
      return db;
    }
    throw new CorruptMemoryError(`Memory file ${file} has unknown version ${raw.version}. It was left untouched.`);
  }

  private static write(file: string, db: DB): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, file);
  }

  private save(): void {
    Store.write(this.file, this.db);
  }

  listConversations(): Conversation[] {
    return [...this.db.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConversation(id: string): Conversation | undefined {
    return this.db.conversations.find((c) => c.id === id);
  }

  createConversation(now: Date, title = "New chat"): Conversation {
    const c: Conversation = {
      id: randomUUID(),
      title,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.db.conversations.push(c);
    this.save();
    return c;
  }

  setTitle(id: string, title: string): void {
    const c = this.getConversation(id);
    if (!c) return;
    c.title = title;
    this.save();
  }

  turns(conversationId: string): Turn[] {
    return this.db.turns.filter((t) => t.conversationId === conversationId);
  }

  allTurns(): readonly Turn[] {
    return this.db.turns;
  }

  addTurn(turn: Omit<Turn, "id">): Turn {
    const t: Turn = { id: randomUUID(), ...turn };
    this.db.turns.push(t);
    const c = this.getConversation(turn.conversationId);
    if (c && c.updatedAt < turn.at) c.updatedAt = turn.at;
    this.save();
    return t;
  }

  updateTurn(id: string, patch: Partial<Pick<Turn, "facts" | "entities" | "decisions" | "extraction" | "extractionAttempts">>): void {
    const t = this.db.turns.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    this.save();
  }

  deleteConversation(id: string): void {
    this.db.conversations = this.db.conversations.filter((c) => c.id !== id);
    this.db.turns = this.db.turns.filter((t) => t.conversationId !== id);
    this.save();
  }
}

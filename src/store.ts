import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

interface DB {
  version: 1;
  conversations: Conversation[];
  turns: Turn[];
}

export class Store {
  private db: DB;

  constructor(private file: string) {
    this.db = Store.load(file);
  }

  private static load(file: string): DB {
    try {
      const db = JSON.parse(readFileSync(file, "utf8")) as DB;
      if (db.version === 1) return db;
    } catch {
      /* missing or unreadable: start fresh */
    }
    return { version: 1, conversations: [], turns: [] };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.file);
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

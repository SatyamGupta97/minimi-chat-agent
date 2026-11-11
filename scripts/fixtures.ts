/**
 * Synthetic past conversations with KNOWN content, used by `npm run seed`
 * (demo) and `npm run eval` (grading). Values are illustrative, chosen so a
 * later re-check has a fixed baseline to compare against. They are never
 * presented as real research: each answer says it is synthetic, so the agent
 * sees the label whenever it recalls one.
 */
import type { Fact, Source, Store } from "../src/store.ts";

export const SYNTHETIC_NOTE = "(Synthetic demo history: the values below are illustrative fixtures, not researched prices.)";

export interface Fixture {
  at: Date;
  question: string;
  answer: string;
  sources?: Source[];
  facts?: Fact[];
  entities?: string[];
  decisions?: string[];
}

/** Local-calendar arithmetic (setDate), so DST never skips or repeats a day. */
export function daysAgo(n: number, from = new Date(), hour = 11): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Most recent past `weekday` (0 = Sunday) strictly before `from`'s local date. */
export function lastWeekday(weekday: number, from = new Date(), hour = 11): Date {
  for (let n = 1; n <= 7; n++) {
    const d = daysAgo(n, from, hour);
    if (d.getDay() === weekday) return d;
  }
  throw new Error("unreachable");
}

export const POSTGRES: Omit<Fixture, "at"> = {
  question: "What are the main managed Postgres hosting options and what do the entry-level paid plans cost?",
  answer: `${SYNTHETIC_NOTE}\n\nNeon Launch: $19/mo [1]. Supabase Pro: $25/mo [2]. AWS RDS: usage-based, no fixed entry plan.`,
  sources: [
    { url: "https://neon.com/pricing", title: "neon.com" },
    { url: "https://supabase.com/pricing", title: "supabase.com" },
  ],
  // Render is discussed but no price was stated: an unknown baseline.
  entities: ["Neon", "Supabase", "AWS RDS", "Render"],
  facts: [
    { subject: "Neon", attribute: "Launch plan price", value: "$19/mo", sourceUrl: "https://neon.com/pricing" },
    { subject: "Supabase", attribute: "Pro plan price", value: "$25/mo", sourceUrl: "https://supabase.com/pricing" },
  ],
};

export const CRMS = ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Attio"];
export const CRM: Omit<Fixture, "at"> = {
  question: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing.",
  answer: `${SYNTHETIC_NOTE}\n\nShortlist: HubSpot Sales Hub Pro ($90/seat/mo), Pipedrive Growth ($49/seat/mo), Salesforce Sales Cloud Enterprise ($165/seat/mo), Zoho CRM Professional ($35/seat/mo), Attio Pro ($59/seat/mo).`,
  entities: CRMS,
  decisions: ["Shortlisted HubSpot, Pipedrive, Salesforce, Zoho CRM and Attio for a 20-person sales team"],
  facts: [
    { subject: "HubSpot", attribute: "Sales Hub Pro per-seat price", value: "$90/seat/mo" },
    { subject: "Pipedrive", attribute: "Growth per-seat price", value: "$49/seat/mo" },
    { subject: "Salesforce", attribute: "Sales Cloud Enterprise per-seat price", value: "$165/seat/mo" },
    { subject: "Zoho CRM", attribute: "Professional per-seat price", value: "$35/seat/mo" },
    { subject: "Attio", attribute: "Pro per-seat price", value: "$59/seat/mo" },
  ],
};

/** A fact that cannot have changed: a re-check must report "unchanged", not invent news. */
export const STABLE: Omit<Fixture, "at"> = {
  question: "When did Python 2 reach end of life?",
  answer: "Python 2 reached end of life on 1 January 2020; the final release, 2.7.18, came out in April 2020.",
  entities: ["Python 2"],
  facts: [
    { subject: "Python 2", attribute: "end-of-life date", value: "1 January 2020" },
    { subject: "Python 2", attribute: "final release", value: "2.7.18 (April 2020)" },
  ],
};

export function seedFixture(store: Store, f: Fixture, tz: string): void {
  const c = store.createConversation(f.at, f.question.slice(0, 50));
  const at = f.at.toISOString();
  const q = store.addTurn({ conversationId: c.id, role: "user", text: f.question, at, tz });
  store.addTurn({
    conversationId: c.id, role: "assistant", replyTo: q.id, status: "completed", text: f.answer, at, tz,
    sources: f.sources ?? [], facts: f.facts ?? [], entities: f.entities ?? [], decisions: f.decisions ?? [], extraction: "done",
  });
}

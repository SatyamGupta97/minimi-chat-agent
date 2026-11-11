import { type GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { config } from "./config.ts";
import type { Fact, Source } from "./store.ts";

/**
 * After each answer, a small fast model distills it into checkable facts
 * ({subject, attribute, value, as_of, source}). Runs in the background, off the
 * latency path. Later, "has anything changed since?" becomes a per-fact diff
 * against fresh search results instead of a vague re-read of an old essay.
 */

const Extraction = z.object({
  title: z.string().describe("3-6 word title for the conversation topic, no quotes, no trailing period"),
  entities: z
    .array(z.string())
    .describe("Every specific product, company, service, person or place the exchange is about, canonical names, e.g. ['Neon', 'Supabase', 'AWS RDS']"),
  decisions: z
    .array(z.string())
    .describe(
      "Context the user stated or decided that a future conversation would need, as self-contained sentences: shortlists, choices, constraints, team size, budget, preferences. E.g. 'Shortlisted HubSpot, Pipedrive, Close, Attio and Zoho CRM for a 20-person sales team'. Empty if none.",
    ),
  facts: z
    .array(
      z.object({
        subject: z.string().describe("The product, company, person or thing, e.g. 'Neon'"),
        attribute: z.string().describe("What about it, e.g. 'Launch plan price'"),
        value: z.string().describe("The stated value, verbatim where possible, e.g. '$19/month'"),
        as_of: z.string().nullable().describe("Date the fact applies from if the answer states one, else null"),
        source: z.string().nullable().describe("Title/domain of the numbered source the answer cited for this fact, else null"),
      }),
    )
    .describe("Time-sensitive, verifiable claims made in the answer (prices, limits, features, releases, dates, versions). Empty if none."),
});

const SCHEMA = z.toJSONSchema(Extraction);

export async function extractFacts(
  client: GoogleGenAI,
  question: string,
  answer: string,
  sources: Source[],
): Promise<{ title: string; facts: Fact[]; entities: string[]; decisions: string[] }> {
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n");
  const res = await client.models.generateContent({
    model: config.extractModel,
    contents: `Extract a short title, the entities discussed, the user's decisions/context, and the verifiable, time-sensitive facts from this exchange. Only include claims the answer actually makes. Citation markers like [2] refer to the numbered sources.\n\n<question>\n${question}\n</question>\n\n<answer>\n${answer}\n</answer>\n\n<sources>\n${sourceList || "(none)"}\n</sources>`,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  });
  // Validate: the schema constrains generation, zod guards what we store.
  const out = Extraction.parse(JSON.parse(res.text ?? ""));
  const urlFor = (n: string | null) => sources.find((s) => n && (s.title === n || s.url === n))?.url ?? null;
  return {
    title: out.title.trim().slice(0, 80),
    entities: out.entities.slice(0, 30),
    decisions: out.decisions.slice(0, 10),
    facts: out.facts.slice(0, 40).map((f) => ({
      subject: f.subject,
      attribute: f.attribute,
      value: f.value,
      asOf: f.as_of,
      sourceUrl: urlFor(f.source) ?? f.source,
    })),
  };
}

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
        source_url: z.string().nullable().describe("URL the answer cited for this fact, else null"),
      }),
    )
    .describe("Time-sensitive, verifiable claims made in the answer (prices, limits, features, releases, dates, versions). Empty if none."),
});

export async function extractFacts(
  client: Anthropic,
  question: string,
  answer: string,
  sources: Source[],
): Promise<{ title: string; facts: Fact[]; entities: string[]; decisions: string[] } | null> {
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n");
  const res = await client.messages.parse({
    model: config.extractModel,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(Extraction), effort: "low" },
    messages: [
      {
        role: "user",
        content: `Extract a short title, the entities discussed, the user's decisions/context, and the verifiable, time-sensitive facts from this exchange. Only include claims the answer actually makes. Citation markers like [2] refer to the numbered sources.\n\n<question>\n${question}\n</question>\n\n<answer>\n${answer}\n</answer>\n\n<sources>\n${sourceList || "(none)"}\n</sources>`,
      },
    ],
  });
  const out = res.parsed_output;
  if (!out) return null;
  return {
    title: out.title.trim().slice(0, 80),
    entities: out.entities.slice(0, 30),
    decisions: out.decisions.slice(0, 10),
    facts: out.facts.slice(0, 40).map((f) => ({
      subject: f.subject,
      attribute: f.attribute,
      value: f.value,
      asOf: f.as_of,
      sourceUrl: f.source_url,
    })),
  };
}

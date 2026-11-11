/**
 * OPTIONAL: add labelled, synthetic past conversations so the memory features
 * can be tried immediately, e.g.
 *   "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
 *   "On Monday we shortlisted 5 CRM tools... has any of them changed pricing since?"
 *
 * Nothing here is researched, and nothing pretends to be. The values are fixed
 * fixtures and each stored answer says it is synthetic, so the agent will say
 * so too. (An earlier version asked the live agent and backdated its answers.
 * That filed today's prices under last week's date, which is exactly the kind
 * of false baseline this project exists to avoid.)
 *
 *   npm run seed     # no API calls
 */
import { config } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { CRM, lastWeekday, POSTGRES, seedFixture } from "./fixtures.ts";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const store = new Store(config.dataFile);
const items = [
  { id: "seed-postgres", at: lastWeekday(2), ...POSTGRES },
  { id: "seed-crm", at: lastWeekday(1, new Date(), 15), ...CRM },
];
let added = 0;
for (const { id, ...f } of items) {
  const ok = seedFixture(store, f, tz, id);
  added += Number(ok);
  console.log(`  ${ok ? "+" : "="} ${f.at.toDateString()}: ${f.question}${ok ? "" : " (already seeded)"}`);
}
console.log(`\n${added} synthetic conversation(s) added to ${config.dataFile}. Start the app with \`npm run dev\`.`);

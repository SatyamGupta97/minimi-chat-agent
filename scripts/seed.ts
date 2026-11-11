/**
 * OPTIONAL: create backdated history so the memory features can be tried
 * immediately, e.g. "Last Tuesday I asked you about Postgres hosting. Has any
 * pricing changed since then?"
 *
 * This doesn't write made-up answers. It asks the real agent real questions
 * with the clock set back, so the stored answers are genuine search results
 * (from today) filed under past dates. Costs a few API calls.
 *
 *   npm run seed
 */
import { Agent } from "../src/agent.ts";
import { config, createClient } from "../src/config.ts";
import { Store } from "../src/store.ts";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY = 86_400_000;

/** Most recent past `weekday` (0=Sun) strictly before today, at `hour` local-ish. */
function lastWeekday(weekday: number, hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  do d.setTime(d.getTime() - DAY);
  while (d.getDay() !== weekday);
  return d;
}

const seeds = [
  { at: lastWeekday(2, 11), q: "What are the main managed Postgres hosting options (Neon, Supabase, AWS RDS, Render, Railway) and what do their entry-level paid plans cost?" },
  { at: lastWeekday(1, 15), q: "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing." },
];

const agent = new Agent(createClient(), new Store(config.dataFile));
for (const s of seeds) {
  console.log(`\n▶ [${s.at.toDateString()}] ${s.q}`);
  await agent.runTurn({ message: s.q, tz, now: s.at }, (e) => {
    if (e.type === "status" && e.kind === "search") console.log(`  search: ${e.query}`);
    if (e.type === "error") console.error(`  error: ${e.message}`);
    if (e.type === "done") console.log(`  done in ${(e.ms / 1000).toFixed(1)}s`);
  });
}
console.log("\nWaiting for background fact extraction…");
await new Promise((r) => setTimeout(r, 15000));
console.log("Seeded. Start the app with `npm run dev`.");

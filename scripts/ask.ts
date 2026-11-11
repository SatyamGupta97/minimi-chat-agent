/**
 * Terminal client: `npm run ask -- "your question"` (add --c <conversationId> to continue one).
 * Shares the same memory file as the web UI.
 */
import { Agent } from "../src/agent.ts";
import { config } from "../src/config.ts";
import { createProvider } from "../src/providers/index.ts";
import { Store } from "../src/store.ts";

const args = process.argv.slice(2);
const ci = args.indexOf("--c");
const conversationId = ci >= 0 ? args.splice(ci, 2)[1] : undefined;
const message = args.join(" ").trim();
if (!message) {
  console.error('usage: npm run ask -- "question" [--c conversationId]');
  process.exit(1);
}

const agent = new Agent(createProvider(), new Store(config.dataFile));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
await agent.runTurn({ conversationId, message, tz }, (e) => {
  if (e.type === "final") process.stdout.write(`${e.text}\n`);
  else if (e.type === "status" && e.kind === "search") process.stderr.write(`\x1b[2m[search] ${e.query}\x1b[0m\n`);
  else if (e.type === "status" && e.kind === "recall") process.stderr.write(`\x1b[2m[memory] ${e.detail}\x1b[0m\n`);
  else if (e.type === "sources") e.cited.forEach((s, i) => process.stdout.write(`${i === 0 ? "\n\n" : ""}[${i + 1}] ${s.title} - ${s.url}\n`));
  else if (e.type === "error") process.stderr.write(`\n[error] ${e.message}\n`);
  else if (e.type === "done") process.stderr.write(`\x1b[2m\n(${e.status}, ${(e.ms / 1000).toFixed(1)}s, ${e.searches} searches)\x1b[0m\n`);
  else if (e.type === "meta") process.stderr.write(`\x1b[2m[conversation ${e.conversationId}]\x1b[0m\n`);
});
// Give the background fact extraction a moment to finish before exiting.
await new Promise((r) => setTimeout(r, 8000));

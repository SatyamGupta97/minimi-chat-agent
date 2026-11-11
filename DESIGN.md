# Design

**One tool-using research agent, with deterministic temporal memory, asynchronous fact extraction, and per-claim comparison against the past. It runs on Groq (`gpt-oss-120b` + built-in browser search) or Gemini (Google Search grounding) behind one small adapter interface.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (it is memory even if the answer fails)
  2. contents = earlier turns as text, each stamped "[sent <time>]"
              + new message, prefixed by an app <context> block: clock, 21-day calendar, index of past chats
  3. stream the model with its built-in web search + recall_memory (local function: date range + topic)
  4. stream text and "Searching: …"; the adapter turns the vendor's citations into stable [n] markers
     (Groq 【cursor†Lx-Ly】 → the exact search result behind those lines; Gemini groundingSupports)
  5. save the answer: status, replyTo, cited sources (evidence) apart from pages it only read
  6. background: a small model extracts {title, entities, user decisions, facts}; retried after a restart
```

## Why

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November? Is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **No date arithmetic in the model.** It looks dates up in a calendar built from local calendar dates, which the tests show stays correct across DST changes.
- **The model reads the fuzzy part; the code does the exact part.** The model turns "last Tuesday" or "the CRM shortlist" into `from`/`to`/`query`. The code applies a hard date filter and BM25-style ranking over the question, entities, user decisions and facts. When nothing matches, it still reports what memory does hold, so the agent says "nothing on 3 Nov; my first chat with you is 9 Nov" instead of inventing one.
- **Prove change, don't narrate it.** Facts are extracted when a turn is saved, so "has pricing changed?" becomes a per-claim diff: the stored value against a cited current value. No change is reported without both sides, a missing baseline is reported as unknown, and a page's publish date is not the date a change took effect.
- **Only finished, cited answers are evidence.** Answers carry `completed | incomplete | failed | cancelled`, and only completed ones become baselines. Answers link to their question by `replyTo`, never by position. Old v1 data is migrated, and pairings that couldn't be recovered are marked `inferred`.
- **Fast.** The first token comes from the one call that does the work. Both vendors run search server-side inside that call alongside our function tool, so search costs no extra round trip. On Groq a searched answer typically takes 8–25 s, and the first token arrives in under a second. Extraction runs after the reply. Per-turn context sits only in the newest message, so the prefix stays cacheable.
- **Vendor-neutral core.** Vendor SDKs are imported only in `src/providers/`. The `Provider` interface is small: one streamed step, tool results, a JSON call, and error text. Each adapter maps its vendor's citation format onto the same `[n]` + `Source` records, so stored memory doesn't depend on the vendor. Memory, recall, statuses, evidence rules and evals don't change when the vendor does. The remaining assumption is built-in server-side search; a vendor without it would search inside its adapter, at the cost of a round trip. Groq is the default because it works on a free key.

## Considered and rejected

- **An intent → plan → search → evaluate pipeline.** It means 3–5 serial LLM calls before the first token. The single loop already plans, searches in parallel and re-searches when evidence is thin.
- **Postgres + pgvector, React.** They would break "`npm install && npm run dev`, one key" for one user's few thousand turns, and embeddings don't help with the hard constraint, which is dates. Storage is an atomic JSON file and assumes a single process. A corrupt file stops startup instead of being silently reset.
- **Backdated live answers as demo history.** That would file today's prices under last week's date. `npm run seed` writes clearly labelled synthetic fixtures instead.
- **A separate search API plus fetch.** The brief allows one tool, and grounding returns citations natively. The trade-off: Google returns redirect links with the domain as the title, so a source names the site, not the exact page.

## Evaluation

`npm test` runs offline and covers the deterministic parts: timezones and DST, recall, `replyTo` under interleaving, migration, corrupt files, extraction recovery and citation placement.

`npm run eval` runs the test-set patterns against the live model. Each scenario gets its own memory with fixture history. A judge model turns each answer into per-claim records (`entity, historicalValue, currentValue, verdict, evidenceUrls`). The checks then test whether the answer proves its verdicts: the old value matches memory, "changed" has two different values plus evidence, no baseline is invented. They also check that explicit dates resolve exactly and that a false premise gets corrected.

## With another week

1. More eval cases: conflicting sources, announcement vs. release date. Tune thinking level and the prompt against the scores.
2. A fact store with last-verified dates, re-checked in the background.
3. Check each claim against the text of its cited page.
4. Hybrid retrieval on SQLite FTS5, multi-user accounts, editable memory.

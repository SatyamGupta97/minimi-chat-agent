# Design

**A research agent whose only tool is web search, backed by deterministic temporal memory that the app looks up, facts extracted asynchronously, and per-claim comparison against the past. It runs on Groq (`gpt-oss-120b` + browser search) or Gemini (Google Search grounding) behind one small adapter.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (it is memory even if the answer fails)
  2. memory lookup in code: date phrases → exact local date ranges (every reading if ambiguous);
     past references without a date → topic search
  3. stream the model: earlier turns stamped "[sent <time>]" + a <context> block (clock, calendar,
     past-chat index, lookup results) + the message; its one tool is built-in web search
  4. stream text, "Checking memory…", "Searching…"; the adapter maps vendor citations to stable [n]
  5. save the answer: status, replyTo, cited sources (evidence) apart from pages only read
  6. background: a small model extracts {title, entities, user decisions, facts}; retried after restarts
```

## Why

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November? Is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **Memory is the app's job, not a second tool.** The brief allows one tool, so the orchestrator resolves date phrases in code and retrieves before the model runs. The resolver is unit-tested and timezone- and DST-correct; "last Tuesday" said on a Wednesday yields both readings. Retrieval is a hard date filter plus BM25-style ranking over questions, entities, user decisions and facts. This also saves a model round trip per memory question. An empty lookup still reports what memory holds ("nothing on 3 Nov; my first chat with you is 9 Nov"), so nothing gets invented. Trade-off: unknown phrasings ("the week before last") fall back to the past-chat index shown every turn.
- **Prove change, don't narrate it.** Facts are extracted when a turn is saved, so "has pricing changed?" becomes a per-claim diff: the stored value against a value cited today. No change is reported without both sides. A missing baseline is reported as unknown. A page's publish date is not the date a change took effect.
- **Only finished, cited answers are evidence.** Turns are `completed | incomplete | failed | cancelled`. Only an explicit vendor "stop" counts as completed, and only completed answers become baselines. Answers link to their question by `replyTo`, never by position; v1 data is migrated and marks reconstructed pairings `inferred`. An extracted fact keeps a URL only if the answer cited it.
- **Fast.** The first token comes from the one call that does the work. Search runs on the vendor's servers and memory arrives with the request, so neither adds a round trip. Searched answers on Groq take 8–25 s, with the first token in under a second. Per-turn context sits only in the newest message, so the prefix stays cacheable.
- **Vendor-neutral core.** Vendor SDKs are imported only in `src/providers/`. The interface is one streamed answer, one JSON call and error text. Adapters map their citation formats onto the same `[n]` + `Source` records (Groq `【cursor†Lx-Ly】` → the exact search result behind those lines), so stored memory doesn't depend on the vendor. Groq is the default because it works on a free key.

## Considered and rejected

- **Memory as a model-callable tool** (my first version): flexible about phrasing, but a second tool against the brief and an extra round trip.
- **An intent → plan → search → evaluate pipeline:** 3–5 serial LLM calls before the first token. One call already plans, searches in parallel and re-searches when evidence is thin.
- **Postgres + pgvector, React:** they would break "`npm install && npm run dev`, one key" for one user's few thousand turns, and embeddings don't help with the hard constraint (dates). Storage is an atomic JSON file and assumes a single process; a corrupt file stops startup instead of being reset.
- **Backdated live answers as demo data:** they would file today's prices under last week's date. `npm run seed` writes labelled synthetic fixtures instead, idempotently.

## Evaluation

`npm test` runs offline and covers the deterministic parts: date phrases, timezones and DST, the memory lookup, recall, `replyTo` under interleaving, migration, corrupt files, extraction recovery, and both citation formats.

`npm run eval` runs the test-set patterns live, each scenario on fixture history. A judge model turns each answer into per-claim records (`entity, historicalValue, currentValue, verdict, evidenceUrls`). The checks pass only when the verdicts are proven: the old value matches memory, "changed" has two values plus evidence, an unknown baseline is stated explicitly, a stable fact is explicitly confirmed. Explicit dates must resolve exactly, and false premises must be corrected.

## With another week

1. More eval cases (conflicting sources, announcement vs. release date); tune effort and the prompt on the scores.
2. A fact store with last-verified dates, re-checked in the background.
3. Check each claim against the text of its cited page.
4. Embeddings alongside BM25 for paraphrased topic references; SQLite FTS5; multi-user accounts.

# Design

**One tool-using research agent, backed by deterministic temporal memory, asynchronous fact extraction, and source-grounded comparisons with the past.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (it's memory even if the answer fails)
  2. request = frozen system instruction
             + this chat's earlier turns as text, each stamped "[sent <time>]"
             + new message, prefixed by an app <context> block: clock, 21-day calendar, index of past chats
  3. stream Gemini with  Google Search  (built-in grounding; search runs inside the model call)
                         recall_memory  (function call; local, deterministic, ~1 ms: date range + topic)
  4. stream text, citations and "Searching: …" to the UI
  5. save the answer with status, replyTo, cited sources (evidence) and retrieved sources (read only)
  6. background: a small model extracts {title, entities, user decisions, facts}; retried after a restart
```

## Why

**The hard part is memory plus time, not search.** "What did I ask on 3 November, is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **No date arithmetic in the model.** It gets a calendar to look dates up in, built from local calendar dates so it stays correct across DST changes. The tests cover that.
- **The model reads the fuzzy part, the code does the exact part.** The model turns "last Tuesday" or "the CRM shortlist" into `from`/`to`/`query`. The code applies a hard date filter and BM25-style ranking over each question, its title, entities, user decisions and facts. When nothing matches, recall still reports what memory does exist, so the agent says "nothing from 3 Nov; my first chat with you is 9 Nov" instead of inventing one.
- **Facts are extracted when a turn is saved.** "Has pricing changed?" then becomes a per-claim diff: the old value and its source against a fresh search. The prompt sets three rules. No change is reported without both sides. An unknown baseline is reported as unknown. A page's publish date is not the date a change took effect. The extractor also keeps what the *user* decided (the shortlist), so the agent doesn't have to ask again.
- **Only finished, cited answers count as evidence.** Each answer has a status: `completed`, `incomplete`, `failed` or `cancelled`. Only `completed` answers are extracted and trusted as a baseline. A cut-off answer comes back as "(my previous answer was cut off)", never as something the agent said. Cited sources are kept apart from pages the answer only read. Answers link to their question explicitly (`replyTo`), never by position.

**Fast.** The first token comes from the one call that does the work: no router, no planner, no summarizer before the answer. Search runs on Google's side inside the same call: Gemini 3+ can combine built-in Search with function calling (`VALIDATED` mode), so it adds no round trip through this server. Extraction happens after the reply. The system instruction is frozen. Per-turn context sits only in the newest user message, so the prefix stays byte-identical and Gemini's implicit cache can reuse it. Within a turn, the model's parts are passed back verbatim so its thought signatures survive the tool round-trips. Raw grounding results are never replayed into later turns: they're large and already stale. Citations are placed when each response ends, from `groundingSupports` (matched by segment text, then by UTF-8 byte offset). The Google Search Suggestions block is shown with each grounded answer, as the Search terms require, in a sandboxed iframe.

**Good to talk to.** It leads with the answer and uses tables for comparisons. It asks a one-line question only when it can't proceed, and it is honest about what it did and didn't verify.

## Considered and rejected

- **Intent → plan → search → evaluate → synthesize pipeline.** That's 3–5 serial LLM calls before the first token. A strong model in one tool loop already plans, searches in parallel, re-searches when evidence is thin, and stops. I'd add stages only if the evals showed the loop failing.
- **Pre-retrieving memory on every turn.** It wastes tokens and attention on the ~90% of turns that don't refer to the past. The per-turn chat index tells the model when recall is worth calling.
- **Postgres + pgvector, React.** They'd break "`npm install && npm run dev`, one key" and add little for a single user with thousands of turns. The hard constraint is the date filter, which embeddings don't help with. Storage is an atomic JSON file and assumes **one server process**. Writes are synchronous, so they're serialized within it. `Store` is narrow enough to swap for SQLite or Postgres in one file.
- **Tavily/Brave plus a fetch tool.** The brief says one tool. Gemini's Search grounding returns citations natively and needs no extra key.
- **A two-call design (search sub-call + reasoning call).** Older Gemini models couldn't combine Search with function calling, which would have forced it. Gemini 3+ can, so the single loop stays. Trade-off: grounding links are Google redirect URLs with the domain as the title, so stored sources identify the site rather than the exact page.

## Evaluation

`npm test` runs offline and checks the deterministic parts: timezones and DST, date and topic recall, `replyTo` linking under interleaved turns, incomplete-answer flags, and extraction recovery and retry.

`npm run eval` drives the real agent through the test-set patterns. Each scenario gets its own memory, seeded with backdated fixture history: a date recall, "last Tuesday … changed?", a CRM shortlist recovered from Monday, no history at all, a wrong date, a current fact, and small talk. Each one is graded from the event stream: recall dates, items mentioned, searches (and their absence), citations, completion and latency.

## With another week

1. Grow the eval set: conflicting sources, "you said X" (check before agreeing), no real change. Add an LLM judge for unsupported claims. Tune effort and the prompt against the scores.
2. A fact store with first-seen and last-verified dates, re-verified in the background, so "has anything changed?" is often answered from fresh checks.
3. Check each extracted claim against the text of its cited source, not just its URL.
4. Hybrid retrieval (embeddings + BM25) on SQLite FTS5, once there are enough chats for paraphrase misses to matter.
5. Per-turn effort routing, multi-user accounts, editable memory, and compaction for very long chats.

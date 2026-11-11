# Design

## How it works

```
browser ──POST /api/chat (SSE)──▶ Agent.runTurn
                                     │  1. save the question (it's memory even if the answer fails)
                                     │  2. build request: frozen system prompt (cached)
                                     │       + this conversation's prior turns as plain text, each stamped "[sent <time>]"
                                     │       + new message + a per-turn system note: clock, 21-day calendar, index of past chats
                                     │  3. stream Claude with two tools ────────┐
                                     │       web_search   (Anthropic server tool: search runs inside the model call)
                                     │       recall_memory(query?, from?, to?) → local, deterministic, ~1 ms
                                     │  4. stream text + citations + "Searching: …" status to the UI
                                     │  5. save answer + cited sources + queries
                                     └─ 6. background: small model extracts {title, entities, user decisions, facts}
```

Past questions are stored in one JSON file (`data/memory.json`). Each one keeps its timestamp, the user's timezone, its answer, the sources it cited, and, after step 6, structured facts like `{Neon, "Launch plan price", "$19/mo", as_of, source_url}`.

## Why it's built this way

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November, is it still correct?" needs three things: turning a date into a range in the user's timezone, finding what was said, and checking each claim again. So:

- **The model never does date arithmetic.** Each turn gets a calendar to look dates up in ("2026-11-10: Tuesday… (yesterday)"). "Last Tuesday" becomes a table lookup, which is much more reliable than asking a model to count days. Dates are local to the user, so 20:00 UTC on 2 Nov counts as 3 Nov in India (there's a test for this).
- **Retrieval is a tool, and it is deterministic.** The model reads the fuzzy part ("last Tuesday", "the CRM shortlist") and passes `from`/`to` and a `query`. The code does the exact part: a hard date filter plus BM25-style ranking over the question, title, entities, user decisions and facts. It is fast and easy to debug. When nothing matches it still returns an overview of memory, so the agent can say "I have no conversation from 3 Nov; my first one with you is from 9 Nov" instead of making one up.
- **Facts are extracted when a turn is saved, not when it's needed.** "Has pricing changed?" is then a per-claim diff: old value and its source against a fresh search. Re-reading an old essay would be vaguer. The prompt says: no change without both sides, an unknown baseline is reported as unknown, and a page's publish date is not the date a change took effect. Every claim traces back to a cited web source, a past answer (with its sources), or a comparison of the two. That is the evidence ledger, and no separate store is needed for it.
- **User decisions are memory too.** "On Monday we shortlisted 5 CRMs" refers to what the *user* said or chose. The extractor keeps that as `decisions`, so the agent can pull the shortlist back up without asking for it again.

**Fast.** There is no router, no planner call and no separate summarizer before the answer: the first token comes from the one call that does the work. Web search is Anthropic's server-side tool, so a search costs no extra round trip through my server. Fact extraction runs after the answer, off the critical path. The system prompt is frozen and cached. Everything that changes per turn goes into a mid-conversation system message, so the cached prefix survives. Earlier turns are replayed as text only. Raw search-result blocks are big and already stale by the next turn, and dropping them keeps every later request small. The UI streams text and shows each search query as it runs.

**Correct.** Primary sources first, month and year in queries, and result dates checked. The answer cites its sources, and the citation markers link to them. If a refusal triggers on a benign request, a server-side fallback re-runs it on another model.

**Good to talk to.** The answer comes first, then tables for comparisons. One-line clarifying questions only when it can't proceed. It says honestly what it verified and what it didn't. Every user message carries the time it was sent, so in a chat resumed three days later, "since then" means three days.

## Considered and rejected

- **A multi-stage pipeline (intent → plan → search → evaluate → synthesize)** costs 3–5 serial LLM calls before the first token. A strong model in one tool loop already plans, searches in parallel, re-searches when evidence is thin, and stops. I'd add stages only if an eval showed the loop failing.
- **A pre-retrieval step on every turn** (always run recall and inject the results) costs tokens and attention on the ~90% of turns that don't refer to the past. The per-turn index of past chats tells the model when recall is worth calling.
- **Postgres + pgvector, embeddings, React/Vite.** They would break "`npm install && npm run dev`, one key" and add nothing at this scale: one user, thousands of turns. Lexical search over extracted entities and facts finds "Postgres hosting" reliably, and the hard constraint is the date filter, which embeddings don't help with. The `Store` interface is narrow, so swapping in SQLite or Postgres is one file.
- **A third-party search API (Tavily/Brave) plus web_fetch.** The brief says one tool. A server-side tool returns citations natively and needs no extra key or round trip.
- **Fake seed history.** `npm run seed` instead asks the real agent real questions with the clock set back, so the backdated memory holds real answers.

## With another week

1. **An eval harness.** A scripted set of multi-session scenarios with injected clocks ("Monday: shortlist CRMs", "Wednesday: what changed?"), graded on recall hits, date resolution, per-claim verdicts and latency. Then tune effort and prompt against it rather than by feel.
2. **Change detection with a fact store:** each fact with first-seen and last-verified dates, re-verified by a cheap background job, so "has anything changed?" can often be answered from cached checks.
3. **Hybrid retrieval** (embeddings + BM25) once there are enough conversations for paraphrase misses to matter. Plus SQLite with FTS5.
4. **Per-turn effort routing** (low for chit-chat, high for multi-entity research) and reading full pricing pages for exact plan tables.
5. Multi-user accounts, editable memory ("forget this"), and context compaction for very long chats.

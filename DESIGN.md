# Design

**A research agent whose only tool is web search, with memory across chats that the app manages: a self-correcting profile, retrieval of past chats by exact date, keywords or meaning, and per-claim comparison against the past. Any OpenAI, Gemini, Claude or Groq key works, behind a small adapter.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (memory even if the answer fails)
  2. memory, in code: profile + latest exchanges from other chats; if the message points at the past,
     resolve its date phrases to exact local ranges and look those days up, else retrieve related chats
  3. one streamed model call, memory fenced as untrusted data; its only tool is web search
  4. adapter maps vendor citations to stable [n]; save answer, status, replyTo, cited sources
  5. background: extract facts → reconcile the profile → embed the exchange
```

## Why

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November? Is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **Memory is the app's job, not a second tool.** The brief allows one tool. Code resolves "last Tuesday" (both readings if ambiguous), "3 November", "the week before last" in the user's timezone, and retrieves before the model runs, saving a round trip. Lookups fire only when the message refers to our past, so "Monday.com" doesn't trigger one. An empty lookup still reports what memory holds, so nothing is invented.
- **Memory works across chats, within a budget.** Each message carries the profile, recent exchanges from other chats, and related chats matched by keywords or meaning (embeddings, when the key has them). Exact names are where embeddings are weak, so keywords stay. Sending all history would blow token budgets and dilute attention.
- **"Related by meaning" is measured by contrast.** On real Gemini vectors a true match scored 0.605 while "thanks!" scored up to 0.59 against every chat, so no fixed cut-off works. A match must stand out from the message's similarity to everything else. The rule was chosen on recorded real data, which is kept as a test fixture.
- **The profile corrects itself.** New statements are reconciled into add / update / delete ("moved to Pune" replaces "lives in Delhi"), so facts don't pile up into contradictions.
- **Prove change, don't narrate it.** "Has pricing changed?" becomes a per-claim diff: the stored value against a value cited today. No change is claimed without both sides. Prompts alone didn't enforce this live (gpt-oss asserted "no change" for unsearched items), so the app audits it: re-check questions get a checklist from the recalled exchange, and any item no search mentioned is flagged to the user as not verified. An extracted fact keeps a source only if its `[n]` sits next to it.
- **Only finished answers are memory.** Turns are `completed | incomplete | failed | cancelled`; only an explicit vendor "stop" with text counts as completed. Answers link to questions by `replyTo`.
- **Untrusted input stays data.** Web pages, recalled chats and the profile are fenced (with `<` escaped) and never followed as instructions.

## Considered and rejected

- **Memory as a model tool:** a second tool, and an extra round trip.
- **Plan → search → evaluate pipelines:** 3–5 serial calls before the first token.
- **A vector database:** one user's few thousand exchanges fit in memory; a cosine scan takes microseconds. Storage is an atomic JSON file (single process); a corrupt file stops startup instead of being reset.
- **Fixed similarity thresholds:** measured not to separate real matches from filler.
- **Backdated live answers as demo data:** `npm run seed` writes labelled synthetic fixtures instead.

## Evaluation

`npm test` (63, offline) covers the deterministic core. `npm run eval` replays a recorded live run through the real app and refuses if the model's input changed. `eval:local` uses Ollama; `eval:live` re-records against a real model with per-claim checks. Live-verified on Groq + Gemini embeddings; the full live suite is still to be recorded (see README).

## With another week

Record the full live eval and tune prompts on it; calibrate the meaning rule on more data; a page to view and delete memories; file uploads (PDF/images, partly built).

# Design

**A research agent whose only tool is web search, with memory across chats that the app manages: a self-correcting user profile, retrieval of past chats by meaning, keywords or exact dates, and per-claim comparison against the past. Any one OpenAI, Gemini, Claude or Groq key works; the vendor sits behind a small adapter.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (memory even if the answer fails)
  2. memory, in code: profile + latest exchanges from other chats; if the message points at the past,
     resolve its date phrases to exact local ranges and look those days up; otherwise retrieve related
     past chats by meaning (embedding) and keywords
  3. one streamed model call with all of that fenced as untrusted data; its only tool is web search
  4. the adapter maps vendor citations to stable [n]; save answer, status, replyTo, cited sources
  5. background: extract {entities, decisions, facts, statements about the user}; reconcile the profile;
     embed the exchange
```

## Why

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November? Is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **Memory is the app's job, not a second tool.** The brief allows one tool. Code resolves "last Tuesday" (both readings when ambiguous), "3 November" or "the week before last", and retrieves before the model runs, saving a round trip. Date lookups only fire when the message refers to our past, so "weather on Monday" and "Monday.com" don't trigger one. An empty lookup still reports what memory holds, so nothing is invented.
- **Memory works across chats, within a budget.** Every message carries:
  - the profile;
  - the latest exchanges from other chats;
  - related past chats, matched by meaning **or** keywords (hybrid: embeddings catch paraphrases, keywords catch exact product names);
  - any date lookup.

  Sending all history would blow token budgets and dilute attention.
- **The profile corrects itself.** New statements about the user are reconciled against existing facts in one small JSON call: add, update ("moved to Pune" replaces "lives in Delhi"), delete ("forget my budget") or ignore. Facts don't pile up into contradictions. If that call fails, the fallback adds only genuinely new facts.
- **Prove change, don't narrate it.** "Has pricing changed?" becomes a per-claim diff: the stored value against a value cited today. No change is claimed without both sides; a missing baseline is "unknown". An extracted fact keeps a source only if that source's `[n]` sits next to it.
- **Only finished answers are memory.** Turns are `completed | incomplete | failed | cancelled`; only an explicit vendor "stop" counts as completed. Answers link to questions by `replyTo`, not position.
- **Recalled memory is untrusted.** Past messages are user-written, and past answers were shaped by web pages. They're fenced, with `<` escaped, and treated as data, never instructions.
- **Vendor-neutral.** SDKs are imported only in `src/providers/`: one streamed answer, one JSON call, optional embeddings, error text. Embeddings can come from a second key (e.g. Groq chat + free Gemini embeddings). Vectors are tagged with their model and re-embedded after a switch. Without any embedding API, memory falls back to keywords.
- **"Related" is measured by contrast, not a fixed cut-off.** On real Gemini vectors a true paraphrase match scored 0.605 while "thanks!" scored up to 0.59 against every chat. So a match must stand out from the message's similarity to the user's other chats (plus fixed reference texts when history is short). The rule was picked by searching recorded real similarities (kept as a test fixture) for what classifies every pair correctly.

## Considered and rejected

- **Memory as a model-callable tool:** a second tool against the brief, and an extra round trip.
- **Intent → plan → search → evaluate pipelines:** 3–5 serial calls before the first token.
- **A vector database:** one user's few thousand exchanges fit in memory, and a cosine scan is microseconds. Storage is an atomic JSON file (single process); a corrupt file stops startup instead of being reset.
- **Embeddings only:** they're weak on exact names and dates, so keywords and the date resolver stay.
- **Backdated live answers as demo data:** `npm run seed` writes labelled synthetic fixtures instead.

## Evaluation

`npm test` runs offline: date phrases and false positives, DST, lookup gating, hybrid recall, profile reconciliation, key detection, migration, citation formats. `npm run eval` replays a recorded live run through the real app and refuses if the model's input changed. `eval:local` runs the memory scenarios on Ollama. `eval:live` re-records against a real model. Checks are per claim: the old value matches memory, "changed" has two values plus evidence, unknown baselines are explicit, recalled prompt injections are ignored.

## With another week

Calibrate the similarity thresholds per embedding model on the eval; a memory page where the user can view and delete facts; summarise long chats before embedding; conflicting-source and release-date eval cases.

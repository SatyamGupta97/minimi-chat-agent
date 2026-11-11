# Design

**A research agent whose only tool is web search, with temporal memory that the app looks up deterministically, facts extracted asynchronously, and per-claim comparison against the past. It runs on Groq (`gpt-oss-120b` + browser search) or Gemini (Google Search grounding) behind one small adapter.**

## How it works

```
POST /api/chat (SSE) → Agent.runTurn
  1. save the question (memory even if the answer fails)
  2. if the message refers to our past: resolve date phrases to local date ranges
     (every reading if ambiguous) and look up those days, or the topic if there is no date
  3. one streamed model call: earlier turns + context (clock, calendar, past-chat index,
     recalled exchanges fenced as untrusted data) + message; its only tool is web search
  4. the adapter maps vendor citations to stable [n]; save the answer with status,
     replyTo, cited sources apart from pages only read
  5. background: extract {title, entities, user decisions, facts about the user, checkable facts}; retried after restarts
```

## Why

**The hard part of the test set is memory plus time, not search.** "What did I ask on 3 November? Is it still right?" means resolving a date in the user's timezone, finding what was said, and re-checking each claim.

- **Memory is the app's job, not a second tool.** The brief allows one tool. Code resolves "last Tuesday" (both readings when ambiguous), "3 November" or "the week before last" in the user's timezone, then retrieves with a hard date filter plus BM25 ranking over questions, entities, decisions and facts. Lookups run only when the message refers to our past, so "weather on Monday" and "Monday.com" don't trigger one. This saves a model round trip, and an empty lookup still reports what memory holds, so nothing is invented.
- **It knows who you are in every chat.** Facts the user states about themselves (name, role, team size, preferences) are extracted in the background into a small profile, which every chat's context includes. Past exchanges, by contrast, are looked up only when asked about, because they're large and usually irrelevant.
- **Recalled memory is untrusted.** Past messages are user-written, and past answers were shaped by web pages. They are fenced (with `<` escaped), and the prompt treats them as data to report, never instructions to follow.
- **Prove change, don't narrate it.** "Has pricing changed?" becomes a per-claim diff: the stored value against a value cited today. No change is claimed without both sides; a missing baseline is "unknown". An extracted fact keeps a source only if that source's `[n]` sits next to the fact.
- **Only finished answers are evidence.** Turns are `completed | incomplete | failed | cancelled`. Only an explicit vendor "stop" counts as completed, and only completed answers become baselines. Answers link to questions by `replyTo`, not position.
- **Fast.** One model call, with search on the vendor's side and memory in the request. On Groq the first token arrives in under a second, and searched answers take 8–25 s. Extraction runs after the reply.
- **Vendor-neutral.** SDKs are imported only in `src/providers/` (one streamed answer, one JSON call, error text). Adapters map citation formats onto the same records, e.g. Groq `【cursor†Lx-Ly】` → the exact search result behind those lines.

## Considered and rejected

- **Memory as a model-callable tool** (my first version): flexible, but a second tool and an extra round trip.
- **Intent → plan → search → evaluate pipelines:** 3–5 serial calls before the first token.
- **Postgres + pgvector, React:** they'd break "`npm install && npm run dev`" for one user, and embeddings don't solve the hard constraint, dates. Storage is an atomic JSON file (single process); a corrupt file stops startup instead of being reset.
- **Backdated live answers as demo data:** that would file today's prices under last week's date. `npm run seed` writes labelled synthetic fixtures instead, idempotently.

## Evaluation

Four levels, and only the last needs a paid key. `npm test` runs offline unit tests (date phrases and false positives, DST, lookup gating, recall, `replyTo`, migration, corrupt files, extraction recovery, both citation formats). `npm run eval` replays a recorded live run through the real app, so lookup, citation numbering, statuses and checks are re-tested free. `eval:local` runs the memory scenarios on a local Ollama model (it has no search, so search scenarios are skipped). `eval:live` re-records against the real model.

Each eval scenario runs on fixture history. A judge turns each answer into per-claim records (`entity, historicalValue, currentValue, verdict, evidenceUrls`). The checks require proof: the old value matches memory, "changed" has two values plus evidence, an unknown baseline is explicit. Further scenarios cover exact date resolution, false premises, and recalled prompt injection.

## With another week

Conflicting-source and release-date evals, with prompt and effort tuned on the scores; re-verifying stored facts in the background; checking claims against cited page text; embeddings alongside BM25 for paraphrases.

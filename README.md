# minimi chat agent

A chat agent with live web search and a memory of your past conversations that knows when each one happened. Ask it things like:

- "What are the cheapest serverless Postgres hosts right now?"
- "What did I ask you yesterday? Is your answer still correct?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

## Run

```bash
cp .env.example .env      # add GROQ_API_KEY (or GEMINI_API_KEY)
npm install
npm run dev               # http://localhost:3000
```

Requires Node 20.12+. You need one key from either provider:

| Provider | Key | Chat model + search | Notes |
|---|---|---|---|
| **Groq** (default when its key is set) | `GROQ_API_KEY` from https://console.groq.com/keys | `openai/gpt-oss-120b` + built-in `browser_search` | Works on a free key, but the free tier is tight: about 8K tokens/min plus a larger token budget over longer windows. A few heavy multi-product questions (or one `npm run eval`) can use it up for a while. A paid Groq plan removes the problem. |
| **Google Gemini** | `GEMINI_API_KEY` from https://aistudio.google.com/apikey | `gemini-3.8-flash` + Google Search grounding | Search grounding needs billing enabled on the key's project. |

## Testing: most of it needs no API key

| Command | Needs | What it tests |
|---|---|---|
| `npm test` | nothing | Offline unit tests: date phrases and false positives, timezones/DST, memory lookup gating, recall, Q/A linking, migration, corrupt files, extraction recovery, citation parsing and placement |
| `npm run eval` | nothing | Replays a recorded live run (`eval/recordings/groq.json`) through the real app: date resolution, memory lookup, citation numbering, turn status and every eval check run for real; only the model's output is canned. Refuses if anything the model would now receive differs from the recording (prompt, context, lookup), so a stale recording can't pass for a new result. **The Groq recording is still being made (free-tier budget); until it's committed this command reports it as missing.** |
| `npm run eval:local` | [Ollama](https://ollama.com) + `ollama pull qwen3:4b` | The memory scenarios against a local model (no web search locally, so search scenarios are skipped). Integration testing; a 4B model is a weak judge, so treat claim-level checks as noisy |
| `npm run eval:live` | a provider key | The full suite against the real model, re-recording `eval/recordings/<provider>.json`. Waits out free-tier rate limits. Run it before submitting or after prompt changes |

Other scripts:

```bash
npm run seed              # add labelled synthetic history (last Monday/Tuesday) to try the memory questions; no API calls
npm run ask -- "question" # terminal client sharing the same memory
```

Memory lives in `data/memory.json`. Delete it to start fresh.

## Layout

| File | What it does |
|---|---|
| `src/agent.ts` | The vendor-neutral turn: memory lookup, context, streaming, statuses, evidence, persistence |
| `src/providers/` | One adapter per vendor (`groq.ts`, `gemini.ts`) behind a small `Provider` interface: streaming, built-in search, citation format, JSON calls |
| `src/prompt.ts` | Frozen system prompt (search policy, memory rules, answer style) |
| `src/dates.ts`, `src/memory-context.ts` | Deterministic date-phrase resolution and the pre-model memory lookup |
| `src/recall.ts` | Date-range plus BM25-style retrieval over past exchanges, and the per-turn memory index |
| `src/time.ts` | Timezone-correct local dates and the calendar given to the model |
| `src/extract.ts` | Background extraction of title, entities, user decisions and checkable facts |
| `src/store.ts` | Atomic JSON-file store |
| `src/server.ts` | HTTP + SSE server, no framework |
| `public/` | Vanilla-JS chat UI (streaming markdown, citations, status chips, history sidebar) |
| `scripts/eval.ts` | End-to-end eval scenarios for the test-set question patterns |

See [DESIGN.md](DESIGN.md) for the reasoning.

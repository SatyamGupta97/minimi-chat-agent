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
| **Groq** (default when its key is set) | `GROQ_API_KEY` from https://console.groq.com/keys | `openai/gpt-oss-120b` + built-in `browser_search` | Works on a free key. The free tier allows 8K tokens/min, so big multi-product questions can hit the limit; wait a minute and retry. |
| **Google Gemini** | `GEMINI_API_KEY` from https://aistudio.google.com/apikey | `gemini-3.8-flash` + Google Search grounding | Search grounding needs billing enabled on the key's project. |

Optional:

```bash
npm run seed              # add labelled synthetic history (last Monday/Tuesday) to try the memory questions; no API calls
npm run ask -- "question" # terminal client sharing the same memory
npm test                  # offline tests: dates/DST, recall, Q/A linking, extraction recovery
npm run eval              # end-to-end scenarios against the live model (fixture history, graded checks)
```

Memory lives in `data/memory.json`. Delete it to start fresh.

## Layout

| File | What it does |
|---|---|
| `src/agent.ts` | The vendor-neutral turn loop: context, `recall_memory`, statuses, evidence, persistence |
| `src/providers/` | One adapter per vendor (`groq.ts`, `gemini.ts`) behind a small `Provider` interface: streaming, built-in search, citation format, JSON calls |
| `src/prompt.ts` | Frozen system prompt (search policy, memory rules, answer style) |
| `src/recall.ts` | Date-range plus BM25-style retrieval over past exchanges, and the per-turn memory index |
| `src/time.ts` | Timezone-correct local dates and the calendar given to the model |
| `src/extract.ts` | Background extraction of title, entities, user decisions and checkable facts |
| `src/store.ts` | Atomic JSON-file store |
| `src/server.ts` | HTTP + SSE server, no framework |
| `public/` | Vanilla-JS chat UI (streaming markdown, citations, status chips, history sidebar) |
| `scripts/eval.ts` | End-to-end eval scenarios for the test-set question patterns |

See [DESIGN.md](DESIGN.md) for the reasoning.

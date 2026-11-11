# minimi chat agent

A chat agent with live web search and a memory of your past conversations that knows when each one happened. Ask it things like:

- "What are the cheapest serverless Postgres hosts right now?"
- "What did I ask you yesterday? Is your answer still correct?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

## Run

```bash
cp .env.example .env      # add your GEMINI_API_KEY
npm install
npm run dev               # http://localhost:3000
```

Requires Node 20.12+. One key is needed: a Google Gemini API key from https://aistudio.google.com/apikey. It covers the chat model (`gemini-3.8-flash` by default, with built-in Google Search grounding) and the background fact extractor (`gemini-3.5-flash-lite`). For the highest quality, set `CHAT_MODEL=gemini-4-carbon`.

Optional:

```bash
npm run seed              # create backdated history (real answers filed under last Monday/Tuesday) to try the memory questions
npm run ask -- "question" # terminal client sharing the same memory
npm test                  # offline tests: dates/DST, recall, Q/A linking, extraction recovery
npm run eval              # end-to-end scenarios against the live model (fixture history, graded checks)
```

Memory lives in `data/memory.json`. Delete it to start fresh.

## Layout

| File | What it does |
|---|---|
| `src/agent.ts` | The turn loop: builds context, streams Gemini, runs `recall_memory`, collects citations, persists |
| `src/prompt.ts` | Frozen system prompt (search policy, memory rules, answer style) |
| `src/recall.ts` | Date-range plus BM25-style retrieval over past exchanges, and the per-turn memory index |
| `src/time.ts` | Timezone-correct local dates and the calendar given to the model |
| `src/extract.ts` | Background extraction of title, entities, user decisions and checkable facts |
| `src/store.ts` | Atomic JSON-file store |
| `src/server.ts` | HTTP + SSE server, no framework |
| `public/` | Vanilla-JS chat UI (streaming markdown, citations, status chips, history sidebar) |
| `scripts/eval.ts` | End-to-end eval scenarios for the test-set question patterns |

See [DESIGN.md](DESIGN.md) for the reasoning.

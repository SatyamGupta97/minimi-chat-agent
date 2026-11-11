# minimi chat agent

A chat agent with live web search and a memory of your past conversations, across chats, that knows when each one happened. Works with a Claude, Gemini or Groq API key. Ask it things like:

- "What are the cheapest serverless Postgres hosts right now?"
- "What did I ask you yesterday? Is your answer still correct?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

## Run

```bash
cp .env.example .env      # paste ONE API key as LLM_API_KEY: Claude, Gemini or Groq
npm install
npm run dev               # http://localhost:3000
```

Requires Node 20.12+. **Bring any one key.** The vendor is detected from the key's format, and nothing else needs configuring:

| Paste a key from | Looks like | Chat model + web search | Notes |
|---|---|---|---|
| **Claude** (Anthropic) | `sk-ant-…` | `claude-opus-5-5` + Anthropic web search | Enable web search for your org in the Anthropic Console |
| **Gemini** (Google) | `AIza…` | `gemini-3.8-flash` + Google Search grounding | Search grounding needs billing enabled on the key's project |
| **Groq** | `gsk_…` | `openai/gpt-oss-120b` + built-in browser search | Works on a free key, but the free tier is tight (~8K tokens/min, 200K/day per model); heavy multi-product questions can exhaust it for a while |

Vendor-specific variables (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`) work too, and `LLM_PROVIDER` forces a vendor. The agent behaves the same on every vendor: memory, dates, citations and evidence rules live in vendor-neutral code, and each vendor is a small adapter in `src/providers/`.

## Testing: most of it needs no API key

| Command | Needs | What it tests |
|---|---|---|
| `npm test` | nothing | Offline unit tests: date phrases and false positives, timezones/DST, memory lookup gating, recall, Q/A linking, migration, corrupt files, extraction recovery, citation parsing and placement |
| `npm run eval` | nothing | Replays a recorded live run (`eval/recordings/<provider>.json`) through the real app: date resolution, memory lookup, citation numbering, turn status and every eval check run for real; only the model's output is canned. Refuses if anything the model would now receive differs from the recording (prompt, context, lookup), so a stale recording can't pass for a new result. **No recording is committed yet** (the free Groq tier's daily limit ran out mid-recording); create one with `npm run eval:live` and any key. |
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
| `src/providers/` | One adapter per vendor (`anthropic.ts`, `gemini.ts`, `groq.ts`, `ollama.ts`) behind a small `Provider` interface: streaming, built-in search, citation format, JSON calls; `replay.ts` records/replays evals |
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

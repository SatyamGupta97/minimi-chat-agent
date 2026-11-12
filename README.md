# minimi chat agent

A chat agent with live web search and a memory of your past conversations, across chats, that knows when each one happened. Works with an OpenAI, Gemini, Claude or Groq API key. Ask it things like:

- "What are the cheapest serverless Postgres hosts right now?"
- "What did I ask you yesterday? Is your answer still correct?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

## Run

```bash
cp .env.example .env      # paste ONE API key as LLM_API_KEY: OpenAI, Gemini, Claude or Groq
npm install
npm run dev               # http://localhost:3000
```

Requires Node 20.12+. **Any one LLM API key works.** The vendor is detected from the key's format, and nothing else needs configuring. **OpenAI and Gemini keys work best:** they also have an embedding API, which lets memory find past chats by *meaning* ("my vacation" finds the chat about "a Goa trip"), not only by shared keywords.

| Paste a key from | Looks like | Chat model + web search | Memory search | Notes |
|---|---|---|---|---|
| **OpenAI** ⭐ | `sk-…` | `gpt-6.1-sol` + web search | meaning + keywords | |
| **Gemini** ⭐ | `AIza…` / `AQ.…` | `gemini-3.8-flash` + Google Search grounding | meaning + keywords | Search grounding needs billing enabled on the key's project |
| **Claude** | `sk-ant-…` | `claude-opus-5-5` + web search | keywords (meaning + keywords with `EMBEDDING_API_KEY`) | Enable web search for your org in the Anthropic Console |
| **Groq** | `gsk_…` | `openai/gpt-oss-120b` + browser search | keywords (meaning + keywords with `EMBEDDING_API_KEY`) | Works on a free key, but the free tier is tight (~8K tokens/min, 200K/day per model) |

**Mix vendors:** chat on one key, meaning-based memory on another. For example, chat with a free Groq key plus a free Gemini key just for embeddings:

```bash
LLM_API_KEY=gsk_…          # chat + web search
EMBEDDING_API_KEY=AIza…    # embeddings only (Gemini or OpenAI); Gemini embeddings work on a free key
```

Vendor-specific variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`) work too, and `LLM_PROVIDER` forces a vendor. With several keys set, OpenAI or Gemini is preferred. The startup log says which memory search is active. Everything else behaves the same on every vendor: memory, dates, citations and evidence rules live in vendor-neutral code, and each vendor is a small adapter in `src/providers/`.

### What it remembers across chats

- **Who you are:** facts you state about yourself (name, city, team, preferences) form a profile used in every chat. It's kept current: "I moved to Pune" *replaces* "lives in Delhi", and "forget my budget" removes it.
- **What you discussed:** the latest exchanges from your other chats, plus past chats related to your message, matched automatically (by meaning and keywords with OpenAI/Gemini; by keywords otherwise).
- **When:** "what did I ask on 3 November?" or "last Tuesday…" looks up those exact days in your timezone.
- **Forgetting:** deleting a chat (🗑 in the sidebar) also removes what was learned only from it: its exchanges, their search vectors, and profile facts that came only from that chat.

## Evaluation status (honest)

- **63 offline tests pass** (`npm test`, no key): dates/timezones/DST, memory lookup and recall, profile updates, the meaning-search rule on recorded real Gemini similarities, citation parsing for every vendor, storage migration, key detection.
- **Live-verified:** Groq (chat + browser search) and Gemini (embeddings), end to end: cross-chat memory, date recall, profile updates, meaning-based recall.
- **The 5-CRM re-check from a new chat, live on Groq:** memory works (the Monday shortlist and all 5 products are recalled without asking). But gpt-oss at low effort usually searches only 1–2 of the 5 and still asserts "no change" for the rest, even with an explicit checklist in its prompt. So the app enforces it: after every re-check answer it compares the checklist with the searches actually run and appends **"⚠ Not verified in this answer: …"** for anything unsearched. Stronger models are expected to search all five; that's unmeasured.
- **Not yet live-verified:** the OpenAI, Claude and Gemini *chat* adapters. They're typechecked and unit-tested, but no real request has gone through them (no funded keys during development).
- **Live eval suite:** partial. 2 of 10 scenarios were recorded before Groq's free-tier daily limit ran out, and later prompt changes made that recording stale, so none is committed. `npm run eval:live` with any funded key records the full suite.

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
| `src/providers/` | One adapter per vendor (`openai.ts`, `gemini.ts`, `anthropic.ts`, `groq.ts`, `ollama.ts`) behind a small `Provider` interface: streaming, built-in search, citation format, JSON calls, optional embeddings; `replay.ts` records/replays evals |
| `src/profile.ts` | Keeps the user profile current: reconciles new statements into add / update / delete |
| `src/semantic.ts` | Meaning-based memory: embeds exchanges in the background, embeds the message at question time, hybrid with keywords |
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

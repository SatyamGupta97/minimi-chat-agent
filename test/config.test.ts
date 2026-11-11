import assert from "node:assert/strict";
import { test } from "node:test";
import { selectProvider, vendorOfKey } from "../src/config.ts";

test("the vendor is detected from the key's format", () => {
  assert.equal(vendorOfKey("sk-ant-api03-abc"), "anthropic");
  assert.equal(vendorOfKey("gsk_abc"), "groq");
  assert.equal(vendorOfKey("AIzaSyAbc"), "gemini");
  assert.equal(vendorOfKey("AQ.Ab8RN6abc"), "gemini"); // newer Google AI Studio key format
  assert.equal(vendorOfKey("sk-proj-abc"), "openai");
  assert.equal(vendorOfKey("sk-svcacct-abc"), "openai");
  assert.equal(vendorOfKey("xai-abc"), undefined);
});

test("one LLM_API_KEY is enough: any supported vendor's key works", () => {
  assert.deepEqual(selectProvider({ LLM_API_KEY: "sk-ant-x" }), { provider: "anthropic", apiKey: "sk-ant-x" });
  assert.deepEqual(selectProvider({ LLM_API_KEY: "gsk_x" }), { provider: "groq", apiKey: "gsk_x" });
  assert.deepEqual(selectProvider({ LLM_API_KEY: "AIzaX" }), { provider: "gemini", apiKey: "AIzaX" });
});

test("several keys: vendors with embeddings (meaning-based memory) are preferred", () => {
  assert.equal(selectProvider({ GROQ_API_KEY: "gsk_x", ANTHROPIC_API_KEY: "sk-ant-x", GEMINI_API_KEY: "AIzaX" }).provider, "gemini");
  assert.equal(selectProvider({ GROQ_API_KEY: "gsk_x", OPENAI_API_KEY: "sk-proj-x", GEMINI_API_KEY: "AIzaX" }).provider, "openai");
  assert.deepEqual(selectProvider({ LLM_API_KEY: "sk-proj-x" }), { provider: "openai", apiKey: "sk-proj-x" });
});

test("vendor-specific variables still work, and LLM_PROVIDER forces a choice", () => {
  assert.deepEqual(selectProvider({ GROQ_API_KEY: "gsk_x" }), { provider: "groq", apiKey: "gsk_x" });
  assert.deepEqual(selectProvider({ ANTHROPIC_API_KEY: "sk-ant-x" }), { provider: "anthropic", apiKey: "sk-ant-x" });
  assert.deepEqual(selectProvider({ GEMINI_API_KEY: "AIzaX", GROQ_API_KEY: "gsk_x", LLM_PROVIDER: "groq" }), { provider: "groq", apiKey: "gsk_x" });
  assert.deepEqual(selectProvider({ LLM_PROVIDER: "ollama" }), { provider: "ollama", apiKey: "" });
});

test("an unrecognised key gets a clear explanation instead of a confusing API error", () => {
  const s = selectProvider({ LLM_API_KEY: "xai-unknown-vendor" });
  assert.equal(s.apiKey, "");
  assert.match(s.problem ?? "", /doesn't look like an OpenAI/);
});

test("EMBEDDING_API_KEY: a Gemini or OpenAI key for embeddings only; others are rejected clearly", async () => {
  const { selectEmbedding } = await import("../src/config.ts");
  assert.deepEqual(selectEmbedding({ EMBEDDING_API_KEY: "AIzaX" }), { provider: "gemini", apiKey: "AIzaX" });
  assert.deepEqual(selectEmbedding({ EMBEDDING_API_KEY: "sk-proj-x" }), { provider: "openai", apiKey: "sk-proj-x" });
  assert.deepEqual(selectEmbedding({}), { apiKey: "" });
  assert.match(selectEmbedding({ EMBEDDING_API_KEY: "gsk_x" }).problem ?? "", /no embedding API/);
});

test("WithEmbeddings: chat goes to the chat vendor, embeddings to the embedding vendor", async () => {
  const { WithEmbeddings } = await import("../src/providers/index.ts");
  const calls: string[] = [];
  const chat = { name: "groq", chatModel: "gpt-oss", webSearch: true, missingConfig: () => null, describeError: () => undefined,
    answer: async () => (calls.push("chat.answer"), { text: "hi", finish: "stop" as const }), json: async () => (calls.push("chat.json"), {}) };
  const emb = { name: "gemini", chatModel: "x", webSearch: true, embeddingModel: "gemini-embedding-001@768", missingConfig: () => null, describeError: () => undefined,
    answer: async () => { throw new Error("must not chat"); }, json: async () => { throw new Error("must not json"); },
    embed: async (t: string[]) => (calls.push("emb.embed"), t.map(() => [1])) };
  const p = new WithEmbeddings(chat as never, emb as never);
  assert.equal(p.name, "groq");
  assert.equal(p.embeddingModel, "gemini-embedding-001@768");
  await p.answer({} as never);
  await p.json("x", { parse: (v: unknown) => v } as never);
  await p.embed(["a"], "query");
  assert.deepEqual(calls, ["chat.answer", "chat.json", "emb.embed"]);
});

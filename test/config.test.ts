import assert from "node:assert/strict";
import { test } from "node:test";
import { selectProvider, vendorOfKey } from "../src/config.ts";

test("the vendor is detected from the key's format", () => {
  assert.equal(vendorOfKey("sk-ant-api03-abc"), "anthropic");
  assert.equal(vendorOfKey("gsk_abc"), "groq");
  assert.equal(vendorOfKey("AIzaSyAbc"), "gemini");
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

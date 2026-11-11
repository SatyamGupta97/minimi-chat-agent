import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkerRewriter, sourcesAt } from "../src/providers/groq.ts";

// Shapes recorded from a live Groq gpt-oss-120b browser_search response.
const searchPage = {
  index: 0,
  type: "browser_search",
  name: "browser.search",
  arguments: '{"query": "latest stable Node.js release"}',
  output: [
    "L0: ",
    "L1: URL: https://exa.ai/search?q=latest+stable+Node.js+release",
    "L2: # Search Results",
    "L3: ",
    "L4: \\* 【0†Node.js — Node.js 26.13.0 (LTS)†nodejs.org】",
    "L5: Node.js 26.13.0 is the latest LTS release.",
    "L6: \\* 【1†Node.js — Download Node.js®†nodejs.org】",
  ].join("\n"),
  search_results: {
    results: [
      { title: "Node.js — Node.js 26.13.0 (LTS)", url: "https://nodejs.org/en/blog/release/v26.13.0", content: "", score: 1 },
      { title: "Node.js — Download Node.js®", url: "https://nodejs.org/en/download/current/", content: "", score: 1 },
    ],
  },
};
const openedPage = {
  index: 1,
  type: "browser.open",
  name: "browser.open",
  arguments: '{"cursor": 0, "id": 1}',
  output: "L0: \nL1: URL: https://nodejs.org/en/download/current/\nL2: Node.js — Download Node.js®\nL3: \nL4: # Download Node.js®\nL8: v26.13.0 LTS",
  search_results: { results: [{ title: "nodejs.org - viewing lines [0 - 74] of 7", url: "https://nodejs.org/en/download/current/", content: "", score: 0 }] },
};

test("search-page lines resolve to the specific result they belong to", () => {
  assert.deepEqual(sourcesAt(searchPage as never, 4, 5).map((s) => s.url), ["https://nodejs.org/en/blog/release/v26.13.0"]);
  assert.deepEqual(sourcesAt(searchPage as never, 5, 6).map((s) => s.url), [
    "https://nodejs.org/en/blog/release/v26.13.0",
    "https://nodejs.org/en/download/current/",
  ]);
  // Header lines belong to no result.
  assert.deepEqual(sourcesAt(searchPage as never, 0, 2), []);
});

test("an opened page resolves to itself, titled from its heading line", () => {
  assert.deepEqual(sourcesAt(openedPage as never, 6, 10), [{ url: "https://nodejs.org/en/download/current/", title: "Node.js — Download Node.js®" }]);
});

test("markers split across stream chunks become stable [n] citations", () => {
  const cited: { url: string }[] = [];
  const pages = new Map<number, unknown>([[0, searchPage], [1, openedPage]]);
  const r = new MarkerRewriter((c, a, b) => sourcesAt(pages.get(c) as never, a, b), {
    cite: (s) => cited.findIndex((c) => c.url === s.url) + 1 || cited.push(s),
  });
  const chunks = ["Latest LTS is v26.13.0【1", "†L6-L", "10】【1†L8】. Release notes【0†L4-L5】 and again【1†L8】.", " Unknown【7†L1】 dropped."];
  const out = chunks.map((c) => r.feed(c)).join("") + r.flush();
  assert.equal(out, "Latest LTS is v26.13.0[1]. Release notes[2] and again[1]. Unknown dropped.");
  assert.equal(cited.length, 2);
});

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Agent, errorMessage, type AgentEvent } from "./agent.ts";
import { config } from "./config.ts";
import { Store } from "./store.ts";
import { isValidTimeZone } from "./time.ts";

const store = new Store(config.dataFile);
const agent = new Agent(new Anthropic(), store);

const STATIC: Record<string, string> = {
  "/": "public/index.html",
  "/app.js": "public/app.js",
  "/style.css": "public/style.css",
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 100_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * One in-flight turn per conversation. A second message while the first is
 * still answering would race on history; the UI already prevents it, so the
 * server simply refuses it.
 */
const busy = new Set<string>();

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { message?: unknown; conversationId?: unknown; tz?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json(res, 400, { error: "message is required" });
  if (message.length > 20_000) return json(res, 400, { error: "message too long" });
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
  if (conversationId && !store.getConversation(conversationId)) return json(res, 404, { error: "unknown conversation" });
  const tz = isValidTimeZone(body.tz) ? body.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (conversationId && busy.has(conversationId)) {
    return json(res, 409, { error: "Still answering the previous message in this conversation." });
  }
  if (conversationId) busy.add(conversationId);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  let lockedId = conversationId;
  const send = (e: AgentEvent) => {
    if (e.type === "meta" && !lockedId) busy.add((lockedId = e.conversationId));
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  try {
    await agent.runTurn({ conversationId, message, tz, signal: abort.signal }, send);
  } catch (err) {
    send({ type: "error", message: errorMessage(err) });
  } finally {
    clearInterval(heartbeat);
    if (lockedId) busy.delete(lockedId);
    res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/chat") return await handleChat(req, res);

    if (req.method === "GET" && path === "/api/conversations") {
      return json(res, 200, store.listConversations().filter((c) => store.turns(c.id).length > 0));
    }

    const m = path.match(/^\/api\/conversations\/([\w-]+)$/);
    if (m) {
      const conv = store.getConversation(m[1]);
      if (!conv) return json(res, 404, { error: "not found" });
      if (req.method === "GET") return json(res, 200, { ...conv, turns: store.turns(conv.id) });
      if (req.method === "DELETE") {
        store.deleteConversation(conv.id);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === "GET" && STATIC[path]) {
      const file = normalize(join(process.cwd(), STATIC[path]));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(await readFile(file));
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: errorMessage(err) });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`\n  Chat agent running → http://localhost:${config.port}`);
  console.log(`  model: ${config.chatModel} (effort ${config.chatEffort}) · memory: ${config.dataFile}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("  ⚠ ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n");
    return;
  }
  // Finish any fact extraction a previous run was interrupted in the middle of.
  agent
    .recoverPendingExtractions()
    .then((n) => n && console.log(`  recovered ${n} pending fact extraction(s)`))
    .catch((e) => console.warn("  extraction recovery failed:", errorMessage(e)));
});

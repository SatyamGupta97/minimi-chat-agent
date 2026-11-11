import DOMPurify from "/vendor/purify.js";
import { marked } from "/vendor/marked.js";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = (s) => document.querySelector(s);
const els = {
  sidebar: $("#sidebar"), list: $("#conversations"), messages: $("#messages"), empty: $("#empty"),
  form: $("#composer"), input: $("#input"), send: $("#send"), title: $("#title"),
};

let conversationId = null;
let inflight = null; // AbortController of the running request

// Never render raw HTML from the model or from web pages: escape it.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
marked.use({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    // Only http(s) links; no javascript: URLs, no auto-loading remote images.
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return text;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`;
    },
    image: ({ href, text }) => (/^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(text || "image")}</a>` : escapeHtml(text)),
  },
});

// Defence in depth: the renderer above already escapes raw HTML and filters
// links; DOMPurify then sanitizes the final HTML (the answer is shaped by
// untrusted web pages). Both live and reopened answers go through here.
function renderMarkdown(text, sources) {
  return DOMPurify.sanitize(renderUnsafe(text, sources), { ADD_ATTR: ["target"], ALLOWED_URI_REGEXP: /^https?:/i });
}

function renderUnsafe(text, sources) {
  let html = marked.parse(text);
  // Turn [n] citation markers into links to the matching source.
  if (sources?.length) {
    html = html.replace(/\[(\d{1,2})\](?![(:])/g, (m, n) => {
      const s = sources[Number(n) - 1];
      return s ? `<sup class="cite"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title)}">${n}</a></sup>` : m;
    });
  }
  return html;
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function addUser(text, at) {
  els.empty.hidden = true;
  const div = document.createElement("div");
  div.className = "msg user";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  div.append(b);
  els.messages.append(div);
  if (at) {
    const w = document.createElement("div");
    w.className = "when";
    w.textContent = fmtTime(at);
    els.messages.append(w);
  }
}

function addAssistant() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="status"></div><div class="answer"></div><div class="sources"></div><div class="suggestions-box"></div><div class="meta"></div>`;
  els.messages.append(div);
  return {
    root: div,
    status: div.querySelector(".status"),
    answer: div.querySelector(".answer"),
    sources: div.querySelector(".sources"),
    suggestions: div.querySelector(".suggestions-box"),
    meta: div.querySelector(".meta"),
  };
}

// Cited sources are numbered evidence. Pages that were only read are shown
// apart (collapsed), so a source list never implies support it didn't give.
function renderSources(el, cited = [], retrieved = []) {
  el.innerHTML = "";
  const link = (s, label) => {
    const a = document.createElement("a");
    a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.title = s.title;
    a.innerHTML = `${label ? `<span class="n">${label}</span>` : ""}<span class="t">${escapeHtml(domain(s.url))} · ${escapeHtml(s.title)}</span>${s.pageAge ? `<span class="age">${escapeHtml(s.pageAge)}</span>` : ""}`;
    return a;
  };
  cited.forEach((s, i) => el.append(link(s, i + 1)));
  if (retrieved.length) {
    const d = document.createElement("details");
    d.className = "read";
    d.innerHTML = `<summary>${cited.length ? `+${retrieved.length} more read, not cited` : `${retrieved.length} pages read (none cited)`}</summary>`;
    const box = document.createElement("div");
    box.className = "sources";
    retrieved.forEach((s) => box.append(link(s)));
    d.append(box);
    el.append(d);
  }
}

// Google Search Suggestions must be displayed with grounded answers, unmodified.
// Google supplies them as HTML+CSS, so render them in a sandboxed iframe: no
// scripts, no access to this page, links open in a new tab.
function renderSuggestions(el, html) {
  if (!html) return;
  const f = document.createElement("iframe");
  f.sandbox = "allow-popups allow-popups-to-escape-sandbox";
  f.title = "Google Search Suggestions";
  f.srcdoc = `<base target="_blank">${html}`;
  f.onload = () => { try { f.style.height = `${f.contentDocument?.body?.scrollHeight || 60}px`; } catch { /* cross-origin: keep default */ } };
  el.replaceChildren(f);
}

const STATUS_LABEL = { incomplete: "Answer incomplete", failed: "Answer failed", cancelled: "Stopped" };

function chip(el, text, live = true) {
  el.querySelectorAll(".chip.live").forEach((c) => c.classList.remove("live"));
  const c = document.createElement("span");
  c.className = `chip${live ? " live" : ""}`;
  c.textContent = text;
  el.append(c);
}

const atBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
const scrollDown = (force) => { if (force || atBottom()) els.messages.scrollTop = els.messages.scrollHeight; };

async function send(text) {
  if (!text.trim() || inflight) return;
  addUser(text);
  const view = addAssistant();
  scrollDown(true);
  chip(view.status, "Thinking");

  inflight = new AbortController();
  els.send.textContent = "Stop"; els.send.classList.add("stop");
  let answer = "";
  let sources = [];
  let raf = 0;
  const paint = () => {
    raf = 0;
    view.answer.innerHTML = renderMarkdown(answer, sources);
    scrollDown();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, conversationId, tz }),
      signal: inflight.signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith("data: ")) continue;
        const e = JSON.parse(frame.slice(6));
        switch (e.type) {
          case "meta":
            if (!conversationId) { conversationId = e.conversationId; els.title.textContent = e.title; }
            break;
          case "status":
            if (e.kind === "search") chip(view.status, `Searching: ${e.query}`);
            else if (e.kind === "recall") chip(view.status, `Checking memory: ${e.detail}`);
            break;
          case "text":
            if (!answer) view.status.querySelectorAll(".chip.live").forEach((c) => c.classList.remove("live"));
            answer += e.text;
            if (!raf) raf = requestAnimationFrame(paint);
            break;
          case "final":
            // Server's authoritative text, with citation markers placed from grounding data.
            answer = e.text;
            paint();
            break;
          case "suggestions":
            renderSuggestions(view.suggestions, e.html);
            break;
          case "sources":
            sources = e.cited;
            renderSources(view.sources, e.cited, e.retrieved);
            paint();
            break;
          case "error": {
            const p = document.createElement("div");
            p.className = "error";
            p.textContent = e.message;
            view.root.append(p);
            break;
          }
          case "done":
            view.meta.textContent = [STATUS_LABEL[e.status], `${(e.ms / 1000).toFixed(1)}s`, e.searches ? `${e.searches} search${e.searches > 1 ? "es" : ""}` : ""]
              .filter(Boolean).join(" · ");
            break;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      const p = document.createElement("div");
      p.className = "error";
      p.textContent = String(err.message ?? err);
      view.root.append(p);
    }
  } finally {
    view.status.querySelectorAll(".chip.live").forEach((c) => c.classList.remove("live"));
    if (!view.status.querySelector(".chip:not(:first-child)") && answer) view.status.remove();
    paint();
    inflight = null;
    els.send.textContent = "Send"; els.send.classList.remove("stop");
    loadConversations();
    // Title is generated in the background; refresh it shortly after.
    setTimeout(loadConversations, 4000);
  }
}

async function loadConversations() {
  const convs = await (await fetch("/api/conversations")).json();
  els.list.innerHTML = "";
  let lastDay = "";
  for (const c of convs) {
    const day = new Date(c.updatedAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    if (day !== lastDay) {
      const h = document.createElement("div");
      h.className = "day"; h.textContent = day;
      els.list.append(h);
      lastDay = day;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = `conv${c.id === conversationId ? " active" : ""}`;
    b.textContent = c.title;
    b.title = c.title;
    b.onclick = () => openConversation(c.id);
    els.list.append(b);
    if (c.id === conversationId) els.title.textContent = c.title;
  }
}

async function openConversation(id) {
  if (inflight) return;
  const conv = await (await fetch(`/api/conversations/${id}`)).json();
  conversationId = id;
  els.title.textContent = conv.title;
  els.messages.querySelectorAll(".msg, .when").forEach((n) => n.remove());
  els.empty.hidden = conv.turns.length > 0;
  for (const t of conv.turns) {
    if (t.role === "user") addUser(t.text, t.at);
    else {
      const v = addAssistant();
      v.status.remove();
      v.answer.innerHTML = renderMarkdown(t.text, t.sources);
      renderSources(v.sources, t.sources, t.retrieved);
      renderSuggestions(v.suggestions, t.searchSuggestions);
      if (STATUS_LABEL[t.status]) v.meta.textContent = STATUS_LABEL[t.status];
    }
  }
  els.sidebar.classList.remove("open");
  loadConversations();
  scrollDown(true);
}

function newChat() {
  if (inflight) return;
  conversationId = null;
  els.title.textContent = "New chat";
  els.messages.querySelectorAll(".msg, .when").forEach((n) => n.remove());
  els.empty.hidden = false;
  els.sidebar.classList.remove("open");
  loadConversations();
  els.input.focus();
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (inflight) { inflight.abort(); return; }
  const text = els.input.value;
  els.input.value = "";
  els.input.style.height = "";
  send(text);
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
});
$("#new-chat").onclick = newChat;
$("#toggle-sidebar").onclick = () => els.sidebar.classList.toggle("open");
document.querySelectorAll(".suggestions button").forEach((b) => (b.onclick = () => send(b.textContent)));

loadConversations();

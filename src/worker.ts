// Daily AI-generated markdown per domain, cached per UTC day.
// Uses xAI Grok 4.1 fast non-reasoning via Cloudflare AI Gateway (OpenAI-compatible).

export interface Env {
  DOMAIN_DO: DurableObjectNamespace;
  XAI_API_KEY: string;
  GATEWAY_BASE?: string;
  GATEWAY_TOKEN?: string;
}

type DomainRecord = {
  text: string;
  generatedAt: string;
};

type XaiChatCompletion = {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
  }>;
  output_text?: string;
  response?: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") || url.host || "localhost";
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const version = "v15";

    const cacheKey = new Request(`https://${host}/${version}/__md/${today}`, {
      method: "GET",
    });

    // 1) Edge cache first.
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // 1b) Ask DO for today's text; if present, render and cache.
    const stub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(host));
    const doRes = await stub.fetch("https://domain-do/daily", {
      headers: { "x-md-host": host, "x-md-version": version },
    });
    if (doRes.ok) {
      const payload = (await doRes.json()) as DomainRecord;
      const response = renderHtmlResponse(host, payload.text, payload.generatedAt, version);
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    }

    // If the DO itself fails, still return a deterministic response instead of retrying forever.
    const text = fallbackText(host, today);
    const response = renderHtmlResponse(host, text, today, version);
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};

// Export helpers for testing.
export { buildPrompt, fallbackText, generateDailyText, renderPage };

export class DomainDO {
  state: DurableObjectState;
  env: Env;
  inflight: Map<string, Promise<DomainRecord>>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.inflight = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const version = request.headers.get("x-md-version") || "v1";
    const host = request.headers.get("x-md-host") || request.headers.get("host") || "localhost";
    const key = `${version}-${today}`;

    if (url.pathname === "/daily") {
      const record = await this.getOrCreateDailyRecord(key, host, today);
      return json(record);
    }

    const existing = await this.state.storage.get<any>(key);
    if (existing) return json(existing);
    return new Response("not found", { status: 404 });
  }

  private async getOrCreateDailyRecord(
    key: string,
    host: string,
    today: string,
  ): Promise<DomainRecord> {
    const existing = await this.state.storage.get<DomainRecord>(key);
    if (existing) return existing;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const text = await generateDailyText(this.env, host, today);
      const record = { text, generatedAt: today };
      await this.state.storage.put(key, record);
      return record;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }
}

async function generateDailyText(env: Env, host: string, today: string): Promise<string> {
  const prompt = buildPrompt(host, today);

  try {
    const text = await callXai(env, prompt);
    return text.trim();
  } catch (err) {
    console.error("AI generation error", err);
    return fallbackText(host, today);
  }
}

async function callXai(env: Env, prompt: string): Promise<string> {
  if (!env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is not set");
  }
  const apiBase =
    env.GATEWAY_BASE || "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/compat";
  const body = {
    model: "grok-4-1-fast-reasoning",
    messages: [
      {
        role: "system",
        content:
          "You write concise, thoughtful Markdown essays. Do not mention Markdown or formatting itself. No HTML. No images. Do not mention the prompt. Never use an em-dash (—); use commas or colons instead.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    top_p: 0.9,
    max_tokens: 500,
    stream: false,
  };

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.GATEWAY_TOKEN || env.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await safeText(res);
    throw new Error(`xAI error ${res.status}: ${msg}`);
  }

  const data = (await res.json()) as XaiChatCompletion;
  const text = data?.choices?.[0]?.message?.content || data?.output_text || data?.response;
  if (!text) throw new Error("xAI response missing content");
  return text;
}

function buildPrompt(host: string, today: string): string {
  return `Write a reflective Markdown piece (220-400 words) for the site "${host}".
Theme: find a simple, thoughtful meaning, metaphor, or philosophy inspired by the domain name.
Tone: calm, sincere, meaningful; avoid jargon and clichés; use clear, everyday language.
If no strong philosophical angle emerges, tell a small, heartwarming story instead.
Structure:
- Start with a single H1 title.
- 2-3 short sections with H2 headings.
- At most one bullet list.
- No images, links, HTML, or code fences.
Constraints: keep it under ~400 words, English only.
Add a one-line italicized closing thought. Date context: ${today} UTC.`;
}

function fallbackText(host: string, today: string): string {
  return `# ${host}

We meant to hand you something thoughtful today, but the generator blinked.

Until it wakes, take this small reminder: meaning often shows up after the first attempt, not before it.

_Generated on ${today} UTC; cached until the next sunrise._`;
}

function renderPage({
  host,
  text,
  generatedAt,
}: {
  host: string;
  text: string;
  generatedAt: string;
}) {
  const rendered = renderMarkdown(text);
  return wrapShell(host, rendered, generatedAt);
}

function renderHtmlResponse(
  host: string,
  text: string,
  generatedAt: string,
  version: string,
): Response {
  return new Response(renderPage({ host, text, generatedAt }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=86400",
      etag: `${host}:${version}:${generatedAt}`,
      "x-generated-on": generatedAt,
      "x-md-version": version,
    },
  });
}

function wrapShell(host: string, renderedHtml: string, generatedAt: string) {
  const css = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.6 "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-width: 72ch;
  margin: 4vh auto 5vh;
  padding: 0 1.5rem;
  background: var(--bg, #f8f8f5);
  color: var(--fg, #111);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0c0c0c; --fg: #e6e6e6; }
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f8f8f5; --fg: #111; }
}
pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
}
footer {
  margin-top: 2.5rem;
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.7;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
footer a {
  color: inherit;
  text-decoration: none;
}
.strong-italic {
  font-style: italic;
  font-weight: 600;
}
em { font-style: italic; }
strong { font-weight: 700; }
footer span, footer a { white-space: nowrap; }
@media (max-width: 340px) {
  footer { flex-direction: column; align-items: flex-start; }
}
}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(host)}" />
  <meta property="og:description" content="One daily markdown page: ${escapeHtml(host)}" />
  <meta property="og:url" content="https://${escapeHtml(host)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23000'%3E%3C/rect%3E%3Ctext x='50%25' y='58%25' text-anchor='middle' font-size='36' font-family='monospace' fill='%23fff'%3Emd%3C/text%3E%3C/svg%3E" />
  <title>${escapeHtml(host)}</title>
  <style>${css}</style>
</head>
<body>
  <pre>${renderedHtml}</pre>
  <footer>
    <span>Generated on ${generatedAt}</span>
    <a href="https://steipete.me">a @steipete project</a>
  </footer>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json" },
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no-body>";
  }
}

function renderMarkdown(markdown: string): string {
  // render inline tags but keep decorators visible
  let escaped = escapeHtml(markdown);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>*$1*</strong>");
  escaped = escaped.replace(/\*(.+?)\*/g, "<em>*$1*</em>");
  escaped = escaped.replace(/~~(.+?)~~/g, "<del>~~$1~~</del>");
  return escaped;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainDO, buildPrompt, fallbackText, renderPage } from "../src/worker";

describe("prompt", () => {
  it("includes host and date", () => {
    const host = "example.com";
    const today = "2025-12-05";
    const prompt = buildPrompt(host, today);
    expect(prompt).toContain(host);
    expect(prompt).toContain(today);
    expect(prompt).toContain("220-400 words");
  });
});

describe("fallback", () => {
  it("mentions host and date", () => {
    const host = "abstract.md";
    const today = "2025-12-05";
    const text = fallbackText(host, today);
    expect(text).toContain(host);
    expect(text).toContain(today);
  });
});

describe("renderPage", () => {
  it("renders footer link and generated date", () => {
    const html = renderPage({
      host: "abstract.md",
      text: "# Title\n\nBody",
      generatedAt: "2025-12-05",
    });
    expect(html).toContain("Generated on 2025-12-05");
    expect(html).toContain("a @steipete project");
    expect(html).toContain("https://steipete.me");
  });
});

describe("DomainDO daily generation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-05T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("coalesces concurrent misses into one upstream generation", async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "# One daily page" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => domainDO.fetch(request).then((res) => res.json())),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.text)).toEqual(
      Array.from({ length: 5 }, () => "# One daily page"),
    );
  });

  it("stores deterministic fallback after upstream failure", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const domainDO = new DomainDO(createState(), { XAI_API_KEY: "xai-key" });
    const request = new Request("https://domain-do/daily", {
      headers: { "x-md-host": "example.com", "x-md-version": "v15" },
    });

    const first = await domainDO.fetch(request).then((res) => res.json());
    const second = await domainDO.fetch(request).then((res) => res.json());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.text).toContain("generator blinked");
    expect(second).toEqual(first);
  });
});

function createState() {
  const values = new Map();

  return {
    storage: {
      get: vi.fn(async (key) => values.get(key)),
      put: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
    },
  };
}

import { describe, expect, test } from "bun:test";
import {
  createMindSwapperCatalogue,
  parseMindSwapperModels,
  serverMindSwapperRevision,
} from "../../src/lib/mindswapper-catalog";

const baseUrl = "https://gateway.example/v1";
const apiKey = "ngw_" + "x".repeat(43);
const connection = { baseUrl, apiKey };

function row(id: string, gateway: Record<string, unknown> = {}) {
  return {
    id, object: "model",
    gateway: {
      name: id, available: true, endpoints: ["chat/completions"],
      chatCompletions: [
        { inputModalities: ["text"], supportedParameters: ["tools"], maxInputTokens: 400, maxOutputTokens: 80 },
        { inputModalities: ["text", "image"], supportedParameters: ["response_format"], maxInputTokens: 600, maxOutputTokens: 60 },
      ],
      ...gateway,
    },
  };
}

function list(...data: ReturnType<typeof row>[]) {
  return { object: "list", data };
}

describe("MindSwapper discovery", () => {
  test("preserves exact ids and single-offer capabilities and omits unavailable or unqualified routes", () => {
    const parsed = parseMindSwapperModels(list(
      row("maker/next-model", { cheapestInputPrice: { usdPerMillion: "0.15", outputUsdPerMillion: "0.5" } }),
      row("maker/disabled", { available: false }),
      row("maker/responses", { endpoints: ["responses"] }),
      row("maker/older-contract", { chatCompletions: undefined, supportedParameters: ["tools"] }),
    ));
    expect(parsed).toEqual([{
      id: "mindswapper:maker/next-model", displayName: "maker/next-model",
      offers: [
        { inputModalities: ["text"], supportedParameters: ["tools"], maxInputTokens: 400, maxOutputTokens: 80 },
        { inputModalities: ["text", "image"], supportedParameters: ["response_format"], maxInputTokens: 600, maxOutputTokens: 60 },
      ],
      indicativePrice: { inputPerMtok: 0.15, outputPerMtok: 0.5 },
    }]);
    expect(() => parseMindSwapperModels(list(row("maker/duplicate"), row("maker/duplicate")))).toThrow();
    expect(() => parseMindSwapperModels(list(row("maker/invalid", {
      chatCompletions: [{ inputModalities: ["text"], supportedParameters: [], maxInputTokens: 0, maxOutputTokens: 10 }],
    })))).toThrow();
  });

  test("coalesces requests for a connection and isolates refresh, delisting, and revocation by revision", async () => {
    let clock = 0;
    const upstream = [
      Response.json(list(row("maker/alpha"))), Response.json(list(row("maker/beta"))),
      Response.json(list()), new Response(null, { status: 401 }),
    ];
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = async (...[url, init]: Parameters<typeof fetch>) => {
      calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init });
      return upstream.shift()!;
    };
    const catalog = createMindSwapperCatalogue(fetcher, () => clock);
    const open = () => connection;
    const [first, parallel, other] = await Promise.all([
      catalog.get("payer-a-1", open), catalog.get("payer-a-1", open), catalog.get("payer-b-1", open),
    ]);
    expect(first[0]?.id).toBe("mindswapper:maker/alpha");
    expect(parallel).toBe(first);
    expect(other[0]?.id).toBe("mindswapper:maker/beta");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(baseUrl + "/models");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer " + apiKey);
    clock += 60_000;
    expect(await catalog.get("payer-a-1", open)).toEqual([]);
    expect(await catalog.get("payer-b-1", open)).toEqual([]);
  });

  test("retains only unexpired rows on transient failure and rejects an oversized refresh", async () => {
    let clock = 0;
    const responses = [
      Response.json(list(row("maker/old"))),
      new Response("x", { headers: { "content-length": "2000000" } }),
      new Response(null, { status: 503 }),
    ];
    const catalog = createMindSwapperCatalogue(async () => responses.shift()!, () => clock);
    expect(await catalog.get("connection", () => connection)).toHaveLength(1);
    clock += 60_000;
    expect(await catalog.get("connection", () => connection)).toHaveLength(1);
    clock += 600_000;
    expect(await catalog.get("connection", () => connection)).toEqual([]);
  });

  test("server binding revisions change with endpoint or key and carry no bearer value", () => {
    const revision = serverMindSwapperRevision(connection);
    expect(revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(revision).not.toContain(apiKey);
    expect(serverMindSwapperRevision({ ...connection, baseUrl: "https://other.example/v1" })).not.toBe(revision);
    expect(serverMindSwapperRevision({ ...connection, apiKey: "ngw_" + "a".repeat(43) })).not.toBe(revision);
  });
});

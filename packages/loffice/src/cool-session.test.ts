/**
 * D362 Milestone B — hermetic unit test for `CoolSessionClient`.
 *
 * Spins an in-process fake coolwsd (`Bun.serve({ websocket })`) that
 * speaks just enough of the line protocol to satisfy the client:
 *   - echoes `coolserver …` on connect,
 *   - replies `loaded: viewid=1 views=1 isfirst=true` after the client's
 *     `coolclient` + `load url=` handshake,
 *   - echoes `unocommandresult:` for `uno <cmd> <json>` requests,
 *   - replies to `save …` with `unocommandresult: .uno:Save` (and a
 *     tolerant `statechanged: .uno:ModifiedStatus=false` path is also
 *     exercised).
 *
 * Asserts: handshake order, sendUnoAndWait resolves with the payload,
 * save() resolves, close() clean, and a timeout path rejects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Jimp, JimpMime } from "jimp";
import { CoolSessionClient, readImagePixelSize } from "./cool-session";
import { resizeImageToCm, LO_INSERT_DPI } from "./image-resize";

// Minimal fake coolwsd: records the order of incoming lines so tests can
// assert handshake ordering, and dispatches canned replies.
let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
const receivedLines: string[] = [];
let lastUpgradePath: string | null = null;
let lastUpgradeOrigin: string | null = null;
// Per-test hooks for custom behaviour.
let onClientLine: ((line: string, ws: { send: (s: string) => void }) => void) | null = null;
// Per-test hook for HTTP POSTs (the insertfile multipart route). Returns
// a Response for the caller to send. Only invoked for non-insertfile POSTs.
let onHttpPost: ((req: Request) => Promise<Response> | Response) | null = null;
// Records the last insertfile POST: the URL, the parsed form fields, and
// the uploaded file bytes. Tests assert against this.
let lastInsertFilePost: {
  url: string;
  name: string | null;
  childid: string | null;
  filename: string | null;
  contentType: string | null;
  bytes: Uint8Array | null;
} | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    websocket: {
      // Declaring `data: undefined` fixes the upgrade() arg-count inference
      // (otherwise Bun types `WebSocketData` as `unknown` and requires
      // `data` on every upgrade call).
      data: undefined,
      open(ws) {
        ws.send("coolserver 0.1 fake-hash 0.1");
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as unknown as ArrayBuffer);
        // Record every incoming line, in order.
        const line = text.split("\n")[0]!;
        receivedLines.push(line);
        if (onClientLine) {
          onClientLine(line, ws);
          return;
        }
        // Default behaviour: handshake + canned replies.
        if (line.startsWith("coolclient ")) {
          // Wait for `load url=` before sending `loaded:` — matches real coolwsd.
          return;
        }
        if (line.startsWith("load url=")) {
          ws.send("loaded: viewid=1 views=1 isfirst=true");
          return;
        }
        if (line.startsWith("uno ")) {
          // Echo a unocommandresult for the command name after `uno `.
          const cmd = line.slice(4).split(" ")[0]!.trim();
          ws.send(
            `unocommandresult: ${JSON.stringify({ commandName: cmd, success: true })}`,
          );
          return;
        }
        if (line.startsWith("save ")) {
          // Acknowledge save with a uno:Save result.
          ws.send(
            `unocommandresult: ${JSON.stringify({ commandName: ".uno:Save", success: true })}`,
          );
          return;
        }
        // Ignore anything else (tile traffic, ping, etc.).
      },
    },
    fetch(req, serverObj) {
      lastUpgradePath = new URL(req.url).pathname;
      lastUpgradeOrigin = req.headers.get("origin");
      if (req.method === "POST" && onHttpPost) {
        return onHttpPost(req);
      }
      // Insertfile multipart POST route — the bytes path for image insert
      // (Map.FileInserter.js:_sendFile). Handle before the upgrade attempt.
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/insertfile")) {
        return handleInsertFilePost(req);
      }
      if (serverObj.upgrade(req)) return new Response(null, { status: 101 });
      return new Response("ws-only", { status: 426 });
    },
  });
  // @ts-expect-error — Bun.serve address shape varies by runtime; port lives under address.port.
  serverPort = (server.address as { port?: number } | undefined)?.port ?? 0;
});

afterAll(() => {
  if (server) {
    server.stop(true);
    server = null;
  }
  onClientLine = null;
  onHttpPost = null;
  lastInsertFilePost = null;
});

/**
 * Parse a multipart insertfile POST, record the fields + file bytes, and
 * return 200. Mirrors coolwsd's `ClientRequestDispatcher.cpp:2272-2318`
 * route: it expects `name`, `childid`, and a single file part. We use the
 * standard multipart parser via `req.formData()` (Bun supports it
 * natively). Tests assert against `lastInsertFilePost`.
 */
async function handleInsertFilePost(req: Request): Promise<Response> {
  const url = req.url;
  const form = await req.formData();
  const name = form.get("name");
  const childid = form.get("childid");
  const file = form.get("file");
  let filename: string | null = null;
  let contentType: string | null = null;
  let bytes: Uint8Array | null = null;
  if (file instanceof Blob) {
    filename = (file as File).name ?? null;
    contentType = file.type || null;
    const buf = new Uint8Array(await file.arrayBuffer());
    bytes = buf;
  }
  lastInsertFilePost = {
    url,
    name: typeof name === "string" ? name : null,
    childid: typeof childid === "string" ? childid : null,
    filename,
    contentType,
    bytes,
  };
  return new Response("ok", { status: 200 });
}

function wsBase(): string {
  return `ws://127.0.0.1:${serverPort}`;
}

const DOC_URL = "http://host.docker.internal:9999/wopi/files/abc?access_token=tok&access_token_ttl=0&permission=edit";
const WOPI_SRC = "http://host.docker.internal:9999/wopi/files/abc";

describe("CoolSessionClient", () => {
  test("connect() uses the serviceRoot path prefix and sends the Origin header", async () => {
    // Regression for the live "socket closed before load" (close 1002):
    // coolwsd needs the `/office-engine` service root on the WS path AND a
    // matching Origin (its server_name). Verified live 2026-07-03.
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      serviceRoot: "/office-engine",
      origin: "http://127.0.0.1:3001",
      timeoutMs: 3000,
    });
    await client.connect();
    expect(lastUpgradePath).toBe(`/office-engine/cool/${encodeURIComponent(DOC_URL)}/ws`);
    expect(lastUpgradeOrigin).toBe("http://127.0.0.1:3001");
    client.close();
  });

  test("handshake sends coolclient then load url=, then resolves on loaded:", async () => {
    receivedLines.length = 0;
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      timeoutMs: 3000,
    });
    await client.connect();

    // The handshake must be ordered: coolclient BEFORE load url=.
    const coolclientIdx = receivedLines.findIndex((l) => l.startsWith("coolclient "));
    const loadIdx = receivedLines.findIndex((l) => l.startsWith("load url="));
    expect(coolclientIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(coolclientIdx);

    // load url= carries the encoded doc URL (the entire docUrl is encodeURIComponent-encoded).
    expect(receivedLines[loadIdx]!).toMatch(/^load url=.+access_token%3Dtok/);

    client.close();
  });

  test("sendUnoAndWait resolves with the parsed unocommandresult payload", async () => {
    receivedLines.length = 0;
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      timeoutMs: 3000,
    });
    await client.connect();

    const payload = (await client.sendUnoAndWait(".uno:InsertText", {
      Text: { type: "string", value: "hi" },
    })) as { commandName: string; success: boolean };

    expect(payload.commandName).toBe(".uno:InsertText");
    expect(payload.success).toBe(true);

    // The wire line must be `uno .uno:InsertText <json>`.
    const unoLine = receivedLines.find((l) => l.startsWith("uno .uno:InsertText "));
    expect(unoLine).toBeDefined();
    expect(unoLine!).toContain('"Text"');
    expect(unoLine!).toContain('"hi"');

    client.close();
  });

  test("sendUnoAndWait(.uno:ExecuteSearch) resolves on searchresultselection: (no unocommandresult)", async () => {
    // Regression: coolwsd does NOT ack ExecuteSearch with unocommandresult:.
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=1 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("uno .uno:ExecuteSearch")) {
        ws.send("searchresultselection: [{}]");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({ wsBaseUrl: wsBase(), docUrl: DOC_URL, wopiSrc: WOPI_SRC, timeoutMs: 2000 });
      await client.connect();
      const res = (await client.sendUnoAndWait(".uno:ExecuteSearch", {
        "SearchItem.SearchString": { type: "string", value: "foo" },
      })) as { commandName: string };
      expect(res.commandName).toBe(".uno:ExecuteSearch");
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("sendUnoAndWait(.uno:ExecuteSearch) rejects on searchnotfound:", async () => {
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=1 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("uno .uno:ExecuteSearch")) {
        ws.send("searchnotfound: []");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({ wsBaseUrl: wsBase(), docUrl: DOC_URL, wopiSrc: WOPI_SRC, timeoutMs: 2000 });
      await client.connect();
      let err: unknown = null;
      try {
        await client.sendUnoAndWait(".uno:ExecuteSearch", {
          "SearchItem.SearchString": { type: "string", value: "nope" },
        });
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/search string not found/);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("save() resolves on unocommandresult for .uno:Save", async () => {
    receivedLines.length = 0;
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      timeoutMs: 3000,
    });
    await client.connect();

    await client.save();

    const saveLine = receivedLines.find((l) => l.startsWith("save "));
    expect(saveLine).toBeDefined();
    expect(saveLine!).toContain("dontTerminateEdit=1");
    expect(saveLine!).toContain("dontSaveIfUnmodified=0");

    client.close();
  });

  test("save() also resolves on a tolerant statechanged .uno:ModifiedStatus=false", async () => {
    receivedLines.length = 0;
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=2 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("save ")) {
        // Don't echo a uno:Save result; instead clear the modified flag.
        ws.send("statechanged: .uno:ModifiedStatus=false");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 3000,
      });
      await client.connect();
      await client.save(); // should resolve on the statechanged signal
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("close() is idempotent and does not throw", async () => {
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      timeoutMs: 3000,
    });
    await client.connect();
    expect(() => {
      client.close();
      client.close();
    }).not.toThrow();
  });

  test("connect() rejects on timeout when no loaded: arrives", async () => {
    onClientLine = (line, _ws) => {
      // Swallow everything — never send `loaded:`.
      void line;
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 200,
      });
      let err: unknown = null;
      try {
        await client.connect();
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/timeout|closed before load/);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("connect() rejects when the server sends an error: before loaded:", async () => {
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("error: cmd=load kind=loadfailed");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      let err: unknown = null;
      try {
        await client.connect();
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/error: cmd=load/);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("sendUnoAndWait rejects on error: for that command", async () => {
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=3 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("uno .uno:GoToCell ")) {
        ws.send("error: cmd=.uno:GoToCell kind=failed");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      let err: unknown = null;
      try {
        await client.sendUnoAndWait(".uno:GoToCell", {
          ToPoint: { type: "string", value: "A1" },
        });
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/error: cmd=.uno:GoToCell/);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getCommandState returns the cached state from a key=value statechanged push", async () => {
    // Grounded wire format: `statechanged: <key>=<value>`
    // (`EXTERNAL/collabora-online-source/wsd/protocol.txt:658-661`).
    // coolwsd pushes `.uno:TrackChanges=true|false` on toggle / doc load.
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=4 views=1 isfirst=true");
        // Simulate the engine pushing initial state on doc load.
        ws.send("statechanged: .uno:TrackChanges=true");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      const state = await client.getCommandState(".uno:TrackChanges");
      expect(state).toBe(true);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getCommandState parses the JSON statechanged form and normalizes booleans", async () => {
    // Grounded JSON form: `statechanged: {"commandName":".uno:Foo","state":"true"}`
    // (`EXTERNAL/collabora-online-source/browser/src/layer/tile/CanvasTileLayer.js:2102-2130`).
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=5 views=1 isfirst=true");
        ws.send(
          `statechanged: ${JSON.stringify({ commandName: ".uno:TrackChanges", state: "false" })}`,
        );
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      const state = await client.getCommandState(".uno:TrackChanges");
      expect(state).toBe(false);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getCommandState awaits a statechanged push that arrives after the call", async () => {
    // Cache miss → await next push within timeoutMs. The push arrives
    // AFTER `getCommandState` is called (no pre-load state).
    let pushLater: ((ws: { send: (s: string) => void }) => void) | null = null;
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=6 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("uno .uno:GoToCell")) {
        // Agent priming the cache by triggering a re-evaluation; the
        // engine pushes state for TrackChanges in response.
        if (pushLater) pushLater(ws);
        ws.send(
          `unocommandresult: ${JSON.stringify({ commandName: ".uno:GoToCell", success: true })}`,
        );
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      // Schedule the state push to land shortly after the getCommandState call.
      pushLater = (ws) => setTimeout(() => ws.send("statechanged: .uno:TrackChanges=true"), 50);
      // Trigger the engine activity that produces the push, then read.
      client.sendUno(".uno:GoToCell", { ToPoint: { type: "string", value: "A1" } });
      const state = await client.getCommandState(".uno:TrackChanges", 1500);
      expect(state).toBe(true);
      client.close();
    } finally {
      onClientLine = null;
      pushLater = null;
    }
  });

  test("getCommandState resolves null on timeout when no state arrives", async () => {
    // No `statechanged:` ever sent for `.uno:TrackChanges` → timeout → null.
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=7 views=1 isfirst=true");
        return;
      }
      // Default uno echo only — no statechanged push.
      if (line.startsWith("uno ")) {
        const cmd = line.slice(4).split(" ")[0]!.trim();
        ws.send(`unocommandresult: ${JSON.stringify({ commandName: cmd, success: true })}`);
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      const state = await client.getCommandState(".uno:TrackChanges", 200);
      expect(state).toBeNull();
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getCommandState cache hit still serves the save-tolerant ModifiedStatus path", async () => {
    // Regression guard: caching `.uno:ModifiedStatus` must NOT break the
    // existing save() path. The save-tolerant `statechanged:
    // .uno:ModifiedStatus=false` signal should still resolve a pending
    // save() AND populate the getCommandState cache.
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=8 views=1 isfirst=true");
        return;
      }
      if (line.startsWith("save ")) {
        ws.send("statechanged: .uno:ModifiedStatus=false");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      await client.save(); // resolves on the statechanged signal
      const modified = await client.getCommandState(".uno:ModifiedStatus");
      expect(modified).toBe(false);
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  // ─── Wave K — image insert primitives (getChildId + postInsertFile) ───
  // Grounded in Collabora's Map.FileInserter.js bytes path: the browser
  // sends `getchildid`, awaits `getchildid: id=<id>`, then multipart-POSTs
  // {name, childid, file} to /cool/<WOPISrc>/insertfile, then sends the
  // socket line `insertfile name=<name> type=graphic`. The agent path
  // mirrors this server-side.

  test("getChildId sends `getchildid` and resolves with the id from `getchildid: id=<id>`", async () => {
    // Grounded wire: `Map.FileInserter.js:50` sends `getchildid`; the engine
    // replies `getchildid: id=<id>` (`CanvasTileLayer.js:848-850` dispatch +
    // `_onGetChildIdMsg:1611-1613` → fires `childid {id: command.id}`,
    // parsed by `ServerCommand.ts:97-99` from the `id=` token).
    receivedLines.length = 0;
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=10 views=1 isfirst=true");
        return;
      }
      if (line === "getchildid") {
        ws.send("getchildid: id=jail-child-xyz");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      const id = await client.getChildId();
      expect(id).toBe("jail-child-xyz");
      // The wire line must be the bare `getchildid` (no args).
      expect(receivedLines).toContain("getchildid");
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getChildId resolves null on timeout when no `getchildid:` reply arrives", async () => {
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=11 views=1 isfirst=true");
        return;
      }
      // Swallow getchildid without replying.
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        timeoutMs: 2000,
      });
      await client.connect();
      const id = await client.getChildId(150);
      expect(id).toBeNull();
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("postInsertFile multipart-POSTs {name, childid, file} to /cool/<WOPISrc>/insertfile and resolves on 200", async () => {
    // Grounded: `Map.FileInserter.js:260-285` posts FormData{name,
    // childid, file} to `getWopiUrl(map)` = `<serviceRoot>/cool/<enc(doc)>/
    // insertfile?WOPISrc=<enc>&compat=` (assembled by `makeHttpUrlWopiSrc`
    // + `makeDocAndWopiSrcUrl` in `global.js:1806-1789`). The server-side
    // agent hits the same loopback URL the office reverse-proxy forwards.
    lastInsertFilePost = null;
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      serviceRoot: "/office-engine",
      timeoutMs: 2000,
    });
    await client.connect();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await client.postInsertFile("img-123", "jail-child-xyz", {
      bytes,
      filename: "photo.png",
      contentType: "image/png",
    });
    client.close();

    expect(lastInsertFilePost).not.toBeNull();
    const post = lastInsertFilePost!;
    // URL is the coolwsd insertfile route under the service root, with the
    // docUrl URL-encoded in the path and WOPISrc in the query.
    expect(post.url).toBe(
      `http://127.0.0.1:${serverPort}/office-engine/cool/${encodeURIComponent(DOC_URL)}/insertfile?WOPISrc=${encodeURIComponent(WOPI_SRC)}&compat=`,
    );
    expect(post.name).toBe("img-123");
    expect(post.childid).toBe("jail-child-xyz");
    expect(post.filename).toBe("photo.png");
    expect(post.contentType).toBe("image/png");
    // File bytes round-trip exactly.
    expect(post.bytes).not.toBeNull();
    expect(Array.from(post.bytes!)).toEqual(Array.from(bytes));
  });

  test("postInsertFile rejects on non-2xx (coolwsd 400 for a bad childid)", async () => {
    // Grounded: `ClientRequestDispatcher.cpp:2292-2296` 400s when the
    // childid doesn't match the doc-broker's jail id; `Map.FileInserter.js:247-257`
    // maps 404 / 413 / other to user-facing errors. The agent must surface
    // the status so the caller can distinguish failure modes.
    onHttpPost = () => new Response("bad childid", { status: 400 });
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      let err: unknown = null;
      try {
        await client.postInsertFile("img-123", "wrong-child", {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "x.png",
          contentType: "image/png",
        });
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/HTTP 400/);
      client.close();
    } finally {
      onHttpPost = null;
    }
  });

  test("sendInsertFile emits the bare `insertfile name=<name> type=<type>` socket line (no `uno ` prefix)", async () => {
    // Grounded: `Map.FileInserter.js:244` posts-then-sends `insertfile
    // name=<name> type=<type>` to tell coolwsd to insert the uploaded
    // file. NOT a UNO command — no `uno ` prefix.
    receivedLines.length = 0;
    const client = new CoolSessionClient({
      wsBaseUrl: wsBase(),
      docUrl: DOC_URL,
      wopiSrc: WOPI_SRC,
      timeoutMs: 2000,
    });
    await client.connect();
    client.sendInsertFile("img-123", "graphic");
    // Yield to the event loop so the server's `message` handler records
    // the line before close() races with frame delivery.
    await new Promise((r) => setTimeout(r, 20));
    client.close();
    expect(receivedLines).toContain("insertfile name=img-123 type=graphic");
    // Must NOT be wrapped in a `uno ` prefix.
    expect(receivedLines.some((l) => l.startsWith("uno insertfile"))).toBe(false);
  });

  // ─── Bug 2 fix: graphicselection echo primitive for image fit-to-slide ─
  // Grounded in `EXTERNAL/collabora-online-source/browser/src/app/GraphicSelectionMiddleware.ts:328-355`:
  // coolwsd pushes `graphicselection: [x1, y1, x2, y2, angle?, extraInfo?]`
  // (twips) when a graphic is selected; an `EMPTY` payload clears the
  // selection. The agent image-insert flow clears the cache before
  // `insertfile`, then awaits the next push to capture the just-inserted
  // image's native rect, then computes fit-to-slide preserving aspect.

  test("getGraphicSelection returns the cached rect from a prior graphicselection push (cache hit)", async () => {
    // The cache is populated when a `graphicselection:` push arrives; a
    // subsequent `getGraphicSelection` call returns it immediately
    // (mirrors `getCommandState`'s cache-hit path). Grounded wire:
    // `graphicselection: <json-array>` of `[x1, y1, x2, y2, angle?, extraInfo?]`
    // in twips (GraphicSelectionMiddleware.ts:350-355 wraps the rest in
    // `[...]` and JSON.parses; `extractAndSetGraphicSelection` constructs
    // `SimpleRectangle(msgData[0], msgData[1], msgData[2], msgData[3])`).
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=21 views=1 isfirst=true");
        // Push a graphicselection for a 15.75×15.75 cm native image at
        // (100, 200) twips. 15.75 cm * 566.93 ≈ 8929 twips; the rect is
        // (100, 200, 9029, 9129) so width = height = 8929.
        ws.send("graphicselection: 100, 200, 9029, 9129, 0");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      // Yield so the post-load push is processed before the call.
      await new Promise((r) => setTimeout(r, 30));
      const rect = await client.getGraphicSelection(500);
      expect(rect).toEqual({ x1: 100, y1: 200, x2: 9029, y2: 9129 });
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("clearGraphicSelectionCache forces a fresh await (cache cleared)", async () => {
    // The agent image-insert flow clears the cache BEFORE `insertfile` so a
    // stale rect from a prior selection is not returned. After clearing,
    // `getGraphicSelection` awaits a fresh push (cache miss → null on
    // timeout when no new push arrives).
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=22 views=1 isfirst=true");
        ws.send("graphicselection: 100, 200, 1100, 1200, 0");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      await new Promise((r) => setTimeout(r, 30));
      // Cache hit before clear.
      const rectBefore = await client.getGraphicSelection(500);
      expect(rectBefore).toEqual({ x1: 100, y1: 200, x2: 1100, y2: 1200 });
      // Clear → cache miss → short timeout → null (no new push arrives).
      client.clearGraphicSelectionCache();
      const rectAfter = await client.getGraphicSelection(150);
      expect(rectAfter).toBeNull();
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getGraphicSelection treats EMPTY as null (kit deselected — cache cleared, no rect)", async () => {
    // Grounded: `graphicselection: EMPTY` clears the selection
    // (GraphicSelectionMiddleware.ts:331 — `if (textMsg.match('EMPTY'))`).
    // The agent path treats EMPTY as null (no rect to size against).
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=23 views=1 isfirst=true");
        // First a real selection, then EMPTY.
        ws.send("graphicselection: 100, 200, 1100, 1200, 0");
        ws.send("graphicselection: EMPTY");
        return;
      }
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      // Yield so both pushes are processed.
      await new Promise((r) => setTimeout(r, 30));
      // EMPTY cleared the cache → no rect; await times out → null.
      const rect = await client.getGraphicSelection(150);
      expect(rect).toBeNull();
      client.close();
    } finally {
      onClientLine = null;
    }
  });

  test("getGraphicSelection resolves null on timeout when no push arrives", async () => {
    onClientLine = (line, ws) => {
      if (line.startsWith("coolclient ")) return;
      if (line.startsWith("load url=")) {
        ws.send("loaded: viewid=24 views=1 isfirst=true");
        return;
      }
      // Swallow without replying.
    };
    try {
      const client = new CoolSessionClient({
        wsBaseUrl: wsBase(),
        docUrl: DOC_URL,
        wopiSrc: WOPI_SRC,
        serviceRoot: "/office-engine",
        timeoutMs: 2000,
      });
      await client.connect();
      const rect = await client.getGraphicSelection(150);
      expect(rect).toBeNull();
      client.close();
    } finally {
      onClientLine = null;
    }
  });
});

// ─── readImagePixelSize: deterministic native-aspect parser ──────────
// `readImagePixelSize` parses PNG IHDR + JPEG SOF headers so the
// `insert_image` placement compute no longer depends on the flaky
// `graphicselection:` echo. These tests verify the parser with real
// header byte fixtures (and an unknown format → null).
describe("readImagePixelSize", () => {
  test("PNG: parses IHDR width/height (big-endian uint32 at offset 16/20)", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    const w = 1920;
    const h = 1080;
    bytes[16] = (w >>> 24) & 0xff;
    bytes[17] = (w >>> 16) & 0xff;
    bytes[18] = (w >>> 8) & 0xff;
    bytes[19] = w & 0xff;
    bytes[20] = (h >>> 24) & 0xff;
    bytes[21] = (h >>> 16) & 0xff;
    bytes[22] = (h >>> 8) & 0xff;
    bytes[23] = h & 0xff;
    expect(readImagePixelSize(bytes)).toEqual({ w: 1920, h: 1080 });
  });

  test("PNG: large dims (4000×3000) parse correctly across all 4 bytes", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    // 4000 = 0x0FA0, 3000 = 0x0BB8.
    bytes[16] = 0x00; bytes[17] = 0x00; bytes[18] = 0x0f; bytes[19] = 0xa0;
    bytes[20] = 0x00; bytes[21] = 0x00; bytes[22] = 0x0b; bytes[23] = 0xb8;
    expect(readImagePixelSize(bytes)).toEqual({ w: 4000, h: 3000 });
  });

  test("PNG: truncated header (< 24 bytes) → null", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("PNG: valid signature but missing IHDR chunk marker → null", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // Leave bytes 12..15 as zeros (NOT "IHDR") — the parser must reject.
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("JPEG: parses SOF0 marker (height/width big-endian after segLen+precision)", () => {
    // FF D8 FF C0 00 11 08 02 58 03 20 ... → height=0x0258=600, width=0x0320=800.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0,
      0x00, 0x11,
      0x08,
      0x02, 0x58, // height = 600
      0x03, 0x20, // width = 800
      0x01, 0x01, 0x11, 0x00,
    ]);
    expect(readImagePixelSize(bytes)).toEqual({ w: 800, h: 600 });
  });

  test("JPEG: parses SOF2 (progressive) marker the same as SOF0", () => {
    // FF D8 FF C2 00 11 08 04 38 07 80 ... → height=0x0438=1080, width=0x0780=1920.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc2,
      0x00, 0x11,
      0x08,
      0x04, 0x38, // height = 1080
      0x07, 0x80, // width = 1920
      0x01, 0x01, 0x11, 0x00,
    ]);
    expect(readImagePixelSize(bytes)).toEqual({ w: 1920, h: 1080 });
  });

  test("JPEG: skips APP0 (FFE0) before SOF0 — the common JFIF layout", () => {
    // SOI + APP0 (marker + 16-byte segment) + SOF0 with h=600, w=800.
    // APP0: FF E0 00 10 + 14 bytes payload (bytes 2..19).
    // SOF0: FF C0 00 11 08 02 58 03 20 ... (bytes 20..).
    const bytes = new Uint8Array(31);
    bytes[0] = 0xff; bytes[1] = 0xd8;        // SOI
    bytes[2] = 0xff; bytes[3] = 0xe0;        // APP0 marker
    bytes[4] = 0x00; bytes[5] = 0x10;        // segLen = 16
    for (let i = 6; i <= 19; i++) bytes[i] = 0x00; // 14 bytes payload
    bytes[20] = 0xff; bytes[21] = 0xc0;      // SOF0 marker
    bytes[22] = 0x00; bytes[23] = 0x11;      // segLen = 17
    bytes[24] = 0x08;                         // precision
    bytes[25] = 0x02; bytes[26] = 0x58;      // height = 600
    bytes[27] = 0x03; bytes[28] = 0x20;      // width = 800
    bytes[29] = 0x01; bytes[30] = 0x01;      // filler
    expect(readImagePixelSize(bytes)).toEqual({ w: 800, h: 600 });
  });

  test("JPEG: no SOF before SOS → null", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x05, 0x01, 0x01, 0x00]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("unknown format (e.g. GIF magic) → null", () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00]);
    expect(readImagePixelSize(bytes)).toBeNull();
  });

  test("empty / too-short buffer → null", () => {
    expect(readImagePixelSize(new Uint8Array(0))).toBeNull();
    expect(readImagePixelSize(new Uint8Array(4))).toBeNull();
  });
});

// ─── resizeImageToCm: sizing-via-bytes resample (D362 second wave) ────
// `resizeImageToCm` resamples image bytes so the intrinsic pixel size
// equals the target cm rect at the engine's insert DPI — the fix for
// coolwsd's broken TransformDialog Width/Height (sizing is now done
// BEFORE insert, not after). These tests verify the cm→px math, the
// PNG round-trip via jimp, and the defensive "return original on
// failure" path.
describe("resizeImageToCm", () => {
  /** Build a real decodable PNG of the given pixel dims (jimp-produced). */
  async function realPng(pxW: number, pxH: number): Promise<Uint8Array> {
    const img = new Jimp({ width: pxW, height: pxH, color: 0xff0000ff });
    const buf = await img.getBuffer(JimpMime.png);
    return new Uint8Array(buf);
  }

  test("resamples to the expected pixel dims for a given cm + dpi (8×3cm @96dpi → 302×113 px)", async () => {
    // 8cm @ 96dpi = round(8/2.54 * 96) = round(302.36) = 302
    // 3cm @ 96dpi = round(3/2.54 * 96) = round(113.39) = 113
    const input = await realPng(800, 600);
    const out = await resizeImageToCm(input, 8, 3, 96);
    // Output is a PNG — jimp decodes it and we verify the pixel dims.
    const decoded = await Jimp.read(Buffer.from(out));
    expect(decoded.width).toBe(302);
    expect(decoded.height).toBe(113);
  });

  test("defaults dpi to LO_INSERT_DPI (96)", async () => {
    // Same as above but without passing dpi explicitly — the default
    // `LO_INSERT_DPI` constant (96) applies.
    const input = await realPng(400, 400);
    const out = await resizeImageToCm(input, 8, 3);
    const decoded = await Jimp.read(Buffer.from(out));
    expect(decoded.width).toBe(302);
    expect(decoded.height).toBe(113);
    // The constant is exported and matches the documented first guess.
    expect(LO_INSERT_DPI).toBe(96);
  });

  test("a different dpi scales the pixel dims accordingly (8×3cm @144dpi → 454×170 px)", async () => {
    // 8cm @ 144dpi = round(8/2.54 * 144) = round(453.54) = 454
    // 3cm @ 144dpi = round(3/2.54 * 144) = round(170.08) = 170
    const input = await realPng(1000, 1000);
    const out = await resizeImageToCm(input, 8, 3, 144);
    const decoded = await Jimp.read(Buffer.from(out));
    expect(decoded.width).toBe(454);
    expect(decoded.height).toBe(170);
  });

  test("output is always PNG regardless of input format (normalizes JPEG → PNG)", async () => {
    // Build a real JPEG with jimp and resize — the output must be a PNG
    // (the helper re-encodes as PNG to normalize EXIF / colour-profile
    // quirks). Assert via the PNG signature in the output bytes.
    const img = new Jimp({ width: 200, height: 200, color: 0x00ff00ff });
    const jpegBytes = new Uint8Array(await img.getBuffer(JimpMime.jpeg));
    const out = await resizeImageToCm(jpegBytes, 5, 5, 96);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    expect(out[0]).toBe(0x89);
    expect(out[1]).toBe(0x50);
    expect(out[2]).toBe(0x4e);
    expect(out[3]).toBe(0x47);
    // Decoded dims = round(5/2.54 * 96) = round(188.97) = 189.
    const decoded = await Jimp.read(Buffer.from(out));
    expect(decoded.width).toBe(189);
    expect(decoded.height).toBe(189);
  });

  test("defensive: returns the ORIGINAL bytes when jimp cannot decode (unknown format)", async () => {
    // Garbage bytes — jimp throws on read; the helper returns the input
    // unchanged so the insert still proceeds (the orchestrator's live
    // calibration surfaces any consistent mismatch as a k-factor).
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const out = await resizeImageToCm(garbage, 8, 3, 96);
    expect(Array.from(out)).toEqual(Array.from(garbage));
  });

  test("defensive: returns the ORIGINAL bytes on empty input", async () => {
    const empty = new Uint8Array(0);
    const out = await resizeImageToCm(empty, 8, 3, 96);
    expect(out).toBe(empty);
  });

  test("defensive: returns the ORIGINAL bytes for non-positive / non-finite cm dims", async () => {
    const input = await realPng(100, 100);
    const out0 = await resizeImageToCm(input, 0, 3, 96);
    expect(out0).toBe(input);
    const outNeg = await resizeImageToCm(input, -1, 3, 96);
    expect(outNeg).toBe(input);
    const outNaN = await resizeImageToCm(input, Number.NaN, 3, 96);
    expect(outNaN).toBe(input);
  });

  test("defensive: returns the ORIGINAL bytes for non-positive / non-finite dpi", async () => {
    const input = await realPng(100, 100);
    const out0 = await resizeImageToCm(input, 8, 3, 0);
    expect(out0).toBe(input);
    const outNeg = await resizeImageToCm(input, 8, 3, -96);
    expect(outNeg).toBe(input);
    const outNaN = await resizeImageToCm(input, 8, 3, Number.NaN);
    expect(outNaN).toBe(input);
  });
});

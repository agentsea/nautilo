/**
 * Stack 200 — focused regression for the full-width management-route
 * classification.
 *
 * Scheduled Tasks (D406) and Connections (D384) were folded into the existing
 * `fullWidthManagementRoute` family used by Memory / Commands / Skills /
 * Approvals / Settings / Admin. That predicate decides whether the shell hides
 * BOTH side panels (left explorer + right context/chat) and lets the routed
 * page own the center column.
 *
 * The predicate lives in `is-full-width-management-route.ts` as a pure helper
 * importable without the shell's Vite module graph. The shell consumes it for
 * layout; this suite locks the classification matrix and wiring contracts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFullWidthManagementRoute } from "../../src/layouts/is-full-width-management-route";

const shellSource = readFileSync(
  join(import.meta.dir, "../../src/layouts/workbench-shell.tsx"),
  "utf8",
);

const helperSource = readFileSync(
  join(import.meta.dir, "../../src/layouts/is-full-width-management-route.ts"),
  "utf8",
);

describe("isFullWidthManagementRoute — durable management destinations", () => {
  test.each([
    ["/settings"],
    ["/admin"],
    ["/help"],
    ["/help/server"],
    ["/approvals"],
    ["/skills"],
    ["/skills/new"],
    ["/skills/my-skill"],
    ["/commands"],
    ["/commands/my-command"],
    ["/memory"],
    ["/memory/abc-123"],
  ])("classifies legacy management route %s as full-width", (pathname) => {
    expect(isFullWidthManagementRoute(pathname)).toBe(true);
  });

  for (const pathname of [
    "/scheduled-tasks",
    // Stack 200 — D406 Scheduled Tasks is now a real full-width management
    // route. No routed sub-pages today, but a deep link must still classify.
    "/scheduled-tasks/anything",
  ]) {
    test(`classifies D406 scheduled-tasks route ${pathname} as full-width`, () => {
      expect(isFullWidthManagementRoute(pathname)).toBe(true);
    });
  }

  for (const pathname of [
    "/connections",
    // Stack 200 — D384 Connections joins the management family; the routed
    // per-server detail page must classify too.
    "/connections/my-server",
  ]) {
    test(`classifies D384 connections route ${pathname} as full-width`, () => {
      expect(isFullWidthManagementRoute(pathname)).toBe(true);
    });
  }
});

describe("isFullWidthManagementRoute — non-management routes stay narrow", () => {
  test.each([
    ["/"],
    ["/rooms/abc"],
    ["/rooms/abc/threads/def"],
    ["/info"],
    ["/costs"],
    ["/auth/callback"],
    ["/invite/token"],
  ])("does NOT classify normal route %s as full-width (keeps both panels)", (pathname) => {
    expect(isFullWidthManagementRoute(pathname)).toBe(false);
  });

  test("empty string is not classified", () => {
    expect(isFullWidthManagementRoute("")).toBe(false);
  });

  test("startsWith shape: a sibling sharing a management prefix also classifies (locked)", () => {
    // `startsWith("/memory")` matches `/memory-lane` too. There is no
    // `/memory-lane` route today (the only `/memory/*` sub-route is `:id`),
    // so this is harmless — but lock the `startsWith` shape so a future
    // tightening to an exact match is a deliberate, visible diff.
    expect(isFullWidthManagementRoute("/memory-lane")).toBe(true);
  });
});

describe("isFullWidthManagementRoute — temporary work surfaces stay out", () => {
  // The shell's WorkSurfaceState (file / app / saas-app / office-doc /
  // app-source / apps-overview / app-detail / terminal) is intentionally NOT
  // routed — those are in-memory surfaces launched from the rail/files. They
  // must stay out of the predicate so they keep their existing side-panel
  // behavior (reader chat rail, saas-app chat toggle, …). There is no
  // pathname for them; the assertion is that the predicate does not grow a
  // `startsWith` that would sweep a future routed temporary surface.
  test("the durable management prefixes include the Server Guide", () => {
    const durable = [
      "/settings",
      "/admin",
      "/help",
      "/approvals",
      "/skills",
      "/commands",
      "/memory",
      "/scheduled-tasks",
      "/connections",
    ];
    for (const p of durable) {
      expect(isFullWidthManagementRoute(p)).toBe(true);
    }
  });

  test("temporary / non-durable prefixes are NOT classified", () => {
    expect(isFullWidthManagementRoute("/files")).toBe(false);
    expect(isFullWidthManagementRoute("/terminal")).toBe(false);
    expect(isFullWidthManagementRoute("/apps")).toBe(false);
    expect(isFullWidthManagementRoute("/apps-overview")).toBe(false);
  });
});

describe("isFullWidthManagementRoute — source-level contract (regression guard)", () => {
  test("the predicate body names every durable management prefix", () => {
    expect(helperSource).toContain('export function isFullWidthManagementRoute');
    expect(helperSource).toContain('pathname === "/settings"');
    expect(helperSource).toContain('pathname === "/admin"');
    expect(helperSource).toContain('pathname === "/help"');
    expect(helperSource).toContain('pathname.startsWith("/help/")');
    expect(helperSource).toContain('pathname === "/approvals"');
    expect(helperSource).toContain('pathname.startsWith("/skills")');
    expect(helperSource).toContain('pathname.startsWith("/commands")');
    expect(helperSource).toContain('pathname.startsWith("/memory")');
    expect(helperSource).toContain('pathname.startsWith("/scheduled-tasks")');
    expect(helperSource).toContain('pathname.startsWith("/connections")');
  });

  test("the shell consumes the helper (no inline duplicate predicate)", () => {
    expect(shellSource).toContain(
      'import { isFullWidthManagementRoute } from "./is-full-width-management-route";',
    );
    expect(shellSource).toContain(
      "const fullWidthManagementRoute = isFullWidthManagementRoute(location.pathname);",
    );
  });

  test("the scheduled-tasks work-surface state and rail interception are gone", () => {
    expect(shellSource).not.toContain('kind: "scheduled-tasks"');
    expect(shellSource).not.toContain("openScheduledTasks");
    expect(shellSource).not.toContain("scheduledTasksWorkSurface");
    expect(shellSource).not.toContain("onRouteClickIntercept");
    expect(shellSource).not.toContain("activeRouteOverrides");
    expect(shellSource).not.toContain(
      'import { ScheduledTasksSurface }',
    );
  });
});

"use strict";

/**
 * Subprocess: read one JSON line from stdin (a PortBundle-shaped object),
 * try to bind each TCP port on 127.0.0.1 in order, exit 0 if all succeed.
 * Exit 2 if any port cannot be bound (EADDRINUSE / listen error).
 * Exit 3 on unexpected failure.
 *
 * Invoked synchronously from {@link ../host-port-liveness.ts} via spawnSync.
 */
const net = require("node:net");
const fs = require("node:fs");

const host = process.env.NAUTILO_PORT_BIND_PROBE_HOST || "127.0.0.1";

let raw;
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(3);
}

let bundle;
try {
  bundle = JSON.parse(raw);
} catch {
  process.exit(3);
}

const ports = [
  bundle.workbench,
  bundle.server,
  bundle.dbPostgres,
  bundle.logtoDb,
  bundle.logtoCore,
  bundle.logtoAdmin,
];

function tryListenOnce(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    const done = (ok) => {
      s.removeAllListeners();
      s.close(() => resolve(ok));
    };
    s.once("error", () => done(false));
    s.listen(port, host, () => done(true));
  });
}

(async () => {
  try {
    for (const p of ports) {
      if (!(await tryListenOnce(p))) {
        process.exit(2);
      }
    }
    process.exit(0);
  } catch {
    process.exit(3);
  }
})();

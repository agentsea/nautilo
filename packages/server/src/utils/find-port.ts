import { createServer } from "node:net";

/**
 * Find an available TCP port, starting from `preferred` and incrementing.
 * Tries up to `maxAttempts` ports before giving up.
 */
export async function findAvailablePort(
  preferred: number,
  maxAttempts = 20
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = preferred + attempt;
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  throw new Error(
    `No available port found in range ${preferred}-${preferred + maxAttempts - 1}`
  );
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    // A concurrent readiness probe can connect during the brief interval
    // between listen() and close(). Reject it immediately; otherwise
    // server.close() waits for that raw TCP client while the client waits
    // forever for an HTTP response this probe server cannot provide.
    server.on("connection", (socket) => {
      socket.destroy();
    });
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

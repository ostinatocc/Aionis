import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const port = Number.parseInt(argValue("--port") ?? "0", 10);
const pidFile = argValue("--pid-file");
const logFile = argValue("--log-file");
if (!Number.isInteger(port) || port <= 0 || !pidFile || !logFile) {
  console.error("usage: node service-lifecycle-hard-server.mjs --port <port> --pid-file <path> --log-file <path>");
  process.exit(2);
}

for (const file of [pidFile, logFile]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

const startedAt = Date.now();

function appendLog(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      lifecycle: "hard",
      pid: process.pid,
      port,
      uptime_ms: Date.now() - startedAt,
    }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found\n");
});

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(pidFile, `${JSON.stringify({ pid: process.pid, port, started_at_ms: startedAt })}\n`);
  appendLog(`service_lifecycle_hard_started pid=${process.pid} port=${port}`);
  process.stdout.write(`service-lifecycle-hard-server listening on 127.0.0.1:${port}\n`);
});

function shutdown() {
  appendLog(`service_lifecycle_hard_stopping pid=${process.pid}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import http from "node:http";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const port = Number.parseInt(argValue("--port") ?? "0", 10);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node service-after-exit-server.mjs --port <port>");
  process.exit(2);
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found\n");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`service-after-exit-server listening on 127.0.0.1:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

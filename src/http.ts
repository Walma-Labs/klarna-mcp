// Streamable-HTTP entrypoint: stateless, one server instance per request.
// Suitable for running in a container (PORT env) or as a reference for
// mounting createKlarnaServer() behind another HTTP host.
//
// No auth here by design. Anyone who can reach this port can use the Klarna
// credentials in its environment (and the write tools, if enabled). Put your
// own authenticating gateway in front, and never expose it publicly.

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createKlarnaServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (req.method !== "POST") {
    // Stateless mode: no GET event stream, no session to DELETE.
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }
  try {
    const server = createKlarnaServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(`klarna-mcp listening on http://0.0.0.0:${PORT} (streamable HTTP, stateless)`);
});

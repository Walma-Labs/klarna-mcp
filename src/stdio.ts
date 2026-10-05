#!/usr/bin/env node
// stdio entrypoint: what the `klarna-mcp` bin runs, for Claude Code,
// Claude Desktop, Cursor and any stdio MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKlarnaServer } from "./server.js";

const server = createKlarnaServer();
await server.connect(new StdioServerTransport());

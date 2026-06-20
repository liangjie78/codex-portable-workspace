#!/usr/bin/env node
process.argv.push("--setup");
await import("../src/cc-switch-worker-mcp.mjs");

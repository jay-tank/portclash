"use strict";

// Workspace fixtures shared by the unit test and the in-editor test.

const fs = require("fs");
const path = require("path");

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/**
 * The monorepo from the article: compose api on ${API_PORT:-8080} with API_PORT=3000 in .env
 * and apps/web running next dev (default 3000) -> PC001; billing Postgres published twice on
 * 5432 -> PC001 + PC003; flask on 5000 -> PC002; a PORT fallback in apps/api -> PC004.
 */
function makeMonorepo(root) {
  write(root, "compose.yaml", [
    "services:",
    "  api:",
    "    build: ./apps/api",
    "    ports:",
    '      - "${API_PORT:-8080}:8080"',
    "    environment:",
    "      PORT: 8080",
    "  postgres:",
    "    image: postgres:16",
    "    ports:",
    '      - "5432:5432"',
    "  redis:",
    "    image: redis:7",
    "    ports:",
    '      - "127.0.0.1:6379:6379"',
    "",
  ].join("\n"));
  write(root, ".env", "API_PORT=3000\nDB_PORT=5432\n");
  write(root, "billing/docker-compose.yml", [
    "services:",
    "  billing-postgres:",
    "    image: postgres:16",
    "    ports:",
    '      - "5432:5432"',
    "",
  ].join("\n"));
  write(root, "apps/web/package.json", JSON.stringify({ name: "web", scripts: { dev: "next dev", start: "next start" } }, null, 2) + "\n");
  write(root, "apps/admin/package.json", JSON.stringify({ name: "admin", scripts: { dev: "vite" } }, null, 2) + "\n");
  write(root, "apps/admin/vite.config.ts", "import { defineConfig } from 'vite';\nexport default defineConfig({\n  server: {\n    port: 5174,\n    strictPort: true,\n  },\n});\n");
  write(root, "apps/api/package.json", JSON.stringify({ name: "api", scripts: { start: "node src/index.js" } }, null, 2) + "\n");
  write(root, "apps/api/src/index.js", "const http = require('http');\nconst port = process.env.PORT || 3000;\nhttp.createServer(() => {}).listen(port);\n");
  write(root, "py/Procfile", "web: flask run\n");
  write(root, ".devcontainer/devcontainer.json", '{\n  // forwarded, never a clash\n  "forwardPorts": [3000, 5432],\n}\n');
  return root;
}

/** A workspace with no declared ports at all (empty state). */
function makeEmpty(root) {
  write(root, "README.md", "# nothing to see\n");
  write(root, "src/util.js", "module.exports = (a, b) => a + b;\n");
  return root;
}

module.exports = { write, makeMonorepo, makeEmpty };

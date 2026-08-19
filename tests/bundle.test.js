import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const bundle = join(root, "dist", "read-the-room-server.js");

test("the committed bundle starts and exposes the keyed door", async () => {
  assert.equal(existsSync(bundle), true, "run npm run build and commit the bundle");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "bundle-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["read_the_room"]);
    assert.deepEqual(
      Object.keys(tools.tools[0].inputSchema.properties),
      ["note", "key", "affirm", "stay"],
    );
  } finally {
    await client.close();
  }
});

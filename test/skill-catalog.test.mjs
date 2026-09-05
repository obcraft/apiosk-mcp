import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";

import { createApioskMcpServer } from "../src/create-server.mjs";
import {
  APIO_SKILL_DESCRIPTION,
  APIO_SKILL_NAME,
  buildApioskSkillEntry,
  readApioskSkillResource,
} from "../src/skill-catalog.mjs";

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

test("the bundled Apiosk skill has exact frontmatter and valid resource digests", async () => {
  const entry = await buildApioskSkillEntry();
  assert.equal(entry.uri, "skill://apiosk/apiosk/SKILL.md");
  assert.deepEqual(entry.frontmatter, {
    name: APIO_SKILL_NAME,
    description: APIO_SKILL_DESCRIPTION,
  });
  assert.equal(entry.resources.length, 2);

  for (const resource of entry.resources) {
    assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);
    const content = await readApioskSkillResource(resource.uri);
    assert.ok(content, `${resource.uri} must be readable`);
    assert.equal(resource.digest, sha256(content.text));
  }

  const manifest = await readApioskSkillResource(entry.uri);
  assert.match(
    manifest.text,
    new RegExp(`^---\\nname: ${APIO_SKILL_NAME}\\ndescription: ${APIO_SKILL_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n---\\n`),
  );
});

test("the live MCP protocol advertises and serves the skills extension", async () => {
  const server = createApioskMcpServer({
    runtime: {
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
    },
  });
  const client = new Client({ name: "skill-import-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  assert.deepEqual(client.getServerCapabilities().extensions, {
    "io.modelcontextprotocol/skills": {},
  });

  const listed = await client.request(
    { method: "skills/list", params: {} },
    z.object({ skills: z.array(z.any()), nextCursor: z.string().optional() }),
  );
  assert.equal(listed.skills.length, 1);

  const fetched = await client.request(
    { method: "skills/get", params: { uri: listed.skills[0].uri } },
    z.object({ skill: z.any() }),
  );
  assert.deepEqual(fetched.skill, listed.skills[0]);

  for (const resource of fetched.skill.resources) {
    const read = await client.readResource({ uri: resource.uri });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, resource.uri);
  }

  await client.close();
  await server.close();
});

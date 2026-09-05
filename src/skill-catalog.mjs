import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as z from "zod/v4";

export const APIO_SKILL_NAME = "apiosk";
export const APIO_SKILL_DESCRIPTION =
  "Find, compare, price, and run external API services through Apiosk. Use when the user needs live or specialized data such as company records, financial data, weather, geocoding, OCR, enrichment, translation, scraping, or another API capability. Apiosk shows the exact price before a paid call and uses the user's connected balance and spending policy.";

const SKILL_ROOT = new URL("../plugin/apiosk/skills/apiosk/", import.meta.url);
const SKILL_URI_ROOT = "skill://apiosk/apiosk/";
const SKILL_FILES = [
  { path: "SKILL.md", mimeType: "text/markdown" },
  { path: "agents/openai.yaml", mimeType: "application/yaml" },
];

export const ListSkillsRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

export const GetSkillRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }),
});

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fileForUri(uri) {
  if (!uri.startsWith(SKILL_URI_ROOT)) return null;
  const path = uri.slice(SKILL_URI_ROOT.length);
  return SKILL_FILES.find((file) => file.path === path) || null;
}

async function loadFile(file) {
  const bytes = await readFile(new URL(file.path, SKILL_ROOT));
  return {
    ...file,
    uri: `${SKILL_URI_ROOT}${file.path}`,
    bytes,
    digest: digest(bytes),
  };
}

export async function buildApioskSkillEntry() {
  const files = await Promise.all(SKILL_FILES.map(loadFile));
  return {
    uri: `${SKILL_URI_ROOT}SKILL.md`,
    frontmatter: {
      name: APIO_SKILL_NAME,
      description: APIO_SKILL_DESCRIPTION,
    },
    resources: files.map(({ uri, digest: sha256 }) => ({ uri, digest: sha256 })),
  };
}

export async function listApioskSkills() {
  return { skills: [await buildApioskSkillEntry()] };
}

export async function getApioskSkill(uri) {
  const skill = await buildApioskSkillEntry();
  if (uri !== skill.uri) throw new Error("Unknown Apiosk skill");
  return { skill };
}

export async function readApioskSkillResource(uri) {
  const file = fileForUri(uri);
  if (!file) return null;
  const loaded = await loadFile(file);
  return {
    uri,
    mimeType: loaded.mimeType,
    text: loaded.bytes.toString("utf8"),
  };
}

export async function listApioskSkillResources() {
  const files = await Promise.all(SKILL_FILES.map(loadFile));
  return files.map(({ uri, mimeType }) => ({
    uri,
    name: uri.slice(SKILL_URI_ROOT.length),
    mimeType,
  }));
}

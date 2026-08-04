#!/usr/bin/env node
/**
 * One-time migration script: compresses all existing scene_blocks/*.md
 * files to <=2000 chars by calling an LLM to rewrite them as concise
 * summaries. Also backs up + deletes persona.md (L3 auto-generation
 * disabled in redesign).
 *
 * Usage:
 *   node scripts/migrate-l2-compress.mjs --data-dir ~/.openclaw/memory-tdai --model gpt-4o
 *
 * Requires OpenAI-compatible env vars (OPENAI_API_KEY, OPENAI_BASE_URL) or
 * flags. This script does NOT use the plugin's host LLM — it calls the
 * API directly to keep the migration independent of plugin runtime.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const dataDir = args["data-dir"];
const model = args.model || "gpt-4o";
const baseUrl = args["base-url"] || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const apiKey = args["api-key"] || process.env.OPENAI_API_KEY;

if (!dataDir) {
  console.error("Error: --data-dir is required");
  process.exit(1);
}
if (!apiKey) {
  console.error("Error: API key required (OPENAI_API_KEY or --api-key)");
  process.exit(1);
}

const sceneBlocksDir = path.join(dataDir, "scene_blocks");
const backupDir = path.join(dataDir, ".backup", "pre-redesign-2026-08-04");
const personaPath = path.join(dataDir, "persona.md");

console.log(`[migrate] data-dir: ${dataDir}`);
console.log(`[migrate] model: ${model}`);

// Step 1: Back up persona.md and remove
try {
  const personaRaw = await fs.readFile(personaPath, "utf-8");
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, "persona.md"), personaRaw, "utf-8");
  await fs.unlink(personaPath);
  console.log(`[migrate] persona.md backed up + removed`);
} catch (err) {
  if (err.code !== "ENOENT") {
    console.warn(`[migrate] persona.md handling failed: ${err.message}`);
  } else {
    console.log(`[migrate] persona.md not present, skipping`);
  }
}

// Step 2: List scene files
let sceneFiles;
try {
  const entries = await fs.readdir(sceneBlocksDir, { withFileTypes: true });
  sceneFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
} catch (err) {
  if (err.code === "ENOENT") {
    console.log(`[migrate] scene_blocks/ not present, nothing to compress`);
    process.exit(0);
  }
  throw err;
}

console.log(`[migrate] found ${sceneFiles.length} scene files to compress`);

// Step 3: Compress each file
let success = 0;
let failed = 0;
for (const file of sceneFiles) {
  try {
    const filePath = path.join(sceneBlocksDir, file);
    const raw = await fs.readFile(filePath, "utf-8");

    // Skip if already small
    if (raw.length <= 2000) {
      console.log(`[migrate] ${file}: already ${raw.length} chars, skipping`);
      success++;
      continue;
    }

    // Backup original
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, file), raw, "utf-8");

    // Call LLM
    const compressed = await compressWithLLM(raw, file, model, baseUrl, apiKey);
    await fs.writeFile(filePath, compressed, "utf-8");
    console.log(`[migrate] ${file}: ${raw.length} → ${compressed.length} chars`);
    success++;
  } catch (err) {
    console.error(`[migrate] ${file} FAILED: ${err.message}`);
    failed++;
  }
}

console.log(`[migrate] done: ${success} succeeded, ${failed} failed`);
console.log(`[migrate] backups in: ${backupDir}`);

async function compressWithLLM(raw, filename, model, baseUrl, apiKey) {
  const prompt = `You are compressing a memory scene block file for a personal AI memory system.

Rewrite the following scene file as a concise summary that:
1. Preserves all facts, decisions, long-term preferences, and key event timestamps
2. Removes incremental batch markers like "[本批次 X 增量 · ...]" (these are noise)
3. Removes duplicate narratives and temporary state
4. Keeps the META header structure (preserve created/updated; update updated to current time)
5. Output length MUST be <= 2000 characters total (including META header)
6. Output must be valid Markdown with the same section structure
7. Output ONLY the new file content, no explanations

Filename: ${filename}

Original content:
\`\`\`markdown
${raw}
\`\`\`

Compressed version (<=2000 chars, valid META header + Markdown body):`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

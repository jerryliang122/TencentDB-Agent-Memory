/**
 * Scene Block file format (v2): lightweight "active work theme" registry.
 *
 * A scene block is no longer a narrative profile — it is a pointer view:
 *
 *   - META header: title, timestamps, one-line summary, memory count
 *   - Body: memory pointers (L1 record id + date + content head)
 *
 * Deep content always lives in L1 (queryable via tdai_memory_search); the
 * scene file only tells the agent *that* a recurring theme exists, *when*
 * it was active, and *where* to dig for details.
 *
 * v1 files (LLM-written narrative + heat META) are migrated lazily by
 * migrateLegacyScene(): healthy ones are converted to v2, husks (bodies
 * wiped by the old truncation guardrail) are archived away by the caller.
 */

export const META_START = "-----META-START-----";
export const META_END = "-----META-END-----";

export interface SceneMetaV2 {
  title: string;
  /** When the scene block file was created (not the work's start). */
  created: string;
  /** Last time the file content changed (metadata refreshes bump this). */
  updated: string;
  /** Earliest member-memory timestamp — activity range start. */
  first_active: string;
  /** Latest member-memory timestamp — activity range end, TTL eviction key. */
  last_active: string;
  /** One-line current-state summary (≤ summaryMaxChars, regenerated fresh). */
  summary: string;
  /** Number of L1 memories pointed to by this scene. */
  memory_count: number;
}

export interface ScenePointer {
  id: string;
  /** ISO date (date-only form kept as-is) of the member memory. */
  ts: string;
  /** Short content head for human/tool readability. */
  head: string;
}

export interface SceneBlockV2 {
  meta: SceneMetaV2;
  pointers: ScenePointer[];
}

/** Max pointers written into the .md body (state file keeps the full list). */
export const MAX_FILE_POINTERS = 100;

/** Default cap for the one-line summary. */
export const SUMMARY_MAX_CHARS = 80;

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const EMBEDDED_ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?/;

// ============================
// v2 parse / format
// ============================

/**
 * Parse a v2 scene file. Returns null when the file is not v2 format
 * (missing title field or still carrying the legacy `heat` field) —
 * callers should run migrateLegacyScene() on such files first.
 */
export function parseSceneFileV2(raw: string): SceneBlockV2 | null {
  const metaBlock = extractMetaBlock(raw);
  if (!metaBlock) return null;
  const title = extractMetaField(metaBlock, "title");
  if (!title || extractMetaField(metaBlock, "heat")) return null;

  const meta: SceneMetaV2 = {
    title,
    created: extractMetaField(metaBlock, "created"),
    updated: extractMetaField(metaBlock, "updated"),
    first_active: extractMetaField(metaBlock, "first_active"),
    last_active: extractMetaField(metaBlock, "last_active"),
    summary: extractMetaField(metaBlock, "summary"),
    memory_count: parseInt(extractMetaField(metaBlock, "memory_count"), 10) || 0,
  };
  return { meta, pointers: parsePointers(extractBody(raw)) };
}

export function formatSceneFileV2(meta: SceneMetaV2, pointers: ScenePointer[]): string {
  const metaText = [
    META_START,
    `title: ${meta.title}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `first_active: ${meta.first_active}`,
    `last_active: ${meta.last_active}`,
    `summary: ${meta.summary}`,
    `memory_count: ${meta.memory_count}`,
    META_END,
  ].join("\n");

  const shown = pointers.slice(0, MAX_FILE_POINTERS);
  const lines = shown.map((p) => `- ${p.id} | ${p.ts || "(无时间)"} | ${p.head}`);
  if (pointers.length > shown.length) {
    lines.push(`- …另有 ${pointers.length - shown.length} 条记忆(完整列表见 scene_state.json)`);
  }
  return `${metaText}\n\n## Memory Pointers\n${lines.join("\n")}\n`;
}

function parsePointers(body: string): ScenePointer[] {
  const pointers: ScenePointer[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^-\s+(\S+)\s+\|\s+([^|]*?)\s+\|\s+(.*)$/);
    if (m) pointers.push({ id: m[1]!, ts: m[2]!.trim(), head: m[3]!.trim() });
  }
  return pointers;
}

// ============================
// v1 → v2 migration
// ============================

export interface LegacyMigration {
  /** v2 block to write (only when healthy). */
  block: SceneBlockV2;
  /** false when the legacy file is a husk (wiped body / no recoverable signal). */
  healthy: boolean;
}

/**
 * Convert a legacy (v1, LLM-written) scene file to the v2 pointer format.
 *
 * Healthy files keep title (from filename stem) + a capped one-line summary +
 * activity times derived from the old META. Narrative bodies are dropped by
 * design — the content lives on in L1. Husks (body wiped by the old
 * truncation guardrail, or nothing but markers) are flagged unhealthy so the
 * caller can archive them.
 */
export function migrateLegacyScene(raw: string, filename: string, nowIso: string): LegacyMigration {
  const metaBlock = extractMetaBlock(raw) ?? "";
  const body = extractBody(raw).trim();

  const isHusk = body === ""
    || /^\[工程截断：.*\]$/.test(body)
    || body === "[DELETED]";
  if (isHusk) {
    return { block: emptyBlock(filename, nowIso), healthy: false };
  }

  const legacyCreated = repairTimestamp(extractMetaField(metaBlock, "created"), "");
  const legacyUpdated = repairTimestamp(extractMetaField(metaBlock, "updated"), "");
  const legacySummary = repairLegacySummary(extractMetaField(metaBlock, "summary"), body);

  return {
    block: {
      meta: {
        title: filename.replace(/\.md$/, ""),
        created: legacyCreated || nowIso,
        updated: nowIso,
        first_active: legacyCreated || nowIso,
        last_active: legacyUpdated || legacyCreated || nowIso,
        summary: legacySummary,
        memory_count: 0,
      },
      pointers: [],
    },
    healthy: legacySummary !== "" || body !== "",
  };
}

/**
 * v1 summaries were frequent corruption victims (swallowed field keys,
 * append-only changelogs). Keep a value only when it looks like prose;
 * otherwise derive a one-liner from the body's first heading/line.
 */
function repairLegacySummary(rawSummary: string, body: string): string {
  const trimmed = rawSummary.trim();
  const looksLikeKey = /^(?:created|updated|summary|heat|last_full_rewrite_at)\s*:/;
  const candidate = trimmed && !looksLikeKey.test(trimmed)
    ? trimmed
    : deriveSummaryFromBody(body);
  return capSummary(candidate);
}

function deriveSummaryFromBody(body: string): string {
  const lines = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).filter(Boolean);
  return lines[0] ?? "";
}

function capSummary(s: string): string {
  return capSceneSummary(s, SUMMARY_MAX_CHARS);
}

/** Truncate a summary to `maxChars` code points with an ellipsis marker. */
export function capSceneSummary(s: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}

function repairTimestamp(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed && ISO_TS_RE.test(trimmed)) return trimmed;
  return trimmed.match(EMBEDDED_ISO_TS_RE)?.[0] ?? fallback;
}

function emptyBlock(filename: string, nowIso: string): SceneBlockV2 {
  return {
    meta: {
      title: filename.replace(/\.md$/, ""),
      created: nowIso,
      updated: nowIso,
      first_active: nowIso,
      last_active: nowIso,
      summary: "",
      memory_count: 0,
    },
    pointers: [],
  };
}

// ============================
// Shared META helpers
// ============================

function extractMetaBlock(raw: string): string | null {
  const startIdx = raw.indexOf(META_START);
  const endIdx = startIdx === -1 ? -1 : raw.indexOf(META_END, startIdx + META_START.length);
  if (startIdx === -1 || endIdx === -1) return null;
  return raw.slice(startIdx + META_START.length, endIdx).trim();
}

function extractBody(raw: string): string {
  const startIdx = raw.indexOf(META_START);
  const endIdx = startIdx === -1 ? -1 : raw.indexOf(META_END, startIdx + META_START.length);
  if (endIdx === -1) return raw;
  return raw.slice(endIdx + META_END.length);
}

function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}

// ============================
// Filename sanitization (moved from the removed scene-extractor.ts)
// ============================

/**
 * Sanitize a scene title into a filesystem-safe stem (no extension).
 * Unicode letters/numbers + `-`/`_`/`.` allowed; whitespace runs become
 * single hyphens; shell/markdown-breaking punctuation is dropped.
 */
export function sanitizeSceneFilenameStem(title: string): string {
  if (!title) return "scene";
  const safe = title
    .replace(/[\s\u00A0\u3000]+/g, "-")
    .replace(/[()[\]{}<>'"`,;:!?*|/\\=&%$#@^~+]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return safe || "scene";
}

/**
 * Scene Synthesis Prompts — the only two LLM touchpoints in the v2 L2 flow.
 *
 *   1. Promotion: candidate pool reaches threshold → one call produces
 *      { title, summary } for the new scene block.
 *   2. Summary refresh: an existing scene accumulated enough new memories
 *      → one call regenerates the one-line current-state summary.
 *
 * Both are single-turn, text-only, JSON-output calls. The engineering
 * caller (scene-synthesizer.ts) validates and truncates everything — the
 * LLM never touches files.
 */

export interface SceneSynthesisSample {
  head: string;
  ts: string;
}

export const PROMOTION_SYSTEM_PROMPT = `You are a memory theme titler. Given a batch of memory snippets that all belong to one recurring work theme, produce a JSON object:

{"title": "<主题标题>", "summary": "<一句话现状>"}

Rules:
- Output language MUST match the dominant language of the snippets (Chinese in → Chinese out).
- "title": 8-20 字符的名词性标题,格式为「领域-主题」(如 "货运业务-LCL拼箱算法"、"基础设施-SSH密钥管理")。只含文字、数字、短横线,禁止空格和标点。
- "summary": ≤60字,描述该主题的当前状态/进展(不是变更历史,禁止出现"第N次"、"新增"、"heat"等字样)。
- Output ONLY the JSON object, no markdown fences, no commentary.`;

export const REFRESH_SYSTEM_PROMPT = `You are a memory state summarizer. Given a scene's title, its previous one-line summary, and newly merged memory snippets, regenerate the CURRENT-state summary.

Output a JSON object: {"summary": "<一句话现状>"}

Rules:
- Output language MUST match the previous summary's language.
- ≤60字。描述当前状态与最新进展;禁止追加式流水账(不得出现"第N次/首次入档/heat N→N"),总是整体重写。
- Output ONLY the JSON object, no markdown fences, no commentary.`;

export function buildPromotionUserPrompt(samples: SceneSynthesisSample[]): string {
  const lines = samples.map((s) => `- (${s.ts || "无时间"}) ${s.head}`);
  return `以下是同一主题的重复记忆片段(按时间排序):\n\n${lines.join("\n")}\n\n请给出该主题的 title 与 summary。`;
}

export function buildRefreshUserPrompt(
  title: string,
  oldSummary: string,
  newHeads: SceneSynthesisSample[],
): string {
  const lines = newHeads.map((s) => `- (${s.ts || "无时间"}) ${s.head}`);
  return `场景标题:${title}\n\n旧摘要:${oldSummary || "(无)"}\n\n新合并的记忆片段:\n${lines.join("\n")}\n\n请重写当前状态摘要。`;
}

/**
 * Parse the LLM's JSON response. Tolerates markdown fences and trailing
 * prose. Returns null when no valid object with the requested keys exists.
 */
export function parseSynthesisJson(raw: string): Record<string, string> | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v.trim();
      }
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

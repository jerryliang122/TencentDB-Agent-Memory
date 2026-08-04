/**
 * Scene Guardrails: engineering-enforced safety nets that don't rely on
 * LLM self-discipline.
 *
 *   enforceSceneLength: hard truncation of scene files exceeding the
 *     configured char limit. Truncates at the last paragraph boundary
 *     (\n\n) within the budget to avoid breaking markdown structure.
 *
 *   detectMergeBloat: identifies suspected append-only / merge bloat by
 *     combining (a) total length growth beyond a ratio AND (b) an increase
 *     in `[本批次 ... 增量]` markers (the production pattern of pure-append
 *     scene updates). Both conditions must be true — a legitimate full
 *     rewrite with substantial new content would not trigger (b).
 */

const TRUNCATION_MARKER_PREFIX = "[工程截断：";
const TRUNCATION_MARKER_SUFFIX = "]";

export interface LengthEnforcementResult {
  truncated: boolean;
  output: string;
  originalLength: number;
}

export function enforceSceneLength(
  raw: string,
  maxChars: number,
): LengthEnforcementResult {
  const originalLength = raw.length;
  if (originalLength <= maxChars) {
    return { truncated: false, output: raw, originalLength };
  }

  const markerLine =
    `\n\n${TRUNCATION_MARKER_PREFIX}原始长度 ${originalLength} 字符，已截断至 ${maxChars} 字符上限${TRUNCATION_MARKER_SUFFIX}`;
  const budget = maxChars - markerLine.length;

  const slice = raw.slice(0, budget);
  const lastPara = slice.lastIndexOf("\n\n");
  const cutAt = lastPara > 0 ? lastPara : budget;
  const truncated = raw.slice(0, cutAt).trimEnd();

  return {
    truncated: true,
    output: `${truncated}${markerLine}`,
    originalLength,
  };
}

export function countBatchMarkers(content: string): number {
  const matches = content.match(/\[本批次[^\]]*增量/g);
  return matches ? matches.length : 0;
}

export interface MergeBloatDetection {
  suspected: boolean;
  reason: string;
}

export function detectMergeBloat(
  oldContent: string,
  newContent: string,
  growthLimit: number,
): MergeBloatDetection {
  if (!oldContent) {
    return { suspected: false, reason: "new file (no old content)" };
  }

  const oldLen = oldContent.length;
  const newLen = newContent.length;
  const growthRatio = newLen / oldLen;

  if (newLen <= oldLen) {
    return { suspected: false, reason: "no growth" };
  }

  if (growthRatio <= growthLimit) {
    return {
      suspected: false,
      reason: `growth ${growthRatio.toFixed(2)} within limit ${growthLimit}`,
    };
  }

  const oldMarkers = countBatchMarkers(oldContent);
  const newMarkers = countBatchMarkers(newContent);

  if (newMarkers > oldMarkers) {
    return {
      suspected: true,
      reason: `growth ${growthRatio.toFixed(2)} > ${growthLimit} AND batch markers ${oldMarkers} → ${newMarkers}`,
    };
  }

  return {
    suspected: false,
    reason: `growth exceeds limit but no batch marker increase (likely legitimate full rewrite)`,
  };
}

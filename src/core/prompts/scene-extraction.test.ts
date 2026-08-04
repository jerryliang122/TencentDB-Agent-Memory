import { describe, it, expect } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

describe("buildSceneExtractionPrompt", () => {
  it("does not inject sceneCountWarning content (deprecated, contradicts UPDATE-only contract)", () => {
    const result = buildSceneExtractionPrompt({
      memoriesJson: "[]",
      sceneSummaries: "",
      currentTimestamp: "2026-08-04T00:00:00.000Z",
      sceneCountWarning: "你必须先执行 MERGE 操作",
      existingSceneFiles: [],
      maxScenes: 15,
    });
    expect(result.userPrompt).not.toContain("MERGE");
    expect(result.userPrompt).not.toContain("场景数量警告");
  });

  it("renders basic structure with empty inputs", () => {
    const result = buildSceneExtractionPrompt({
      memoriesJson: "[]",
      sceneSummaries: "",
      currentTimestamp: "2026-08-04T00:00:00.000Z",
      existingSceneFiles: [],
      maxScenes: 15,
    });
    expect(result.systemPrompt).toContain("Memory Consolidation Architect");
    expect(result.userPrompt).toContain("New Memories List");
  });
});

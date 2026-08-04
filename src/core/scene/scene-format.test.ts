import { describe, it, expect } from "vitest";
import { parseSceneBlock, formatSceneBlock, formatMeta } from "./scene-format.js";

describe("scene-format", () => {
  it("parses new last_full_rewrite_at field", () => {
    const raw = `-----META-START-----
created: 2026-01-01T00:00:00.000Z
updated: 2026-08-04T00:00:00.000Z
summary: test
heat: 5
last_full_rewrite_at: 2026-08-04T00:00:00.000Z
-----META-END-----

# Content`;
    const block = parseSceneBlock(raw, "test.md");
    expect(block.meta.last_full_rewrite_at).toBe("2026-08-04T00:00:00.000Z");
  });

  it("returns empty last_full_rewrite_at for legacy files without the field", () => {
    const raw = `-----META-START-----
created: 2026-01-01T00:00:00.000Z
updated: 2026-08-04T00:00:00.000Z
summary: legacy
heat: 3
-----META-END-----

content`;
    const block = parseSceneBlock(raw, "legacy.md");
    expect(block.meta.last_full_rewrite_at).toBe("");
  });

  it("formatMeta includes last_full_rewrite_at", () => {
    const meta = {
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-08-04T00:00:00.000Z",
      summary: "test",
      heat: 5,
      last_full_rewrite_at: "2026-08-04T00:00:00.000Z",
    };
    const out = formatMeta(meta);
    expect(out).toContain("last_full_rewrite_at: 2026-08-04T00:00:00.000Z");
  });
});

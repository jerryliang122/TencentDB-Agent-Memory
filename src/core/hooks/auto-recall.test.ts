import { describe, expect, it } from "vitest";

// formatMemoryLine and FormatableMemory are not currently exported; the
// implementation will add `export` to enable direct unit testing.
import { formatMemoryLine } from "./auto-recall.js";
import type { FormatableMemory } from "./auto-recall.js";

const baseMemory: FormatableMemory = {
  record_id: "m_1785515129486_dee4cb6c",
  type: "episodic",
  scene_name: "我帮Jerry完成KOOK官方语音API调研",
  content: "KOOK音乐机器人项目完整记录（持续更新中）：\n\n【早期方案】最初技术方案为 khl.py框架",
  activity_start_time: "2026-05-11T08:37:03.369Z",
  activity_end_time: "2026-06-08T00:00:00.000Z",
  timestamp: undefined,
};

describe("formatMemoryLine — subject-only mode (subjectOnly=true)", () => {
  it("truncates content to subjectHintChars and appends ellipsis + record_id", () => {
    const result = formatMemoryLine(baseMemory, {
      subjectOnly: true,
      subjectHintChars: 20,
    });

    // Should contain type tag with scene_name
    expect(result).toContain(`[episodic|${baseMemory.scene_name}]`);
    // Should contain first 20 code points of content (after newline normalization)
    // (newline in content is replaced with space to keep bullet single-line)
    expect(result).toContain("KOOK音乐机器人项目完整记录（持续更新");
    // Should end with ellipsis (single char, no verbose "已截断" suffix)
    expect(result).toContain("…");
    expect(result).not.toContain("已截断");
    // Should include record_id suffix
    expect(result).toContain(`[id=${baseMemory.record_id}]`);
  });

  it("preserves content as-is when shorter than subjectHintChars (no ellipsis)", () => {
    const short: FormatableMemory = {
      ...baseMemory,
      content: "短记忆",
    };

    const result = formatMemoryLine(short, {
      subjectOnly: true,
      subjectHintChars: 60,
    });

    expect(result).toContain("短记忆");
    expect(result).not.toContain("…");
    expect(result).toContain(`[id=${short.record_id}]`);
  });

  it("subjectHintChars=0 emits subject-only line with no content", () => {
    const result = formatMemoryLine(baseMemory, {
      subjectOnly: true,
      subjectHintChars: 0,
    });

    // Should have type tag + scene_name
    expect(result).toContain(`[episodic|${baseMemory.scene_name}]`);
    // Should NOT contain content fragment (use a marker unique to content,
    // not scene_name — scene_name happens to contain "KOOK" too)
    expect(result).not.toContain("项目完整记录");
    expect(result).not.toContain("khl.py");
    expect(result).not.toContain("…");
    // Should still have record_id
    expect(result).toContain(`[id=${baseMemory.record_id}]`);
    // Should still have activity time
    expect(result).toContain("活动时间");
  });

  it("normalizes newlines in hint to keep bullet single-line", () => {
    const multiLine: FormatableMemory = {
      ...baseMemory,
      content: "首行主题\n\n第二行内容继续",
    };

    const result = formatMemoryLine(multiLine, {
      subjectOnly: true,
      subjectHintChars: 60,
    });

    // Output must be a single line (no embedded \n)
    expect(result).not.toContain("\n");
    // But should still contain text from both segments (joined by space)
    expect(result).toContain("首行主题");
  });

  it("falls back to [type] tag when scene_name is empty", () => {
    const noScene: FormatableMemory = {
      ...baseMemory,
      scene_name: "",
    };

    const result = formatMemoryLine(noScene, {
      subjectOnly: true,
      subjectHintChars: 20,
    });

    // Tag should be just [episodic] without scene
    expect(result).toContain("[episodic]");
    expect(result).not.toContain("[episodic|");
    // record_id still present
    expect(result).toContain(`[id=${baseMemory.record_id}]`);
  });

  it("omits content fragment when content is empty (subject-only with empty content)", () => {
    const emptyContent: FormatableMemory = {
      ...baseMemory,
      content: "",
    };

    const result = formatMemoryLine(emptyContent, {
      subjectOnly: true,
      subjectHintChars: 60,
    });

    expect(result).toContain("[episodic|");
    expect(result).not.toContain("…");
    expect(result).toContain(`[id=${baseMemory.record_id}]`);
  });
});

describe("formatMemoryLine — legacy mode (subjectOnly=false)", () => {
  it("emits full content + time, NO record_id suffix (backward compat)", () => {
    const result = formatMemoryLine(baseMemory, { subjectOnly: false });

    // Full content is present
    expect(result).toContain(baseMemory.content);
    // Tag present
    expect(result).toContain(`[episodic|${baseMemory.scene_name}]`);
    // Activity time present
    expect(result).toContain("活动时间");
    // record_id NOT appended in legacy mode
    expect(result).not.toContain(`[id=${baseMemory.record_id}]`);
    // No ellipsis (legacy mode renders full content; truncation is the
    // responsibility of applyRecallBudget, not formatMemoryLine)
    expect(result).not.toContain("…");
  });
});

describe("formatMemoryLine — time formatting (both modes)", () => {
  it("emits time range when both activity_start_time and activity_end_time present", () => {
    const result = formatMemoryLine(baseMemory, {
      subjectOnly: true,
      subjectHintChars: 0,
    });

    expect(result).toContain("活动时间:");
    expect(result).toContain("~");
  });

  it("emits point time when only timestamp is present", () => {
    const pointTime: FormatableMemory = {
      ...baseMemory,
      activity_start_time: undefined,
      activity_end_time: undefined,
      timestamp: "2026-07-15T10:30:00.000Z",
    };

    const result = formatMemoryLine(pointTime, {
      subjectOnly: true,
      subjectHintChars: 0,
    });

    expect(result).toContain("活动时间:");
    // No range separator for point-in-time
    expect(result).not.toContain("~");
  });

  it("omits time info entirely when all time fields are absent", () => {
    const noTime: FormatableMemory = {
      ...baseMemory,
      activity_start_time: undefined,
      activity_end_time: undefined,
      timestamp: undefined,
    };

    const result = formatMemoryLine(noTime, {
      subjectOnly: true,
      subjectHintChars: 0,
    });

    expect(result).not.toContain("活动时间");
  });
});

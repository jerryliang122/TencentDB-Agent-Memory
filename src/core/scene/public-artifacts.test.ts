import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSceneBlockArtifacts, SCENE_ARTIFACT_KIND } from "./public-artifacts.js";

const tmpDirs: string[] = [];

async function makeDataDir(entries: Array<Record<string, unknown>>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
  tmpDirs.push(dir);
  await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
  await fs.mkdir(path.join(dir, "scene_blocks"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".metadata", "scene_index.json"),
    JSON.stringify(entries),
    "utf-8",
  );
  for (const e of entries) {
    await fs.writeFile(path.join(dir, "scene_blocks", String(e.filename)), "# scene\n", "utf-8");
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("listSceneBlockArtifacts", () => {
  it("returns host-shaped artifacts for active scenes", async () => {
    const dir = await makeDataDir([
      {
        filename: "001-api-design.md",
        title: "API design",
        last_active: "2026-08-27T00:00:00.000Z",
        updated: "2026-08-26T00:00:00.000Z",
      },
    ]);
    const artifacts = await listSceneBlockArtifacts({
      pluginDataDir: dir,
      ttlDays: 30,
      now: new Date("2026-08-27T12:00:00.000Z"),
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: SCENE_ARTIFACT_KIND,
      workspaceDir: dir,
      relativePath: "scene_blocks/001-api-design.md",
      absolutePath: path.join(dir, "scene_blocks", "001-api-design.md"),
      agentIds: ["*"],
      contentType: "markdown",
    });
  });

  it("drops scenes whose last_active is older than the TTL", async () => {
    const dir = await makeDataDir([
      { filename: "old.md", last_active: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
      { filename: "fresh.md", last_active: "2026-08-20T00:00:00.000Z", updated: "2026-08-20T00:00:00.000Z" },
    ]);
    const artifacts = await listSceneBlockArtifacts({
      pluginDataDir: dir,
      ttlDays: 30,
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(artifacts.map((a) => a.relativePath)).toEqual(["scene_blocks/fresh.md"]);
  });

  it("keeps entries with unparsable timestamps (disk TTL owns eviction)", async () => {
    const dir = await makeDataDir([{ filename: "unknown.md", last_active: "", updated: "" }]);
    const artifacts = await listSceneBlockArtifacts({
      pluginDataDir: dir,
      ttlDays: 30,
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(artifacts).toHaveLength(1);
  });

  it("returns empty for a missing index without throwing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-empty-"));
    tmpDirs.push(dir);
    const artifacts = await listSceneBlockArtifacts({ pluginDataDir: dir, ttlDays: 30 });
    expect(artifacts).toEqual([]);
  });
});

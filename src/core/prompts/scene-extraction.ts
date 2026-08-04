/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to OpenClaw actual API.
 *
 * v3 (L2 redesign): MERGE and CREATE operations removed. The LLM now performs UPDATE
 * only; new-topic proposals are signaled out-of-band via the [PROPOSE_CANDIDATE] text
 * marker, and the engineering layer (SceneExtractor + candidate pool) decides when to
 * materialize a new scene file. Rewrite-mode (full vs. micro) is selected per scene
 * based on the META `last_full_rewrite_at` field.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) when due for a full rewrite (≥ 24h since last_full_rewrite_at)
 * - edit (targeted partial updates) when recently rewritten (< 24h)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 */

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  /** @deprecated No longer used — scene-count discipline is auto-managed by the
   *  engineering layer (candidate pool, length cap, bloat detection). Retained on
   *  the interface for backward compatibility; callers may safely stop populating it. */
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  // Note: maxScenes is retained on the signature for callers but is no longer used
  // to drive tiered warnings in the prompt — scene-count discipline is enforced by
  // the engineering layer (Task 10: candidate pool + length cap + bloat detection).
  void maxScenes;

  return `# Memory Consolidation Architect

**Output language contract**:
- Detect the dominant language from "New Memories List".
- Scene file names, Markdown section headings, and natural-language body text must use that language.
- For English memories, output English file names and English section headings.
- For non-Chinese memories, do not emit Chinese file names or Chinese section headings.
- If the language is ambiguous, default to English.
- Keep META field names (\`created\`, \`updated\`, \`summary\`, \`heat\`, \`last_full_rewrite_at\`) and system markers such as \`[DELETED]\`, \`[PROPOSE_CANDIDATE]\` in English.

## 角色定义 (Role Definition)
你是记忆整合架构师。你的目标是为用户构建一个"数字第二大脑"。你不仅仅是在记录数据，你更像是一位人类学家和心理学家，负责分析原始记忆，从中提取核心特征、捕捉隐性信号，并构建不断演变的叙事。

## 架构模型

### Layer 1 (Input): Raw Memories
- **来源**：API 分批召回（每批 20 条）
- **状态**：碎片化、无序

### Layer 2 (Processing): Scene Diaries
- **形态**：**不是清单，是连贯的叙事文档**
- **逻辑**：将 L1 碎片融合进特定场景文件
- **动作**：**仅 UPDATE（更新）**——整合新记忆到现有场景，重写叙事
- **禁止**：简单追加列表、增量标记段落、合并多文件

你主要负责 L1 到 L2 的整合任务。

## 输入环境 (Input Context)
你将接收三个输入：
1. 新增记忆 (New Memory)
2. 现有 Block 映射表 (Existing Blocks Map)：当前所有场景文件的文件名 + summary + META
3. 当前时间 (Current Time)

## ⛔ 文件操作约束（必须严格遵守）
1. **所有文件操作使用相对文件名**（如 \`Engineering-Practice.md\`），当前工作目录已设为场景文件目录
2. **read 只能读取用户消息中"已有场景文件清单"列出的文件**，禁止猜测或编造不在清单中的文件名
3. **禁止创建新文件（CREATE 已禁用）**——所有新记忆必须整合进**已有**场景文件
4. **局部更新场景文件**：使用 **edit** 工具，参数 \`path\`=文件名, \`edits\`=[{\`oldText\`: 旧内容, \`newText\`: 新内容}]
5. **整体重写场景文件**：使用 **write** 工具，参数 \`path\`=文件名, \`content\`=完整新内容（包含完整 META 头）
6. **场景索引和系统配置由工程系统自动维护**
7. **删除文件的唯一方式**：使用 **write** 工具将文件内容写为 \`[DELETED]\` 标记
8. **禁止创建报告/整合/汇总类文件**

## 🚫 绝对禁止（工程会自动检测并回滚）
- ❌ **禁止追加 \`[本批次 X 增量 · ...]\` 段落**——这是被严格禁止的偷懒行为
- ❌ **禁止简单拼接旧内容 + 新内容**——必须基于旧 + 新**重写叙事**
- ❌ **禁止创建新场景文件**（CREATE 路径已关闭，候选池机制负责新场景准入）
- ❌ **禁止长度超过 2000 字符**——超出工程会硬截断（保留头部 + 自动追加截断标记）

## 📛 文件命名规范（强制）

为保证下游工具（场景导航、健康检查、对象存储同步等）能正确解析路径引用，**新建文件**或 **MERGE 后的目标文件**必须遵守以下命名规则：

- **允许字符**：Unicode letters（包括 Latin/CJK/Cyrillic 等）、数字、短横线 \`-\`、下划线 \`_\`、点号 \`.\`
- **必须以 \`.md\` 结尾**（小写）
- **❌ 禁止包含**：空格、全角空格、引号、括号 \`( ) [ ] { }\`、斜杠 \`/ \\\`、冒号 \`:\`、分号 \`;\`、问号 \`?\`、感叹号 \`!\`、星号 \`*\`、竖线 \`|\`、其他标点
- **多词分隔**：使用 \`-\`（短横线）连接，不要用空格
- **更新现有文件**时，沿用清单中给出的文件名，不要改名
- **英文记忆的新建文件名**必须使用英文标题，并用短横线连接单词

✅ 正确示例：
- \`Daily-Rhythm-in-Shanghai.md\`
- \`日常生活-健康管理.md\`
- \`技术研究-Rust学习.md\`
- \`Coffee-Yirgacheffe.md\`
- \`Work-and-Engineering-Practice.md\`

❌ 错误示例（每次都会触发工程兜底重命名）：
- \`Daily Rhythm in Shanghai.md\`（含空格）
- \`Coffee (Yirgacheffe).md\`（含括号）
- \`Q1 Milestone?.md\`（含空格和问号）

> 提示：即使你没遵守，工程系统会自动归一化文件名（空格替换为短横线、删除括号等），但这会增加日志噪音和潜在冲突。请在 \`write\` 时直接使用合规名字。


## 工作流

### 阶段 1：分析与分类
分析新记忆。它的核心领域是什么？匹配哪个现有场景？

### 阶段 2：检索与策略
将新记忆与"现有 Block 映射表"比对。

**核心原则：唯一操作是 UPDATE。** 没有 MERGE、没有 CREATE。

**UPDATE 模式选择**（基于每个场景 META 的 \`last_full_rewrite_at\` 字段）：
- 距 \`last_full_rewrite_at\` < 24 小时 → **微调模式**：使用 **edit** 工具局部更新关键章节
- 距 \`last_full_rewrite_at\` ≥ 24 小时 → **全量重写模式**：使用 **write** 工具**整体重写**该场景文件，更新 \`last_full_rewrite_at\` = 当前时间

**全量重写要求**：
- 必须基于旧内容 + 新记忆**重新组织叙事**，不是拼接
- 禁止保留任何 \`[本批次 X 增量]\` 历史段落（如果旧文件里有，重写时清除）
- 严格控制在 2000 字符内

### 阶段 3：撰写与合成
深度整合：严禁简单文本追加。结合上下文重写叙事。
隐性推断：寻找用户没说出口的信息。
冲突检测：矛盾记录在 "Evolution Trajectory" section。

### 当无现有场景匹配时：PROPOSE_CANDIDATE
若新记忆无法融入任何现有场景（**这是正常情况，不是错误**）：
- **不要创建新文件**
- **不要强行塞进不相关的场景**
- 在你的 **text output**（不是文件操作）中输出标记：

\`\`\`
[PROPOSE_CANDIDATE]
topic: 简短主题名（如 "Rust 学习"）
reason: 为什么这是新主题，与现有场景为何不匹配
matched_memory_ids: [m_001, m_002, ...]
[/PROPOSE_CANDIDATE]
\`\`\`

工程层会跟踪候选，累积足够证据（≥5 条记忆或 ≥3 个独立 session）后**自动创建**正式场景文件。你下次执行时会看到该新场景出现在"已有场景清单"中。

### 热度管理
- 更新 Block: \`heat = 旧 heat + 1\`
- 整体重写时同步更新 META 中 \`last_full_rewrite_at\` 字段为当前时间

## 输出规范

### 📄 场景文件内容（必须输出）

每个场景文件控制在 2000 字符内。基于已有 .md 进行更新。模板（仅供参考结构，可自主调整）：

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: {{OLD_HEAT_PLUS_1}}
last_full_rewrite_at: {{CURRENT_TIME_IF_FULL_REWRITE_OR_KEEP_OLD_IF_EDIT}}
-----META-END-----

## User Core Traits
[一段连贯描述，最多 100 字]

## Core Narrative
[一段连贯叙事，最多 400 字。Trigger -> Action -> Result 结构]

## Implicit Signals
[可选。隐性推断]

## Evolution Trajectory
[可选。记录偏好或重大信念的变化]

## Pending Confirmation / Contradictions
[可选。待确认的矛盾]
\`\`\`

#### 文件操作（必须使用工具）
- **read** 读取需要更新的场景文件
- **write** 整体重写场景文件（全量重写模式）
- **edit** 局部更新场景文件（微调模式）
- **删除**：\`write\` 写入 \`[DELETED]\` 标记`;
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
  } = params;

  // sceneCountWarning is @deprecated — engineering layer auto-manages scene count
  // (TTL cleanup, candidate pool promotion). Always render empty to avoid
  // contradicting the UPDATE-only contract in systemPrompt.
  const warningSection = "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 已有场景文件清单（仅以下文件可 read）\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 已有场景文件清单\n（当前无已有场景文件）\n`;

  const userPrompt = `**Output language**: Scene file names, section headings, and body text must use the dominant language in the New Memories List below. For English memories, use English memory titles and English headings.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: buildSceneSystemPrompt(maxScenes),
    userPrompt,
  };
}

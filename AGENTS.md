# TencentDB Agent Memory

OpenClaw 插件（`memory-tencentdb`），为 AI 代理提供三层记忆系统：**L0 原始对话 → L1 结构化记忆 → L2 活跃工作主题**。

- 数据全部本地存储：SQLite（`vectors.db`）+ JSONL 文件，无外部数据库依赖
- LLM / embedding 通过 OpenAI 兼容 API 调用（可选独立 endpoint，或复用 OpenClaw 内嵌 agent）
- 读取时自动召回注入 + agent 主动检索工具，两层配合

## 命令

```bash
npm install                    # 安装依赖
npm run build                  # 构建插件 (tsdown)
npm run test                   # 运行单元测试 (vitest)
npm run test:watch             # 监视模式
npm run test:coverage          # 覆盖率报告
npm run typecheck              # 类型检查 (tsc --noEmit)
```

## 开发

**本地开发无需构建。** Node.js 22.16+ 原生支持 TypeScript 类型剥离 — OpenClaw 直接加载 `.ts` 源文件。

```bash
# 将当前目录链接为本地 OpenClaw 插件
openclaw plugins install --link .
openclaw gateway restart       # 代码修改后重启生效
```

## 记忆工作原理

```
用户发消息 ──► before_prompt_build (auto-recall) ──► 会话 priming / 漂移检测，注入记忆到 prompt
agent 回合结束 ──► agent_end (auto-capture)      ──► 写 L0
                     │
                     ▼
          MemoryPipelineManager（L1/L2 调度）
                     │ 每 5 轮对话 或 空闲 600s
                     ▼
                L1 提取（LLM）──► 结构化记忆 + 冲突去重
                     │ 延迟 10s（最小间隔 15min）
                     ▼
                L2 提取（LLM）──► 场景块 .md 文件
```

### 写路径

- **L0 捕获**（`agent_end` → `src/core/hooks/auto-capture.ts`）：JSONL（`conversations/YYYY-MM-DD.jsonl`）与游标在 checkpoint 文件锁下原子写入；SQLite L0 写入在锁外，靠每条记录唯一 ID 幂等去重。SQLite 路径先写元数据 + FTS，embedding 后台异步补齐。游标防重复，插件启动时间做首启下限。
- **调度**（`src/utils/pipeline-manager.ts`）：L1 按对话轮数阈值（warmup 1→2→4→…，封顶 everyN=5）或空闲超时触发，失败重试 30s×5；L2 用 downward-only 定时器（L1 后延迟 10s、minInterval 15min 下限、maxInterval 60min 兜底），会话 24h 不活跃停止轮询。所有任务走 `SerialQueue`（并发=1），状态持久化到 checkpoint 可恢复。
- **L1 提取**（`src/core/record/l1-extractor.ts`）：单次 LLM JSON-mode 调用同时做场景分段 + 记忆提取；质量门过滤纯符号短串/命令/注入风险（长度门已禁用）；`batchDedup` 向量召回 top-5 相似旧记忆做冲突检测（新增/合并/丢弃）。结果写 `records/` JSONL + SQLite L1 表（带向量索引）。
- **L2 场景归纳**（`src/core/scene/`，v2 设计：**工程路由 + LLM 单次综合，稳态零 LLM**）：
  - **路由**（`scene-router.ts`）：新 L1 记忆按 embedding 余弦相似度分配给场景锚点（`scene_state.json` 维护滚动均值锚点，阈值 `sceneRoutingThreshold` 默认 0.55），无 embedding 时退化为 bigram 文本相似度
  - **候选池**（`scene-candidates.ts`）：路由无匹配的记忆累积进候选；≥5 条相似记忆或 ≥3 个 session → 升级为场景块（升级时 LLM 生成标题+摘要，一次调用）；30 天无新证据过期
  - **场景块 = 轻量指针视图**（`scene-format.ts`）：标题 + 活动时间区间 + 一句话现状摘要（≤80 字，每次重新生成禁止追加）+ L1 记忆指针列表；不做叙事正文，内容都在 L1
  - **TTL**：`last_active` 超过 30 天（可配）→ 场景归档到 `.backup/scene_blocks_expired/`，从注入中消失；LLM 永远不接触文件系统
  - **摘要刷新**（`scene-synthesizer.ts`，第二个也是最后一个 LLM 触点）：累积 ≥5 条新记忆或距上次刷新 >7 天才重新生成
  - 存量 v1 叙事文件首次运行时自动迁移：健康的转 v2，被截断毁坏的 husk 归档到 `.backup/scene_blocks_husks/`

### 读路径

- **自动召回**（`before_prompt_build` → `src/core/hooks/auto-recall.ts`，5s 超时保护）——**会话锚定模式**（`recall.sessionMode`，默认 `drift`）：一个会话通常是一个任务，召回以会话为单位锚定，而非每轮用最新消息重跑（旧模式的措辞漂移会把无关记忆混进 prompt）：
  - **会话 priming**（首条通过 `minQueryChars` 的消息触发一次）：按策略搜索 L1 —— keyword（FTS5 BM25）/ embedding（余弦）/ hybrid（默认，RRF k=60 合并），阈值分路解耦：向量 `scoreThreshold`（默认 0.55）、FTS `ftsScoreThreshold`（默认 0.35，BM25 分度尺与余弦不可比）。priming 有**向量闸门** `primingScoreThreshold`（默认 0.62，BGE-M3 实测校准）：候选最高向量分达标才注入，否则整体放过——闲聊、无历史的新任务零污染。锚点（首条消息 embedding + 已注入 record_id）存入 `RecallSessionTracker`（`recall-session.ts`，纯内存，TTL `sessionTtlMinutes` 默认 30min 不活动过期）
  - **漂移检测**（后续每轮，消息过 `minQueryChars` 时）：embed 当前消息与锚点比余弦——≥ `driftThreshold`（默认 0.5）同任务 → 跳过召回（priming 已持久化在转录里）；低于阈值 → 换任务：无条件重锚点 + 重新 priming（闸门同样生效），按 record_id 去重只注入新增。embed 失败保守跳过（宁可不召回也不注入脏内容）；无 embedding 部署退化 bigram 文本相似度；历史压缩（消息数骤降 >20）强制重 priming 并重置去重
  - `<relevant-memories>`（priming 轮注入）→ 前置到**用户 prompt**；`persistToTranscript` 默认开启时由 `before_message_write` 持久化写入用户消息 JSONL，后续轮次转录里天然可见
  - 工具指南（静态、跨会话字节一致）→ 追加到 **system prompt 尾部**，命中 prompt cache。`recall.sceneInjection` 默认 `off`：`<active-scenes>` **不再自动注入**（`ambient` 可回退旧行为），场景感知来自记忆行 `[type|scene]` 标记 + 工具按需检索——system prompt 跨会话完全一致，`/new` 后不会被无关热点主题污染
  - 注入行是紧凑格式：`[type|scene] 内容前 60 字提示 [id=m_xxx]`，agent 按需取全文
  - 回退开关：`sessionMode="every-turn"` 恢复旧的逐轮完整召回行为（不经 tracker，行为逐字节一致）
- **主动检索工具**（`src/tools/`）：`tdai_memory_search`（L1 hybrid 搜索）、`tdai_memory_get`（按 record_id 取全文）、`tdai_conversation_search`（L0 原文检索）。指南限制每轮合计最多 5 次调用。

### 存储

- SQLite `vectors.db`：L0 表、L1 表、向量（余弦）、FTS5 全文索引
- embedding 未配置时自动退化为纯关键词模式（L2 路由退化为文本相似度）
- 数据目录（`<openclaw-state>/memory-tdai/`）：`conversations/`、`records/`、`scene_blocks/`（v2 场景文件）、`.metadata/`（checkpoint 游标、`scene_state.json` 锚点状态、`scene_index.json` 索引、`scene_candidates.json` 候选池）、`.backup/`（含 `scene_blocks_expired/` TTL 归档、`scene_blocks_husks/` 损坏文件归档）、`vectors.db`

## 目录结构

```
index.ts              # 插件入口（OpenClaw hooks + tools）
src/config.ts         # 配置类型和解析器（默认值都在这里）
src/core/
  conversation/       # L0 — 原始对话捕获（l0-recorder）
  record/             # L1 — 结构化记忆提取、去重、读写
  scene/              # L2 — v2 场景归纳（路由/候选池/编排器/格式/注入视图）
    scene-router.ts       # embedding 余弦确定性路由（纯函数）
    scene-candidates.ts   # 候选池：累积 → 阈值升级 → 过期清理
    scene-consolidator.ts # L2 编排器（迁移/TTL归档/路由/升级/落盘）
    scene-synthesizer.ts  # 仅有的两个 LLM 触点：升级标题+摘要、摘要刷新
    scene-format.ts       # v2 场景文件格式 + v1 迁移
    scene-navigation.ts   # system prompt 注入视图（TTL 过滤）
    scene-index.ts        # scene_index.json 读写/重建
  hooks/              # auto-recall / auto-capture / recall-session（会话锚点状态）hooks
  store/              # SQLite 向量库 + embedding + BM25 + 工厂
  prompts/            # L1 提取/去重 + L2 综合提示词
  report/             # 指标上报
  search/             # RRF merge 等共享搜索逻辑
src/tools/            # 懒加载工具模块
  memory-search.ts    # tdai_memory_search
  memory-get.ts       # tdai_memory_get
  conversation-search.ts # tdai_conversation_search
src/utils/
  pipeline-factory.ts # Pipeline 创建工厂（createPipeline）
  pipeline-manager.ts # L1/L2 调度管理
  checkpoint.ts       # 游标 / 会话状态持久化
  memory-cleaner.ts   # 定时清理（含场景 TTL 归档）
src/offload/          # 上下文压缩（Mermaid 画布，独立可选功能）
```

**模式**: 入口点直接使用 `createPipeline()`, `performAutoRecall()`, `performAutoCapture()` 等 factory 函数，通过 `api.registerTool()` 注册工具。hooks：`before_prompt_build`（召回）、`before_message_write`（持久化/清除 `<relevant-memories>` 注入）、`agent_end`（捕获）、`gateway_stop`（3s 超时优雅关闭）。

## 测试

- 单元测试: `src/**/*.test.ts`
- E2E: 独立配置 `vitest.e2e.config.ts` 保留，但当前仓库暂无 `*.e2e.test.ts` 测试文件
- 测试超时: 120s（长时间运行的 LLM/embedding 测试）

## 提交

需要 DCO。每个提交必须签名:

```bash
git commit -s -m "feat(scope): 描述"
```

类型: `feat`, `fix`, `docs`, `perf`, `refactor`, `test`, `chore`
范围: `store`, `hooks`, `scene`, `record`, `conversation`, `offload`

## 关键文件

- `openclaw.plugin.json` — 插件清单 + 配置 schema
- `package.json` — `openclaw` 键下的 OpenClaw 元数据
- `src/config.ts` — 配置类型、解析器和全部默认值

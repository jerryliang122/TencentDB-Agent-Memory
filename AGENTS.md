# TencentDB Agent Memory

OpenClaw/Hermes 插件，提供四层 AI 代理记忆（L0 对话 → L1 记录 → L2 场景 → L3 人设）。

## 命令

```bash
npm install                    # 安装依赖
npm run build                  # 构建插件 + 脚本 (tsdown + tsc)
npm run test                   # 运行单元测试 (vitest)
npm run test:watch             # 监视模式
npm run test:coverage          # 覆盖率报告
```

## 开发

**本地开发无需构建。** Node.js 22.16+ 原生支持 TypeScript 类型剥离 — OpenClaw 直接加载 `.ts` 源文件。

```bash
# 将当前目录链接为本地 OpenClaw 插件
openclaw plugins install --link .
openclaw gateway restart       # 代码修改后重启生效
```

## 架构

```
index.ts              # 插件入口（OpenClaw hooks + tools）
src/core/tdai-core.ts # 宿主无关的核心记忆逻辑
src/adapters/         # 宿主适配器
src/core/
  conversation/       # L0 — 原始对话捕获
  record/             # L1 — 结构化记忆提取
  scene/              # L2 — 场景摘要
  persona/            # L3 — 用户画像生成
src/offload/          # 上下文压缩（Mermaid 画布）
hermes-plugin/        # Hermes agent 集成
```

**模式**: `TdaiCore`（宿主无关）+ `HostAdapter`（OpenClaw 或 standalone）。新功能放入 `src/core/`，适配器将宿主事件转换为 core 调用。

## 测试

- 单元测试: `src/**/*.test.ts`
- E2E 测试: `**/*.e2e.test.ts`（独立配置 `vitest.e2e.config.ts`）
- 测试超时: 120s（长时间运行的 LLM/embedding 测试）

## 提交

需要 DCO。每个提交必须签名:

```bash
git commit -s -m "feat(scope): 描述"
```

类型: `feat`, `fix`, `docs`, `perf`, `refactor`, `test`, `chore`
范围: `store`, `hooks`, `persona`, `scene`, `record`, `conversation`, `gateway`, `hermes`

## 关键文件

- `openclaw.plugin.json` — 插件清单 + 配置 schema
- `package.json` — `openclaw` 键下的 OpenClaw 元数据
- `src/config.ts` — 配置类型和解析器

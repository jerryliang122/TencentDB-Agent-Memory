<div align="center">

<img src="./assets/images/logo.png" alt="TencentDB Agent Memory" width="880" />

### Agents remember, Humans innovate.

[![npm](https://img.shields.io/npm/v/@tencentdb-agent-memory/memory-tencentdb?color=blue)](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E=22.16-brightgreen)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E=2026.3.13-orange)](https://github.com/openclaw/openclaw)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/dJQM6mKMF)

[Highlights](#-highlights) · [Overview](#overview) · [Core Technology](#core-technology-reject-flat-storage-embrace-layering-and-symbolization) · [Features](#-features) · [Quick Start](#quick-start)

<div align="center">

[**English**](./README.md) · [简体中文](./README_CN.md)

</div>


</div>

---

> **⚠️ Fork Notice — Breaking Changes from Upstream**
>
> This is a fork of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) with the following breaking changes:
>
> - **Removed TCVDB backend** — Tencent Cloud Vector Database support has been removed. The plugin now uses local SQLite exclusively.
> - **Removed L3 Persona** — The memory layer system is simplified from L0–L3 to **L0–L2** (Conversation → Atom → Scenario).
> - **Removed Hermes / Gateway / CLI / Docker** — Only the **OpenClaw plugin** path is supported. The Hermes plugin, Gateway server, CLI tools, and Docker configurations have all been removed.
>
> If you need the full feature set (TCVDB, L3 Persona, Hermes integration), use the [upstream repository](https://github.com/Tencent/TencentDB-Agent-Memory).

---

## ✨ Highlights

> **TencentDB Agent Memory = symbolic short-term memory + layered long-term memory.**
>
> - **Symbolic short-term memory** offloads heavy tool logs and condenses them into compact Mermaid symbols, cutting token usage and improving task success.
> - **Layered long-term memory** distills fragmented conversations into structured scenes, instead of flat vector piles.

When integrated with OpenClaw, it cuts token usage by up to **61.38%**, improves pass rate by **51.52%** (relative), and raises PersonaMem accuracy from **48%** to **76%**.

> Benchmark data below is from the upstream repository's testing.

| Memory Capability | Benchmark | OpenClaw Success | With Plugin | Relative Δ | OpenClaw Tokens | With Plugin Tokens | Relative Δ |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Short-term** | WideSearch | 33% | **50%** | **+51.52%** | 221.31M | **85.64M** | **−61.38%** |
| **Short-term** | SWE-bench | 58.4% | **64.2%** | **+9.93%** | 3474.1M | **2375.4M** | **−33.09%** |
| **Short-term** | AA-LCR | 44.0% | **47.5%** | **+7.95%** | 112.0M | **77.3M** | **−30.98%** |
| **Long-term** | PersonaMem | 48% | **76%** | **+59%** | — | — | — |

> These results are measured over continuous long-horizon sessions, not isolated turns. For example, SWE-bench runs 50 consecutive tasks per session to simulate the context-accumulation pressure of real-world long-horizon agents.

---

## Overview

**Memory is not about hoarding everything in the AI — it is about sparing humans from having to repeat themselves.**

In practice, we constantly re-explain the same SOPs, project background, tool conventions, and output formats to the Agent. Such information should not require repetition, nor should it be indiscriminately dumped into the context.

TencentDB Agent Memory helps the Agent learn your workflows, retain task context, and reuse past experience. We reject both brute-force history accumulation and irreversible lossy summarization. Instead, we design memory as a layered system: **symbolic memory** for in-task information overload, and **memory layering** for cross-session experience.

> **Let the Agent remember what should be remembered, so people can focus on judgment, creation, and work that truly matters.**

---

## Core Technology: Reject Flat Storage, Embrace Layering and Symbolization

Our architecture rests on two pillars: **memory layering** and **symbolic memory**. Together they ensure Agents do not merely "remember more", but "reason better".

### 1. Memory Layering: Progressive Disclosure with Heterogeneous Storage

Traditional memory systems shred data into fragments and dump them into a flat vector store. Recall degenerates into a blind search across disconnected fragments, with no macro-level guidance.

Whether it is long-term knowledge or short-term tasks, memory should never be flat — both its formation and its recall must be hierarchical. TencentDB Agent Memory adopts **layering** as its unified architectural paradigm:

*   **Short-term context layering.** The bottom layer archives raw tool outputs (`refs/*.md`); the middle layer extracts step-level summaries (`jsonl`); the top layer condenses state into a lightweight Mermaid canvas. The Agent only needs to attend to the top-layer structure in context, and drills down to the lower layers via `node_id` when an error occurs.
*   **Long-term memory layering.** In place of flat logs, we build a semantic hierarchy: **L0 Conversation** (raw dialogue) → **L1 Atom** (structured facts) → **L2 Scenario** (scene blocks). The Scenario layer carries topical groupings; the system drills down to Atoms only when details matter.

<p align="center">
  <img src="./assets/images/memory-pyramid-en.jpg" alt="TencentDB Agent Memory L0 to L2 memory hierarchy" width="860" />
</p>

**Heterogeneous storage and progressive disclosure.** A dual-layer storage strategy underpins this architecture. The bottom layer (facts, logs, traces) is persisted in databases for robust full-text retrieval; the top layer (scenes, canvases) is stored as human-readable Markdown files for high information density and white-box inspection. **Lower layers preserve evidence; upper layers preserve structure.**

**Full traceability and lossless recovery.** Compression often sacrifices traceability. TencentDB Agent Memory avoids irreversible compression by maintaining a deterministic path from high-level abstractions back to ground-truth evidence. Whether it is an offloaded error log or a distilled scene summary, the system guarantees a complete drill-down path: "top-layer symbol (Scenario / canvas) → mid-layer index (JSONL) → bottom-layer raw text (L0 Conversation / refs)".

<div align="center">
  <img src="assets/images/flowchart1.png" alt="Retrievable and Recoverable Drill-Down Chain" />
</div>

### 2. Symbolic Memory: Maximum Semantics in Minimum Symbols (Mermaid Canvas)

In long tasks, the largest token consumers are verbose intermediate logs (search results, code, error traces). To address this, we combine **context offloading** with **symbolic memory** (optional `offload` feature):

*   **Mermaid symbol graph.** Instead of verbose prose or flat JSON, we encode task state transitions in high-density Mermaid syntax — precise enough for LLMs to parse, concise enough for humans to read.
*   **History offloading.** Full tool logs are offloaded to external files; only a lightweight Mermaid task map remains in context.
*   **`node_id` tracing.** The Agent reasons over the symbol graph; to verify a detail, it greps for the `node_id` and instantly retrieves the full raw text — cutting token cost while preserving full traceability.

```mermaid
graph LR
    Log["Verbose Logs<br/>(hundreds of thousands of tokens)"] -->|"1. Offload full text"| FS[("External FS<br/>(refs/*.md)")]
    Log -->|"2. Extract relations"| MMD["Mermaid Canvas<br/>(with node_id)"]

    MMD -->|"3. Light injection"| Agent(("Agent Context<br/>(a few hundred tokens)"))
    Agent -. "4. Recall via node_id" .-> FS

    style Log fill:#f1f5f9,stroke:#94a3b8,stroke-dasharray: 5 5,color:#475569
    style FS fill:#f8fafc,stroke:#cbd5e1,stroke-width:2px,color:#334155
    style MMD fill:#eff6ff,stroke:#3b82f6,stroke-width:2px,color:#1e3a8a
    style Agent fill:#fffbeb,stroke:#f59e0b,stroke-width:2px,color:#92400e
```

---

## Quick Start

### Install the plugin

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
openclaw gateway restart
```

> Please use the native OpenClaw command to upgrade the plugin. This approach prevents the plugin from being disabled caused by semantic version ranges.
> ```bash
> openclaw plugins update @tencentdb-agent-memory/memory-tencentdb
> ```

### Zero-config to enable

Defaults to a local `SQLite + sqlite-vec` backend.

```jsonc
// ~/.openclaw/openclaw.json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

Once enabled, TencentDB Agent Memory automatically handles conversation capture, memory extraction, scene consolidation, and session-anchored recall: the first message of a conversation primes relevant past knowledge into the prompt behind a high-similarity vector gate (chitchat and unrelated topics pass through clean), and later turns stay silent unless the topic drifts.

### Enable short-term compression (optional, requires version ≥ 0.3.4)

```jsonc
{
  "memory-tencentdb": {
    "config": {
      "offload": {
        "enabled": true
      }
    }
  }
}
```

Register the slot in your plugin config so OpenClaw routes context-offload requests to this plugin:

```jsonc
{
  "plugins": {
    "slots": {
      "contextEngine": "memory-tencentdb"
    }
  }
}
```

---

## 🔧 Configurable Parameters

**Every field has a sensible default — it runs with zero configuration.** When you want to tune, peel back the layers based on how deep you go.

<details>
<summary><b>🟢 Level 1 · Daily tuning</b> (covers 90% of use cases)</summary>

| Field | Default | Description |
| :--- | :--- | :--- |
| `timezone` | `"system"` | Timezone for user/LLM-facing timestamps: `"system"` (follow process tz) / IANA name (`Asia/Shanghai`) / offset string (`+08:00`) |
| `recall.strategy` | `"hybrid"` | Recall strategy: `keyword` / `embedding` / `hybrid` (RRF fusion, recommended) |
| `recall.maxResults` | `5` | Number of items returned per recall |
| `recall.maxCharsPerMemory` | `0` | Max characters injected for one recalled L1 memory; `0` disables this guard |
| `recall.maxTotalRecallChars` | `0` | Total character budget for auto-recalled L1 memories; `0` disables this guard |
| `recall.minQueryChars` | `6` | Min sanitized user-text length (Unicode code points) to trigger L1 memory search. Shorter messages (acknowledgments like "好的", "嗯", "ok", "对") skip L1 search. `0` disables the gate; `2` restores the historical hard floor |
| `pipeline.everyNConversations` | `5` | Trigger an L1 memory extraction every N turns |
| `extraction.maxMemoriesPerSession` | `20` | Max memories extracted per L1 pass |
| `offload.enabled` | `false` | Whether to enable short-term compression |

</details>

<details>
<summary><b>🟡 Level 2 · Advanced tuning</b> (long task / long session)</summary>

| Field | Default | Description |
| :--- | :--- | :--- |
| `pipeline.enableWarmup` | `true` | Warm-up: a new session triggers from turn 1, doubling each time up to N (1→2→4→…) |
| `pipeline.l1IdleTimeoutSeconds` | `600` | Trigger L1 after the user has been idle for this many seconds |
| `pipeline.l2MinIntervalSeconds` | `900` | Minimum interval between two L2 passes within the same session |
| `recall.timeoutMs` | `5000` | Recall timeout; on timeout, skip injection without blocking the conversation |
| `recall.sessionMode` | `"drift"` | In-session recall policy. A conversation is usually one task: `drift` (default) primes the session on the first qualifying message, then each turn only checks drift against the anchor — same topic injects nothing (the priming block is already persisted in the transcript), a topic switch re-primes and injects only records not yet injected this session. `first-turn` primes once and never recalls mid-session; `every-turn` restores the legacy per-turn full recall (rollback switch) |
| `recall.primingScoreThreshold` | `0.62` | Vector-score gate for session priming: memories are injected only when the best vector candidate reaches this threshold — chitchat / topics with no relevant history pass through completely clean. BGE-M3 calibrated (`0.58` wide / `0.65` strict) |
| `recall.driftThreshold` | `0.5` | Cosine below which a mid-session message counts as a topic switch (drift mode only). Missed switches just keep the old topic's memories (tools can compensate); false switches inject noise — hence the conservative default |
| `recall.sessionTtlMinutes` | `30` | Inactivity TTL for session recall state (anchors + injected ids); after it the next message re-primes. In-memory only |
| `recall.sceneInjection` | `"off"` | Whether to auto-inject `<active-scenes>` (all TTL-active work themes) into the system prompt. `off` (default) never injects — scene awareness comes from the `[type\|scene]` tag on recalled lines + on-demand tools, keeping the system prompt byte-identical across sessions (best caching, no hot-topic pollution in `/new` conversations); `ambient` restores the legacy behavior |
| `extraction.enableDedup` | `true` | L1 vector dedup / conflict detection |
| `capture.excludeAgents` | `[]` | Glob patterns to exclude specific agents (e.g. `bench-judge-*`) |
| `capture.l0l1RetentionDays` | `0` | Local retention days for L0 / L1 files; `0` = never clean up |
| `offload.mildOffloadRatio` | `0.5` | Mild compression trigger ratio (of context window) |
| `offload.aggressiveCompressRatio` | `0.85` | Aggressive compression trigger ratio |
| `offload.mmdMaxTokenRatio` | `0.2` | Token budget ratio for MMD injection |
| `bm25.language` | `"zh"` | Tokenizer language: `zh` (jieba) / `en` |

</details>

<details>
<summary><b>🔴 Level 3 · Full parameter reference</b> (ops / custom models / remote embedding)</summary>

For all fields, types, and constraints see [`openclaw.plugin.json`](./openclaw.plugin.json)。

- `embedding.*` — remote embedding service (OpenAI-compatible API)
  - `embedding.sendDimensions` (default `true`): whether to include the `dimensions` field in the request body. OpenAI `text-embedding-3-*` models rely on it for Matryoshka truncation, but some self-hosted / OSS models (e.g. **BGE-M3**) do not support custom dimensions and will reject the request with HTTP 400 `does not support matryoshka representation`. Set it to `false` for those backends, e.g.:
    ```json
    {
      "embedding": {
        "enabled": true,
        "provider": "openai",
        "baseUrl": "http://your-host:your-port/v1",
        "apiKey": "<KEY>",
        "model": "bge-m3",
        "dimensions": 1024,
        "sendDimensions": false
      }
    }
    ```
- `llm.*` — standalone LLM mode (bypass OpenClaw's built-in model and run L1/L2 extraction with a designated API)
- `offload.backendUrl / backendApiKey` — offload the L1/L1.5/L2/L4 flow to a backend service
- `report.*` — metrics reporting

</details>

---

## 🤔 Features

### 1. Macro Scenarios + Micro Facts: A Unified Drill-Down Mechanism

The biggest risk in compression is saving tokens at the cost of losing the evidence. TencentDB Agent Memory therefore does not collapse history into an irreversible summary — it preserves a clear path from high-level abstraction back to ground-truth evidence.

| Question type | First look at | Drill down to |
| :--- | :--- | :--- |
| Daily preferences, project context, long-term goals | L2 Scenario | L1 Atom / L0 Conversation when facts are needed |
| Specific facts, dates, project details | L1 Atom / L0 Conversation | Widen the time range, or fall back to semantic recall when results are sparse |
| Continuing a long-running task | Active Mermaid task canvas | Check the JSONL when the summary lacks detail, then `refs/*.md` for raw text |

Scenario blocks are maintained automatically in the background (routing, promotion, summary refresh), but they are **not auto-injected into the prompt** — the agent pulls them on demand: `tdai_memory_search` results and recalled memory lines carry a `[type|scene]` tag, and `read_file scene_blocks/<scene>.md` returns the topic's memory pointer list. This keeps the context clean while preserving the macro view.

The upper layers carry judgment and direction; the lower layers carry evidence and precision. Short-term compression and long-term memory form a single closed loop: **collapsible and expandable, abstract yet auditable.**

### 2. White-Box Debuggability: Memory Is Not a Black Box

Most memory systems fall short here: when recall is wrong, all you see is a list of vector scores, with no way to tell where things went wrong. TencentDB Agent Memory keeps the key intermediates as readable files:

- L2 Scenario blocks are plain Markdown — open them and inspect.
- Short-term task canvases are Mermaid — readable by both humans and Agents.
- Raw payloads, summaries, and nodes are linked by `result_ref` and `node_id`.

Debugging no longer means probing an opaque database — it becomes a deterministic walk along the chain "Scenario → Atom → Conversation" until the root cause surfaces.

**All of these layered memory artifacts live under `~/.openclaw/memory-tdai/` — feel free to open the directory and inspect each layer for yourself.**

### 3. Production-Ready Engineering: Not a Demo

| Capability | Description |
| :--- | :--- |
| OpenClaw plugin | Automatically captures, extracts, and recalls memory once installed |
| Local backend | `SQLite + sqlite-vec`, ready to use out of the box |
| Hybrid retrieval | BM25 + vector + RRF — supports both keyword and semantic recall |
| Agent tools | `tdai_memory_search` / `tdai_memory_get` / `tdai_conversation_search` |

---

## Documentation

| Document | Contents |
| :--- | :--- |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes and version history |
| [`openclaw.plugin.json`](./openclaw.plugin.json) | OpenClaw plugin manifest and configuration schema |

---

## Community & Contributing

We welcome every kind of contribution — bug reports, feature ideas, doc fixes, benchmark reproductions, ecosystem integrations, or a Pull Request. Agent memory is far from a solved problem, and we'd love to figure it out together.

- 🐞 **Found a bug or have a question?** Open an issue at [GitHub Issues](https://github.com/jerryliang122/TencentDB-Agent-Memory/issues) — we respond within 24 hours.
- 💡 **Have an idea to share?** Start a thread in [GitHub Discussions](https://github.com/jerryliang122/TencentDB-Agent-Memory/discussions).
- 🛠️ **Want to contribute code?** Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.
- 💬 **Want to chat with us?** Join our [Discord community](https://discord.gg/dJQM6mKMF) and talk to the early developers directly.

---

## Roadmap

- [x] Long-term memory (L0 → L2: Conversation → Atom → Scenario)
- [x] Short-term context compression (Context Offload + Mermaid canvas)
- [x] Local SQLite backend
- [x] OpenClaw plugin integration
- [ ] Portable memory: cross-Agent / cross-framework / cross-device import, export, and live migration
- [ ] Automatic Skill generation
- [ ] Visual debugging and memory observability dashboard

---

<table>
  <tr>
    <td width="68%">
      <b>If TencentDB Agent Memory has been useful to you, please give the project a ⭐ to support us.</b><br />
      For any suggestions, feel free to open an issue and start the discussion.
    </td>
    <td width="32%" align="right">
      <img src="./assets/images/star-helper.png" alt="Star TencentDB Agent Memory" width="260" />
    </td>
  </tr>
</table>

[MIT](./LICENSE) © TencentDB Agent Memory Team

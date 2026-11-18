# ⚡ PurpleLight (紫电)

> *"紫电青霜，王将军之武库。"* — 王勃《滕王阁序》

**PurpleLight (紫电)** is an interactive, context-forking multi-agent security vulnerability research & bug hunting workbench built on top of [`@opencode-ai/sdk`](https://opencode.ai) and Feishu (Lark) WebSocket Long-Connection (`@larksuiteoapi/node-sdk`).

It separates **high-level architectural reasoning** from **noisy low-level verification** through Git-like session branching:

1. **Strategist Microkernel (`main`)** — Connects to your top-tier reasoning model with zero heavy I/O tools (`bash`, `read`, `grep`, `skill` disabled) to preserve **100% Context Hygiene** during threat modeling and attack-surface brainstorming.
2. **Session-Forked Scouts (`scout-N`)** — Spawned via `session.fork()` to inherit the full strategic conversation context, then executed asynchronously in the background on fast/cost-effective coding models with full `bash / read / write / grep / webfetch / skill` capabilities.
3. **Silent Background Execution, Clean Final Reporting** — Intermediate Scout tool calls and exploration noise never pollute your main chat; Scouts record structured facts into a shared SQLite blackboard and surface **only their comprehensive final report** back to both the Strategist context and Feishu.
4. **Live Hint Steering (Unicast & Broadcast)** — Inject newly discovered hints from the Strategist (or directly via Feishu quote-replies / slash commands) into a single running Scout (`send_hint`) or across all active Scouts (`broadcast_hint`) via silent `noReply: true` context injection.

---

## ✨ Core Features

- **Context-Inheriting `fork_scout` Primitives**: Branch multiple parallel hypotheses (`scout-1`, `scout-2`, ...) from any point in your main discussion without rewriting background prompts.
- **Lightweight Exploration Graph Blackboard (`bun:sqlite` WAL)**: Tracks `intents`, `facts`, `findings`, `hints`, `scouts`, and `hook_approvals` in a single embedded `data/PurpleLight.db` file.
- **Dynamic Turn Budgets & In-Place Extension**: Each Scout runs with a default `80`-step budget (with graceful settlement before halting) and can be dynamically resumed in-place via `extend_scout` or `/extend scout-1 40`.
- **Workspace Boundary Guardrail Hook**: Every Scout receives an isolated directory (`workspaces/scout-N`). File writes inside its workspace execute freely; writes outside trigger `tool.execute.before` suspension and push an interactive `/approve <id>` / `/deny <id>` prompt to Feishu.
- **Native Feishu WS Experience**:
  - Pure outbound WebSocket (`Lark.WSClient`) — **zero public IP or inbound webhook ports required**.
  - Native quote-replies (`im.v1.message.reply`), compact `post`/`text` chat bubbles, `Typing` reaction indicator, real-time Main-Agent tool call bubbles, and in-place editable `⏳ Working — X min — iteration M/N, waiting for provider response (streaming)` heartbeats.
- **Hot-Swappable Providers & Live `/models` Discovery**: Independently switch `main` and `scout` across `deepseek`, `openrouter`, and `custom` OpenAI-compatible endpoints directly from Feishu.

---

## 📂 Project Structure

```text
PurpleLight/
├── opencode.json               # Role & tool boundary definitions (strategist vs scout)
├── plugin/
│   └── PurpleLight-plugin.ts   # OpenCode SDK plugin: 11 orchestration primitives + runtime hooks
├── src/
│   ├── db.ts                   # SQLite Exploration Graph blackboard & model settings
│   └── gateway.ts              # Feishu WSClient gateway, SSE telemetry & HTTP control API
├── .opencode/skills/
│   └── bilibili-intel/SKILL.md # Optional Bilibili subtitle/comment intelligence skill for Scouts
├── scripts/
│   └── bili_sub.py             # WBI-signed Bilibili transcript extractor
└── deploy/
    ├── PurpleLight-opencode.service
    └── PurpleLight-gateway.service
```

---

## 🚀 Quick Start

### 1. Prerequisites
- [Bun](https://bun.sh) >= 1.2
- [OpenCode CLI](https://opencode.ai) >= 1.19 (`opencode serve`)
- A Feishu (Lark) self-built bot app with **Long-Connection (长连接)** enabled for `im.message.receive_v1` and scopes:
  - `im:message`, `im:message:send_as_bot`, `im:message.p2p_msg:readonly` (optional: `im:message.reactions:write_only`)

### 2. Install & Configure
```bash
git clone https://github.com/anjhz0318/PurpleLight.git
cd PurpleLight
bun install

cp .env.example .env
# Edit .env with your DEEPSEEK_API_KEY / OPENROUTER_API_KEY and FEISHU_APP_ID / FEISHU_APP_SECRET
```

### 3. Run
Start the OpenCode headless backend (`127.0.0.1:4096`) and the PurpleLight gateway (`127.0.0.1:4099`):
```bash
# Terminal 1
bun run opencode

# Terminal 2
bun run start
```
Or install as persistent `systemd` services using the unit templates under [`deploy/`](./deploy/).

---

## 💬 Feishu Slash Commands

| Command | Description |
| :--- | :--- |
| `/status` or `/scouts` | View active `main`/`scout` models, Exploration Graph counts, and Scout progress |
| `/provider` | Show or switch active provider (`deepseek` / `openrouter` / `custom`) per role |
| `/provider set custom <url> <key>` | Configure a custom OpenAI-compatible endpoint dynamically |
| `/model [keyword]` | Dynamically fetch live `/models` from the active provider(s) |
| `/model <main\|scout> <model_id>` | Switch model for `main` (Strategist) or `scout` (Subagents) |
| `/report <scout-id>` | Read the full unclipped report and workspace file list of a Scout |
| `/hint <scout-id> <text>` | Send a targeted **unicast** hint to one Scout (or quote-reply its report) |
| `/broadcast <text>` | **Broadcast** a new global hint to all forked Scouts |
| `/extend <scout-id> <turns> [note]` | Dynamically add step budget (e.g. `+40`) and wake a Scout to continue |
| `/approve <id>` / `/deny <id>` | Approve or reject out-of-workspace file write hooks |
| `/new` | Start a fresh Strategist session and clean Exploration Graph |

---

## 📄 License

MIT

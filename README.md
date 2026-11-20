# ⚡ PurpleLight (紫电)

> *"紫电青霜，王将军之武库。"* — 王勃《滕王阁序》

**PurpleLight (紫电)** is an interactive, context-forking multi-agent security vulnerability research & bug hunting workbench built on top of [`@opencode-ai/sdk`](https://opencode.ai) and Feishu (Lark) WebSocket Long-Connection (`@larksuiteoapi/node-sdk`).

It structures vulnerability research around **Insight (Intel + Intuition) -> Attack Hypothesis -> Context-Forked Scout Verification -> Fact / Finding**, separating high-level architectural reasoning from noisy low-level verification:

1. **Strategist Microkernel (`main`)** — Connects to your frontier reasoning model (defaulting to `glm/glm-5.3`) with zero heavy I/O tools (`bash`, `read`, `grep` disabled) to preserve **100% Context Hygiene**. Exclusively manages the `Insight` hypothesis tree, loads Strategist-specific domain skills (`skills/strategist/*`, e.g., `hackerone-rules`), recalls archived campaigns across `/new` sessions (`search_history` / `load_history`), and sees a live catalog of all Skills & MCP servers mounted on Scouts.
2. **Session-Forked Scouts (`scout-N`)** — Spawned via `session.fork()` around a specific `insight_id` to inherit the full strategic conversation context, then executed silently in the background on fast/cost-effective coding models with full `bash / read / write / grep / webfetch / load_skill / MCP` capabilities.
3. **Strict Insight-Linked Blackboard & Cross-Session Memory** — Scouts incrementally append `facts` and `findings` strictly bound to Strategist-owned `insights`. Executing `/new` starts a clean session (resetting IDs to `1` and wiping temporary workspaces) while archiving prior `insights / facts / findings` in SQLite so the Strategist can search and reload past target intelligence automatically.
4. **Role-Separated Skills (`skills/strategist/` vs `skills/scout/`)** — Strategic platform rules (like HackerOne Same-Root-Cause deduplication rules, Signal math, and submission formatting) live in `skills/strategist/`, while execution SOPs (like Bilibili transcript extraction, non-blocking background server launches, and 5-way GitHub duplicate checks) live in `skills/scout/`.

---

## 📂 Project Structure

```text
PurpleLight/
├── opencode.json               # Role, permission & tool boundary definitions (strategist vs scout)
├── plugin/
│   └── PurpleLight-plugin.ts   # OpenCode SDK plugin: Insight/History/Skill/Scout primitives & hooks
├── src/
│   ├── db.ts                   # SQLite Insight Graph blackboard, cross-session archive & provider settings
│   └── gateway.ts              # Feishu WSClient gateway, watchdog, SSE telemetry & HTTP control API
├── skills/
│   ├── strategist/             # Strategist-only domain & platform skills (loaded via load_skill)
│   │   └── hackerone-rules/SKILL.md
│   └── scout/                  # Scout execution skills (indexed for Strategist, executed by Scouts)
│       ├── bilibili-intel/SKILL.md
│       └── recon-and-poc-ops/SKILL.md
├── scripts/
│   └── bili_sub.py             # WBI-signed Bilibili transcript extractor
└── deploy/
    ├── PurpleLight-opencode.service
    └── PurpleLight-gateway.service
```

---

## 💬 Feishu Slash Commands

| Command | Description |
| :--- | :--- |
| `/status` or `/scouts` | View active `main`/`scout` models, Insight tree, archive stats, and Scout progress |
| `/stop [scout-id\|all]` | Immediately abort the active Strategist turn (and running Scouts) or stop a specific `scout-N` |
| `/provider` | Show or switch active provider (`glm` / `deepseek` / `openrouter` / `custom`) per role |
| `/provider set <glm\|deepseek\|openrouter> <key>` | Configure API key for built-in providers dynamically |
| `/provider set custom <url> <key>` | Configure a custom OpenAI-compatible endpoint dynamically |
| `/model [keyword]` | Dynamically fetch live `/models` from the active provider(s) |
| `/model <main\|scout> <model_id>` | Switch model for `main` (Strategist) or `scout` (Subagents) |
| `/report <scout-id>` | Read the full unclipped report and workspace file list of a Scout |
| `/hint <scout-id> <text>` | Send a targeted **unicast** hint to one Scout (or quote-reply its report) |
| `/broadcast <text>` | **Broadcast** a new global hint to all forked Scouts |
| `/extend <scout-id> <turns> [sec] [note]` | Dynamically add step/timeout budget and wake a Scout to continue |
| `/clean [scout-id\|all]` | Clean a specific Scout's workspace or all completed Scout workspaces |
| `/approve <id>` / `/deny <id>` | Approve or reject out-of-workspace file write hooks |
| `/new` | Archive current Insights/Findings/Facts into history DB, start a fresh session, and wipe Scout workspaces |

---

## 📄 License

MIT

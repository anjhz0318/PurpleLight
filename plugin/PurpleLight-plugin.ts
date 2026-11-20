import { type Plugin, tool } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join, resolve, relative } from "path";
import {
  PROJECT_ROOT,
  WORKSPACES_ROOT,
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  db,
  pushOutboxEvent,
  getGraphOverview,
  getAgentModelConfig,
  cleanScoutWorkspaces,
  ensureHuntingSession,
  nextSessionScopedId,
  getInsightBySessionAndId,
  getHistoricalArchiveStats,
  searchHistoricalKnowledge,
  loadHistoryIntoSession
} from "../src/db";

// ─────────────────────────────────────────────────────────────────────────────
// Role-Separated Skill & MCP Discovery System (Hermes Practice)
// - `skills/strategist/<name>/SKILL.md` -> Strategist-exclusive domain/platform skills
// - `skills/scout/<name>/SKILL.md` (+ `.opencode/skills/`) -> Scout execution skills
// Strategist loads its own skills via `load_skill`, and sees the catalog of all
// Scout skills + MCP servers so it can assign them via `fork_scout(skills=[...])`!
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoveredSkill {
  name: string;
  role: "strategist" | "scout";
  description: string;
  skillDir: string;
  skillMdPath: string;
}

interface DiscoveredMcpServer {
  name: string;
  type: string;
  summary: string;
}

function parseSkillFrontmatter(
  mdContent: string,
  fallbackName: string,
  defaultRole: "strategist" | "scout"
): { name: string; description: string; role: "strategist" | "scout" } {
  let name = fallbackName;
  let description = "";
  let role: "strategist" | "scout" = defaultRole;

  const fmMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch && fmMatch[1]) {
    const fm = fmMatch[1];
    const nameLine = fm.match(/^name:\s*(.+)$/m);
    const descLine = fm.match(/^description:\s*(.+)$/m);
    const roleLine = fm.match(/^role:\s*(.+)$/m);
    if (nameLine?.[1]) name = nameLine[1].trim().replace(/^["']|["']$/g, "");
    if (descLine?.[1]) description = descLine[1].trim().replace(/^["']|["']$/g, "");
    if (roleLine?.[1]) {
      const r = roleLine[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (r === "strategist" || r === "main") role = "strategist";
      else if (r === "scout") role = "scout";
    }
  }
  if (!description) {
    const firstHeading = mdContent.replace(/^---[\s\S]*?---\r?\n/, "").match(/^#\s+(.+)$/m);
    description = firstHeading?.[1]?.trim() || `${role} skill`;
  }
  return { name, description, role };
}

function listFilesRelative(baseDir: string, currentDir = baseDir): string[] {
  const out: string[] = [];
  if (!existsSync(currentDir)) return out;
  try {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listFilesRelative(baseDir, full));
      } else if (entry.isFile() && entry.name !== "SKILL.md") {
        out.push(relative(baseDir, full));
      }
    }
  } catch {}
  return out;
}

function discoverAllSkillsAndMcp(): {
  strategistSkills: DiscoveredSkill[];
  scoutSkills: DiscoveredSkill[];
  mcpServers: DiscoveredMcpServer[];
} {
  const strategistSkills: DiscoveredSkill[] = [];
  const scoutSkills: DiscoveredSkill[] = [];
  const seenStrategist = new Set<string>();
  const seenScout = new Set<string>();

  const scanSources: Array<{ dir: string; defaultRole: "strategist" | "scout" }> = [
    { dir: join(PROJECT_ROOT, "skills", "strategist"), defaultRole: "strategist" },
    { dir: join(PROJECT_ROOT, "skills", "scout"), defaultRole: "scout" },
    { dir: join(PROJECT_ROOT, ".opencode", "skills"), defaultRole: "scout" }
  ];

  for (const src of scanSources) {
    if (!existsSync(src.dir)) continue;
    try {
      for (const entry of readdirSync(src.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(src.dir, entry.name);
        const skillMdPath = join(skillDir, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const parsed = parseSkillFrontmatter(content, entry.name, src.defaultRole);
          const item: DiscoveredSkill = {
            name: parsed.name,
            role: parsed.role,
            description: parsed.description,
            skillDir,
            skillMdPath
          };
          if (parsed.role === "strategist") {
            if (!seenStrategist.has(item.name)) {
              seenStrategist.add(item.name);
              strategistSkills.push(item);
            }
          } else {
            if (!seenScout.has(item.name)) {
              seenScout.add(item.name);
              scoutSkills.push(item);
            }
          }
        } catch {}
      }
    } catch {}
  }

  const mcpServers: DiscoveredMcpServer[] = [];
  const opencodeConfigPath = join(PROJECT_ROOT, "opencode.json");
  if (existsSync(opencodeConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(opencodeConfigPath, "utf-8"));
      const mcpObj = cfg?.mcp || {};
      for (const [srvName, srvCfg] of Object.entries<any>(mcpObj)) {
        if (!srvCfg || srvCfg.enabled === false) continue;
        const type = String(srvCfg.type || "local");
        const summary =
          type === "remote"
            ? String(srvCfg.url || "remote MCP")
            : Array.isArray(srvCfg.command)
              ? srvCfg.command.join(" ")
              : String(srvCfg.command || "local MCP");
        mcpServers.push({ name: srvName, type, summary });
      }
    } catch {}
  }

  return { strategistSkills, scoutSkills, mcpServers };
}

function formatSkillBlocksForStrategist(): string {
  const { strategistSkills, scoutSkills, mcpServers } = discoverAllSkillsAndMcp();
  const blocks: string[] = [];

  if (strategistSkills.length > 0) {
    const lines = [
      `<strategist_skills>`,
      `  以下是专属于你（主脑 Strategist）的领域知识与平台策略 Skills（目录: skills/strategist/）。当讨论目标选型、赏金平台判重规则（如是否构成同一 Root Cause）、Signal 策略或撰写漏洞报告前，请主动调用 \`load_skill(name="...")\` 加载全文：`,
      ...strategistSkills.map((s) => `    - ${s.name}: ${s.description}`),
      `</strategist_skills>`
    ];
    blocks.push(lines.join("\n"));
  } else {
    blocks.push(
      `<strategist_skills>\n  当前 skills/strategist/ 下暂无主脑专属 Skill。\n</strategist_skills>`
    );
  }

  const scoutLines: string[] = [
    `<scout_available_capabilities>`,
    `  以下是挂载给 Scout 子分支的执行层 Skills（目录: skills/scout/）与 MCP Servers。你作为主脑无需自己加载它们，但在调用 \`fork_scout(skills=[...])\` 或 \`send_hint\` 时可明确点名让 Scout 加载调用：`
  ];
  if (scoutSkills.length > 0) {
    scoutLines.push(`  Scout Skills:`);
    for (const s of scoutSkills) {
      scoutLines.push(`    - ${s.name}: ${s.description}`);
    }
  } else {
    scoutLines.push(`  Scout Skills: （暂无）`);
  }
  if (mcpServers.length > 0) {
    scoutLines.push(`  Scout MCP Servers:`);
    for (const m of mcpServers) {
      scoutLines.push(`    - ${m.name} [${m.type}]: ${m.summary}`);
    }
  }
  scoutLines.push(`</scout_available_capabilities>`);
  blocks.push(scoutLines.join("\n"));

  return blocks.join("\n\n");
}

function formatSkillsBlockForScout(requestedSkills: string[] = []): string {
  const { scoutSkills, mcpServers } = discoverAllSkillsAndMcp();
  const lines: string[] = [];
  if (requestedSkills.length > 0) {
    lines.push(
      `- ⚡ 主脑指定优先加载 Skills: ${requestedSkills.map((s) => `\`${s}\``).join(", ")} —— 请在动手前先调用 \`load_skill(name="...")\` 阅读其标准操作流程！`
    );
  }
  if (scoutSkills.length > 0) {
    lines.push(
      `- 可用执行层 Skills (调用 \`load_skill(name="...")\` 加载): ${scoutSkills.map((s) => `\`${s.name}\` (${s.description})`).join(" | ")}`
    );
  }
  if (mcpServers.length > 0) {
    lines.push(`- 已挂载 MCP Servers: ${mcpServers.map((m) => `\`${m.name}\``).join(", ")}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session & Workspace Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getScoutBySession(sessionId: string): any | null {
  return db.prepare(`SELECT * FROM scouts WHERE session_id = ?`).get(sessionId) as any;
}

function getScoutById(scoutId: string): any | null {
  return db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(scoutId) as any;
}

function resolveMainSessionId(sessionId: string): string {
  const scout = getScoutBySession(sessionId);
  return scout ? scout.parent_session_id : sessionId;
}

function assertStrategistCaller(sessionId: string, toolName: string) {
  const scout = getScoutBySession(sessionId);
  if (scout) {
    throw new Error(
      `[PERMISSION_DENIED] 工具 \`${toolName}\` 仅限主脑 (Strategist) 调用。子分支 (${scout.scout_id}) 只能调用 \`record_fact\` 和 \`report_finding\` 向已有的 Insight 增量写入验证结果。`
    );
  }
}

function requireValidInsight(mainSessionId: string, insightId: number) {
  const ins = getInsightBySessionAndId(mainSessionId, insightId);
  if (!ins) {
    const existing = db
      .prepare(`SELECT id, title, status FROM insights WHERE main_session_id = ? ORDER BY id ASC`)
      .all(mainSessionId) as any[];
    const hint =
      existing.length > 0
        ? `当前会话有效的 Insight ID 列表: ${existing.map((e) => `#${e.id}(${e.title.slice(0, 24)})`).join(", ")}`
        : `当前会话黑板尚无任何 Insight，请主脑先调用 manage_insight(action="add", ...) 创建至少一条 Insight。`;
    throw new Error(`[INVALID_INSIGHT_ID] 未找到 Insight #${insightId}。${hint}`);
  }
  return ins;
}

function isInsideDir(targetPath: string, baseDir: string): boolean {
  const absTarget = resolve(targetPath);
  const absBase = resolve(baseDir);
  const rel = relative(absBase, absTarget);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function waitForHookApproval(approvalId: number | bigint, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare(`SELECT status FROM hook_approvals WHERE id = ?`).get(approvalId) as any;
    if (!row) return false;
    if (row.status === "approved") return true;
    if (row.status === "denied") return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  db.prepare(
    `UPDATE hook_approvals SET status = 'timeout', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`
  ).run(approvalId);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PurpleLight OpenCode Plugin
// ─────────────────────────────────────────────────────────────────────────────

export const PurpleLightPlugin: Plugin = async ({ client }) => {
  return {
    "permission.ask": async (_input, output) => {
      output.status = "allow";
    },

    "shell.env": async (input, output) => {
      if (!input.sessionID) return;
      const scout = getScoutBySession(input.sessionID);
      if (scout) {
        output.env.SCOUT_ID = scout.scout_id;
        output.env.SCOUT_WORKSPACE = scout.workspace_dir;
        if (scout.insight_id) {
          output.env.SCOUT_INSIGHT_ID = String(scout.insight_id);
        }
      }
    },

    "chat.params": async (input, output) => {
      output.options = output.options || {};
      if (input.model?.providerID === "deepseek" || (input.model as any)?.variants?.max) {
        output.options.reasoningEffort = "max";
      } else if (!output.options.reasoningEffort) {
        output.options.reasoningEffort = "high";
      }
    },

    "tool.execute.before": async (input, output) => {
      const scout = getScoutBySession(input.sessionID);
      if (!scout) return;

      if (scout.status === "stopped" || scout.status === "timeout") {
        throw new Error(`[SCOUT_TERMINATED] 当前子分支 (${scout.scout_id}) 状态为 ${scout.status}，已停止执行。`);
      }

      if (scout.deadline_at && Date.now() > Number(scout.deadline_at)) {
        db.prepare(`UPDATE scouts SET status = 'timeout', updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(
          scout.scout_id
        );
        throw new Error(
          `[SCOUT_TIMEOUT] 当前子分支 (${scout.scout_id}) 已超过设定的超时时间 (${scout.timeout_sec}s)，请立即停止操作。`
        );
      }

      const settlementTools = new Set([
        "record_fact",
        "report_finding",
        "submit_scout_report",
        "graph_overview",
        "load_skill"
      ]);

      // 1. Increment step count and check turn budget (default 80, extendable via extend_scout)
      if (!settlementTools.has(input.tool)) {
        const nextStep = (scout.steps_used || 0) + 1;
        db.prepare(`UPDATE scouts SET steps_used = ?, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(
          nextStep,
          scout.scout_id
        );

        if (nextStep > scout.max_steps) {
          db.prepare(`UPDATE scouts SET status = 'exhausted', updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(
            scout.scout_id
          );
          throw new Error(
            `[BUDGET_EXHAUSTED] 你已达到当前轮数上限 (${scout.max_steps} 步)。请立即停止调用探测/执行类工具，直接调用 record_fact(insight_id=${scout.insight_id || 1}, ...) 记录已发现的事实，并调用 submit_scout_report 提交完整阶段性报告（如果任务尚未完成、需要更多轮数深入探索，请将 submit_scout_report 的 suggest_more_turns 设为 true，主 Agent 可为你动态追加轮数）。`
          );
        }
      }

      // 2. Workspace Boundary Hook Approval for file modification tools
      const writeTools = new Set(["write", "edit", "apply_patch"]);
      if (writeTools.has(input.tool)) {
        const rawPath = output.args?.filePath || output.args?.path || "";
        if (rawPath) {
          const resolvedPath = rawPath.startsWith("/") ? resolve(rawPath) : resolve(PROJECT_ROOT, rawPath);
          if (!isInsideDir(resolvedPath, scout.workspace_dir)) {
            const res = db
              .prepare(`
              INSERT INTO hook_approvals (scout_id, session_id, tool_name, target_path, args_json, status)
              VALUES (?, ?, ?, ?, ?, 'pending')
            `)
              .run(scout.scout_id, input.sessionID, input.tool, resolvedPath, JSON.stringify(output.args || {}));
            const approvalId = res.lastInsertRowid;

            pushOutboxEvent(scout.parent_session_id, scout.scout_id, "hook_approval_needed", {
              approval_id: Number(approvalId),
              scout_id: scout.scout_id,
              tool_name: input.tool,
              target_path: resolvedPath,
              workspace_dir: scout.workspace_dir
            });

            const approved = await waitForHookApproval(approvalId, 120000);
            if (!approved) {
              throw new Error(
                `[WORKSPACE_HOOK_DENIED] 越界修改被拦截 (Approval #${approvalId})：你的专属工作区是 ${scout.workspace_dir}，修改工作区外文件 (${resolvedPath}) 未获人工批准。请将所有脚本、临时文件和产物写入 ${scout.workspace_dir} 目录内！`
              );
            }
          }
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const scout = getScoutBySession(input.sessionID);

      if (scout) {
        for (let i = 0; i < output.system.length; i++) {
          output.system[i] = output.system[i]
            .replace(/IMPORTANT: Keep your responses short[\s\S]*?demonstrate appropriate verbosity:/g, "")
            .replace(/You MUST answer concisely with fewer than 4 lines[^\n]*/g, "");
        }
        const remainSec = scout.deadline_at
          ? Math.max(0, Math.round((Number(scout.deadline_at) - Date.now()) / 1000))
          : scout.timeout_sec;
        let requestedSkills: string[] = [];
        try {
          requestedSkills = JSON.parse(scout.skills_json || "[]");
        } catch {}
        const parentInsight = scout.insight_id
          ? getInsightBySessionAndId(scout.parent_session_id, Number(scout.insight_id))
          : null;
        const insightBanner = parentInsight
          ? `- 归属 Insight: **Insight #${parentInsight.id}** — ${parentInsight.title}\n` +
            `  - 情报/直觉: ${parentInsight.insight}\n` +
            (parentInsight.hypothesis ? `  - 待验证假设: ${parentInsight.hypothesis}\n` : "")
          : "";
        const skillsSection = formatSkillsBlockForScout(requestedSkills);

        output.system.push(
          `\n# PurpleLight (紫电) 子分支运行契约 (${scout.scout_id})\n` +
            `- 身份: 紫电 (PurpleLight) 系统的执行子 Agent (${scout.scout_id}, role: ${scout.role})\n` +
            insightBanner +
            `- 专属工作区: ${scout.workspace_dir} (所有脚本、临时文件、下载产物请写在此目录内；修改目录外文件会触发 Hook 拦截审批)\n` +
            `- 预算约束: 轮数已用 ${scout.steps_used}/${scout.max_steps} 步 | 剩余超时时间约 ${remainSec}s (执行 curl/网络请求时务必加上 --max-time 或 timeout 以防单步永久阻塞；后台启动常驻服务须重定向关闭句柄 \`< /dev/null > server.log 2>&1 &\`)\n` +
            (skillsSection ? `${skillsSection}\n` : "") +
            `- 黑板写入规范: 你只能增量写入 \`record_fact\` 与 \`report_finding\`（无权修改或删除 Insights），且每次调用**必须传入 \`insight_id\`**（默认传入你的归属 Insight ID: \`${scout.insight_id || 1}\`）。完成任务或轮数耗尽时，必须调用 \`submit_scout_report\` 提交完整最终报告（提交后会自动回调唤醒主 Agent）。`
        );
      } else {
        output.system.length = 0;
        const archiveStats = getHistoricalArchiveStats(input.sessionID);
        const skillBlocks = formatSkillBlocksForStrategist();

        output.system.push(
          `你是 **紫电 (PurpleLight)**，安全漏洞挖掘与研究工作台的主 Agent（Strategist）。\n\n` +
            `## 核心方法论与职责边界\n` +
            `- 漏洞挖掘遵循 **「情报/直觉 (Insight) -> 形成攻击假设 (Hypothesis) -> 派生 Scout 实证验证 -> 沉淀 Fact / Finding」** 的闭环。\n` +
            `- 为保持主会话上下文洁净，你不直接挂载 \`bash / read / write / grep\` 等底层执行工具；日常技术讨论、威胁建模与攻击面推演直接自然回答，根据问题本身决定详略。\n` +
            `- **跨会话历史记忆召回（重要）**：当用户在当前会话提到要挖掘或继续研究某个目标（例如“我要挖 Vercel”）且当前黑板为空时，**请先主动调用 \`search_history\` 检索历史数据库**（当前历史归档库共存有 ${archiveStats.sessions_count} 个历史会话、${archiveStats.insights_count} 条 Insights、${archiveStats.findings_count} 个 Findings、${archiveStats.facts_count} 条 Facts）。若发现此前已挖掘过该目标，调用 \`load_history\` 将相关的历史 Insights / Findings / Facts 加载进本轮黑板，避免重复踩坑或漏掉既有成果。\n` +
            `- **黑板权限模型**：\n` +
            `  - **只有你（主脑）拥有 \`manage_insight\` 与 \`delete_record\` 权限**：负责创建、更新（状态：\`exploring\` / \`confirmed\` / \`falsified\` / \`parked\`）和删除 Insights，以及删改勘误黑板上的 Facts / Findings。\n` +
            `  - 在调用 \`fork_scout\` 派发侦察或验证任务前，必须先通过 \`manage_insight\` 建立（或确认已有）对应的 \`insight_id\`，并将该 \`insight_id\` 传给 \`fork_scout\`；Scout 子分支只能向关联的 \`insight_id\` 增量写入 \`record_fact\` 与 \`report_finding\`。\n\n` +
            `## 编排与黑板工具\n` +
            `- \`load_skill\`: 加载主脑专属领域知识 Skill（如赏金平台规则、Root Cause 判重准则、报告规范等）\n` +
            `- \`search_history\` / \`load_history\`: 检索跨会话历史数据库，并将指定历史会话/目标的 Insights、Findings、Facts 一键导入本轮黑板\n` +
            `- \`manage_insight\`: 新增 (\`add\`)、更新 (\`update\`) 或删除 (\`delete\`) 灵感/情报/攻击假设节点\n` +
            `- \`graph_overview\`: 查看本轮探索图树状全貌（传入 \`insight_id\` 可下钻查看该节点下所有 Facts 与 Findings 的完整正文与 PoC）\n` +
            `- \`record_fact\` / \`report_finding\` / \`delete_record\`: 主脑登记或删除勘误事实与漏洞记录\n` +
            `- \`fork_scout\`: 绑定 \`insight_id\` 分叉出继承完整上下文的 Scout 子分支静默执行（支持指定 \`skills\`、\`max_steps\`、\`timeout_sec\`）；结束或异常退出时自动回调唤醒你\n` +
            `- \`stop_scout\` / \`extend_scout\` / \`send_hint\` / \`broadcast_hint\` / \`get_scout_detail\` / \`list_scouts\` / \`clean_workspaces\`: 控制、续命、单播/广播引导、尾部诊断与清理子分支\n\n` +
            `${skillBlocks}\n\n` +
            `## 飞书快捷指令（仅在用户询问用法时提示）\n` +
            `\`/status\`、\`/scouts\`、\`/stop [scout-id|all]\`、\`/report <scout-id>\`、\`/hint <scout-id> <内容>\`、\`/broadcast <内容>\`、\`/extend <scout-id> <轮数> [秒数]\`、\`/clean [scout-id|all]\`、\`/provider\`、\`/model\`、\`/approve <id>\`、\`/deny <id>\`、\`/new\`、\`/help\``
        );
      }
    },

    tool: {
      load_skill: tool({
        description:
          "按角色隔离加载对应的 Skill 知识文件（主脑加载 skills/strategist/ 下的战略与平台规则 Skill；Scout 加载 skills/scout/ 下的执行层 Skill）。支持可选传入 file_path 读取该 Skill 目录下的附属参考文件。",
        args: {
          name: tool.schema.string().describe("要加载的 Skill 名称（例如 'hackerone-rules' 或 'bilibili-intel'）"),
          file_path: tool.schema
            .string()
            .optional()
            .describe("可选：读取该 Skill 目录下的附属文件相对路径（如 'references/checklist.md'）；省略则读取主 SKILL.md")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          const callerRole: "strategist" | "scout" = scout ? "scout" : "strategist";
          const { strategistSkills, scoutSkills } = discoverAllSkillsAndMcp();
          const ownPool = callerRole === "strategist" ? strategistSkills : scoutSkills;
          const otherPool = callerRole === "strategist" ? scoutSkills : strategistSkills;

          const found = ownPool.find((s) => s.name === args.name);
          if (!found) {
            const inOther = otherPool.find((s) => s.name === args.name);
            if (inOther && callerRole === "strategist") {
              return JSON.stringify({
                status: "role_mismatch",
                message: `Skill '${args.name}' 属于 Scout 执行层技能 (${inOther.description})。为保持主脑上下文洁净，主脑无需直接加载它——请在调用 fork_scout(insight_id=..., skills=["${args.name}"], goal=...) 时将其指派给 Scout 加载执行。`,
                available_strategist_skills: strategistSkills.map((s) => s.name)
              });
            }
            if (inOther && callerRole === "scout") {
              return JSON.stringify({
                status: "role_mismatch",
                message: `Skill '${args.name}' 属于主脑专属战略技能，Scout 只能加载执行层 Skills。`,
                available_scout_skills: scoutSkills.map((s) => s.name)
              });
            }
            return JSON.stringify({
              status: "not_found",
              message: `未找到名为 '${args.name}' 的 ${callerRole} Skill。`,
              available_skills: ownPool.map((s) => ({ name: s.name, description: s.description }))
            });
          }

          if (args.file_path && args.file_path.trim()) {
            const targetFile = resolve(found.skillDir, args.file_path.trim());
            if (!isInsideDir(targetFile, found.skillDir) || !existsSync(targetFile)) {
              throw new Error(`Skill '${found.name}' 下不存在附属文件: ${args.file_path}`);
            }
            return JSON.stringify(
              {
                status: "ok",
                skill: found.name,
                role: found.role,
                file: args.file_path.trim(),
                content: readFileSync(targetFile, "utf-8")
              },
              null,
              2
            );
          }

          const content = readFileSync(found.skillMdPath, "utf-8");
          const linkedFiles = listFilesRelative(found.skillDir);
          return JSON.stringify(
            {
              status: "ok",
              skill: found.name,
              role: found.role,
              description: found.description,
              linked_files: linkedFiles,
              content
            },
            null,
            2
          );
        }
      }),

      graph_overview: tool({
        description:
          "查看当前会话的探索图树状黑板（包含所有 Insights 及其下属的 Facts 摘要、Findings 摘要与 Scouts 状态；若传入 insight_id 则下钻返回该 Insight 下全部 Facts 和 Findings 的完整正文与 PoC 细节）",
        args: {
          insight_id: tool.schema
            .number()
            .optional()
            .describe("可选：指定某个 Insight ID，下钻读取其关联的全部 Facts 详细内容与 Findings 完整 PoC")
        },
        async execute(args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const overview = getGraphOverview(mainId, args.insight_id);
          return JSON.stringify(overview, null, 2);
        }
      }),

      search_history: tool({
        description:
          "【主脑专用】搜索跨会话持久保存在数据库中的历史 Insights（情报/灵感/攻击假设）、Findings（已确认漏洞）与 Facts（验证事实）。开启新目标（如用户说“我要挖 Vercel”）时应第一时间调用检索历史积累。",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe("搜索关键词（如目标名 'vercel'、组件名 'better-auth'、漏洞类型 'ssrf' 等；留空则列出所有历史归档会话总览）"),
          status: tool.schema
            .enum(["exploring", "confirmed", "falsified", "parked"])
            .optional()
            .describe("可选：按 Insight 状态过滤"),
          limit: tool.schema.number().optional().describe("最大返回条数，默认 30")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "search_history");
          const res = searchHistoricalKnowledge({
            excludeSessionId: ctx.sessionID,
            query: args.query,
            status: args.status,
            limit: args.limit
          });
          return JSON.stringify(res, null, 2);
        }
      }),

      load_history: tool({
        description:
          "【主脑专用】将历史会话中匹配目标的 Insights 及其关联的所有 Facts 和 Findings 一键加载导入到当前会话黑板中（自动按当前会话重新顺序编号并保持关联树结构，自动跳过重复导入）。",
        args: {
          source_session_id: tool.schema.string().describe("要导入的历史主会话 ID（从 search_history 结果中获取）"),
          insight_ids: tool.schema
            .array(tool.schema.number())
            .optional()
            .describe("可选：仅导入指定的历史 Insight ID 列表；不传则导入该历史会话下匹配 query 或全部的 Insights"),
          query: tool.schema.string().optional().describe("可选：按关键词过滤要导入的 Insights")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "load_history");
          const res = loadHistoryIntoSession({
            targetSessionId: ctx.sessionID,
            sourceSessionId: args.source_session_id,
            insightIds: args.insight_ids,
            query: args.query
          });
          return JSON.stringify(res, null, 2);
        }
      }),

      manage_insight: tool({
        description:
          "【主脑专用】管理探索图上的核心灵感/情报/攻击假设节点 (Insight)。支持新增 (add)、更新状态或内容 (update) 与删除 (delete)。子 Agent 无权调用。",
        args: {
          action: tool.schema.enum(["add", "update", "delete"]).describe("操作类型: add | update | delete"),
          insight_id: tool.schema.number().optional().describe("update 或 delete 时必填的目标 Insight ID"),
          target: tool.schema.string().optional().describe("所属目标或子系统标签（如 'vercel'、'vercel/ai'、'better-auth'）"),
          title: tool.schema.string().optional().describe("灵感/假设简短标题（add 时必填）"),
          insight: tool.schema
            .string()
            .optional()
            .describe("触发该灵感的底层情报、安全公告规律、架构观察或直觉依据（add 时必填）"),
          hypothesis: tool.schema
            .string()
            .optional()
            .describe("由此形成的具体攻击假设、不对称点与待验证路径"),
          status: tool.schema
            .enum(["exploring", "confirmed", "falsified", "parked"])
            .optional()
            .describe("状态: exploring(验证中) | confirmed(已实锤出洞) | falsified(已证伪排除) | parked(暂缓)"),
          priority: tool.schema.number().optional().describe("优先级 1-10，默认 5"),
          cascade: tool.schema
            .boolean()
            .optional()
            .describe("delete 时是否一并删除当前会话下挂载在该 Insight 上的 facts 与 findings（默认 true）")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "manage_insight");
          const mainId = ctx.sessionID;
          ensureHuntingSession(mainId, "", args.target || "");

          if (args.action === "add") {
            if (!args.title?.trim() || !args.insight?.trim()) {
              throw new Error("manage_insight(action='add') 必须提供非空的 title 与 insight 字段");
            }
            const nextId = nextSessionScopedId("insights", mainId);
            const status = args.status || "exploring";
            const priority = args.priority ?? 5;
            db.prepare(`
              INSERT INTO insights (id, main_session_id, target, title, insight, hypothesis, priority, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              nextId,
              mainId,
              (args.target || "").trim(),
              args.title.trim(),
              args.insight.trim(),
              (args.hypothesis || "").trim(),
              priority,
              status
            );
            return JSON.stringify({
              status: "ok",
              action: "added",
              insight_id: nextId,
              title: args.title.trim(),
              insight_status: status
            });
          }

          if (args.action === "update") {
            if (!args.insight_id) {
              throw new Error("manage_insight(action='update') 必须指定 insight_id");
            }
            const existing = requireValidInsight(mainId, args.insight_id);
            const newTarget = args.target !== undefined ? args.target.trim() : existing.target;
            const newTitle = args.title !== undefined ? args.title.trim() : existing.title;
            const newInsight = args.insight !== undefined ? args.insight.trim() : existing.insight;
            const newHyp = args.hypothesis !== undefined ? args.hypothesis.trim() : existing.hypothesis;
            const newStatus = args.status !== undefined ? args.status : existing.status;
            const newPrio = args.priority !== undefined ? args.priority : existing.priority;

            db.prepare(`
              UPDATE insights
              SET target = ?, title = ?, insight = ?, hypothesis = ?, status = ?, priority = ?, updated_at = CURRENT_TIMESTAMP
              WHERE main_session_id = ? AND id = ?
            `).run(newTarget, newTitle, newInsight, newHyp, newStatus, newPrio, mainId, args.insight_id);

            return JSON.stringify({
              status: "ok",
              action: "updated",
              insight_id: args.insight_id,
              title: newTitle,
              insight_status: newStatus
            });
          }

          if (args.action === "delete") {
            if (!args.insight_id) {
              throw new Error("manage_insight(action='delete') 必须指定 insight_id");
            }
            requireValidInsight(mainId, args.insight_id);
            const cascade = args.cascade !== false;
            let deletedFacts = 0;
            let deletedFindings = 0;
            if (cascade) {
              deletedFacts = db
                .prepare(`DELETE FROM facts WHERE main_session_id = ? AND insight_id = ?`)
                .run(mainId, args.insight_id).changes;
              deletedFindings = db
                .prepare(`DELETE FROM findings WHERE main_session_id = ? AND insight_id = ?`)
                .run(mainId, args.insight_id).changes;
            }
            db.prepare(`DELETE FROM insights WHERE main_session_id = ? AND id = ?`).run(mainId, args.insight_id);
            return JSON.stringify({
              status: "ok",
              action: "deleted",
              insight_id: args.insight_id,
              deleted_facts: deletedFacts,
              deleted_findings: deletedFindings
            });
          }

          throw new Error(`Unsupported action: ${args.action}`);
        }
      }),

      delete_record: tool({
        description: "【主脑专用】删除当前会话黑板上误报、重复或无价值的 Fact 或 Finding 记录（Scout 无删除权限）。",
        args: {
          record_type: tool.schema.enum(["fact", "finding"]).describe("要删除的记录类型: fact | finding"),
          id: tool.schema.number().describe("当前会话下的 Fact ID 或 Finding ID")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "delete_record");
          const mainId = ctx.sessionID;
          const table = args.record_type === "fact" ? "facts" : "findings";
          const res = db.prepare(`DELETE FROM ${table} WHERE main_session_id = ? AND id = ?`).run(mainId, args.id);
          if (res.changes === 0) {
            throw new Error(`未在当前会话黑板找到 ${args.record_type} #${args.id}`);
          }
          return JSON.stringify({
            status: "ok",
            deleted_type: args.record_type,
            deleted_id: args.id
          });
        }
      }),

      record_fact: tool({
        description:
          "向探索图黑板增量写入一条验证得出的客观事实/结论 (Fact，必须绑定到已有的 insight_id；肯定结论与证伪排除结论均应记录)",
        args: {
          insight_id: tool.schema.number().describe("必填：该事实归属的 Insight ID"),
          summary: tool.schema.string().describe("一句话核心结论摘要"),
          detail: tool.schema.string().describe("详细技术分析、调用链、外部情报拆解或实验证据（不限长度）"),
          evidence: tool.schema.string().optional().describe("关键命令输出、文件路径行号或流量特征"),
          source: tool.schema
            .string()
            .optional()
            .describe("来源: code_audit | target_response | tool_output | third_party_intel | inference"),
          confidence: tool.schema.string().optional().describe("置信度: observed | inferred")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          const mainId = scout ? scout.parent_session_id : ctx.sessionID;
          const scoutId = scout ? scout.scout_id : "strategist";
          const insightId = args.insight_id ?? (scout?.insight_id ? Number(scout.insight_id) : null);

          if (!insightId) {
            throw new Error("record_fact 必须传入关联的 insight_id");
          }
          requireValidInsight(mainId, insightId);

          const nextFactId = nextSessionScopedId("facts", mainId);
          db.prepare(`
            INSERT INTO facts (id, main_session_id, insight_id, scout_id, summary, detail, evidence, source, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            nextFactId,
            mainId,
            insightId,
            scoutId,
            args.summary,
            args.detail,
            args.evidence ?? "",
            args.source ?? "observation",
            args.confidence ?? "observed"
          );

          db.prepare(`UPDATE insights SET updated_at = CURRENT_TIMESTAMP WHERE main_session_id = ? AND id = ?`).run(
            mainId,
            insightId
          );

          return JSON.stringify({
            status: "ok",
            fact_id: nextFactId,
            insight_id: insightId,
            scout_id: scoutId
          });
        }
      }),

      report_finding: tool({
        description: "向探索图黑板增量登记一个已确认的漏洞或高价值风险点 (Finding，必须绑定到已有的 insight_id，含完整 PoC 与证据)",
        args: {
          insight_id: tool.schema.number().describe("必填：该漏洞归属的 Insight ID"),
          title: tool.schema.string().describe("漏洞标题"),
          severity: tool.schema.enum(["critical", "high", "medium", "low"]).describe("严重程度"),
          vuln_class: tool.schema.string().describe("漏洞类型，如 SSRF / HTTP Desync / IDOR / RCE / Auth Bypass"),
          summary: tool.schema.string().describe("漏洞一句话原理概述"),
          poc_detail: tool.schema.string().describe("完整的复现步骤、代码位置、Payload 与验证输出（不限字数）"),
          counterevidence: tool.schema.string().optional().describe("已排除的干扰因素或边界限制说明")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          const mainId = scout ? scout.parent_session_id : ctx.sessionID;
          const scoutId = scout ? scout.scout_id : "strategist";
          const insightId = args.insight_id ?? (scout?.insight_id ? Number(scout.insight_id) : null);

          if (!insightId) {
            throw new Error("report_finding 必须传入关联的 insight_id");
          }
          requireValidInsight(mainId, insightId);

          const nextFindingId = nextSessionScopedId("findings", mainId);
          db.prepare(`
            INSERT INTO findings (id, main_session_id, insight_id, scout_id, title, severity, vuln_class, summary, poc_detail, counterevidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            nextFindingId,
            mainId,
            insightId,
            scoutId,
            args.title,
            args.severity,
            args.vuln_class,
            args.summary,
            args.poc_detail,
            args.counterevidence ?? ""
          );

          db.prepare(`
            UPDATE insights
            SET status = CASE WHEN status = 'exploring' THEN 'confirmed' ELSE status END,
                updated_at = CURRENT_TIMESTAMP
            WHERE main_session_id = ? AND id = ?
          `).run(mainId, insightId);

          if (scout) {
            await client.session
              .prompt({
                path: { id: mainId },
                body: {
                  noReply: true,
                  parts: [
                    {
                      type: "text",
                      text: `🔥 [Scout ${scoutId} 在 Insight #${insightId} 下登记漏洞 Finding #${nextFindingId}] [${args.severity.toUpperCase()}] ${args.title}\n摘要: ${args.summary}\n详情与PoC:\n${args.poc_detail}`
                    }
                  ]
                }
              })
              .catch(() => {});
          }

          return JSON.stringify({
            status: "ok",
            finding_id: nextFindingId,
            insight_id: insightId
          });
        }
      }),

      fork_scout: tool({
        description:
          "【主脑专用】围绕指定的 Insight ID，从当前主会话一键分叉 (Fork) 出继承完整对话上下文的 Scout 子 Agent，分配独立工作区在后台静默执行；结束或超时后自动回调激活主 Agent。",
        args: {
          insight_id: tool.schema
            .number()
            .describe("必填：该 Scout 任务所归属/验证的 Insight ID（请先通过 manage_insight 建立 Insight）"),
          goal: tool.schema.string().describe("指派给该 Scout 子 Agent 的具体任务目标与验证要求"),
          skills: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("可选：点名要求该 Scout 优先加载使用的执行层 Skill 名称列表（见 <scout_available_capabilities>）"),
          max_steps: tool.schema.number().optional().describe("最大执行轮数上限，默认 80 轮"),
          timeout_sec: tool.schema
            .number()
            .optional()
            .describe("最大超时时间（秒），默认 600 秒（10分钟）；超时后自动中断并回调激活主 Agent"),
          model: tool.schema
            .string()
            .optional()
            .describe(`可选：临时指定子 Agent 模型（支持前缀 ${SUPPORTED_PROVIDERS.join("/")}），默认使用当前配置的 scout 模型`)
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "fork_scout");
          const mainId = ctx.sessionID;
          const insightRow = requireValidInsight(mainId, args.insight_id);

          const maxSteps = args.max_steps ?? 80;
          const timeoutSec = Math.max(5, args.timeout_sec ?? 600);
          const deadlineAt = Date.now() + timeoutSec * 1000;
          const requestedSkills = Array.isArray(args.skills) ? args.skills.filter(Boolean) : [];

          const configuredScoutModel = getAgentModelConfig("scout");
          let providerID: string = configuredScoutModel.providerID;
          let modelID: string = configuredScoutModel.modelID;
          if (args.model) {
            const slashIdx = args.model.indexOf("/");
            if (slashIdx > 0 && isSupportedProvider(args.model.slice(0, slashIdx))) {
              providerID = args.model.slice(0, slashIdx);
              modelID = args.model.slice(slashIdx + 1);
            } else {
              modelID = args.model;
            }
          }

          const forkRes = await client.session.fork({
            path: { id: mainId }
          });
          if (forkRes.error || !forkRes.data) {
            throw new Error(`Failed to fork session: ${JSON.stringify(forkRes.error)}`);
          }
          const forkedSessionId = forkRes.data.id;

          const countRow = db
            .prepare(`SELECT COUNT(*) as cnt FROM scouts WHERE parent_session_id = ?`)
            .get(mainId) as any;
          const scoutNum = (countRow?.cnt || 0) + 1;
          const scoutId = `scout-${scoutNum}`;
          const workspaceDir = resolve(WORKSPACES_ROOT, scoutId);
          mkdirSync(workspaceDir, { recursive: true });

          await client.session
            .update({
              path: { id: forkedSessionId },
              body: { title: `[${scoutId} -> Insight#${args.insight_id}] ${args.goal.slice(0, 45)}` }
            })
            .catch(() => {});

          const chatBinding = db
            .prepare(`SELECT last_user_msg_id FROM chat_bindings WHERE main_session_id = ?`)
            .get(mainId) as any;
          const originUserMsgId = chatBinding?.last_user_msg_id || null;

          db.prepare(`
            INSERT OR REPLACE INTO scouts (
              scout_id, session_id, parent_session_id, insight_id, role, goal, skills_json, workspace_dir, model,
              status, steps_used, max_steps, timeout_sec, deadline_at, callback_sent, feishu_thread_msg_id
            )
            VALUES (?, ?, ?, ?, 'scout', ?, ?, ?, ?, 'running', 0, ?, ?, ?, 0, ?)
          `).run(
            scoutId,
            forkedSessionId,
            mainId,
            args.insight_id,
            args.goal,
            JSON.stringify(requestedSkills),
            workspaceDir,
            `${providerID}/${modelID}`,
            maxSteps,
            timeoutSec,
            deadlineAt,
            originUserMsgId
          );

          const skillsDirective =
            requestedSkills.length > 0
              ? `- 必读 Skills: 请先调用 ${requestedSkills.map((s) => `\`load_skill(name="${s}")\``).join(", ")} 加载工作流说明后再执行操作！\n`
              : "";

          const launchPrompt =
            `🎯 [子 Agent 专项任务指派 — ${scoutId}]\n` +
            `- 归属 Insight: **Insight #${insightRow.id}** (${insightRow.title})\n` +
            `  - 情报依据: ${insightRow.insight}\n` +
            (insightRow.hypothesis ? `  - 核心假设: ${insightRow.hypothesis}\n` : "") +
            `- 专属工作目录: ${workspaceDir} (所有临时文件、脚本、下载内容必须保存在该目录下)\n` +
            `- 轮数预算上限: ${maxSteps} 步 | 超时上限: ${timeoutSec} 秒\n` +
            skillsDirective +
            `- 你的具体任务目标:\n${args.goal}\n\n` +
            `请结合你继承的前序主会话上下文立即开始执行。过程中发现的关键事实（含肯定实锤与证伪排除）请调用 \`record_fact(insight_id=${insightRow.id}, ...)\`，确认漏洞请调用 \`report_finding(insight_id=${insightRow.id}, ...)\`，任务完成时请务必调用 \`submit_scout_report\` 提交完整最终报告！`;

          await client.session.promptAsync({
            path: { id: forkedSessionId },
            body: {
              agent: "scout",
              variant: "max",
              model: { providerID, modelID },
              parts: [{ type: "text", text: launchPrompt }]
            } as any
          });

          return JSON.stringify({
            status: "forked_and_running_silently",
            scout_id: scoutId,
            session_id: forkedSessionId,
            insight_id: args.insight_id,
            insight_title: insightRow.title,
            skills: requestedSkills,
            workspace_dir: workspaceDir,
            max_steps: maxSteps,
            timeout_sec: timeoutSec,
            model: `${providerID}/${modelID}`
          });
        }
      }),

      stop_scout: tool({
        description: "【主脑专用】强制终止指定正在运行或卡住的 Scout 子分支",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          reason: tool.schema.string().optional().describe("终止原因说明（可选）")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "stop_scout");
          const scout = getScoutById(args.scout_id);
          if (!scout) {
            throw new Error(`Scout not found: ${args.scout_id}`);
          }
          await client.session
            .abort({
              path: { id: scout.session_id }
            })
            .catch(() => {});

          const summaryNote = args.reason ? `由主脑主动终止: ${args.reason}` : "由主脑主动终止 (stopped)";
          db.prepare(`
            UPDATE scouts
            SET status = 'stopped', callback_sent = 1, report_summary = COALESCE(NULLIF(report_summary, ''), ?), updated_at = CURRENT_TIMESTAMP
            WHERE scout_id = ?
          `).run(summaryNote, scout.scout_id);

          return JSON.stringify({
            status: "stopped",
            scout_id: scout.scout_id,
            insight_id: scout.insight_id,
            steps_used: scout.steps_used,
            reason: summaryNote
          });
        }
      }),

      send_hint: tool({
        description: "【主脑专用·定向单播 Hint】仅向某一个指定的子 Agent (scout_id) 发送新线索或方向微调指令（静默注入上下文，不干扰其他分支）",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          hint: tool.schema.string().describe("要定向同步给该子 Agent 的线索或指导意见")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "send_hint");
          const scout = getScoutById(args.scout_id);
          if (!scout) {
            throw new Error(`Scout not found: ${args.scout_id}`);
          }
          const mainId = scout.parent_session_id;
          db.prepare(`
            INSERT INTO hints (main_session_id, target_scout_id, content, source)
            VALUES (?, ?, ?, 'strategist_unicast')
          `).run(mainId, scout.scout_id, args.hint);

          await client.session.prompt({
            path: { id: scout.session_id },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `⚡ [来自主会话的定向单播 Hint (仅对 ${scout.scout_id} 可见)]:\n${args.hint}`
                }
              ]
            }
          });

          return JSON.stringify({ status: "delivered_unicast", scout_id: scout.scout_id, hint: args.hint });
        }
      }),

      broadcast_hint: tool({
        description: "【主脑专用·全局广播 Hint】向当前主会话下所有分叉出去的子 Agent 同步广播关键全局线索",
        args: {
          hint: tool.schema.string().describe("需要全局广播的线索内容")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "broadcast_hint");
          const mainId = ctx.sessionID;
          db.prepare(`
            INSERT INTO hints (main_session_id, target_scout_id, content, source)
            VALUES (?, NULL, ?, 'strategist_broadcast')
          `).run(mainId, args.hint);

          const scouts = db.prepare(`SELECT * FROM scouts WHERE parent_session_id = ?`).all(mainId) as any[];
          const deliveredTo: string[] = [];

          for (const s of scouts) {
            await client.session
              .prompt({
                path: { id: s.session_id },
                body: {
                  noReply: true,
                  parts: [
                    {
                      type: "text",
                      text: `🌐 [来自主会话的全局广播 Hint]:\n${args.hint}`
                    }
                  ]
                }
              })
              .catch(() => {});
            deliveredTo.push(s.scout_id);
          }

          return JSON.stringify({ status: "broadcast_complete", delivered_to: deliveredTo, hint: args.hint });
        }
      }),

      extend_scout: tool({
        description: "【主脑专用】动态为某个子 Agent (scout_id) 追加执行轮数上限与超时时间，并唤醒它基于原有上下文继续深度探索",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          add_turns: tool.schema.number().describe("要追加的轮数，例如 40 或 80"),
          timeout_sec: tool.schema.number().optional().describe("重置后的超时时间（秒），默认继承该分支原 timeout_sec（或 600 秒）"),
          instruction: tool.schema.string().optional().describe("追加轮数同时附带的进一步探索指令（可选）")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "extend_scout");
          const scout = getScoutById(args.scout_id);
          if (!scout) {
            throw new Error(`Scout not found: ${args.scout_id}`);
          }
          if (scout.workspace_dir) {
            mkdirSync(scout.workspace_dir, { recursive: true });
          }
          const newMaxSteps = (scout.max_steps || 80) + args.add_turns;
          const timeoutSec = Math.max(5, args.timeout_sec ?? scout.timeout_sec ?? 600);
          const newDeadlineAt = Date.now() + timeoutSec * 1000;

          db.prepare(`
            UPDATE scouts
            SET max_steps = ?, timeout_sec = ?, deadline_at = ?, callback_sent = 0, status = 'running', suggest_more_turns = 0, updated_at = CURRENT_TIMESTAMP
            WHERE scout_id = ?
          `).run(newMaxSteps, timeoutSec, newDeadlineAt, scout.scout_id);

          const configuredScout = getAgentModelConfig("scout");
          let providerID: string = configuredScout.providerID;
          let modelID: string = configuredScout.modelID;
          if (scout.model && scout.model.includes("/")) {
            const idx = scout.model.indexOf("/");
            providerID = scout.model.slice(0, idx);
            modelID = scout.model.slice(idx + 1);
          }
          const resumeText =
            `🔋 [主会话已为你追加预算与超时时间]\n` +
            `- 新增轮数: +${args.add_turns} 步 (当前已用 ${scout.steps_used} 步 / 新上限 ${newMaxSteps} 步) | 新超时窗口: ${timeoutSec}s\n` +
            (args.instruction ? `- 主脑最新指示: ${args.instruction}\n` : `- 请接着刚才的进度继续深入探索，无需重复已完成的工作。\n`) +
            `完成后请再次调用 submit_scout_report 提交完整报告。`;

          await client.session.promptAsync({
            path: { id: scout.session_id },
            body: {
              agent: "scout",
              variant: "max",
              model: { providerID, modelID },
              parts: [{ type: "text", text: resumeText }]
            } as any
          });

          return JSON.stringify({
            status: "extended_and_resumed",
            scout_id: scout.scout_id,
            insight_id: scout.insight_id,
            steps_used: scout.steps_used,
            new_max_steps: newMaxSteps,
            timeout_sec: timeoutSec
          });
        }
      }),

      list_scouts: tool({
        description: "【主脑专用】列出当前主会话分叉出的所有 Scout 子 Agent 及其归属 Insight、状态、轮数消耗、超时设置与汇报摘要",
        args: {},
        async execute(_args, ctx) {
          assertStrategistCaller(ctx.sessionID, "list_scouts");
          const mainId = ctx.sessionID;
          const scouts = db
            .prepare(`
            SELECT scout_id, session_id, insight_id, role, goal, skills_json, workspace_dir, model, status, steps_used, max_steps, timeout_sec, deadline_at, report_summary, suggest_more_turns, created_at, updated_at
            FROM scouts WHERE parent_session_id = ? ORDER BY rowid ASC
          `)
            .all(mainId);
          return JSON.stringify(scouts, null, 2);
        }
      }),

      get_scout_detail: tool({
        description:
          "【主脑专用】获取指定 Scout 子 Agent 的完整详细报告、工作区文件列表、已记录 Facts，以及最后 N 轮的消息与工具调用入参（不含工具返回结果，便于诊断卡死或失败原因）",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          tail_turns: tool.schema.number().optional().describe("要提取的最后几轮助手消息与工具调用入参轮数，默认 5")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "get_scout_detail");
          const scout = getScoutById(args.scout_id);
          if (!scout) throw new Error(`Scout not found: ${args.scout_id}`);
          let files: string[] = [];
          try {
            files = readdirSync(scout.workspace_dir);
          } catch {}
          const facts = db
            .prepare(`SELECT * FROM facts WHERE main_session_id = ? AND scout_id = ? ORDER BY id DESC`)
            .all(scout.parent_session_id, scout.scout_id);
          const findings = db
            .prepare(`SELECT * FROM findings WHERE main_session_id = ? AND scout_id = ? ORDER BY id DESC`)
            .all(scout.parent_session_id, scout.scout_id);

          const tailCount = Math.max(1, Math.min(20, args.tail_turns ?? 5));
          let recentActivity: any[] = [];
          try {
            const msgRes = await client.session.messages({
              path: { id: scout.session_id }
            });
            const allMsgs = Array.isArray(msgRes.data) ? msgRes.data : [];
            const assistantMsgs = allMsgs.filter((m: any) => m?.info?.role === "assistant");
            const sliced = assistantMsgs.slice(-tailCount);
            recentActivity = sliced.map((m: any, idx: number) => {
              const turnNumber = assistantMsgs.length - sliced.length + idx + 1;
              const texts: string[] = [];
              const toolCalls: any[] = [];
              for (const part of m.parts || []) {
                if (part?.type === "text" && part.text?.trim()) {
                  texts.push(part.text.trim());
                } else if (part?.type === "tool") {
                  const st = part.state || {};
                  const callEntry: Record<string, any> = {
                    tool: part.tool,
                    status: st.status || "unknown",
                    input: st.input ?? {}
                  };
                  if (st.status === "error" && st.error) {
                    callEntry.error = String(st.error).slice(0, 500);
                  }
                  if (st.time) {
                    callEntry.time = st.time;
                  }
                  toolCalls.push(callEntry);
                }
              }
              return {
                assistant_turn: turnNumber,
                message_id: m.info?.id,
                created_at: m.info?.time?.created ? new Date(m.info.time.created).toISOString() : undefined,
                ...(m.info?.error ? { message_error: m.info.error } : {}),
                ...(texts.length > 0 ? { assistant_text: texts.join("\n") } : {}),
                tool_calls: toolCalls
              };
            });
          } catch (e: any) {
            recentActivity = [{ warning: `Failed to fetch session messages: ${e?.message || String(e)}` }];
          }

          return JSON.stringify(
            {
              scout,
              workspace_files: files,
              recent_activity: recentActivity,
              facts,
              findings
            },
            null,
            2
          );
        }
      }),

      clean_workspaces: tool({
        description:
          "【主脑专用】清理 Scout 子分支的专属工作区目录 (workspaces/scout-N)。可指定清理单个 scout_id、清理当前主会话下所有已结束的 Scout 工作区，或全量清理所有工作区。",
        args: {
          scout_id: tool.schema
            .string()
            .optional()
            .describe("指定要清理的单个子分支 ID（如 scout-1）；不传则默认清理当前主会话下的 Scout 工作区"),
          all: tool.schema.boolean().optional().describe("设为 true 时清理 workspaces/ 下的全部历史工作区目录"),
          include_running: tool.schema
            .boolean()
            .optional()
            .describe("是否连同仍在 running 状态的子分支工作区一并强制清理（默认 false，保护运行中分支）")
        },
        async execute(args, ctx) {
          assertStrategistCaller(ctx.sessionID, "clean_workspaces");
          const mainId = ctx.sessionID;
          const res = cleanScoutWorkspaces({
            mainSessionId: mainId,
            scoutId: args.scout_id,
            all: args.all,
            includeRunning: args.include_running
          });
          return JSON.stringify(
            {
              status: "ok",
              ...res
            },
            null,
            2
          );
        }
      }),

      submit_scout_report: tool({
        description:
          "【Scout 专用最终汇报工具】当 Scout 完成指派的任务（或达到轮数上限收尾）时调用，将完整详尽的最终报告（不限字数）推送到飞书并自动回调激活主 Agent",
        args: {
          summary: tool.schema.string().describe("核心结论摘要（1-3句话，便于主会话快速索引）"),
          detail: tool.schema
            .string()
            .describe("完整详尽的调查报告正文（不限长度！可包含完整代码调用链分析、外部报告关键情报提炼、PoC 输出结果、实验数据等）"),
          suggest_more_turns: tool.schema
            .boolean()
            .optional()
            .describe("如果当前任务因轮数限制或复杂度尚未彻底完成，设为 true 请求主 Agent 调用 extend_scout 追加轮数"),
          suggested_next_steps: tool.schema.string().optional().describe("建议主 Agent 接下来采取的行动或进一步探索方向")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          if (!scout) {
            return "Warning: submit_scout_report should be called by a forked scout session.";
          }
          const newStatus = args.suggest_more_turns ? "exhausted" : "completed";
          db.prepare(`
            UPDATE scouts
            SET status = ?, callback_sent = 1, report_summary = ?, report_detail = ?, suggest_more_turns = ?, suggested_next_steps = ?, updated_at = CURRENT_TIMESTAMP
            WHERE scout_id = ?
          `).run(
            newStatus,
            args.summary,
            args.detail,
            args.suggest_more_turns ? 1 : 0,
            args.suggested_next_steps ?? "",
            scout.scout_id
          );

          pushOutboxEvent(scout.parent_session_id, scout.scout_id, "scout_report_submitted", {
            scout_id: scout.scout_id,
            insight_id: scout.insight_id,
            goal: scout.goal,
            status: newStatus,
            steps_used: scout.steps_used,
            max_steps: scout.max_steps,
            summary: args.summary,
            detail: args.detail,
            suggest_more_turns: !!args.suggest_more_turns,
            suggested_next_steps: args.suggested_next_steps ?? ""
          });

          return JSON.stringify({
            status: "report_submitted_and_main_agent_callback_queued",
            scout_id: scout.scout_id,
            insight_id: scout.insight_id,
            scout_status: newStatus
          });
        }
      })
    }
  };
};

export default PurpleLightPlugin;

import { type Plugin, tool } from "@opencode-ai/plugin";
import { mkdirSync, readdirSync } from "fs";
import { join, resolve, relative } from "path";
import { PROJECT_ROOT, WORKSPACES_ROOT, db, pushOutboxEvent, getGraphOverview, getAgentModelConfig, cleanScoutWorkspaces } from "../src/db";

const BILI_SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "bili_sub.py");

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

function isInsideWorkspace(targetPath: string, workspaceDir: string): boolean {
  const absTarget = resolve(targetPath);
  const absWorkspace = resolve(workspaceDir);
  const rel = relative(absWorkspace, absTarget);
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
  db.prepare(`UPDATE hook_approvals SET status = 'timeout', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).run(approvalId);
  return false;
}

export const PurpleLightPlugin: Plugin = async ({ client }) => {
  return {
    "shell.env": async (input, output) => {
      if (!input.sessionID) return;
      const scout = getScoutBySession(input.sessionID);
      if (scout) {
        output.env.SCOUT_ID = scout.scout_id;
        output.env.SCOUT_WORKSPACE = scout.workspace_dir;
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
        db.prepare(`UPDATE scouts SET status = 'timeout', updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(scout.scout_id);
        throw new Error(`[SCOUT_TIMEOUT] 当前子分支 (${scout.scout_id}) 已超过设定的超时时间 (${scout.timeout_sec}s)，请立即停止操作。`);
      }

      const settlementTools = new Set(["record_fact", "report_finding", "submit_scout_report", "graph_overview"]);

      // 1. Increment step count and check turn budget (default 80, extendable via extend_scout)
      if (!settlementTools.has(input.tool)) {
        const nextStep = (scout.steps_used || 0) + 1;
        db.prepare(`UPDATE scouts SET steps_used = ?, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(nextStep, scout.scout_id);

        if (nextStep > scout.max_steps) {
          db.prepare(`UPDATE scouts SET status = 'exhausted', updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`).run(scout.scout_id);
          throw new Error(
            `[BUDGET_EXHAUSTED] 你已达到当前轮数上限 (${scout.max_steps} 步)。请立即停止调用探测/执行类工具，直接调用 record_fact 记录已发现的事实，并调用 submit_scout_report 提交完整阶段性报告（如果任务尚未完成、需要更多轮数深入探索，请将 submit_scout_report 的 suggest_more_turns 设为 true，主 Agent 可为你动态追加轮数）。`
          );
        }
      }

      // 2. Workspace Boundary Hook Approval for file modification tools
      const writeTools = new Set(["write", "edit", "apply_patch"]);
      if (writeTools.has(input.tool)) {
        const rawPath = output.args?.filePath || output.args?.path || "";
        if (rawPath) {
          const resolvedPath = rawPath.startsWith("/") ? resolve(rawPath) : resolve(PROJECT_ROOT, rawPath);
          if (!isInsideWorkspace(resolvedPath, scout.workspace_dir)) {
            const res = db.prepare(`
              INSERT INTO hook_approvals (scout_id, session_id, tool_name, target_path, args_json, status)
              VALUES (?, ?, ?, ?, ?, 'pending')
            `).run(scout.scout_id, input.sessionID, input.tool, resolvedPath, JSON.stringify(output.args || {}));
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
        // Strip OpenCode's CLI-only brevity constraint ("fewer than 4 lines / One word answers are best")
        for (let i = 0; i < output.system.length; i++) {
          output.system[i] = output.system[i]
            .replace(/IMPORTANT: Keep your responses short[\s\S]*?demonstrate appropriate verbosity:/g, "")
            .replace(/You MUST answer concisely with fewer than 4 lines[^\n]*/g, "");
        }
        const remainSec = scout.deadline_at ? Math.max(0, Math.round((Number(scout.deadline_at) - Date.now()) / 1000)) : scout.timeout_sec;
        output.system.push(
          `\n# PurpleLight (紫电) 子分支运行契约 (${scout.scout_id})\n` +
          `- 身份: 紫电 (PurpleLight) 系统的执行子 Agent (${scout.scout_id}, role: ${scout.role})\n` +
          `- 专属工作区: ${scout.workspace_dir} (所有脚本、临时文件、下载产物请写在此目录内；修改目录外文件会触发 Hook 拦截审批)\n` +
          `- 预算约束: 轮数已用 ${scout.steps_used}/${scout.max_steps} 步 | 剩余超时时间约 ${remainSec}s (执行 curl/网络请求时务必加上 --max-time 或 timeout 以防单步永久阻塞)\n` +
          `- 如需提取 B 站视频字幕或评论情报，请先调用 skill(name="bilibili-intel") 或执行 python3 ${BILI_SCRIPT_PATH}。\n` +
          `- 关键验证结论（肯定或证伪）请调用 record_fact；确认关键发现请调用 report_finding；完成任务或轮数耗尽时，必须调用 submit_scout_report 提交完整最终报告（提交后会自动回调唤醒主 Agent）。`
        );
      } else {
        // Clear OpenCode's default CLI system prompt ("fewer than 4 lines / One word answers are best")
        output.system.length = 0;
        output.system.push(
          `你是 **紫电 (PurpleLight)**，多智能体软件工程、安全架构合规审计（Authorized SDLC & Defensive Security Research）与深度研究工作台的主 Agent（Strategist）。\n\n` +
          `## 职责与能力边界\n` +
          `- 为保持主会话上下文洁净，你不直接挂载 \`bash / read / write / grep / skill\` 等底层执行工具。\n` +
          `- 日常技术交流、架构梳理与思路讨论直接自然回答即可，根据问题本身决定详略。\n` +
          `- 需要执行具体动作（读取外部文档/报告、用 Skill 提取 B 站视频字幕、代码审查、编写并运行测试验证脚本）时，通过以下编排原语交由子 Agent 完成：\n` +
          `  - \`add_intent\`: 在探索图黑板登记研究意图或待验证假设\n` +
          `  - \`fork_scout\`: 从当前主会话分叉 (Fork) 出继承完整上下文的 Scout 子 Agent，支持设置 \`max_steps\` (默认 80 轮) 与 \`timeout_sec\` (默认 600 秒) 在后台静默执行；当 Scout 正常结案、超时或耗尽轮数时，系统会自动回调唤醒你进行下一步决策\n` +
          `  - \`stop_scout\`: 强制终止指定正在运行或卡住的 Scout 子分支\n` +
          `  - \`send_hint\`: 向单个指定 Scout 定向单播发送新线索（静默注入，不影响其他分支）\n` +
          `  - \`broadcast_hint\`: 向所有活跃 Scout 全局广播线索\n` +
          `  - \`extend_scout\`: 为指定 Scout 动态追加轮数上限与超时时间，并唤醒继续探索\n` +
          `  - \`get_scout_detail\`: 查看指定 Scout 的完整报告、工作区文件、Facts，以及**最后 N 轮的消息与工具调用入参**（不含工具返回结果，专用于诊断 Scout 进展或卡死/失败原因）\n` +
          `  - \`list_scouts\` / \`graph_overview\` / \`clean_workspaces\`: 查看分支列表、黑板全貌或清理工作区\n\n` +
          `## 飞书快捷指令（仅在用户询问用法时提示）\n` +
          `\`/status\`、\`/scouts\`、\`/stop [scout-id|all]\`、\`/report <scout-id>\`、\`/hint <scout-id> <内容>\`、\`/broadcast <内容>\`、\`/extend <scout-id> <轮数> [秒数]\`、\`/clean [scout-id|all]\`、\`/provider\`、\`/model\`、\`/approve <id>\`、\`/deny <id>\`、\`/new\`、\`/help\``
        );
      }
    },

    tool: {
      graph_overview: tool({
        description: "查看当前任务的探索图黑板全貌（包含所有 intents 意图、facts 验证事实、findings 关键发现、hints 线索以及 scouts 子分支状态）",
        args: {},
        async execute(_args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const overview = getGraphOverview(mainId);
          return JSON.stringify(overview, null, 2);
        }
      }),

      add_intent: tool({
        description: "在探索图黑板上新增一条研究意图或待验证假设 (Intent)",
        args: {
          title: tool.schema.string().describe("意图/假设简短标题"),
          detail: tool.schema.string().describe("意图详细描述、架构逻辑与验证方向"),
          priority: tool.schema.number().optional().describe("优先级 1-10，默认 5")
        },
        async execute(args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const res = db.prepare(`
            INSERT INTO intents (main_session_id, title, detail, priority, status)
            VALUES (?, ?, ?, ?, 'open')
          `).run(mainId, args.title, args.detail, args.priority ?? 5);
          const intentId = Number(res.lastInsertRowid);
          return JSON.stringify({ status: "ok", intent_id: intentId, title: args.title });
        }
      }),

      record_fact: tool({
        description: "向探索图黑板静默写入一条验证得出的客观事实/结论 (Fact，支持长篇详细 detail 与证据，肯定或否定结论均可记录)",
        args: {
          summary: tool.schema.string().describe("一句话核心结论摘要"),
          detail: tool.schema.string().describe("详细技术分析、调用链、情报拆解或代码证据（不限长度）"),
          evidence: tool.schema.string().optional().describe("关键命令输出、文件路径行号或特征记录"),
          source: tool.schema.string().optional().describe("来源: code_audit | target_response | tool_output | third_party_intel | inference"),
          confidence: tool.schema.string().optional().describe("置信度: observed | inferred"),
          intent_id: tool.schema.number().optional().describe("关联的 intent_id（可选）")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          const mainId = scout ? scout.parent_session_id : ctx.sessionID;
          const scoutId = scout ? scout.scout_id : "strategist";
          const intentId = args.intent_id ?? (scout ? scout.intent_id : null);

          const res = db.prepare(`
            INSERT INTO facts (main_session_id, scout_id, intent_id, summary, detail, evidence, source, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mainId,
            scoutId,
            intentId,
            args.summary,
            args.detail,
            args.evidence ?? "",
            args.source ?? "observation",
            args.confidence ?? "observed"
          );
          const factId = Number(res.lastInsertRowid);
          return JSON.stringify({ status: "ok", fact_id: factId, scout_id: scoutId });
        }
      }),

      report_finding: tool({
        description: "向探索图黑板登记一个已确认的关键问题或高价值架构缺陷发现 (Finding，含完整验证步骤与证据)",
        args: {
          title: tool.schema.string().describe("发现问题标题"),
          severity: tool.schema.enum(["critical", "high", "medium", "low"]).describe("严重程度"),
          vuln_class: tool.schema.string().describe("问题分类或缺陷类型"),
          summary: tool.schema.string().describe("问题一句话原理概述"),
          poc_detail: tool.schema.string().describe("完整的复现验证步骤、代码位置、测试用例与验证输出（不限字数）"),
          counterevidence: tool.schema.string().optional().describe("已排除的干扰因素或边界条件说明"),
          intent_id: tool.schema.number().optional().describe("关联的 intent_id")
        },
        async execute(args, ctx) {
          const scout = getScoutBySession(ctx.sessionID);
          const mainId = scout ? scout.parent_session_id : ctx.sessionID;
          const scoutId = scout ? scout.scout_id : "strategist";
          const intentId = args.intent_id ?? (scout ? scout.intent_id : null);

          const res = db.prepare(`
            INSERT INTO findings (main_session_id, scout_id, intent_id, title, severity, vuln_class, summary, poc_detail, counterevidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mainId,
            scoutId,
            intentId,
            args.title,
            args.severity,
            args.vuln_class,
            args.summary,
            args.poc_detail,
            args.counterevidence ?? ""
          );
          const findingId = Number(res.lastInsertRowid);

          if (scout) {
            await client.session.prompt({
              path: { id: mainId },
              body: {
                noReply: true,
                parts: [{
                  type: "text",
                  text: `🔥 [Scout ${scoutId} 登记漏洞 Finding #${findingId}] [${args.severity.toUpperCase()}] ${args.title}\n摘要: ${args.summary}\n详情与PoC:\n${args.poc_detail}`
                }]
              }
            }).catch(() => {});
          }

          return JSON.stringify({ status: "ok", finding_id: findingId });
        }
      }),

      fork_scout: tool({
        description: "从当前主会话一键分叉 (Fork) 出一个继承全部对话上下文的 Scout 子 Agent，分配独立工作区文件夹、最大轮数 (max_steps) 与超时时间 (timeout_sec) 在后台静默执行；结束或超时后会自动回调激活主 Agent",
        args: {
          goal: tool.schema.string().describe("指派给该 Scout 子 Agent 的具体任务目标与要求"),
          intent_id: tool.schema.number().optional().describe("关联的探索图 intent_id（如果不传则自动创建一个对应 Intent）"),
          max_steps: tool.schema.number().optional().describe("最大执行轮数上限，默认 80 轮"),
          timeout_sec: tool.schema.number().optional().describe("最大超时时间（秒），默认 600 秒（10分钟）；超时后自动中断并回调激活主 Agent"),
          model: tool.schema.string().optional().describe("子 Agent 模型，默认使用当前配置的 scout 模型")
        },
        async execute(args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const maxSteps = args.max_steps ?? 80;
          const timeoutSec = Math.max(5, args.timeout_sec ?? 600);
          const deadlineAt = Date.now() + timeoutSec * 1000;
          const configuredScoutModel = getAgentModelConfig("scout");
          let providerID = configuredScoutModel.providerID;
          let modelID = configuredScoutModel.modelID;
          if (args.model) {
            const slashIdx = args.model.indexOf("/");
            if (slashIdx > 0 && ["deepseek", "openrouter", "custom"].includes(args.model.slice(0, slashIdx))) {
              providerID = args.model.slice(0, slashIdx);
              modelID = args.model.slice(slashIdx + 1);
            } else {
              modelID = args.model;
            }
          }

          let intentId = args.intent_id ?? null;
          if (!intentId) {
            const r = db.prepare(`
              INSERT INTO intents (main_session_id, title, detail, priority, status)
              VALUES (?, ?, ?, 5, 'running')
            `).run(mainId, args.goal.slice(0, 80), args.goal);
            intentId = Number(r.lastInsertRowid);
          } else {
            db.prepare(`UPDATE intents SET status = 'running' WHERE id = ?`).run(intentId);
          }

          const forkRes = await client.session.fork({
            path: { id: mainId }
          });
          if (forkRes.error || !forkRes.data) {
            throw new Error(`Failed to fork session: ${JSON.stringify(forkRes.error)}`);
          }
          const forkedSessionId = forkRes.data.id;

          const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM scouts WHERE parent_session_id = ?`).get(mainId) as any;
          const scoutNum = (countRow?.cnt || 0) + 1;
          const scoutId = `scout-${scoutNum}`;
          const workspaceDir = resolve(WORKSPACES_ROOT, scoutId);
          mkdirSync(workspaceDir, { recursive: true });

          await client.session.update({
            path: { id: forkedSessionId },
            body: { title: `[${scoutId}] ${args.goal.slice(0, 50)}` }
          }).catch(() => {});

          const chatBinding = db.prepare(`SELECT last_user_msg_id FROM chat_bindings WHERE main_session_id = ?`).get(mainId) as any;
          const originUserMsgId = chatBinding?.last_user_msg_id || null;

          db.prepare(`
            INSERT OR REPLACE INTO scouts (
              scout_id, session_id, parent_session_id, intent_id, role, goal, workspace_dir, model,
              status, steps_used, max_steps, timeout_sec, deadline_at, callback_sent, feishu_thread_msg_id
            )
            VALUES (?, ?, ?, ?, 'scout', ?, ?, ?, 'running', 0, ?, ?, ?, 0, ?)
          `).run(
            scoutId,
            forkedSessionId,
            mainId,
            intentId,
            args.goal,
            workspaceDir,
            `${providerID}/${modelID}`,
            maxSteps,
            timeoutSec,
            deadlineAt,
            originUserMsgId
          );

          db.prepare(`UPDATE intents SET scout_id = ? WHERE id = ?`).run(scoutId, intentId);

          const launchPrompt =
            `🎯 [子 Agent 专项任务指派 — ${scoutId}]\n` +
            `- 关联 Intent ID: ${intentId}\n` +
            `- 专属工作目录: ${workspaceDir} (所有临时文件、脚本、下载内容必须保存在该目录下)\n` +
            `- 轮数预算上限: ${maxSteps} 步 | 超时上限: ${timeoutSec} 秒\n` +
            `- 你的具体任务目标:\n${args.goal}\n\n` +
            `请结合你继承的前序主会话上下文立即开始执行。过程中发现的关键事实请调用 record_fact，任务完成时请务必调用 submit_scout_report 提交完整最终报告！`;

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
            intent_id: intentId,
            workspace_dir: workspaceDir,
            max_steps: maxSteps,
            timeout_sec: timeoutSec,
            model: `${providerID}/${modelID}`
          });
        }
      }),

      stop_scout: tool({
        description: "强制终止指定正在运行或卡住的 Scout 子分支 (调用底层 session.abort 掐断模型流与正在执行的 bash 工具)",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          reason: tool.schema.string().optional().describe("终止原因说明（可选）")
        },
        async execute(args) {
          const scout = getScoutById(args.scout_id);
          if (!scout) {
            throw new Error(`Scout not found: ${args.scout_id}`);
          }
          await client.session.abort({
            path: { id: scout.session_id }
          }).catch(() => {});

          const summaryNote = args.reason ? `由主脑主动终止: ${args.reason}` : "由主脑主动终止 (stopped)";
          db.prepare(`
            UPDATE scouts
            SET status = 'stopped', callback_sent = 1, report_summary = COALESCE(NULLIF(report_summary, ''), ?), updated_at = CURRENT_TIMESTAMP
            WHERE scout_id = ?
          `).run(summaryNote, scout.scout_id);

          if (scout.intent_id) {
            db.prepare(`UPDATE intents SET status = 'stopped' WHERE id = ?`).run(scout.intent_id);
          }

          return JSON.stringify({
            status: "stopped",
            scout_id: scout.scout_id,
            steps_used: scout.steps_used,
            reason: summaryNote
          });
        }
      }),

      send_hint: tool({
        description: "【定向单播 Hint】仅向某一个指定的子 Agent (scout_id) 发送新线索或方向微调指令（静默注入上下文，不干扰其他子 Agent）",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          hint: tool.schema.string().describe("要定向同步给该子 Agent 的线索或指导意见")
        },
        async execute(args) {
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
              parts: [{
                type: "text",
                text: `⚡ [来自主会话的定向单播 Hint (仅对 ${scout.scout_id} 可见)]:\n${args.hint}`
              }]
            }
          });

          return JSON.stringify({ status: "delivered_unicast", scout_id: scout.scout_id, hint: args.hint });
        }
      }),

      broadcast_hint: tool({
        description: "【全局广播 Hint】向当前主会话下所有分叉出去的子 Agent 同步广播关键全局线索（通过 noReply: true 静默注入所有分支）",
        args: {
          hint: tool.schema.string().describe("需要全局广播的线索内容")
        },
        async execute(args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          db.prepare(`
            INSERT INTO hints (main_session_id, target_scout_id, content, source)
            VALUES (?, NULL, ?, 'strategist_broadcast')
          `).run(mainId, args.hint);

          const scouts = db.prepare(`SELECT * FROM scouts WHERE parent_session_id = ?`).all(mainId) as any[];
          const deliveredTo: string[] = [];

          for (const s of scouts) {
            await client.session.prompt({
              path: { id: s.session_id },
              body: {
                noReply: true,
                parts: [{
                  type: "text",
                  text: `🌐 [来自主会话的全局广播 Hint]:\n${args.hint}`
                }]
              }
            }).catch(() => {});
            deliveredTo.push(s.scout_id);
          }

          return JSON.stringify({ status: "broadcast_complete", delivered_to: deliveredTo, hint: args.hint });
        }
      }),

      extend_scout: tool({
        description: "动态为某个子 Agent (scout_id) 追加执行轮数上限与超时时间，并唤醒它基于原有上下文继续深度探索",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          add_turns: tool.schema.number().describe("要追加的轮数，例如 40 或 80"),
          timeout_sec: tool.schema.number().optional().describe("重置后的超时时间（秒），默认继承该分支原 timeout_sec（或 600 秒）"),
          instruction: tool.schema.string().optional().describe("追加轮数同时附带的进一步探索指令（可选）")
        },
        async execute(args) {
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

          if (scout.intent_id) {
            db.prepare(`UPDATE intents SET status = 'running' WHERE id = ?`).run(scout.intent_id);
          }

          const configuredScout = getAgentModelConfig("scout");
          let providerID = configuredScout.providerID;
          let modelID = configuredScout.modelID;
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
            steps_used: scout.steps_used,
            new_max_steps: newMaxSteps,
            timeout_sec: timeoutSec
          });
        }
      }),

      list_scouts: tool({
        description: "列出当前主会话分叉出的所有 Scout 子 Agent 及其状态、轮数消耗、超时设置、工作区目录与汇报摘要",
        args: {},
        async execute(_args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const scouts = db.prepare(`
            SELECT scout_id, session_id, intent_id, role, goal, workspace_dir, model, status, steps_used, max_steps, timeout_sec, deadline_at, report_summary, suggest_more_turns, created_at, updated_at
            FROM scouts WHERE parent_session_id = ? ORDER BY created_at DESC
          `).all(mainId);
          return JSON.stringify(scouts, null, 2);
        }
      }),

      get_scout_detail: tool({
        description: "获取指定 Scout 子 Agent 的完整详细报告、工作区文件列表、已记录 Facts，以及最后 N 轮的消息与工具调用入参（不含工具返回结果，便于诊断卡死或失败原因）",
        args: {
          scout_id: tool.schema.string().describe("目标子 Agent ID，例如 scout-1"),
          tail_turns: tool.schema.number().optional().describe("要提取的最后几轮助手消息与工具调用入参轮数，默认 5")
        },
        async execute(args) {
          const scout = getScoutById(args.scout_id);
          if (!scout) throw new Error(`Scout not found: ${args.scout_id}`);
          let files: string[] = [];
          try {
            files = readdirSync(scout.workspace_dir);
          } catch {}
          const facts = db.prepare(`SELECT * FROM facts WHERE scout_id = ? ORDER BY id DESC`).all(scout.scout_id);
          const findings = db.prepare(`SELECT * FROM findings WHERE scout_id = ? ORDER BY id DESC`).all(scout.scout_id);

          // Extract last N assistant turns (messages + tool call input arguments ONLY, stripping tool outputs & reasoning)
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

          return JSON.stringify({
            scout,
            workspace_files: files,
            recent_activity: recentActivity,
            facts,
            findings
          }, null, 2);
        }
      }),

      clean_workspaces: tool({
        description: "清理 Scout 子分支的专属工作区目录 (workspaces/scout-N)。可指定清理单个 scout_id、清理当前主会话下所有已结束的 Scout 工作区，或全量清理所有工作区。",
        args: {
          scout_id: tool.schema.string().optional().describe("指定要清理的单个子分支 ID（如 scout-1）；不传则默认清理当前主会话下的 Scout 工作区"),
          all: tool.schema.boolean().optional().describe("设为 true 时清理 workspaces/ 下的全部历史工作区目录"),
          include_running: tool.schema.boolean().optional().describe("是否连同仍在 running 状态的子分支工作区一并强制清理（默认 false，保护运行中分支）")
        },
        async execute(args, ctx) {
          const mainId = resolveMainSessionId(ctx.sessionID);
          const res = cleanScoutWorkspaces({
            mainSessionId: mainId,
            scoutId: args.scout_id,
            all: args.all,
            includeRunning: args.include_running
          });
          return JSON.stringify({
            status: "ok",
            ...res
          }, null, 2);
        }
      }),

      submit_scout_report: tool({
        description: "【Scout 专用最终汇报工具】当 Scout 完成指派的任务（或达到轮数上限收尾）时调用，将完整详尽的最终报告（不限字数）推送到飞书并自动回调激活主 Agent",
        args: {
          summary: tool.schema.string().describe("核心结论摘要（1-3句话，便于主会话快速索引）"),
          detail: tool.schema.string().describe("完整详尽的调查报告正文（不限长度！可包含完整代码调用链分析、B站视频/外部报告关键情报提炼、PoC 输出结果、实验数据等）"),
          suggest_more_turns: tool.schema.boolean().optional().describe("如果当前任务因轮数限制或复杂度尚未彻底完成，设为 true 请求主 Agent 调用 extend_scout 追加轮数"),
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

          if (scout.intent_id) {
            db.prepare(`UPDATE intents SET status = ? WHERE id = ?`).run(
              args.suggest_more_turns ? "exhausted" : "done",
              scout.intent_id
            );
          }

          pushOutboxEvent(scout.parent_session_id, scout.scout_id, "scout_report_submitted", {
            scout_id: scout.scout_id,
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
            scout_status: newStatus
          });
        }
      })
    }
  };
};

export default PurpleLightPlugin;

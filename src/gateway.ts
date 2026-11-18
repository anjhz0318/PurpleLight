import { createOpencodeClient } from "@opencode-ai/sdk";
import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { PROJECT_ROOT, db, getGraphOverview, getAgentModelConfig, setAgentModelConfig, cleanScoutWorkspaces } from "./db";

const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const opencode = createOpencodeClient({ baseUrl: OPENCODE_URL });
const OPENCODE_CONFIG_PATH = join(PROJECT_ROOT, "opencode.json");
const ENV_FILE_PATH = join(PROJECT_ROOT, ".env");
const WORKING_HEARTBEAT_MS = Number(process.env.PURPLELIGHT_HEARTBEAT_MS || 60_000);
const MAIN_MAX_ITERATIONS = 80;
const TOOL_PREVIEW_CAP = 72;

// ─────────────────────────────────────────────────────────────────────────────
// Config, Secret-Safe .env Management & Dynamic Upstream /models Fetching
// ─────────────────────────────────────────────────────────────────────────────

function readOpencodeConfig(): any {
  try {
    return JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveOpencodeConfigAndReload(cfg: any) {
  writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  await opencode.instance.dispose().catch(() => {});
}

function loadEnvFile(path = ENV_FILE_PATH): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      out[k] = v;
    }
  }
  return out;
}

function upsertEnvVars(updates: Record<string, string>, path = ENV_FILE_PATH) {
  const current = loadEnvFile(path);
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      current[k] = v;
      process.env[k] = v;
    }
  }
  const lines = Object.entries(current).map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

function resolveOptionValue(rawVal: string | undefined, envMap: Record<string, string>): string {
  if (!rawVal) return "";
  const m = rawVal.match(/^\{env:([A-Za-z0-9_]+)\}$/);
  if (m) return envMap[m[1]!] || "";
  return rawVal;
}

interface LiveModelItem {
  id: string;
  name?: string;
  context_window?: number;
}

function getProviderEndpointAndKey(providerID: string, cfg?: any): { baseURL: string; apiKey: string } {
  const c = cfg || readOpencodeConfig();
  const p = c.provider?.[providerID]?.options || {};
  const env = { ...process.env, ...loadEnvFile() } as Record<string, string>;
  const resolvedBase = resolveOptionValue(p.baseURL, env);
  const resolvedKey = resolveOptionValue(p.apiKey, env);

  if (providerID === "deepseek") {
    return {
      baseURL: (resolvedBase || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
      apiKey: resolvedKey || env.DEEPSEEK_API_KEY || ""
    };
  }
  if (providerID === "openrouter") {
    return {
      baseURL: (resolvedBase || env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      apiKey: resolvedKey || env.OPENROUTER_API_KEY || ""
    };
  }
  return {
    baseURL: (resolvedBase || env.CUSTOM_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: resolvedKey || env.CUSTOM_API_KEY || ""
  };
}

async function fetchLiveModelsFromEndpoint(providerID: "deepseek" | "openrouter" | "custom"): Promise<{
  ok: boolean;
  baseURL: string;
  models: LiveModelItem[];
  error?: string;
}> {
  const cfg = readOpencodeConfig();
  const { baseURL, apiKey } = getProviderEndpointAndKey(providerID, cfg);
  if (!baseURL) {
    return { ok: false, baseURL: "", models: [], error: "未配置 Base URL" };
  }
  const url = baseURL.endsWith("/models") ? baseURL : `${baseURL}/models`;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, baseURL: url, models: [], error: `HTTP ${resp.status}: ${txt.slice(0, 120)}` };
    }
    const data = (await resp.json()) as any;
    const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    const models: LiveModelItem[] = rawList
      .map((m: any) => ({
        id: String(m.id || m.name || "").trim(),
        name: m.name || m.id,
        context_window: m.context_window || m.context_length || undefined
      }))
      .filter((m: LiveModelItem) => m.id.length > 0);

    if (models.length > 0 && providerID === "custom") {
      cfg.provider = cfg.provider || {};
      cfg.provider.custom = cfg.provider.custom || {
        name: "Custom OpenAI-Compatible",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "{env:CUSTOM_BASE_URL}", apiKey: "{env:CUSTOM_API_KEY}" }
      };
      cfg.provider.custom.npm = "@ai-sdk/openai-compatible";
      cfg.provider.custom.models = cfg.provider.custom.models || {};
      let changed = false;
      for (const m of models) {
        if (!cfg.provider.custom.models[m.id]) {
          cfg.provider.custom.models[m.id] = {
            name: m.name || m.id,
            reasoning: true,
            tool_call: true
          };
          changed = true;
        }
      }
      if (changed) {
        await saveOpencodeConfigAndReload(cfg);
      }
    }

    return { ok: true, baseURL: url, models };
  } catch (e: any) {
    return { ok: false, baseURL: url, models: [], error: e?.message || String(e) };
  }
}

async function ensureProviderModelRegistered(providerID: string, modelID: string) {
  const cfg = readOpencodeConfig();
  cfg.provider = cfg.provider || {};
  cfg.provider[providerID] = cfg.provider[providerID] || { options: {} };
  if (providerID === "custom") {
    cfg.provider.custom.name = cfg.provider.custom.name || "Custom OpenAI-Compatible";
    cfg.provider.custom.npm = "@ai-sdk/openai-compatible";
    cfg.provider.custom.options = cfg.provider.custom.options || {
      baseURL: "{env:CUSTOM_BASE_URL}",
      apiKey: "{env:CUSTOM_API_KEY}"
    };
    cfg.provider.custom.models = cfg.provider.custom.models || {};
    cfg.provider.custom.models[modelID] = {
      name: modelID,
      reasoning: true,
      tool_call: true
    };
  }
  if ((providerID === "deepseek" || providerID === "openrouter") && cfg.provider[providerID]?.models) {
    delete cfg.provider[providerID].models;
  }
  const mainCfg = getAgentModelConfig("main");
  const scoutCfg = getAgentModelConfig("scout");
  cfg.model = `${mainCfg.providerID}/${mainCfg.modelID}`;
  cfg.small_model = `${scoutCfg.providerID}/${scoutCfg.modelID}`;
  if (cfg.agent?.strategist) cfg.agent.strategist.model = `${mainCfg.providerID}/${mainCfg.modelID}`;
  if (cfg.agent?.scout) cfg.agent.scout.model = `${scoutCfg.providerID}/${scoutCfg.modelID}`;
  await saveOpencodeConfigAndReload(cfg);
}

function normalizeRole(raw: string): "main" | "scout" | null {
  const lower = (raw || "").toLowerCase();
  if (["main", "strategist", "master", "主", "主agent", "主脑"].includes(lower)) return "main";
  if (["scout", "sub", "worker", "子", "子agent", "子分支"].includes(lower)) return "scout";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes-Style Native Feishu Outbound Transport (reply + post/text + update + Typing reaction)
// ─────────────────────────────────────────────────────────────────────────────

let activeLarkClient: Lark.Client | null = null;

const MARKDOWN_SYNTAX_RE = /```|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\)|^#{1,6}\s+|^\s*[-*]\s+|^\s*\d+\.\s+|^\s*>\s+/m;

function buildMarkdownPostPayload(content: string): string {
  const rows: Array<Array<{ tag: string; text: string }>> = [];
  const parts = content.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("```") && part.endsWith("```")) {
      rows.push([{ tag: "md", text: part }]);
      continue;
    }
    const trimmedSegment = part.replace(/^\n+|\n+$/g, "");
    if (trimmedSegment) {
      rows.push([{ tag: "md", text: trimmedSegment }]);
    }
  }
  if (rows.length === 0) {
    rows.push([{ tag: "md", text: content }]);
  }
  return JSON.stringify({ zh_cn: { content: rows } });
}

function buildOutboundPayload(content: string): { msgType: "text" | "post"; payload: string } {
  if (MARKDOWN_SYNTAX_RE.test(content)) {
    return { msgType: "post", payload: buildMarkdownPostPayload(content) };
  }
  return { msgType: "text", payload: JSON.stringify({ text: content }) };
}

export interface SendFeishuOptions {
  replyToMsgId?: string;
  replyInThread?: boolean;
}

async function sendFeishuMessage(
  chatId: string,
  text: string,
  opts?: SendFeishuOptions
): Promise<string | undefined> {
  if (!activeLarkClient || !chatId.startsWith("oc_")) return undefined;
  const { msgType, payload } = buildOutboundPayload(text);

  const attemptSend = async (type: "text" | "post", bodyContent: string, useReply: boolean): Promise<string | undefined> => {
    if (useReply && opts?.replyToMsgId) {
      const resp = await activeLarkClient!.im.v1.message.reply({
        path: { message_id: opts.replyToMsgId },
        data: {
          msg_type: type,
          content: bodyContent,
          reply_in_thread: !!opts.replyInThread
        }
      });
      if (resp?.code === 0 && resp.data?.message_id) {
        return resp.data.message_id;
      }
      throw new Error(`reply failed code=${resp?.code} msg=${resp?.msg}`);
    } else {
      const resp = await activeLarkClient!.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: type,
          content: bodyContent
        }
      });
      if (resp?.code === 0 && resp.data?.message_id) {
        return resp.data.message_id;
      }
      throw new Error(`create failed code=${resp?.code} msg=${resp?.msg}`);
    }
  };

  if (opts?.replyToMsgId) {
    try {
      return await attemptSend(msgType, payload, true);
    } catch {
      if (msgType === "post") {
        try {
          return await attemptSend("text", JSON.stringify({ text }), true);
        } catch {}
      }
    }
  }

  try {
    return await attemptSend(msgType, payload, false);
  } catch (err) {
    if (msgType === "post") {
      try {
        return await attemptSend("text", JSON.stringify({ text }), false);
      } catch (e2) {
        console.error("[Feishu Send Fallback Error]:", e2);
      }
    } else {
      console.error("[Feishu Send Error]:", err);
    }
    return undefined;
  }
}

async function editFeishuMessage(messageId: string, text: string): Promise<boolean> {
  if (!activeLarkClient || !messageId) return false;
  const { msgType, payload } = buildOutboundPayload(text);
  try {
    const resp = await activeLarkClient.im.v1.message.update({
      path: { message_id: messageId },
      data: { msg_type: msgType, content: payload }
    });
    if (resp?.code === 0) return true;
    if (msgType === "post") {
      const fallback = await activeLarkClient.im.v1.message.update({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) }
      });
      return fallback?.code === 0;
    }
    return false;
  } catch {
    return false;
  }
}

async function addTypingReaction(messageId: string): Promise<string | undefined> {
  if (!activeLarkClient || !messageId) return undefined;
  try {
    const resp = await activeLarkClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "Typing" } }
    });
    return resp?.data?.reaction_id;
  } catch {
    return undefined;
  }
}

async function removeReaction(messageId: string, reactionId?: string): Promise<void> {
  if (!activeLarkClient || !messageId || !reactionId) return;
  try {
    await activeLarkClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId }
    });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-Time Session Activity & Main-Agent Tool Progress Engine (OpenCode SSE)
// Note: Scout subagents run silently in the background; ONLY Main Agent tool
// calls are streamed to chat, and Scouts ONLY display their final report!
// ─────────────────────────────────────────────────────────────────────────────

interface SessionLiveState {
  sessionId: string;
  startedAt: number;
  iteration: number;
  maxIterations: number;
  activity: string;
  currentTool: string | null;
  busy: boolean;
  seenToolPartIds: Set<string>;
  lastProgressLine: string;
  lastProgressMsgId?: string;
  repeatCount: number;
}

const sessionStates = new Map<string, SessionLiveState>();
const activeMainTurnReplyMsgId = new Map<string, string>();

function getOrInitSessionState(sessionId: string, maxIterations = MAIN_MAX_ITERATIONS): SessionLiveState {
  let st = sessionStates.get(sessionId);
  if (!st) {
    st = {
      sessionId,
      startedAt: Date.now(),
      iteration: 0,
      maxIterations,
      activity: "waiting for provider response (streaming)",
      currentTool: null,
      busy: false,
      seenToolPartIds: new Set(),
      lastProgressLine: "",
      repeatCount: 0
    };
    sessionStates.set(sessionId, st);
  }
  return st;
}

function resetSessionTurnState(sessionId: string, maxIterations = MAIN_MAX_ITERATIONS): SessionLiveState {
  const existing = sessionStates.get(sessionId);
  const st: SessionLiveState = {
    sessionId,
    startedAt: Date.now(),
    iteration: 0,
    maxIterations,
    activity: "waiting for provider response (streaming)",
    currentTool: null,
    busy: true,
    seenToolPartIds: existing?.seenToolPartIds || new Set(),
    lastProgressLine: "",
    lastProgressMsgId: undefined,
    repeatCount: 0
  };
  sessionStates.set(sessionId, st);
  return st;
}

function oneLineTrunc(val: any, cap = TOOL_PREVIEW_CAP): string {
  const s = String(val ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > cap ? s.slice(0, cap - 3) + "..." : s;
}

const TOOL_EMOJIS: Record<string, string> = {
  bash: "💻",
  read: "📖",
  write: "✍️",
  edit: "✏️",
  apply_patch: "🩹",
  grep: "🔍",
  glob: "🗂️",
  webfetch: "🌐",
  websearch: "🔎",
  skill: "🧩",
  graph_overview: "📊",
  add_intent: "🎯",
  fork_scout: "🚀",
  send_hint: "⚡",
  broadcast_hint: "📡",
  extend_scout: "🔋",
  list_scouts: "📋",
  get_scout_detail: "📑",
  clean_workspaces: "🧹",
  record_fact: "📌",
  report_finding: "🔥",
  submit_scout_report: "✅"
};

export function formatToolProgressBubble(toolName: string, args: Record<string, any> = {}): string | null {
  const emoji = TOOL_EMOJIS[toolName] || "⚙️";

  if (toolName === "bash") {
    const rawCmd = String(args.command || "").trim();
    if (!rawCmd) return `${emoji} bash`;
    const lines = rawCmd.split("\n");
    let shortCmd = lines[0] || rawCmd;
    if (shortCmd.length > TOOL_PREVIEW_CAP) {
      shortCmd = shortCmd.slice(0, TOOL_PREVIEW_CAP - 3) + "...";
    } else if (lines.length > 1) {
      shortCmd += " ...";
    }
    return `${emoji} bash\n\`\`\`\n${shortCmd}\n\`\`\``;
  }

  let preview = "";
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const p = String(args.filePath || args.path || "");
    preview = p ? basename(p) || p : "";
  } else if (toolName === "grep") {
    preview = oneLineTrunc(args.pattern || args.query || "");
  } else if (toolName === "glob") {
    preview = oneLineTrunc(args.pattern || "");
  } else if (toolName === "webfetch" || toolName === "websearch") {
    preview = oneLineTrunc(args.url || args.query || "");
  } else if (toolName === "skill") {
    preview = oneLineTrunc(args.name || "");
  } else if (toolName === "add_intent") {
    preview = oneLineTrunc(args.title || args.detail || "");
  } else if (toolName === "fork_scout") {
    preview = oneLineTrunc(args.goal || "");
  } else if (toolName === "send_hint") {
    preview = `${args.scout_id || ""}: ${oneLineTrunc(args.hint || "", 50)}`.trim();
  } else if (toolName === "broadcast_hint") {
    preview = oneLineTrunc(args.hint || "");
  } else if (toolName === "extend_scout") {
    preview = `${args.scout_id || ""} (+${args.add_turns || 40})`;
  } else if (toolName === "get_scout_detail") {
    preview = oneLineTrunc(args.scout_id || "");
  } else if (toolName === "clean_workspaces") {
    preview = args.scout_id ? String(args.scout_id) : args.all ? "all" : "session";
  } else {
    const firstVal = Object.values(args).find((v) => typeof v === "string" && v.trim());
    if (firstVal) preview = oneLineTrunc(firstVal);
  }

  return preview ? `${emoji} ${toolName}  \`${preview.replace(/`/g, "'")}\`` : `${emoji} ${toolName}`;
}

async function emitMainToolProgressToFeishu(sessionId: string, st: SessionLiveState, toolName: string, args: Record<string, any>) {
  // Never emit Scout tool calls into main Feishu chat; Scouts run silently until final report!
  const scout = db.prepare(`SELECT 1 FROM scouts WHERE session_id = ?`).get(sessionId);
  if (scout) return;

  const chatRow = db.prepare(`SELECT chat_id, last_user_msg_id FROM chat_bindings WHERE main_session_id = ?`).get(sessionId) as any;
  if (!chatRow?.chat_id || !chatRow.chat_id.startsWith("oc_")) return;

  const replyToMsgId = activeMainTurnReplyMsgId.get(sessionId) || chatRow.last_user_msg_id || undefined;
  const bubble = formatToolProgressBubble(toolName, args);
  if (!bubble) return;

  if (bubble === st.lastProgressLine && st.lastProgressMsgId) {
    st.repeatCount += 1;
    const deduped = `${bubble} (×${st.repeatCount + 1})`;
    await editFeishuMessage(st.lastProgressMsgId, deduped);
    return;
  }

  st.lastProgressLine = bubble;
  st.repeatCount = 0;
  const sentId = await sendFeishuMessage(chatRow.chat_id, bubble, { replyToMsgId });
  if (sentId) {
    st.lastProgressMsgId = sentId;
  }
}

function startOpencodeEventStream() {
  (async () => {
    while (true) {
      try {
        const sub = await opencode.event.subscribe();
        for await (const ev of sub.stream) {
          const props: any = (ev as any).properties || {};
          const sid: string | undefined = props.sessionID || props.part?.sessionID || props.info?.sessionID;
          if (!sid) continue;

          const scoutRow = db.prepare(`SELECT max_steps FROM scouts WHERE session_id = ?`).get(sid) as any;
          const maxIter = scoutRow?.max_steps || MAIN_MAX_ITERATIONS;
          const st = getOrInitSessionState(sid, maxIter);
          st.maxIterations = maxIter;

          if (ev.type === "session.status") {
            const statusType = props.status?.type;
            if (statusType === "busy") {
              if (!st.busy) {
                st.busy = true;
                st.startedAt = Date.now();
              }
              if (!st.currentTool) {
                st.activity = "waiting for provider response (streaming)";
              }
            } else if (statusType === "retry") {
              st.busy = true;
              st.activity = "retrying provider request";
            } else if (statusType === "idle") {
              st.busy = false;
              st.currentTool = null;
            }
          } else if (ev.type === "session.idle") {
            st.busy = false;
            st.currentTool = null;
          } else if (ev.type === "message.part.updated") {
            const part = props.part;
            if (!part) continue;
            if (part.type === "step-start") {
              st.iteration += 1;
              st.currentTool = null;
              st.activity = "waiting for provider response (streaming)";
            } else if (part.type === "reasoning" || part.type === "text") {
              st.activity = "waiting for provider response (streaming)";
            } else if (part.type === "tool") {
              const status = part.state?.status;
              if (status === "running") {
                st.currentTool = part.tool || "tool";
                st.activity = `running ${st.currentTool}`;
                if (part.id && !st.seenToolPartIds.has(part.id)) {
                  st.seenToolPartIds.add(part.id);
                  const inputArgs = (part.state?.input && typeof part.state.input === "object") ? part.state.input : {};
                  emitMainToolProgressToFeishu(sid, st, st.currentTool!, inputArgs).catch((err) =>
                    console.error("[Tool Progress Emit Error]:", err)
                  );
                }
              } else if (status === "completed" || status === "error") {
                st.currentTool = null;
                st.activity = "waiting for provider response (streaming)";
              }
            }
          }
        }
      } catch {
        // Reconnect smoothly after OpenCode config reload / restart
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}

export function buildWorkingHeartbeatText(opts: {
  elapsedMs: number;
  iteration: number;
  maxIterations: number;
  activity: string;
}): string {
  const mins = Math.max(1, Math.floor(opts.elapsedMs / 60_000));
  const iter = Math.max(1, opts.iteration);
  return `⏳ Working — ${mins} min — iteration ${iter}/${opts.maxIterations}, ${opts.activity}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation & Slash Command Router
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateMainSession(chatId: string, userMsgId?: string): Promise<string> {
  const row = db.prepare(`SELECT main_session_id FROM chat_bindings WHERE chat_id = ?`).get(chatId) as any;
  if (row?.main_session_id) {
    if (userMsgId) {
      db.prepare(`UPDATE chat_bindings SET last_user_msg_id = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`)
        .run(userMsgId, chatId);
    }
    return row.main_session_id;
  }
  const created = await opencode.session.create({
    body: { title: `Feishu Main Strategist (${chatId})` }
  });
  if (!created.data?.id) {
    throw new Error(`Failed to create OpenCode session: ${JSON.stringify(created.error)}`);
  }
  db.prepare(`
    INSERT OR REPLACE INTO chat_bindings (chat_id, main_session_id, last_user_msg_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(chatId, created.data.id, userMsgId || null);
  return created.data.id;
}

function extractReplyText(parts: any[] = []): string {
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && p.text?.trim()) {
      texts.push(p.text.trim());
    }
  }
  return texts.join("\n\n").trim() || "（已完成编排操作，等待子分支最终汇报）";
}

export async function handleIncomingText(
  chatId: string,
  text: string,
  parentMsgId?: string,
  sendReply?: (msg: string) => Promise<string | undefined>,
  userMsgId?: string
): Promise<string> {
  const trimmed = text.trim();
  const mainSessionId = await getOrCreateMainSession(chatId, userMsgId);

  // 1. Check if user replied to a Scout's Final Report bubble to inject a targeted Hint
  if (parentMsgId && !trimmed.startsWith("/")) {
    const threadRow = db.prepare(`SELECT scout_id FROM thread_bindings WHERE thread_msg_id = ?`).get(parentMsgId) as any;
    if (threadRow?.scout_id) {
      const scout = db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(threadRow.scout_id) as any;
      if (scout) {
        db.prepare(`INSERT INTO hints (main_session_id, target_scout_id, content, source) VALUES (?, ?, ?, 'feishu_thread')`)
          .run(mainSessionId, scout.scout_id, trimmed);
        await opencode.session.prompt({
          path: { id: scout.session_id },
          body: {
            noReply: true,
            parts: [{ type: "text", text: `⚡ [人类操作员通过飞书引用回复向 ${scout.scout_id} 定向注入 Hint]:\n${trimmed}` }]
          }
        });
        const msg = `⚡ 已定向注入 Hint 到 **${scout.scout_id}** (不干扰其他分支):\n> ${trimmed}`;
        if (sendReply) await sendReply(msg);
        return msg;
      }
    }
  }

  // 2. Slash Commands
  if (trimmed === "/new") {
    const cleanRes = cleanScoutWorkspaces({
      mainSessionId,
      all: true,
      includeRunning: true
    });
    const created = await opencode.session.create({
      body: { title: `Feishu Main Strategist (${chatId}) - ${new Date().toISOString()}` }
    });
    const newId = created.data!.id;
    db.prepare(`INSERT OR REPLACE INTO chat_bindings (chat_id, main_session_id, last_user_msg_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(chatId, newId, userMsgId || null);
    const cleanedNote = cleanRes.cleaned_scouts.length > 0
      ? `\n🧹 已自动清空 ${cleanRes.cleaned_scouts.length} 个历史 Scout 工作区 (${cleanRes.cleaned_scouts.join(", ")})。`
      : `\n🧹 工作区目录已处于干净状态。`;
    const msg = `🆕 已开启新会话 (\`${newId}\`) 与空白探索图黑板。${cleanedNote}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed === "/clean" || trimmed.startsWith("/clean ")) {
    const arg = trimmed.slice(6).trim();
    const isAll = !arg || arg.toLowerCase() === "all";
    const res = cleanScoutWorkspaces({
      mainSessionId,
      scoutId: !isAll ? arg : undefined,
      all: isAll,
      includeRunning: false
    });
    const cleanedLine = res.cleaned_scouts.length > 0
      ? `✅ 已清空 ${res.cleaned_scouts.length} 个工作区: \`${res.cleaned_scouts.join("`, `")}\``
      : `🧹 没有需要清理的工作区目录（已处于干净状态）`;
    const skippedLine = res.skipped_running.length > 0
      ? `\n⏳ 已跳过仍在运行中的子分支: \`${res.skipped_running.join("`, `")}\``
      : "";
    const msg = `${cleanedLine}${skippedLine}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed === "/status" || trimmed === "/graph" || trimmed === "/scouts") {
    const ov = getGraphOverview(mainSessionId);
    const mainCfg = getAgentModelConfig("main");
    const scoutCfg = getAgentModelConfig("scout");
    const scoutLines = ov.scouts.length === 0
      ? "  （暂无分叉出的 Scout）"
      : ov.scouts.map((s: any) => {
          const st = sessionStates.get(s.session_id);
          const liveAct = s.status === "running" && st?.busy ? ` | ${st.activity}` : "";
          return `  - **${s.scout_id}** [${s.status}${liveAct}] 轮数: \`${s.steps_used}/${s.max_steps}\` | 模型: \`${s.model}\`\n    目标: ${s.goal.slice(0, 80)}\n    工作区: \`${s.workspace_dir}\`${s.report_summary ? `\n    摘要: ${s.report_summary}` : ""}`;
        }).join("\n");
    const factLines = ov.facts.slice(0, 8).map((f: any) => `  - [#${f.id} by ${f.scout_id}] ${f.summary}`).join("\n") || "  （暂无）";
    const findingLines = ov.findings.map((f: any) => `  - 🔥 [#${f.id} ${f.severity.toUpperCase()}] **${f.title}** (${f.vuln_class}): ${f.summary}`).join("\n") || "  （暂无）";
    const msg =
      `📊 **紫电 (PurpleLight) · 实时状态总览**\n` +
      `- 主会话 ID: \`${mainSessionId}\`\n` +
      `- 🧠 **main**: \`${mainCfg.providerID}/${mainCfg.modelID}\`\n` +
      `- 🤖 **scout**: \`${scoutCfg.providerID}/${scoutCfg.modelID}\`\n` +
      `- Intents: ${ov.intents.length} | Facts: ${ov.facts.length} | Findings: ${ov.findings.length} | Hints: ${ov.hints.length}\n\n` +
      `🤖 **Scouts**:\n${scoutLines}\n\n` +
      `📌 **最新 Facts**:\n${factLines}\n\n` +
      `🏆 **确认 Findings**:\n${findingLines}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
    const args = trimmed.slice(9).trim().split(/\s+/).filter(Boolean);
    const cfg = readOpencodeConfig();
    const mainCfg = getAgentModelConfig("main");
    const scoutCfg = getAgentModelConfig("scout");

    if (args.length === 0) {
      const msg =
        `**可用 Providers**: \`deepseek\` / \`openrouter\` / \`custom\`\n` +
        `- 🧠 **main**: \`${mainCfg.providerID}\`\n` +
        `- 🤖 **scout**: \`${scoutCfg.providerID}\`\n\n` +
        `切换: \`/provider <main|scout> <deepseek|openrouter|custom>\`\n` +
        `配置: \`/provider set <deepseek|openrouter> <api_key>\` 或 \`/provider set custom <base_url> <api_key>\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    if (args[0].toLowerCase() === "set") {
      const targetProv = (args[1] || "").toLowerCase();
      cfg.provider = cfg.provider || {};

      if (targetProv === "custom") {
        const baseURL = args[2];
        const apiKey = args[3];
        if (!baseURL || !apiKey) {
          const msg = `用法: \`/provider set custom <base_url> <api_key>\``;
          if (sendReply) await sendReply(msg);
          return msg;
        }
        upsertEnvVars({ CUSTOM_BASE_URL: baseURL, CUSTOM_API_KEY: apiKey });
        cfg.provider.custom = {
          name: "Custom OpenAI-Compatible",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "{env:CUSTOM_BASE_URL}", apiKey: "{env:CUSTOM_API_KEY}" },
          models: cfg.provider.custom?.models || {}
        };
        await saveOpencodeConfigAndReload(cfg);
        await fetchLiveModelsFromEndpoint("custom");
        const msg = `✅ 已配置 \`custom\` 端点 (\`${baseURL}\`)`;
        if (sendReply) await sendReply(msg);
        return msg;
      }

      if (targetProv === "deepseek" || targetProv === "openrouter") {
        const apiKey = args[2];
        const baseURL = args[3];
        if (!apiKey) {
          const msg = `用法: \`/provider set ${targetProv} <api_key> [base_url]\``;
          if (sendReply) await sendReply(msg);
          return msg;
        }
        const envKeyName = targetProv === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY";
        const envBaseName = targetProv === "deepseek" ? "DEEPSEEK_BASE_URL" : "OPENROUTER_BASE_URL";
        const updates: Record<string, string> = { [envKeyName]: apiKey };
        if (baseURL) updates[envBaseName] = baseURL;
        upsertEnvVars(updates);

        cfg.provider[targetProv] = cfg.provider[targetProv] || { options: {} };
        cfg.provider[targetProv].options = {
          apiKey: `{env:${envKeyName}}`,
          ...(baseURL ? { baseURL: `{env:${envBaseName}}` } : {})
        };
        await saveOpencodeConfigAndReload(cfg);
        const msg = `✅ 已更新 \`${targetProv}\` 配置`;
        if (sendReply) await sendReply(msg);
        return msg;
      }

      const msg = `❌ 仅支持: \`deepseek\` / \`openrouter\` / \`custom\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    const role = normalizeRole(args[0]);
    const providerID = (args[1] || "").toLowerCase();
    if (!role || !["deepseek", "openrouter", "custom"].includes(providerID)) {
      const msg = `用法: \`/provider <main|scout> <deepseek|openrouter|custom>\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    const live = await fetchLiveModelsFromEndpoint(providerID as "deepseek" | "openrouter" | "custom");
    let newModelID = args[2] || "";
    if (!newModelID) {
      newModelID = live.models[0]?.id || (role === "main" ? mainCfg.modelID : scoutCfg.modelID);
    }

    setAgentModelConfig(role, providerID, newModelID);
    await ensureProviderModelRegistered(providerID, newModelID);

    const msg = `✅ **${role}** Provider 已切换为 \`${providerID}\` (当前模型: \`${newModelID}\`)`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const args = trimmed.slice(6).trim().split(/\s+/).filter(Boolean);
    const mainCfg = getAgentModelConfig("main");
    const scoutCfg = getAgentModelConfig("scout");

    const roleArg = args[0] ? normalizeRole(args[0]) : null;
    if (args.length === 0 || (!roleArg && args.length === 1)) {
      const keyword = (args[0] || "").toLowerCase();
      const activeProvs = Array.from(new Set([mainCfg.providerID, scoutCfg.providerID])) as Array<"deepseek" | "openrouter" | "custom">;
      const sections: string[] = [];

      for (const prov of activeProvs) {
        const live = await fetchLiveModelsFromEndpoint(prov);
        if (!live.ok) {
          sections.push(`**\`${prov}\`**: ⚠️ 获取失败 (${live.error})`);
          continue;
        }
        const filtered = keyword
          ? live.models.filter((m) => m.id.toLowerCase().includes(keyword))
          : live.models;
        const listStr = filtered.slice(0, 40).map((m) =>
          m.name && m.name !== m.id ? `\`${m.id}\` (${m.name})` : `\`${m.id}\``
        ).join(", ") || "（无匹配模型）";
        sections.push(
          `**当前生效 Provider \`${prov}\` 模型列表 (${filtered.length}${keyword ? `/${live.models.length}` : ""} 个)**:\n${listStr}${filtered.length > 40 ? `\n*(仅显示前 40 个，可用 \`/model <关键词>\` 过滤)*` : ""}`
        );
      }

      const msg =
        `- 🧠 **main**: \`${mainCfg.providerID}/${mainCfg.modelID}\`\n` +
        `- 🤖 **scout**: \`${scoutCfg.providerID}/${scoutCfg.modelID}\`\n\n` +
        sections.join("\n\n") +
        `\n\n切换: \`/model <main|scout> <模型名>\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    if (roleArg && args.length === 1) {
      const targetCfg = roleArg === "main" ? mainCfg : scoutCfg;
      const live = await fetchLiveModelsFromEndpoint(targetCfg.providerID as "deepseek" | "openrouter" | "custom");
      if (!live.ok) {
        const msg = `❌ 获取 \`${targetCfg.providerID}\` 模型列表失败: ${live.error}`;
        if (sendReply) await sendReply(msg);
        return msg;
      }
      const listStr = live.models.slice(0, 50).map((m) =>
        m.name && m.name !== m.id ? `\`${m.id}\` (${m.name})` : `\`${m.id}\``
      ).join(", ");
      const msg =
        `**${roleArg}** 当前: \`${targetCfg.providerID}/${targetCfg.modelID}\`\n` +
        `**\`${targetCfg.providerID}\` 可用模型 (${live.models.length} 个)**:\n${listStr}`;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    const rawTarget = args[1];
    if (!roleArg || !rawTarget) {
      const msg = `用法: \`/model <main|scout> <模型名>\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }

    const currentCfg = getAgentModelConfig(roleArg);
    const providerID = currentCfg.providerID;
    const modelID = rawTarget;

    await fetchLiveModelsFromEndpoint(providerID as "deepseek" | "openrouter" | "custom");
    setAgentModelConfig(roleArg, providerID, modelID);
    await ensureProviderModelRegistered(providerID, modelID);

    const msg = `✅ **${roleArg}** 模型已切换为 \`${modelID}\` (Provider: \`${providerID}\`)`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed.startsWith("/report ")) {
    const scoutId = trimmed.replace("/report ", "").trim();
    const scout = db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(scoutId) as any;
    if (!scout) {
      const msg = `❌ 未找到子分支: \`${scoutId}\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }
    let files: string[] = [];
    try { files = readdirSync(scout.workspace_dir); } catch {}
    const msg =
      `📑 **${scout.scout_id} 完整详细报告**\n` +
      `- 状态: \`${scout.status}\` | 轮数: \`${scout.steps_used}/${scout.max_steps}\`\n` +
      `- 专属工作区: \`${scout.workspace_dir}\` (文件: ${files.join(", ") || "空"})\n` +
      `- 核心摘要: ${scout.report_summary || "（尚未结案）"}\n\n` +
      `---\n${scout.report_detail || "（子 Agent 仍在静默探索中，完成后将自动推送最终汇报）"}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed.startsWith("/hint ")) {
    const parts = trimmed.slice(6).trim().split(/\s+/);
    const scoutId = parts[0];
    const hintText = parts.slice(1).join(" ");
    const scout = db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(scoutId) as any;
    if (!scout || !hintText) {
      const msg = `用法: \`/hint scout-1 你的定向线索内容\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }
    db.prepare(`INSERT INTO hints (main_session_id, target_scout_id, content, source) VALUES (?, ?, ?, 'human_unicast')`)
      .run(mainSessionId, scout.scout_id, hintText);
    await opencode.session.prompt({
      path: { id: scout.session_id },
      body: {
        noReply: true,
        parts: [{ type: "text", text: `⚡ [人类操作员定向单播 Hint -> ${scout.scout_id}]:\n${hintText}` }]
      }
    });
    const msg = `⚡ 已向 **${scout.scout_id}** 发送定向单播 Hint:\n> ${hintText}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed.startsWith("/broadcast ")) {
    const hintText = trimmed.slice(11).trim();
    db.prepare(`INSERT INTO hints (main_session_id, target_scout_id, content, source) VALUES (?, NULL, ?, 'human_broadcast')`)
      .run(mainSessionId, hintText);
    const scouts = db.prepare(`SELECT * FROM scouts WHERE parent_session_id = ?`).all(mainSessionId) as any[];
    for (const s of scouts) {
      await opencode.session.prompt({
        path: { id: s.session_id },
        body: {
          noReply: true,
          parts: [{ type: "text", text: `🌐 [人类操作员全局广播 Hint]:\n${hintText}` }]
        }
      }).catch(() => {});
    }
    const msg = `🌐 已向全部 ${scouts.length} 个子分支全局广播 Hint:\n> ${hintText}`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed.startsWith("/extend ")) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const scoutId = parts[0];
    const addTurns = parseInt(parts[1] || "40", 10);
    const extraInstr = parts.slice(2).join(" ");
    const scout = db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(scoutId) as any;
    if (!scout || isNaN(addTurns)) {
      const msg = `用法: \`/extend scout-1 40 [可选补充指令]\``;
      if (sendReply) await sendReply(msg);
      return msg;
    }
    const newMax = (scout.max_steps || 80) + addTurns;
    if (scout.workspace_dir) {
      mkdirSync(scout.workspace_dir, { recursive: true });
    }
    db.prepare(`UPDATE scouts SET max_steps = ?, status = 'running', suggest_more_turns = 0, updated_at = CURRENT_TIMESTAMP WHERE scout_id = ?`)
      .run(newMax, scout.scout_id);
    if (userMsgId) {
      db.prepare(`UPDATE scouts SET feishu_thread_msg_id = ? WHERE scout_id = ?`).run(userMsgId, scout.scout_id);
    }
    const [providerID, modelID] = (scout.model || "deepseek/deepseek-flash").split("/");
    await opencode.session.promptAsync({
      path: { id: scout.session_id },
      body: {
        agent: "scout",
        variant: "max",
        model: { providerID, modelID },
        parts: [{
          type: "text",
          text: `🔋 [已为你追加 +${addTurns} 轮预算，新上限: ${newMax} 步]\n${extraInstr || "请基于已有上下文继续深入探索，完成后调用 submit_scout_report 汇报。"}`
        }]
      } as any
    });
    const msg = `🔋 已为 **${scout.scout_id}** 追加 **+${addTurns}** 轮上限（当前 \`${scout.steps_used}/${newMax}\`），子分支已在后台继续静默探索。`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed.startsWith("/approve ") || trimmed.startsWith("/deny ")) {
    const isApprove = trimmed.startsWith("/approve ");
    const approvalId = parseInt(trimmed.split(/\s+/)[1] || "0", 10);
    const row = db.prepare(`SELECT * FROM hook_approvals WHERE id = ?`).get(approvalId) as any;
    if (!row) {
      const msg = `❌ 未找到待审批记录 #${approvalId}`;
      if (sendReply) await sendReply(msg);
      return msg;
    }
    const newStatus = isApprove ? "approved" : "denied";
    db.prepare(`UPDATE hook_approvals SET status = ?, decided_by = 'human', decided_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newStatus, approvalId);
    const msg = isApprove
      ? `✅ 已批准 Approval #${approvalId} (${row.scout_id} 修改 \`${row.target_path}\`)`
      : `🚫 已拒绝 Approval #${approvalId} (${row.scout_id} 修改 \`${row.target_path}\`)`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  if (trimmed === "/help") {
    const msg =
      `⚡ **紫电 (PurpleLight) · 飞书快捷指令**\n\n` +
      `- \`/status\` / \`/scouts\` : 查看模型状态、探索图黑板与所有 Scout 分支进度\n` +
      `- \`/provider\` : 查看或切换 \`main\` / \`scout\` 的 Provider (\`deepseek\` / \`openrouter\` / \`custom\`)\n` +
      `- \`/model\` : 实时抓取并查看/切换当前生效 Provider 的模型列表\n` +
      `- \`/report <scout-id>\` : 查看指定子分支的完整结案报告\n` +
      `- \`/hint <scout-id> <内容>\` : 向单个子分支发送定向单播 Hint（也可直接引用回复该分支的最终汇报）\n` +
      `- \`/broadcast <内容>\` : 向所有子分支发送全局广播 Hint\n` +
      `- \`/extend <scout-id> <轮数> [指令]\` : 为指定子分支动态追加轮数上限并唤醒\n` +
      `- \`/clean [scout-id|all]\` : 清空指定或全部已完成 Scout 的工作区目录\n` +
      `- \`/approve <id>\` / \`/deny <id>\` : 审批子分支修改工作区外文件的请求\n` +
      `- \`/new\` : 开启全新的主脑会话并自动清空历史工作区`;
    if (sendReply) await sendReply(msg);
    return msg;
  }

  // 3. Normal Conversation -> Route to Main Agent (Strategist) with live SSE progress & "⏳ Working" heartbeat
  const mainModelCfg = getAgentModelConfig("main");
  const turnState = resetSessionTurnState(mainSessionId, MAIN_MAX_ITERATIONS);
  if (userMsgId) {
    activeMainTurnReplyMsgId.set(mainSessionId, userMsgId);
  }

  let turnDone = false;
  let heartbeatMsgId: string | undefined;
  const heartbeatTimer = setInterval(async () => {
    if (turnDone || !chatId.startsWith("oc_")) return;
    const elapsedMs = Date.now() - turnState.startedAt;
    if (elapsedMs < WORKING_HEARTBEAT_MS) return;
    const hbText = buildWorkingHeartbeatText({
      elapsedMs,
      iteration: turnState.iteration || 1,
      maxIterations: MAIN_MAX_ITERATIONS,
      activity: turnState.activity || "waiting for provider response (streaming)"
    });
    if (heartbeatMsgId) {
      const ok = await editFeishuMessage(heartbeatMsgId, hbText);
      if (ok) return;
    }
    heartbeatMsgId = await sendFeishuMessage(chatId, hbText, { replyToMsgId: userMsgId });
  }, WORKING_HEARTBEAT_MS);

  try {
    const res = await opencode.session.prompt({
      path: { id: mainSessionId },
      body: {
        agent: "strategist",
        variant: "max",
        model: { providerID: mainModelCfg.providerID, modelID: mainModelCfg.modelID },
        parts: [{ type: "text", text: trimmed }]
      } as any
    });

    if (res.error) {
      const errMsg = `⚠️ 主脑调用异常: ${JSON.stringify(res.error)}`;
      if (sendReply) await sendReply(errMsg);
      return errMsg;
    }

    const replyText = extractReplyText(res.data?.parts as any[]);
    if (sendReply) await sendReply(replyText);
    return replyText;
  } finally {
    turnDone = true;
    clearInterval(heartbeatTimer);
    activeMainTurnReplyMsgId.delete(mainSessionId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background Outbox Poller -> ONLY Delivers Scout Final Report (& Workspace Guardrail Approvals)
// Intermediate Scout process & tool calls are suppressed to keep main chat clean!
// ─────────────────────────────────────────────────────────────────────────────

function startOutboxPoller() {
  setInterval(async () => {
    if (!activeLarkClient) return;
    const events = db.prepare(`SELECT * FROM events_outbox WHERE delivered = 0 ORDER BY id ASC LIMIT 20`).all() as any[];
    for (const ev of events) {
      if (!ev.main_session_id) {
        db.prepare(`UPDATE events_outbox SET delivered = 1 WHERE id = ?`).run(ev.id);
        continue;
      }
      const chatRow = db.prepare(`SELECT chat_id, last_user_msg_id FROM chat_bindings WHERE main_session_id = ?`).get(ev.main_session_id) as any;
      if (!chatRow?.chat_id || !chatRow.chat_id.startsWith("oc_")) {
        db.prepare(`UPDATE events_outbox SET delivered = 1 WHERE id = ?`).run(ev.id);
        continue;
      }
      db.prepare(`UPDATE events_outbox SET delivered = 1 WHERE id = ?`).run(ev.id);

      const chatId = chatRow.chat_id;
      const p = JSON.parse(ev.payload_json || "{}");
      const scoutRow = p.scout_id ? (db.prepare(`SELECT feishu_thread_msg_id FROM scouts WHERE scout_id = ?`).get(p.scout_id) as any) : null;
      const replyAnchor = scoutRow?.feishu_thread_msg_id || chatRow.last_user_msg_id || undefined;
      let msg = "";

      if (ev.event_type === "scout_report_submitted") {
        const preview = p.detail.length > 2500
          ? p.detail.slice(0, 2500) + `\n\n...(全文共 ${p.detail.length} 字，已完整注入主会话，可发 \`/report ${p.scout_id}\` 查看全文)`
          : p.detail;
        msg =
          `✅ **[${p.scout_id} 最终汇报]** (轮数: \`${p.steps_used}/${p.max_steps}\` | 状态: \`${p.status}\`)\n` +
          `- **核心摘要**: ${p.summary}\n` +
          (p.suggest_more_turns ? `- ⚠️ **申请追加轮数**: 是 (${p.suggested_next_steps || "可发 /extend " + p.scout_id + " 40 继续探索"})\n` : "") +
          `\n---\n${preview}`;
      } else if (ev.event_type === "hook_approval_needed") {
        msg =
          `🛡️ **[Hook 越界文件修改拦截 — Approval #${p.approval_id}]**\n` +
          `- 子分支: \`${p.scout_id}\` | 工具: \`${p.tool_name}\`\n` +
          `- 目标路径: \`${p.target_path}\` (位于专属工作区 \`${p.workspace_dir}\` 外)\n\n` +
          `请在 120 秒内回复 \`/approve ${p.approval_id}\` 或 \`/deny ${p.approval_id}\``;
      }

      if (msg) {
        const sentMsgId = await sendFeishuMessage(chatId, msg, { replyToMsgId: replyAnchor });
        if (sentMsgId && p.scout_id) {
          db.prepare(`INSERT OR REPLACE INTO thread_bindings (thread_msg_id, scout_id, chat_id) VALUES (?, ?, ?)`)
            .run(sentMsgId, p.scout_id, chatId);
        }
      }
    }
  }, 800);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Feishu WebSocket Long-Connection (WSClient)
// ─────────────────────────────────────────────────────────────────────────────

let currentAppId = "";

function claimMessageId(msgId: string, chatId: string): boolean {
  const existing = db.prepare(`SELECT 1 FROM processed_messages WHERE message_id = ?`).get(msgId);
  if (existing) return false;
  db.prepare(`INSERT OR IGNORE INTO processed_messages (message_id, chat_id) VALUES (?, ?)`).run(msgId, chatId);
  return true;
}

async function processFeishuMsgItem(
  msgId: string,
  chatId: string,
  msgType: string,
  rawContent: string,
  parentId?: string
) {
  if (!claimMessageId(msgId, chatId)) return;

  let text = "";
  if (msgType === "text") {
    try {
      const parsed = JSON.parse(rawContent || "{}");
      text = (parsed.text || "").replace(/@_user_\d+/g, "").trim();
    } catch {}
  } else if (msgType === "post") {
    try {
      const parsed = JSON.parse(rawContent || "{}");
      const contentRows = parsed?.content || parsed?.zh_cn?.content || [];
      const chunks: string[] = [];
      for (const row of contentRows) {
        if (Array.isArray(row)) {
          for (const elem of row) {
            if (elem?.text) chunks.push(elem.text);
          }
        }
      }
      text = chunks.join("\n").replace(/@_user_\d+/g, "").trim();
    } catch {}
  }
  if (!text) return;

  console.log(`[Feishu WS Incoming] msg=${msgId} chat=${chatId} parent=${parentId || "none"}: ${text}`);

  const reactionId = await addTypingReaction(msgId);
  try {
    await handleIncomingText(
      chatId,
      text,
      parentId,
      async (replyContent) => {
        return await sendFeishuMessage(chatId, replyContent, { replyToMsgId: msgId });
      },
      msgId
    );
  } finally {
    await removeReaction(msgId, reactionId);
  }
}

function tryStartFeishuWS() {
  const env = { ...process.env, ...loadEnvFile() } as Record<string, string>;
  const appId = env.FEISHU_APP_ID || "";
  const appSecret = env.FEISHU_APP_SECRET || "";
  if (!appId || !appSecret || appId === currentAppId) return;

  currentAppId = appId;
  console.log(`[Feishu Gateway] Connecting with AppID: ${appId}...`);

  activeLarkClient = new Lark.Client({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info
  });

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.info }).register({
      "im.message.receive_v1": async (data: any) => {
        try {
          const msg = data.message;
          if (!msg) return;
          processFeishuMsgItem(
            msg.message_id,
            msg.chat_id,
            msg.message_type || "",
            msg.content || "{}",
            msg.parent_id || msg.root_id || undefined
          ).catch((err) => console.error("[Feishu Async Turn Error]:", err));
        } catch (err) {
          console.error("[Feishu Handler Error]:", err);
        }
      }
    })
  });
}

startOpencodeEventStream();
startOutboxPoller();
tryStartFeishuWS();
setInterval(tryStartFeishuWS, 3000);

const PORT = Number(process.env.PURPLELIGHT_PORT || 4099);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "PurpleLight",
        feishu_connected: !!currentAppId,
        tracked_sessions: sessionStates.size
      });
    }
    if (url.pathname === "/chat" && req.method === "POST") {
      const body = (await req.json()) as any;
      const chatId = body.chatId || "local-test-chat";
      const reply = await handleIncomingText(chatId, body.text, body.parentMsgId);
      return Response.json({ ok: true, reply });
    }
    return new Response("Not Found", { status: 404 });
  }
});

console.log(`[PurpleLight Gateway] Listening on http://127.0.0.1:${PORT}`);

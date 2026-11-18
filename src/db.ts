import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join, resolve } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "PurpleLight.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'open',
  scout_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_session_id TEXT NOT NULL,
  scout_id TEXT,
  intent_id INTEGER,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'observation',
  confidence TEXT NOT NULL DEFAULT 'observed',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_session_id TEXT NOT NULL,
  scout_id TEXT,
  intent_id INTEGER,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  vuln_class TEXT NOT NULL,
  summary TEXT NOT NULL,
  poc_detail TEXT NOT NULL,
  counterevidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_session_id TEXT NOT NULL,
  target_scout_id TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'strategist',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scouts (
  scout_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  parent_session_id TEXT NOT NULL,
  intent_id INTEGER,
  role TEXT NOT NULL DEFAULT 'scout',
  goal TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'deepseek/deepseek-flash',
  status TEXT NOT NULL DEFAULT 'running',
  steps_used INTEGER NOT NULL DEFAULT 0,
  max_steps INTEGER NOT NULL DEFAULT 80,
  report_summary TEXT NOT NULL DEFAULT '',
  report_detail TEXT NOT NULL DEFAULT '',
  suggest_more_turns INTEGER NOT NULL DEFAULT 0,
  suggested_next_steps TEXT NOT NULL DEFAULT '',
  feishu_thread_msg_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hook_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target_path TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS events_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_session_id TEXT NOT NULL,
  scout_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_bindings (
  chat_id TEXT PRIMARY KEY,
  main_session_id TEXT NOT NULL,
  last_user_msg_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS thread_bindings (
  thread_msg_id TEXT PRIMARY KEY,
  scout_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_settings (
  role TEXT PRIMARY KEY, -- 'main' | 'scout'
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

try {
  db.exec(`ALTER TABLE chat_bindings ADD COLUMN last_user_msg_id TEXT;`);
} catch {}

db.prepare(`
  INSERT OR IGNORE INTO agent_settings (role, provider_id, model_id)
  VALUES ('main', 'deepseek', 'deepseek-v4-pro')
`).run();

db.prepare(`
  INSERT OR IGNORE INTO agent_settings (role, provider_id, model_id)
  VALUES ('scout', 'deepseek', 'deepseek-flash')
`).run();

export interface AgentModelConfig {
  role: "main" | "scout";
  providerID: string;
  modelID: string;
}

export function getAgentModelConfig(role: "main" | "scout"): AgentModelConfig {
  const row = db.prepare(`SELECT provider_id, model_id FROM agent_settings WHERE role = ?`).get(role) as any;
  if (!row) {
    return role === "main"
      ? { role: "main", providerID: "deepseek", modelID: "deepseek-v4-pro" }
      : { role: "scout", providerID: "deepseek", modelID: "deepseek-flash" };
  }
  return {
    role,
    providerID: row.provider_id,
    modelID: row.model_id
  };
}

export function setAgentModelConfig(role: "main" | "scout", providerID: string, modelID: string): AgentModelConfig {
  db.prepare(`
    INSERT OR REPLACE INTO agent_settings (role, provider_id, model_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(role, providerID, modelID);
  return { role, providerID, modelID };
}

export function pushOutboxEvent(mainSessionId: string, scoutId: string | null, eventType: string, payload: Record<string, any>) {
  db.prepare(`
    INSERT INTO events_outbox (main_session_id, scout_id, event_type, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(mainSessionId, scoutId, eventType, JSON.stringify(payload));
}

export function getGraphOverview(mainSessionId: string) {
  const intents = db.prepare(`SELECT * FROM intents WHERE main_session_id = ? ORDER BY id DESC`).all(mainSessionId) as any[];
  const facts = db.prepare(`SELECT * FROM facts WHERE main_session_id = ? ORDER BY id DESC`).all(mainSessionId) as any[];
  const findings = db.prepare(`SELECT * FROM findings WHERE main_session_id = ? ORDER BY id DESC`).all(mainSessionId) as any[];
  const hints = db.prepare(`SELECT * FROM hints WHERE main_session_id = ? ORDER BY id DESC`).all(mainSessionId) as any[];
  const scouts = db.prepare(`SELECT * FROM scouts WHERE parent_session_id = ? ORDER BY created_at DESC`).all(mainSessionId) as any[];
  return { intents, facts, findings, hints, scouts };
}

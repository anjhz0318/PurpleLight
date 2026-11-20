import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, resolve, relative } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const WORKSPACES_ROOT = join(PROJECT_ROOT, "workspaces");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACES_ROOT, { recursive: true });

export const SUPPORTED_PROVIDERS = ["glm", "deepseek", "openrouter", "custom"] as const;
export type ProviderID = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(p: string): p is ProviderID {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

export const db = new Database(join(DATA_DIR, "PurpleLight.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

// ─────────────────────────────────────────────────────────────────────────────
// Schema Initialization & Lossless Legacy Migration
// ─────────────────────────────────────────────────────────────────────────────

function hasColumn(tableName: string, colName: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    return cols.some((c) => c.name === colName);
  } catch {
    return false;
  }
}

function tableExists(tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as any;
  return !!row;
}

db.exec(`
CREATE TABLE IF NOT EXISTS hunting_sessions (
  session_id TEXT PRIMARY KEY,
  target_tag TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS insights (
  uid INTEGER PRIMARY KEY AUTOINCREMENT,
  id INTEGER NOT NULL,
  main_session_id TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  insight TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'exploring', -- 'exploring' | 'confirmed' | 'falsified' | 'parked'
  origin_uid INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(main_session_id, id)
);

CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(main_session_id);
CREATE INDEX IF NOT EXISTS idx_insights_target ON insights(target);
`);

if (tableExists("facts") && !hasColumn("facts", "uid")) {
  db.exec(`
    ALTER TABLE facts RENAME TO facts_legacy_v1;
    CREATE TABLE facts (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER NOT NULL,
      main_session_id TEXT NOT NULL,
      insight_id INTEGER NOT NULL,
      scout_id TEXT NOT NULL DEFAULT 'strategist',
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'observation',
      confidence TEXT NOT NULL DEFAULT 'observed',
      origin_uid INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(main_session_id, id)
    );
    INSERT INTO facts (id, main_session_id, insight_id, scout_id, summary, detail, evidence, source, confidence, created_at)
    SELECT id, main_session_id, COALESCE(intent_id, 1), COALESCE(scout_id, 'strategist'), summary, detail, COALESCE(evidence, ''), COALESCE(source, 'observation'), COALESCE(confidence, 'observed'), created_at
    FROM facts_legacy_v1;
    DROP TABLE facts_legacy_v1;
  `);
} else {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER NOT NULL,
      main_session_id TEXT NOT NULL,
      insight_id INTEGER NOT NULL,
      scout_id TEXT NOT NULL DEFAULT 'strategist',
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'observation',
      confidence TEXT NOT NULL DEFAULT 'observed',
      origin_uid INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(main_session_id, id)
    );
  `);
}

if (tableExists("findings") && !hasColumn("findings", "uid")) {
  db.exec(`
    ALTER TABLE findings RENAME TO findings_legacy_v1;
    CREATE TABLE findings (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER NOT NULL,
      main_session_id TEXT NOT NULL,
      insight_id INTEGER NOT NULL,
      scout_id TEXT NOT NULL DEFAULT 'strategist',
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      vuln_class TEXT NOT NULL,
      summary TEXT NOT NULL,
      poc_detail TEXT NOT NULL,
      counterevidence TEXT NOT NULL DEFAULT '',
      origin_uid INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(main_session_id, id)
    );
    INSERT INTO findings (id, main_session_id, insight_id, scout_id, title, severity, vuln_class, summary, poc_detail, counterevidence, created_at)
    SELECT id, main_session_id, COALESCE(intent_id, 1), COALESCE(scout_id, 'strategist'), title, severity, vuln_class, summary, poc_detail, COALESCE(counterevidence, ''), created_at
    FROM findings_legacy_v1;
    DROP TABLE findings_legacy_v1;
  `);
} else {
  db.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      uid INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER NOT NULL,
      main_session_id TEXT NOT NULL,
      insight_id INTEGER NOT NULL,
      scout_id TEXT NOT NULL DEFAULT 'strategist',
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      vuln_class TEXT NOT NULL,
      summary TEXT NOT NULL,
      poc_detail TEXT NOT NULL,
      counterevidence TEXT NOT NULL DEFAULT '',
      origin_uid INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(main_session_id, id)
    );
  `);
}

if (tableExists("intents")) {
  const insightCount = (db.prepare(`SELECT COUNT(*) as c FROM insights`).get() as any)?.c || 0;
  if (insightCount === 0) {
    const oldIntents = db.prepare(`SELECT * FROM intents ORDER BY id ASC`).all() as any[];
    const insertIns = db.prepare(`
      INSERT OR IGNORE INTO insights (id, main_session_id, target, title, insight, hypothesis, priority, status, created_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)
    `);
    for (const row of oldIntents) {
      const mappedStatus =
        row.status === "done" ? "confirmed" : row.status === "stopped" ? "parked" : "exploring";
      insertIns.run(
        row.id,
        row.main_session_id,
        row.title,
        row.detail || row.title,
        row.detail || "",
        row.priority ?? 5,
        mappedStatus,
        row.created_at
      );
    }
  }
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_facts_session_insight ON facts(main_session_id, insight_id);
CREATE INDEX IF NOT EXISTS idx_findings_session_insight ON findings(main_session_id, insight_id);

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
  insight_id INTEGER,
  role TEXT NOT NULL DEFAULT 'scout',
  goal TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  workspace_dir TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'deepseek/deepseek-flash',
  status TEXT NOT NULL DEFAULT 'running',
  steps_used INTEGER NOT NULL DEFAULT 0,
  max_steps INTEGER NOT NULL DEFAULT 80,
  timeout_sec INTEGER NOT NULL DEFAULT 600,
  deadline_at INTEGER,
  callback_sent INTEGER NOT NULL DEFAULT 0,
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

for (const sql of [
  `ALTER TABLE chat_bindings ADD COLUMN last_user_msg_id TEXT;`,
  `ALTER TABLE scouts ADD COLUMN timeout_sec INTEGER NOT NULL DEFAULT 600;`,
  `ALTER TABLE scouts ADD COLUMN deadline_at INTEGER;`,
  `ALTER TABLE scouts ADD COLUMN callback_sent INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE scouts ADD COLUMN insight_id INTEGER;`,
  `ALTER TABLE scouts ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';`
]) {
  try {
    db.exec(sql);
  } catch {}
}

if (hasColumn("scouts", "intent_id")) {
  try {
    db.exec(`UPDATE scouts SET insight_id = intent_id WHERE insight_id IS NULL AND intent_id IS NOT NULL;`);
  } catch {}
}

// Default model settings: main defaults to first-class `glm` (`glm-5.3`), scout defaults to `deepseek` (`deepseek-flash`)
db.prepare(`
  INSERT OR IGNORE INTO agent_settings (role, provider_id, model_id)
  VALUES ('main', 'glm', 'glm-5.3')
`).run();

db.prepare(`
  INSERT OR IGNORE INTO agent_settings (role, provider_id, model_id)
  VALUES ('scout', 'deepseek', 'deepseek-flash')
`).run();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: Agent Settings, Per-Session Sequential IDs, Blackboard & History
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentModelConfig {
  role: "main" | "scout";
  providerID: ProviderID;
  modelID: string;
}

export function getAgentModelConfig(role: "main" | "scout"): AgentModelConfig {
  const row = db.prepare(`SELECT provider_id, model_id FROM agent_settings WHERE role = ?`).get(role) as any;
  if (!row) {
    return role === "main"
      ? { role: "main", providerID: "glm", modelID: "glm-5.3" }
      : { role: "scout", providerID: "deepseek", modelID: "deepseek-flash" };
  }
  const prov = isSupportedProvider(row.provider_id) ? row.provider_id : "glm";
  return {
    role,
    providerID: prov,
    modelID: row.model_id
  };
}

export function setAgentModelConfig(role: "main" | "scout", providerID: ProviderID, modelID: string): AgentModelConfig {
  db.prepare(`
    INSERT OR REPLACE INTO agent_settings (role, provider_id, model_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(role, providerID, modelID);
  return { role, providerID, modelID };
}

export function ensureHuntingSession(sessionId: string, title = "", targetTag = "") {
  db.prepare(`
    INSERT INTO hunting_sessions (session_id, target_tag, title, status)
    VALUES (?, ?, ?, 'active')
    ON CONFLICT(session_id) DO UPDATE SET
      target_tag = CASE WHEN excluded.target_tag != '' THEN excluded.target_tag ELSE hunting_sessions.target_tag END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE hunting_sessions.title END
  `).run(sessionId, targetTag, title);
}

export function nextSessionScopedId(table: "insights" | "facts" | "findings", mainSessionId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(id), 0) as max_id FROM ${table} WHERE main_session_id = ?`)
    .get(mainSessionId) as any;
  return Number(row?.max_id || 0) + 1;
}

export function getInsightBySessionAndId(mainSessionId: string, insightId: number): any | null {
  return db
    .prepare(`SELECT * FROM insights WHERE main_session_id = ? AND id = ?`)
    .get(mainSessionId, insightId) as any;
}

export function pushOutboxEvent(
  mainSessionId: string,
  scoutId: string | null,
  eventType: string,
  payload: Record<string, any>
) {
  db.prepare(`
    INSERT INTO events_outbox (main_session_id, scout_id, event_type, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(mainSessionId, scoutId, eventType, JSON.stringify(payload));
}

export function getGraphOverview(mainSessionId: string, specificInsightId?: number) {
  if (specificInsightId !== undefined) {
    const insight = getInsightBySessionAndId(mainSessionId, specificInsightId);
    if (!insight) {
      throw new Error(`未在当前会话黑板找到 Insight #${specificInsightId}`);
    }
    const findings = db
      .prepare(`SELECT * FROM findings WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
      .all(mainSessionId, specificInsightId) as any[];
    const facts = db
      .prepare(`SELECT * FROM facts WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
      .all(mainSessionId, specificInsightId) as any[];
    const scouts = db
      .prepare(`SELECT * FROM scouts WHERE parent_session_id = ? AND insight_id = ? ORDER BY rowid ASC`)
      .all(mainSessionId, specificInsightId) as any[];
    return {
      insight,
      findings,
      facts,
      scouts
    };
  }

  const insights = db
    .prepare(`SELECT * FROM insights WHERE main_session_id = ? ORDER BY id ASC`)
    .all(mainSessionId) as any[];
  const facts = db
    .prepare(`SELECT * FROM facts WHERE main_session_id = ? ORDER BY id ASC`)
    .all(mainSessionId) as any[];
  const findings = db
    .prepare(`SELECT * FROM findings WHERE main_session_id = ? ORDER BY id ASC`)
    .all(mainSessionId) as any[];
  const hints = db
    .prepare(`SELECT * FROM hints WHERE main_session_id = ? ORDER BY id DESC`)
    .all(mainSessionId) as any[];
  const scouts = db
    .prepare(`SELECT * FROM scouts WHERE parent_session_id = ? ORDER BY rowid ASC`)
    .all(mainSessionId) as any[];

  const insightTree = insights.map((ins) => ({
    id: ins.id,
    target: ins.target,
    title: ins.title,
    status: ins.status,
    priority: ins.priority,
    insight: ins.insight,
    hypothesis: ins.hypothesis,
    updated_at: ins.updated_at,
    findings: findings
      .filter((f) => f.insight_id === ins.id)
      .map((f) => ({
        id: f.id,
        scout_id: f.scout_id,
        severity: f.severity,
        vuln_class: f.vuln_class,
        title: f.title,
        summary: f.summary
      })),
    facts: facts
      .filter((f) => f.insight_id === ins.id)
      .map((f) => ({
        id: f.id,
        scout_id: f.scout_id,
        summary: f.summary,
        source: f.source,
        confidence: f.confidence
      }))
  }));

  return {
    counts: {
      insights: insights.length,
      facts: facts.length,
      findings: findings.length,
      scouts: scouts.length,
      hints: hints.length
    },
    insight_tree: insightTree,
    scouts,
    hints: hints.slice(0, 15)
  };
}

export function getHistoricalArchiveStats(excludeSessionId?: string) {
  const row = excludeSessionId
    ? (db
        .prepare(`
          SELECT
            COUNT(DISTINCT main_session_id) as sessions_count,
            COUNT(*) as insights_count,
            (SELECT COUNT(*) FROM findings WHERE main_session_id != ?) as findings_count,
            (SELECT COUNT(*) FROM facts WHERE main_session_id != ?) as facts_count
          FROM insights
          WHERE main_session_id != ?
        `)
        .get(excludeSessionId, excludeSessionId, excludeSessionId) as any)
    : (db
        .prepare(`
          SELECT
            COUNT(DISTINCT main_session_id) as sessions_count,
            COUNT(*) as insights_count,
            (SELECT COUNT(*) FROM findings) as findings_count,
            (SELECT COUNT(*) FROM facts) as facts_count
          FROM insights
        `)
        .get() as any);
  return {
    sessions_count: Number(row?.sessions_count || 0),
    insights_count: Number(row?.insights_count || 0),
    findings_count: Number(row?.findings_count || 0),
    facts_count: Number(row?.facts_count || 0)
  };
}

export function searchHistoricalKnowledge(opts: {
  excludeSessionId?: string;
  query?: string;
  status?: string;
  includeCurrentSession?: boolean;
  limit?: number;
}) {
  const q = (opts.query || "").trim();
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
  const excludeSid = !opts.includeCurrentSession && opts.excludeSessionId ? opts.excludeSessionId : "";

  const sessionRows = db
    .prepare(`
      SELECT
        i.main_session_id as session_id,
        COALESCE(NULLIF(hs.target_tag, ''), MAX(i.target), '') as target_tag,
        COALESCE(hs.title, '') as session_title,
        COALESCE(hs.status, 'archived') as session_status,
        MIN(i.created_at) as started_at,
        MAX(i.updated_at) as last_updated_at,
        COUNT(DISTINCT i.id) as insights_count,
        (SELECT COUNT(*) FROM findings fd WHERE fd.main_session_id = i.main_session_id) as findings_count,
        (SELECT COUNT(*) FROM facts fc WHERE fc.main_session_id = i.main_session_id) as facts_count
      FROM insights i
      LEFT JOIN hunting_sessions hs ON hs.session_id = i.main_session_id
      WHERE (? = '' OR i.main_session_id != ?)
      GROUP BY i.main_session_id
      ORDER BY started_at DESC
    `)
    .all(excludeSid, excludeSid) as any[];

  if (!q) {
    const sessions = sessionRows.map((sr) => {
      const topInsights = db
        .prepare(
          `SELECT id, target, title, status, priority FROM insights WHERE main_session_id = ? ORDER BY id ASC LIMIT 25`
        )
        .all(sr.session_id);
      const sessionFindings = db
        .prepare(
          `SELECT id, insight_id, severity, vuln_class, title FROM findings WHERE main_session_id = ? ORDER BY id ASC`
        )
        .all(sr.session_id);
      return {
        ...sr,
        insights_preview: topInsights,
        findings_preview: sessionFindings
      };
    });
    return {
      query: "",
      total_historical_sessions: sessions.length,
      sessions
    };
  }

  const terms = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const candidateInsights = db
    .prepare(`
      SELECT * FROM insights
      WHERE (? = '' OR main_session_id != ?)
      ${opts.status ? `AND status = ?` : ""}
      ORDER BY created_at DESC
    `)
    .all(...(opts.status ? [excludeSid, excludeSid, opts.status] : [excludeSid, excludeSid])) as any[];

  const matchedResults: any[] = [];
  for (const ins of candidateInsights) {
    const linkedFindings = db
      .prepare(`SELECT * FROM findings WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
      .all(ins.main_session_id, ins.id) as any[];
    const linkedFacts = db
      .prepare(`SELECT * FROM facts WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
      .all(ins.main_session_id, ins.id) as any[];

    const haystack = [
      ins.target,
      ins.title,
      ins.insight,
      ins.hypothesis,
      ...linkedFindings.map((fd) => `${fd.title} ${fd.vuln_class} ${fd.summary} ${fd.poc_detail}`),
      ...linkedFacts.map((fc) => `${fc.summary} ${fc.detail}`)
    ]
      .join("\n")
      .toLowerCase();

    const matchedTermCount = terms.filter((t) => haystack.includes(t.toLowerCase())).length;
    if (matchedTermCount === 0) continue;

    matchedResults.push({
      score: matchedTermCount,
      source_session_id: ins.main_session_id,
      insight_id: ins.id,
      target: ins.target,
      title: ins.title,
      status: ins.status,
      priority: ins.priority,
      insight: ins.insight,
      hypothesis: ins.hypothesis,
      created_at: ins.created_at,
      findings_count: linkedFindings.length,
      findings: linkedFindings.map((fd) => ({
        id: fd.id,
        severity: fd.severity,
        vuln_class: fd.vuln_class,
        title: fd.title,
        summary: fd.summary
      })),
      facts_count: linkedFacts.length,
      facts_preview: linkedFacts.slice(0, 8).map((fc) => ({
        id: fc.id,
        scout_id: fc.scout_id,
        summary: fc.summary
      }))
    });
  }

  matchedResults.sort((a, b) => b.score - a.score || a.insight_id - b.insight_id);
  const sliced = matchedResults.slice(0, limit);

  return {
    query: q,
    matched_insights_count: matchedResults.length,
    returned_count: sliced.length,
    matched_sessions: Array.from(new Set(sliced.map((r) => r.source_session_id))),
    results: sliced
  };
}

export function loadHistoryIntoSession(opts: {
  targetSessionId: string;
  sourceSessionId: string;
  insightIds?: number[];
  query?: string;
}) {
  if (opts.targetSessionId === opts.sourceSessionId) {
    throw new Error("source_session_id 不能与当前活跃主会话 ID 相同");
  }

  let sourceInsights = db
    .prepare(`SELECT * FROM insights WHERE main_session_id = ? ORDER BY id ASC`)
    .all(opts.sourceSessionId) as any[];

  if (sourceInsights.length === 0) {
    throw new Error(`未在历史库中找到会话 ${opts.sourceSessionId} 的 Insights 记录`);
  }

  if (opts.insightIds && opts.insightIds.length > 0) {
    const idSet = new Set(opts.insightIds.map(Number));
    sourceInsights = sourceInsights.filter((ins) => idSet.has(Number(ins.id)));
  }

  if (opts.query && opts.query.trim()) {
    const terms = opts.query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    sourceInsights = sourceInsights.filter((ins) => {
      const linkedFindings = db
        .prepare(`SELECT title, vuln_class, summary FROM findings WHERE main_session_id = ? AND insight_id = ?`)
        .all(opts.sourceSessionId, ins.id) as any[];
      const linkedFacts = db
        .prepare(`SELECT summary, detail FROM facts WHERE main_session_id = ? AND insight_id = ?`)
        .all(opts.sourceSessionId, ins.id) as any[];
      const hay = [
        ins.target,
        ins.title,
        ins.insight,
        ins.hypothesis,
        ...linkedFindings.map((f) => `${f.title} ${f.vuln_class} ${f.summary}`),
        ...linkedFacts.map((f) => `${f.summary} ${f.detail}`)
      ]
        .join("\n")
        .toLowerCase();
      return terms.some((t) => hay.includes(t));
    });
  }

  let loadedInsights = 0;
  let skippedInsights = 0;
  let loadedFindings = 0;
  let loadedFacts = 0;
  const importedMap: Array<{ old_insight_id: number; new_insight_id: number; title: string; status: string }> = [];

  const tx = db.transaction(() => {
    ensureHuntingSession(opts.targetSessionId);

    for (const srcIns of sourceInsights) {
      const originUid = srcIns.origin_uid || srcIns.uid;
      const already = db
        .prepare(`SELECT id FROM insights WHERE main_session_id = ? AND (origin_uid = ? OR uid = ?)`)
        .get(opts.targetSessionId, originUid, originUid) as any;

      let targetInsightId: number;
      if (already) {
        targetInsightId = Number(already.id);
        skippedInsights += 1;
      } else {
        targetInsightId = nextSessionScopedId("insights", opts.targetSessionId);
        db.prepare(`
          INSERT INTO insights (
            id, main_session_id, target, title, insight, hypothesis, priority, status, origin_uid, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          targetInsightId,
          opts.targetSessionId,
          srcIns.target || "",
          srcIns.title,
          srcIns.insight,
          srcIns.hypothesis || "",
          srcIns.priority ?? 5,
          srcIns.status || "exploring",
          originUid,
          srcIns.created_at
        );
        loadedInsights += 1;
        importedMap.push({
          old_insight_id: srcIns.id,
          new_insight_id: targetInsightId,
          title: srcIns.title,
          status: srcIns.status
        });
      }

      const srcFindings = db
        .prepare(`SELECT * FROM findings WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
        .all(opts.sourceSessionId, srcIns.id) as any[];

      for (const fd of srcFindings) {
        const fdOriginUid = fd.origin_uid || fd.uid;
        const fdExists = db
          .prepare(`SELECT id FROM findings WHERE main_session_id = ? AND (origin_uid = ? OR uid = ?)`)
          .get(opts.targetSessionId, fdOriginUid, fdOriginUid);
        if (fdExists) continue;

        const nextFdId = nextSessionScopedId("findings", opts.targetSessionId);
        const scoutTag = String(fd.scout_id || "").startsWith("history:") ? fd.scout_id : `history:${fd.scout_id}`;
        db.prepare(`
          INSERT INTO findings (
            id, main_session_id, insight_id, scout_id, title, severity, vuln_class, summary, poc_detail, counterevidence, origin_uid, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nextFdId,
          opts.targetSessionId,
          targetInsightId,
          scoutTag,
          fd.title,
          fd.severity,
          fd.vuln_class,
          fd.summary,
          fd.poc_detail,
          fd.counterevidence || "",
          fdOriginUid,
          fd.created_at
        );
        loadedFindings += 1;
      }

      const srcFacts = db
        .prepare(`SELECT * FROM facts WHERE main_session_id = ? AND insight_id = ? ORDER BY id ASC`)
        .all(opts.sourceSessionId, srcIns.id) as any[];

      for (const fc of srcFacts) {
        const fcOriginUid = fc.origin_uid || fc.uid;
        const fcExists = db
          .prepare(`SELECT id FROM facts WHERE main_session_id = ? AND (origin_uid = ? OR uid = ?)`)
          .get(opts.targetSessionId, fcOriginUid, fcOriginUid);
        if (fcExists) continue;

        const nextFcId = nextSessionScopedId("facts", opts.targetSessionId);
        const scoutTag = String(fc.scout_id || "").startsWith("history:") ? fc.scout_id : `history:${fc.scout_id}`;
        db.prepare(`
          INSERT INTO facts (
            id, main_session_id, insight_id, scout_id, summary, detail, evidence, source, confidence, origin_uid, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nextFcId,
          opts.targetSessionId,
          targetInsightId,
          scoutTag,
          fc.summary,
          fc.detail,
          fc.evidence || "",
          fc.source || "observation",
          fc.confidence || "observed",
          fcOriginUid,
          fc.created_at
        );
        loadedFacts += 1;
      }
    }
  });

  tx();

  return {
    status: "ok",
    source_session_id: opts.sourceSessionId,
    target_session_id: opts.targetSessionId,
    loaded_insights: loadedInsights,
    skipped_already_loaded_insights: skippedInsights,
    loaded_findings: loadedFindings,
    loaded_facts: loadedFacts,
    imported_insights: importedMap
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Cleanup & /new Session Archiving Reset
// ─────────────────────────────────────────────────────────────────────────────

export interface CleanWorkspacesResult {
  cleaned_scouts: string[];
  cleaned_dirs: string[];
  skipped_running: string[];
}

function isSafeWorkspaceSubdir(targetDir: string): boolean {
  const absRoot = resolve(WORKSPACES_ROOT);
  const absTarget = resolve(targetDir);
  const rel = relative(absRoot, absTarget);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

export function cleanScoutWorkspaces(opts: {
  mainSessionId?: string;
  scoutId?: string;
  all?: boolean;
  includeRunning?: boolean;
}): CleanWorkspacesResult {
  const cleanedScouts: string[] = [];
  const cleanedDirs: string[] = [];
  const skippedRunning: string[] = [];
  const includeRunning = !!opts.includeRunning;

  if (opts.scoutId) {
    const scout = db.prepare(`SELECT * FROM scouts WHERE scout_id = ?`).get(opts.scoutId) as any;
    if (scout && scout.status === "running" && !includeRunning) {
      skippedRunning.push(scout.scout_id);
      return { cleaned_scouts: cleanedScouts, cleaned_dirs: cleanedDirs, skipped_running: skippedRunning };
    }
    const dir = scout?.workspace_dir || join(WORKSPACES_ROOT, opts.scoutId);
    if (isSafeWorkspaceSubdir(dir) && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      cleanedScouts.push(opts.scoutId);
      cleanedDirs.push(dir);
    }
    return { cleaned_scouts: cleanedScouts, cleaned_dirs: cleanedDirs, skipped_running: skippedRunning };
  }

  const rows = opts.all
    ? (db.prepare(`SELECT * FROM scouts`).all() as any[])
    : opts.mainSessionId
      ? (db.prepare(`SELECT * FROM scouts WHERE parent_session_id = ?`).all(opts.mainSessionId) as any[])
      : [];

  const runningDirs = new Set<string>();
  for (const s of rows) {
    if (s.status === "running" && !includeRunning) {
      skippedRunning.push(s.scout_id);
      if (s.workspace_dir) runningDirs.add(resolve(s.workspace_dir));
      continue;
    }
    if (s.workspace_dir && isSafeWorkspaceSubdir(s.workspace_dir) && existsSync(s.workspace_dir)) {
      rmSync(s.workspace_dir, { recursive: true, force: true });
      cleanedScouts.push(s.scout_id);
      cleanedDirs.push(s.workspace_dir);
    }
  }

  if (opts.all) {
    try {
      for (const entry of readdirSync(WORKSPACES_ROOT)) {
        const fullPath = join(WORKSPACES_ROOT, entry);
        if (runningDirs.has(resolve(fullPath))) continue;
        if (isSafeWorkspaceSubdir(fullPath) && existsSync(fullPath)) {
          rmSync(fullPath, { recursive: true, force: true });
          if (!cleanedScouts.includes(entry)) cleanedScouts.push(entry);
          if (!cleanedDirs.includes(fullPath)) cleanedDirs.push(fullPath);
        }
      }
    } catch {}
  }

  return {
    cleaned_scouts: cleanedScouts,
    cleaned_dirs: cleanedDirs,
    skipped_running: skippedRunning
  };
}

export function resetBlackboardForNewSession(oldMainSessionId?: string) {
  if (oldMainSessionId) {
    db.prepare(`
      INSERT INTO hunting_sessions (session_id, status, archived_at)
      VALUES (?, 'archived', CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'archived',
        archived_at = CURRENT_TIMESTAMP
    `).run(oldMainSessionId);
  }

  db.exec(`
    DELETE FROM scouts;
    DELETE FROM hints;
    DELETE FROM hook_approvals;
    DELETE FROM thread_bindings;
    DELETE FROM events_outbox;
    DELETE FROM sqlite_sequence WHERE name IN (
      'hints',
      'hook_approvals',
      'events_outbox'
    );
  `);
}

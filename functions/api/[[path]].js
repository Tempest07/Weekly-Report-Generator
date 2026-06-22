const MAX_FILE_BYTES = 80 * 1024 * 1024;
const REQUIRED_INPUTS = [
  ["balance", "balanceFile", "余额台账"],
  ["ppt", "pptFile", "委外周报 PPT"],
  ["cbAdd", "cbAddFile", "CB 增持台账"],
  ["cbReduce", "cbReduceFile", "CB 减持台账"],
];
const DV01_FIELDS = [
  ["fvociCreditDv01", "FVOCI信用债 DV01"],
  ["fvociAbsDv01", "FVOCI ABS DV01"],
  ["acCreditDv01", "AC信用债 DV01"],
  ["acAbsDv01", "AC ABS DV01"],
];
const RESULT_FIELDS = ["pdf", "docx", "archive", "log"];
const JOB_STATUSES = new Set(["pending", "running", "completed", "failed", "canceled"]);

export async function onRequest(context) {
  try {
    if (context.request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    await ensureSchema(context.env.DB);
    return await route(context);
  } catch (error) {
    return json({ error: error.message || String(error) }, 500);
  }
}

async function route(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const parts = path.split("/").filter(Boolean);
  const method = context.request.method.toUpperCase();

  if (parts[0] === "jobs" && parts.length === 1 && method === "GET") {
    const denied = authorizeUser(context);
    if (denied) return denied;
    return listJobs(context.env.DB);
  }

  if (parts[0] === "jobs" && parts.length === 1 && method === "POST") {
    const denied = authorizeUser(context);
    if (denied) return denied;
    return createJob(context);
  }

  if (parts[0] === "jobs" && parts[1] && parts.length === 2 && method === "GET") {
    const denied = authorizeUser(context);
    if (denied) return denied;
    return getJobResponse(context.env.DB, parts[1]);
  }

  if (parts[0] === "jobs" && parts[1] && parts[2] === "cancel" && parts.length === 3 && method === "POST") {
    const denied = authorizeUser(context);
    if (denied) return denied;
    return cancelJob(context.env.DB, parts[1]);
  }

  if (parts[0] === "jobs" && parts[1] && parts[2] === "files" && parts[3] && method === "GET") {
    const denied = authorizeDownload(context, url);
    if (denied) return denied;
    return downloadJobFile(context.env, parts[1], parts[3]);
  }

  if (parts[0] === "runner" && parts[1] === "status" && parts.length === 2 && method === "GET") {
    const denied = authorizeUser(context);
    if (denied) return denied;
    return getRunnerStatus(context.env.DB);
  }

  if (parts[0] === "runner" && parts[1] === "status" && parts.length === 2 && method === "PATCH") {
    const denied = authorizeRunner(context);
    if (denied) return denied;
    return updateRunnerStatus(context);
  }

  if (parts[0] === "runner" && parts[1] === "next" && method === "GET") {
    const denied = authorizeRunner(context);
    if (denied) return denied;
    return claimNextJob(context);
  }

  if (parts[0] === "runner" && parts[1] === "jobs" && parts[2] && parts.length === 3 && method === "GET") {
    const denied = authorizeRunner(context);
    if (denied) return denied;
    return getJobResponse(context.env.DB, parts[2]);
  }

  if (parts[0] === "runner" && parts[1] === "jobs" && parts[2] && parts.length === 3 && method === "PATCH") {
    const denied = authorizeRunner(context);
    if (denied) return denied;
    return updateRunnerJob(context, parts[2]);
  }

  if (parts[0] === "runner" && parts[1] === "jobs" && parts[2] && parts[3] === "results" && method === "POST") {
    const denied = authorizeRunner(context);
    if (denied) return denied;
    return uploadRunnerResults(context, parts[2]);
  }

  return json({ error: "Not Found" }, 404);
}

async function createJob({ request, env }) {
  if (!env.REPORT_BUCKET) throw new Error("R2 binding REPORT_BUCKET 尚未配置");
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_FILE_BYTES * 4) return json({ error: "上传文件过大" }, 413);

  const form = await request.formData();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const inputs = [];

  for (const [kind, field, label] of REQUIRED_INPUTS) {
    const file = form.get(field);
    validateFile(file, label);
    const key = `jobs/${id}/inputs/${kind}-${safeFileName(file.name)}`;
    await env.REPORT_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || contentTypeFromName(file.name),
      },
      customMetadata: {
        jobId: id,
        kind,
        originalName: file.name || `${kind}.bin`,
      },
    });
    inputs.push({
      id: `input-${kind}`,
      kind,
      label,
      fileName: file.name || `${kind}.bin`,
      size: file.size || 0,
      contentType: file.type || contentTypeFromName(file.name),
      key,
    });
  }

  const dv01 = {};
  for (const [field, label] of DV01_FIELDS) {
    dv01[field] = parseRequiredNumber(form.get(field), label);
  }

  await env.DB.prepare(`
    INSERT INTO weekly_report_jobs (
      id, status, created_at, updated_at, progress, message,
      inputs_json, dv01_json, results_json, metadata_json
    )
    VALUES (?1, 'pending', ?2, ?2, 0, ?3, ?4, ?5, '[]', ?6)
  `).bind(
    id,
    now,
    "等待 Windows 小助手处理",
    JSON.stringify(inputs),
    JSON.stringify(dv01),
    JSON.stringify({ source: "web", userAgent: request.headers.get("User-Agent") || "" }),
  ).run();

  return json({ status: "ok", job: await loadJob(env.DB, id) }, 201);
}

async function listJobs(db) {
  const rows = await db.prepare(`
    SELECT * FROM weekly_report_jobs
    ORDER BY created_at DESC
    LIMIT 50
  `).all();
  return json({ jobs: (rows.results || []).map(normalizeJobRow) });
}

async function getJobResponse(db, id) {
  const job = await loadJob(db, id);
  if (!job) return json({ error: "任务不存在" }, 404);
  return json({ job });
}

async function claimNextJob({ env }) {
  const row = await env.DB.prepare(`
    SELECT * FROM weekly_report_jobs
    WHERE status = 'pending' AND COALESCE(cancel_requested, 0) = 0
    ORDER BY created_at ASC
    LIMIT 1
  `).first();
  if (!row) return json({ job: null });

  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE weekly_report_jobs
    SET status = 'running',
        updated_at = ?1,
        claimed_at = ?1,
        progress = 8,
        message = 'Windows 小助手已领取任务'
    WHERE id = ?2 AND status = 'pending'
  `).bind(now, row.id).run();

  if (!result.meta || result.meta.changes !== 1) {
    return json({ job: null });
  }

  const job = await loadJob(env.DB, row.id);
  return json({
    job: {
      ...job,
      inputDownloads: (job.inputs || []).map((file) => ({
        id: file.id,
        kind: file.kind,
        fileName: file.fileName,
        url: `/api/jobs/${encodeURIComponent(job.id)}/files/${encodeURIComponent(file.id)}`,
      })),
    },
  });
}

async function updateRunnerJob({ request, env }, id) {
  const body = await request.json();
  const status = body.status ? String(body.status) : "";
  if (status && !JOB_STATUSES.has(status)) throw new Error(`非法任务状态：${status}`);
  const progress = clampProgress(body.progress);
  const message = String(body.message || "").slice(0, 1000);
  const error = String(body.error || "").slice(0, 4000);
  const now = new Date().toISOString();

  const current = await loadJob(env.DB, id);
  if (!current) return json({ error: "任务不存在" }, 404);
  const nextStatus = status || current.status;
  const completedAt = ["completed", "failed", "canceled"].includes(nextStatus) ? now : current.completedAt || null;

  await env.DB.prepare(`
    UPDATE weekly_report_jobs
    SET status = ?1,
        updated_at = ?2,
        completed_at = ?3,
        progress = ?4,
        message = ?5,
        error = ?6,
        cancel_requested = CASE WHEN ?1 IN ('completed', 'failed', 'canceled') THEN 0 ELSE cancel_requested END
    WHERE id = ?7
  `).bind(
    nextStatus,
    now,
    completedAt,
    progress ?? current.progress ?? 0,
    message || current.message || "",
    error || current.error || "",
    id,
  ).run();

  return json({ status: "ok", job: await loadJob(env.DB, id) });
}

async function uploadRunnerResults({ request, env }, id) {
  if (!env.REPORT_BUCKET) throw new Error("R2 binding REPORT_BUCKET 尚未配置");
  const current = await loadJob(env.DB, id);
  if (!current) return json({ error: "任务不存在" }, 404);

  const form = await request.formData();
  const results = [...(current.results || [])];
  for (const kind of RESULT_FIELDS) {
    const file = form.get(kind);
    if (!isFileLike(file) || !file.size) continue;
    validateFile(file, kind);
    const resultId = `result-${kind}`;
    const key = `jobs/${id}/results/${kind}-${safeFileName(file.name)}`;
    await env.REPORT_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || contentTypeFromName(file.name),
      },
      customMetadata: {
        jobId: id,
        kind,
        originalName: file.name || `${kind}.bin`,
      },
    });
    const item = {
      id: resultId,
      kind,
      fileName: file.name || `${kind}.bin`,
      size: file.size || 0,
      contentType: file.type || contentTypeFromName(file.name),
      key,
      uploadedAt: new Date().toISOString(),
    };
    const index = results.findIndex((candidate) => candidate.id === resultId || candidate.kind === kind);
    if (index >= 0) results[index] = item;
    else results.push(item);
  }

  const status = String(form.get("status") || "completed");
  if (!JOB_STATUSES.has(status)) throw new Error(`非法任务状态：${status}`);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE weekly_report_jobs
    SET status = ?1,
        updated_at = ?2,
        completed_at = ?2,
        progress = ?3,
        message = ?4,
        error = ?5,
        results_json = ?6,
        cancel_requested = 0
    WHERE id = ?7
  `).bind(
    status,
    now,
    status === "completed" ? 100 : clampProgress(form.get("progress")) ?? 95,
    String(form.get("message") || (status === "completed" ? "生成完成" : "生成失败")).slice(0, 1000),
    String(form.get("error") || "").slice(0, 4000),
    JSON.stringify(results),
    id,
  ).run();

  return json({ status: "ok", job: await loadJob(env.DB, id) });
}

async function cancelJob(db, id) {
  const current = await loadJob(db, id);
  if (!current) return json({ error: "任务不存在" }, 404);
  if (["completed", "failed", "canceled"].includes(current.status)) {
    return json({ status: "ok", job: current });
  }

  const now = new Date().toISOString();
  if (current.status === "pending") {
    await db.prepare(`
      UPDATE weekly_report_jobs
      SET status = 'canceled',
          updated_at = ?1,
          completed_at = ?1,
          cancel_requested = 0,
          message = '已取消，未进入本地生成流程'
      WHERE id = ?2
    `).bind(now, id).run();
  } else {
    await db.prepare(`
      UPDATE weekly_report_jobs
      SET updated_at = ?1,
          cancel_requested = 1,
          message = '已请求停止，等待 Windows 接单员终止本地流程'
      WHERE id = ?2 AND status = 'running'
    `).bind(now, id).run();
  }
  return json({ status: "ok", job: await loadJob(db, id) });
}

async function getRunnerStatus(db) {
  const row = await db.prepare("SELECT * FROM weekly_report_runner_status WHERE id = 'default'").first();
  if (!row) {
    return json({
      runner: {
        status: "offline",
        message: "Windows 接单员尚未上报状态",
        updatedAt: null,
        currentJobId: "",
        ageSeconds: null,
        online: false,
      },
    });
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(row.updated_at)) / 1000));
  return json({
    runner: {
      status: row.status || "unknown",
      message: row.message || "",
      updatedAt: row.updated_at,
      currentJobId: row.current_job_id || "",
      metadata: parseJson(row.metadata_json, {}),
      ageSeconds,
      online: ageSeconds <= 90 && row.status !== "stopped",
    },
  });
}

async function updateRunnerStatus({ request, env }) {
  const body = await request.json();
  const now = new Date().toISOString();
  const status = String(body.status || "online").slice(0, 80);
  const message = String(body.message || "").slice(0, 1000);
  const currentJobId = String(body.currentJobId || "").slice(0, 120);
  const metadata = JSON.stringify(body.metadata || {});

  await env.DB.prepare(`
    INSERT INTO weekly_report_runner_status (id, updated_at, status, message, current_job_id, metadata_json)
    VALUES ('default', ?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      status = excluded.status,
      message = excluded.message,
      current_job_id = excluded.current_job_id,
      metadata_json = excluded.metadata_json
  `).bind(now, status, message, currentJobId, metadata).run();

  return json({ status: "ok" });
}

async function downloadJobFile(env, id, fileId) {
  const job = await loadJob(env.DB, id);
  if (!job) return json({ error: "任务不存在" }, 404);
  const files = [...(job.inputs || []), ...(job.results || [])];
  const file = files.find((item) => item.id === fileId || item.kind === fileId);
  if (!file) return json({ error: "文件不存在" }, 404);
  const object = await env.REPORT_BUCKET.get(file.key);
  if (!object) return json({ error: "R2 文件不存在" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", file.contentType || headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName || file.id)}`);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function loadJob(db, id) {
  const row = await db.prepare("SELECT * FROM weekly_report_jobs WHERE id = ?").bind(id).first();
  return row ? normalizeJobRow(row) : null;
}

function normalizeJobRow(row) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at || null,
    completedAt: row.completed_at || null,
    progress: Number(row.progress || 0),
    message: row.message || "",
    error: row.error || "",
    cancelRequested: Number(row.cancel_requested || 0) === 1,
    inputs: parseJson(row.inputs_json, []),
    dv01: parseJson(row.dv01_json, {}),
    results: parseJson(row.results_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

async function ensureSchema(db) {
  if (!db) throw new Error("D1 binding DB 尚未配置");
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS weekly_report_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      inputs_json TEXT NOT NULL,
      dv01_json TEXT NOT NULL,
      results_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_weekly_report_jobs_status_created ON weekly_report_jobs(status, created_at)").run();
  await ensureColumn(db, "weekly_report_jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS weekly_report_runner_status (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      current_job_id TEXT,
      metadata_json TEXT
    )
  `).run();
}

async function ensureColumn(db, tableName, columnName, columnDefinition) {
  const info = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = (info.results || []).some((column) => column.name === columnName);
  if (!exists) {
    await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`).run();
  }
}

function authorizeUser(context) {
  const authorization = context.request.headers.get("Authorization") || "";
  if (authorization === `Bearer ${context.env.APP_PASSWORD}` && context.env.APP_PASSWORD) return null;
  return json({ error: "Unauthorized" }, 401);
}

function authorizeRunner(context) {
  const authorization = context.request.headers.get("Authorization") || "";
  if (authorization === `Bearer ${context.env.RUNNER_TOKEN}` && context.env.RUNNER_TOKEN) return null;
  return json({ error: "Unauthorized" }, 401);
}

function authorizeDownload(context, url) {
  const authorization = context.request.headers.get("Authorization") || "";
  const queryToken = url.searchParams.get("token") || "";
  if (context.env.APP_PASSWORD && (authorization === `Bearer ${context.env.APP_PASSWORD}` || queryToken === context.env.APP_PASSWORD)) return null;
  if (context.env.RUNNER_TOKEN && authorization === `Bearer ${context.env.RUNNER_TOKEN}`) return null;
  return json({ error: "Unauthorized" }, 401);
}

function validateFile(file, label) {
  if (!isFileLike(file)) throw new Error(`请上传${label}`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${label}超过大小限制`);
}

function isFileLike(value) {
  return value && typeof value === "object" && typeof value.stream === "function" && typeof value.size === "number";
}

function parseRequiredNumber(value, label) {
  const text = String(value || "").trim().replace(/,/g, "");
  if (!text) throw new Error(`请填写${label}`);
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  return number;
}

function clampProgress(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function safeFileName(name = "file.bin") {
  return String(name || "file.bin").replace(/[\\/:*?"<>|#%{}^\[\]`]/g, "_").slice(0, 160);
}

function contentTypeFromName(name = "") {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xlsm")) return "application/vnd.ms-excel.sheet.macroEnabled.12";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

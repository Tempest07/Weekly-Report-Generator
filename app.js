const TOKEN_KEY = "weekly-report-generator-token";
const API_BASE = "./api";

const form = document.querySelector("#jobForm");
const passwordInput = document.querySelector("#passwordInput");
const savePasswordButton = document.querySelector("#savePasswordButton");
const refreshButton = document.querySelector("#refreshButton");
const submitButton = document.querySelector("#submitButton");
const jobsList = document.querySelector("#jobsList");
const connectionStatus = document.querySelector("#connectionStatus");
const runnerStatus = document.querySelector("#runnerStatus");
const jobTemplate = document.querySelector("#jobTemplate");

const STATUS_LABELS = {
  pending: "等待",
  running: "生成中",
  completed: "完成",
  failed: "失败",
  canceled: "取消",
};

const RESULT_LABELS = {
  pdf: "PDF",
  docx: "Word",
  archive: "中间件",
  log: "日志",
};

passwordInput.value = sessionStorage.getItem(TOKEN_KEY) || "";

bindFileLabels();
savePasswordButton.addEventListener("click", saveTokenAndRefresh);
refreshButton.addEventListener("click", loadDashboard);
form.addEventListener("submit", createJob);

if (passwordInput.value) {
  loadDashboard();
}

function bindFileLabels() {
  document.querySelectorAll("input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const label = document.querySelector(`[data-file-label="${input.id}"]`);
      const file = input.files?.[0];
      if (label) label.textContent = file ? file.name : "选择文件";
    });
  });
}

function token() {
  return passwordInput.value.trim();
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${token()}`,
    ...extra,
  };
}

function saveTokenAndRefresh() {
  sessionStorage.setItem(TOKEN_KEY, token());
  loadDashboard();
}

function setStatus(kind, title, detail = "") {
  const dot = connectionStatus.querySelector(".dot");
  dot.className = `dot ${kind}`;
  connectionStatus.querySelector("strong").textContent = title;
  connectionStatus.querySelector("span:last-child").textContent = detail;
}

async function requestJson(path, options = {}) {
  if (!token()) throw new Error("请先输入云端口令");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadDashboard() {
  try {
    setStatus("idle", "连接中", "正在读取任务队列和接单员状态");
    const [jobsData, runnerData] = await Promise.all([
      requestJson("/jobs"),
      requestJson("/runner/status"),
    ]);
    renderJobs(jobsData.jobs || []);
    renderRunnerStatus(runnerData.runner);
    setStatus("ok", "已连接", `${jobsData.jobs?.length || 0} 个任务`);
  } catch (error) {
    renderJobs([]);
    renderRunnerStatus(null, error.message || String(error));
    setStatus("bad", "连接失败", error.message || String(error));
  }
}

async function createJob(event) {
  event.preventDefault();
  try {
    submitButton.disabled = true;
    submitButton.textContent = "上传中";
    setStatus("idle", "上传中", "正在创建周报任务");

    const data = new FormData(form);
    await requestJson("/jobs", {
      method: "POST",
      body: data,
      headers: {},
    });

    form.reset();
    document.querySelectorAll("[data-file-label]").forEach((item) => {
      item.textContent = "选择文件";
    });
    await loadDashboard();
  } catch (error) {
    setStatus("bad", "提交失败", error.message || String(error));
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "提交生成";
  }
}

async function cancelJob(id) {
  if (!confirm("确定要取消这个周报任务吗？如果本地正在生成，会请求 Windows 接单员终止流程。")) return;
  try {
    setStatus("idle", "正在取消", `任务 ${id.slice(0, 8)}`);
    await requestJson(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    await loadDashboard();
  } catch (error) {
    setStatus("bad", "取消失败", error.message || String(error));
  }
}

function renderRunnerStatus(runner, error = "") {
  const dot = runnerStatus.querySelector(".runner-state .dot");
  const title = runnerStatus.querySelector(".runner-state strong");
  const detail = runnerStatus.querySelector(".runner-state span:last-child");
  if (!runner) {
    dot.className = "dot bad";
    title.textContent = "不可用";
    detail.textContent = error || "暂时无法读取接单员状态";
    return;
  }

  const online = Boolean(runner.online);
  dot.className = `dot ${online ? "ok" : "bad"}`;
  title.textContent = online ? statusText(runner.status) : "离线";
  const age = runner.ageSeconds == null ? "" : ` · ${runner.ageSeconds} 秒前`;
  const current = runner.currentJobId ? ` · 当前任务 ${runner.currentJobId.slice(0, 8)}` : "";
  detail.textContent = `${runner.message || "无状态信息"}${current}${age}`;
}

function renderJobs(jobs) {
  jobsList.innerHTML = "";
  if (!jobs.length) {
    jobsList.innerHTML = '<div class="empty">暂无任务</div>';
    return;
  }

  for (const job of jobs) {
    const node = jobTemplate.content.firstElementChild.cloneNode(true);
    const status = normalizeStatus(job.status);
    const pill = node.querySelector(".status-pill");
    pill.classList.add(status);
    pill.textContent = STATUS_LABELS[status] || status;
    node.querySelector(".job-title strong").textContent = `任务 ${job.id.slice(0, 8)}`;
    node.querySelector("p").textContent = job.message || job.error || formatTime(job.createdAt || job.created_at);
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    node.querySelector(".job-meta").textContent = [
      `${progress}%`,
      formatTime(job.createdAt || job.created_at),
      job.cancelRequested ? "已请求停止" : "",
    ].filter(Boolean).join(" · ");
    node.querySelector(".progress-line span").style.width = `${progress}%`;

    const actions = node.querySelector(".job-actions");
    if (["pending", "running"].includes(status)) {
      const cancelButton = document.createElement("button");
      cancelButton.className = "download-link danger-action";
      cancelButton.type = "button";
      cancelButton.textContent = job.cancelRequested ? "停止中" : "取消";
      cancelButton.disabled = Boolean(job.cancelRequested);
      cancelButton.addEventListener("click", () => cancelJob(job.id));
      actions.append(cancelButton);
    }
    for (const result of job.results || []) {
      const link = document.createElement("a");
      link.className = "download-link";
      link.href = `${API_BASE}/jobs/${encodeURIComponent(job.id)}/files/${encodeURIComponent(result.id || result.kind)}?token=${encodeURIComponent(token())}`;
      link.textContent = RESULT_LABELS[result.kind] || result.kind || "下载";
      link.target = "_blank";
      link.rel = "noreferrer";
      actions.append(link);
    }
    jobsList.append(node);
  }
}

function statusText(value) {
  const text = String(value || "").toLowerCase();
  const labels = {
    idle: "在线待命",
    online: "在线",
    running: "生成中",
    uploading: "上传结果",
    stopped: "已停止",
    offline: "离线",
  };
  return labels[text] || value || "在线";
}

function normalizeStatus(value) {
  const text = String(value || "pending").toLowerCase();
  return STATUS_LABELS[text] ? text : "pending";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

setInterval(() => {
  if (token()) loadDashboard();
}, 15000);

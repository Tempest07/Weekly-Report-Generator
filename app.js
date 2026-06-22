const TOKEN_KEY = "weekly-report-generator-token";
const API_BASE = "./api";

const form = document.querySelector("#jobForm");
const passwordInput = document.querySelector("#passwordInput");
const savePasswordButton = document.querySelector("#savePasswordButton");
const refreshButton = document.querySelector("#refreshButton");
const submitButton = document.querySelector("#submitButton");
const jobsList = document.querySelector("#jobsList");
const connectionStatus = document.querySelector("#connectionStatus");
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
refreshButton.addEventListener("click", loadJobs);
form.addEventListener("submit", createJob);

if (passwordInput.value) {
  loadJobs();
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
  loadJobs();
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

async function loadJobs() {
  try {
    setStatus("idle", "连接中", "正在读取任务队列");
    const data = await requestJson("/jobs");
    renderJobs(data.jobs || []);
    setStatus("ok", "已连接", `${data.jobs?.length || 0} 个任务`);
  } catch (error) {
    renderJobs([]);
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
    await loadJobs();
  } catch (error) {
    setStatus("bad", "提交失败", error.message || String(error));
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "提交生成";
  }
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
    node.querySelector(".progress-line span").style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;

    const actions = node.querySelector(".job-actions");
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
  if (token()) loadJobs();
}, 15000);

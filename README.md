# 信用债券处周报生成器

独立的信用债券处周报生成任务入口，计划挂在 Gateway：

```text
https://tempest07.com/weekly-report/
```

## 架构

- 手机网页：上传余额台账、委外周报 PPT、CB 增持台账、CB 减持台账，并填写 4 个表内 DV01。
- Pages Function：创建任务、查询状态、下载结果。
- D1：保存任务状态和元数据。
- R2：保存输入文件、结果文件、中间件压缩包和日志。
- Windows Runner：轮询任务，下载输入，调用本地周报脚本，上传结果。

## Cloudflare 绑定

Pages 项目建议名称：

```text
weekly-report-generator
```

绑定：

```text
D1 binding: DB
D1 database: weekly-report-generator

R2 binding: REPORT_BUCKET
R2 bucket: weekly-report-generator
```

Secrets：

```text
APP_PASSWORD = 手机网页口令
RUNNER_TOKEN = Windows Runner 专用口令
```

## API

用户侧使用 `APP_PASSWORD`：

```http
GET /api/jobs
POST /api/jobs
GET /api/jobs/:id
GET /api/jobs/:id/files/:fileId
```

Runner 使用 `RUNNER_TOKEN`：

```http
GET /api/runner/next
PATCH /api/runner/jobs/:id
POST /api/runner/jobs/:id/results
```

`POST /api/jobs` 使用 `multipart/form-data`：

```text
balanceFile
pptFile
cbAddFile
cbReduceFile
fvociCreditDv01
fvociAbsDv01
acCreditDv01
acAbsDv01
```

`POST /api/runner/jobs/:id/results` 使用 `multipart/form-data`：

```text
status = completed / failed
message
error
pdf
docx
archive
log
```

## 下一步

本项目先提供云端任务中心。Windows Runner 需要在本地周报项目中实现，按上面的 Runner API 领取任务、执行脚本、上传结果。

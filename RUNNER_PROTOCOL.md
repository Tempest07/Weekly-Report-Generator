# Runner Protocol

Windows Runner 是一段运行在本地 Windows 机器上的小程序。它主动轮询云端任务，然后调用现有周报脚本。

## Claim next job

```http
GET /api/runner/next
Authorization: Bearer RUNNER_TOKEN
```

无任务：

```json
{ "job": null }
```

有任务：

```json
{
  "job": {
    "id": "uuid",
    "status": "running",
    "dv01": {
      "fvociCreditDv01": 4386,
      "fvociAbsDv01": 95,
      "acCreditDv01": 6415,
      "acAbsDv01": 268
    },
    "inputDownloads": [
      { "id": "input-balance", "kind": "balance", "fileName": "余额台账260618.xlsx", "url": "/api/jobs/uuid/files/input-balance" }
    ]
  }
}
```

## Update progress

```http
PATCH /api/runner/jobs/:id
Authorization: Bearer RUNNER_TOKEN
Content-Type: application/json
```

```json
{
  "status": "running",
  "progress": 42,
  "message": "刷新 Excel/Wind 公式"
}
```

失败时：

```json
{
  "status": "failed",
  "progress": 95,
  "message": "生成失败",
  "error": "完整错误摘要"
}
```

## Upload results

```http
POST /api/runner/jobs/:id/results
Authorization: Bearer RUNNER_TOKEN
Content-Type: multipart/form-data
```

字段：

```text
status = completed / failed
message
error
pdf = 周报XXXXXX_AG.pdf
docx = 周报XXXXXX_AG.docx
archive = 中间文件.zip
log = weekly_report.log
```

上传成功后，手机网页会在任务卡片上显示下载按钮。

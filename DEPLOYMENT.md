# Deployment

## 1. GitHub / Pages

创建独立仓库，建议：

```text
Tempest07/Weekly-Report-Generator
```

Cloudflare Pages 项目：

```text
weekly-report-generator
```

构建设置：

```text
Framework preset: None
Build command: 留空
Build output directory: .
```

## 2. D1

创建数据库：

```text
weekly-report-generator
```

Pages 绑定：

```text
Variable name: DB
D1 database: weekly-report-generator
```

API 会在首次请求时自动创建 `weekly_report_jobs` 表。

## 3. R2

创建 bucket：

```text
weekly-report-generator
```

Pages 绑定：

```text
Variable name: REPORT_BUCKET
R2 bucket: weekly-report-generator
```

## 4. Secrets

Pages 项目添加 Secrets：

```text
APP_PASSWORD = 手机网页登录口令
RUNNER_TOKEN = Windows Runner 专用口令
```

`APP_PASSWORD` 给网页使用，`RUNNER_TOKEN` 只放在 Windows 机器上。

## 5. Gateway

`tempest07-home/gateway-worker.js` 已新增：

```js
{
  prefix: "/weekly-report",
  origin: "https://weekly-report-generator.pages.dev",
}
```

统一入口：

```text
https://tempest07.com/weekly-report/
```

## 6. Windows Runner 对接

Runner 只需要主动请求云端，不需要暴露 Windows 端口。

推荐循环：

1. `GET /api/runner/next`
2. 若返回任务，下载 `inputDownloads` 里的 4 个文件
3. 调用本地 `Invoke-WeeklyReportPipeline.ps1`
4. 周期性 `PATCH /api/runner/jobs/:id` 更新进度
5. 生成完成后 `POST /api/runner/jobs/:id/results` 上传结果

所有 Runner 请求 header：

```http
Authorization: Bearer RUNNER_TOKEN
```

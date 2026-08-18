---
name: pm-ai-agent
description: >-
  Connect to the local PM-AI task management API. Use when the user wants to
  fetch, claim, work on, or complete tasks managed by PM-AI. Read inbox,
  claim tasks, report progress, and mark complete via REST API.
metadata:
  surfaces:
    - ide
  environments:
    - local
---

# PM-AI Agent Skill

Connect to the local PM-AI project management system as an **executor agent**.

## Important Rules

- You are an **executor only**: claim, progress, complete, or release tasks
- **DO NOT** create tasks, publish drafts, cancel, approve reviews, or reopen tasks
- **DO NOT** directly edit files under `.pm-ai/tasks/` — use the API for status changes
- You **MAY** read task markdown files and edit business files in the workspace

## Discover the API

1. Read `%APPDATA%/pm-ai/config.json` for `baseUrl` and `token`
2. Fallback: `http://127.0.0.1:7432`
3. Verify with `GET /api/v1/health` (no auth required)

## Authentication

All API calls (except `/health`) require:

```
Authorization: Bearer <token from config.json>
X-PM-AI-Actor: agent
Content-Type: application/json
```

## Workflow

### 1. Check inbox

```http
GET /api/v1/inbox
```

Returns all `todo` tasks across projects.

### 2. Read task details

```http
GET /api/v1/tasks/{task_id}?project_id={project_id}
```

Response includes: title, goal, acceptance_criteria, constraints, workspace path, rejections, agent_notes.

### 3. Claim a task

```http
POST /api/v1/tasks/{task_id}/claim?project_id={project_id}
{"agent_name": "cursor", "expected_version": 1}
```

Returns `lease_token` and `expires_at`. Lease is 15 minutes; renew with heartbeat.

### 4. Report progress (optional)

```http
POST /api/v1/tasks/{task_id}/progress?project_id={project_id}
{"agent_name": "cursor", "lease_token": "...", "summary": "已完成 API 路由"}
```

### 5. Heartbeat (keep lease alive)

```http
POST /api/v1/tasks/{task_id}/heartbeat?project_id={project_id}
{"agent_name": "cursor", "lease_token": "..."}
```

### 6. Complete task

```http
POST /api/v1/tasks/{task_id}/complete?project_id={project_id}
{
  "agent_name": "cursor",
  "lease_token": "...",
  "result_note": "已完成登入頁響應式修復",
  "artifacts": ["src/pages/Login.tsx"]
}
```

Task moves to `done` with `human_reviewed=false` (awaiting human review).

### 7. Release (cannot finish)

```http
POST /api/v1/tasks/{task_id}/release?project_id={project_id}
{"agent_name": "cursor", "lease_token": "...", "reason": "缺少設計稿"}
```

Returns task to `todo`.

## Error Handling

- **409 Conflict**: version mismatch or task already claimed — re-read task and retry
- **403 Forbidden**: invalid lease or disallowed action
- **404 Not Found**: task or project doesn't exist

## Example PowerShell

```powershell
$config = Get-Content "$env:APPDATA\pm-ai\config.json" | ConvertFrom-Json
$headers = @{
  "Authorization" = "Bearer $($config.token)"
  "X-PM-AI-Actor" = "agent"
}
Invoke-RestMethod -Uri "$($config.baseUrl)/api/v1/inbox" -Headers $headers
```

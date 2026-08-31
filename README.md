# PM-AI

本機人機協作專案管理系統。人作為決策者，本機 AI Agent 作為執行者。

## 快速開始

需要 **Node.js 22.13 或更新**（22 LTS、24 都可以）。用 Node 内置 sqlite，安装时不需要 Visual Studio / Python。

```bash
node -v
npm install
npm run dev
```

服務啟動後會開啟瀏覽器：

- UI：http://127.0.0.1:7432
- API：http://127.0.0.1:7432/api/v1
- Token：`%APPDATA%/pm-ai/config.json`

### 局域網訪問（可選）

預設僅本機可訪問。若需同一 WiFi / 局域網內其他設備（手機、平板）訪問，在 `.env` 加入：

```bash
HOST=0.0.0.0
```

重啟後控制台會列出局域網 URL（例如 `http://192.168.x.x:7432`）。Windows 若無法連入，請在「Windows 防火牆」中允許 Node.js 或端口 7432。

> **安全提示**：LAN 模式下，同一網段內的設備可打開 UI 並自動取得 API Token。請只在可信網路環境使用。

## 開發

```bash
# 建置前端並啟動本機服務（建議）
npm run dev

# 前端 watch + 後端（兩邊同時熱重載）
npm run dev:watch

# 生產建置
npm run build
npm start
```

## 使用流程

1. 開啟 UI，建立專案並綁定本機資料夾
2. 建立任務（草稿），填寫標題和驗收標準
3. 點「交給 Agent」，任務進入待處理佇列
4. 在本機 Cursor 開啟該 workspace（已自動安裝 `.cursor/skills/pm-ai-agent/SKILL.md`），讓 Agent 認領並完成任務
5. 回到 UI 驗收或打回

## Agent 對接

詳見 [`skill/SKILL.md`](skill/SKILL.md)。新建專案時會自動複製到綁定 workspace 的 `.cursor/skills/pm-ai-agent/SKILL.md`。

Agent 可以：建立任務、認領待處理、寫進度、完成、釋放、評論。
Agent 不能：發布草稿、取消、驗收。

## 資料位置

| 資料 | 位置 |
|------|------|
| 任務檔案 | `<workspace>/.pm-ai/tasks/*.md` |
| 專案設定 | `<workspace>/.pm-ai/project.yml` |
| 活動日誌 | `<workspace>/.pm-ai/activity/*.jsonl` |
| 任務評論 | `<workspace>/.pm-ai/comments/{任務ID}.jsonl` |
| 需求文档 | `<workspace>/.pm-ai/requirements.md` |
| UI 設計稿 | `<workspace>/.pm-ai/designs/*.html` |
| 索引/租約 | `%APPDATA%/pm-ai/pm-ai.sqlite` |
| API 設定 | `%APPDATA%/pm-ai/config.json` |

## 規格

完整需求見 [`需求分析.md`](需求分析.md)。

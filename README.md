# PM-AI

本機人機協作專案管理系統。人作為決策者，本機 AI Agent 作為執行者。

## 快速開始

```bash
npm install
npm run dev
```

服務啟動後會開啟瀏覽器：

- UI：http://127.0.0.1:7432
- API：http://127.0.0.1:7432/api/v1
- Token：`%APPDATA%/pm-ai/config.json`

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
4. 在本機 Cursor 中使用 [`skill/SKILL.md`](skill/SKILL.md) 讓 Agent 認領並完成任務
5. 回到 UI 驗收或打回

## Agent 對接

詳見 [`skill/SKILL.md`](skill/SKILL.md)。

Agent 只能：認領待處理、寫進度、完成、釋放。
Agent 不能：建任務、發布、取消、驗收。

## 資料位置

| 資料 | 位置 |
|------|------|
| 任務檔案 | `<workspace>/.pm-ai/tasks/*.md` |
| 專案設定 | `<workspace>/.pm-ai/project.yml` |
| 活動日誌 | `<workspace>/.pm-ai/activity/*.jsonl` |
| 索引/租約 | `%APPDATA%/pm-ai/pm-ai.sqlite` |
| API 設定 | `%APPDATA%/pm-ai/config.json` |

## 規格

完整需求見 [`需求分析.md`](需求分析.md)。

# GitHub 與 Render 部署

Render 由使用者操作，本專案不會自動建立 Render 服務或變更計費方案。

## 1. GitHub

將程式上傳至指定儲存庫的 `main` 分支。只提交程式、文件及 `.env.example`，不得提交服務帳戶 JSON、`.env`、`data/`、`work/`。

GitHub Actions 會先執行測試；未設定 `COLLECT_API_BASE` 時只測試，不發布尚未連接後臺的網站。

## 2. Render Web Service

連接相同 GitHub 儲存庫，選擇 Node Web Service：

| 設定 | 值 |
|---|---|
| Branch | main |
| Root Directory | 留空 |
| Build Command | npm ci |
| Start Command | npm start |
| Health Check Path | /api/health |
| Instance 類型 | Free |

免費方案不需持久磁碟。服務啟動會核對 Google 資料夾、表頭及密碼，失敗則不開始接收上傳。

在 Render 的 Secret Files 新增：

- `google-service-account.json`：貼入服務帳戶 JSON 金鑰完整內容。
- `collect-config.json`：填入 `driveFolderId` 與 `spreadsheetId`。這兩個 ID 不提交到 GitHub。

設定環境變數：

| 名稱 | 值 |
|---|---|
| SESSION_SECRET | 至少32字元的隨機值，後續部署保持相同 |

其餘固定設定由程式管理。Render 的 `PORT`、`RENDER` 由平台提供，不必另設。

本機產生 SESSION_SECRET：

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. 發布 GitHub Pages

1. 儲存庫 Settings → Pages → Source 選 GitHub Actions。
2. Settings → Secrets and variables → Actions → Variables 新增 `COLLECT_API_BASE`，填入 Render HTTPS 網址，例如 `https://你的服務.onrender.com`。
3. Actions → Test and deploy frontend → Run workflow。
4. 工作流程只發布 `public/`，不公開後臺或金鑰。

## 4. 上線驗收

- 登入、選5個座號、輸入10字主題、上傳實際 iPad 照片與 MOV。
- 超過10字、超過100MB、非媒體檔案都應阻擋。
- 修改工作表2 A2 後，舊密碼不能登入、既有登入不能開始新上傳。
- 中斷網路後恢復，保持頁面開啟，按重試可續傳。
- 檢查同時上傳多份作品、每檔只有一筆紀錄。
- 上傳進行中重啟 Render，確認加密工作憑證與 Google 端進度可正常續傳。
- 用實際教室 Wi-Fi 及多台 iPad 驗證等待時間、影片格式與休眠影響。

## 參考

- Render Web Service：https://render.com/docs/web-services
- Render 免費服務：https://render.com/docs/free
- Google Drive 分塊上傳：https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Google Sheets RAW 寫入：https://developers.google.com/workspace/sheets/api/guides/values

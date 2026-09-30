# Collect.Silomo

供老師收取學生 iPad 照片／影片的網站。前台為原生 HTML、CSS、JavaScript，後臺採 Node.js 22，零第三方執行依賴。前台部署 GitHub Pages，API 由使用者操作 Render 部署。

## 本機啟動

在 PowerShell：

```powershell
Set-Location 'C:\Users\Lowe\Documents\Codex\Collect.Silomo'
npm.cmd start
```

開啟 http://localhost:3000 。目前本機 `.env` 已設定 Google 實際模式，登入密碼來自「工作表2」A2；實際上傳會寫入指定共用雲端硬碟及「工作表1」。請勿將 `.env` 或服務帳戶 JSON 上傳至 GitHub。

若要模擬測試，不寫入 Google：

```powershell
$env:MODE='mock'
$env:PORT='3001'
$env:DATA_DIR='./work/mock-data'
$env:ALLOWED_ORIGINS='http://localhost:3001,http://127.0.0.1:3001'
npm.cmd start
```

模擬網址 http://localhost:3001 ，密碼預設 `1234`。畫面會顯示測試提示。另開 PowerShell 即可回到 `.env` 中的正式模式設定。

## 規格

- 年級只有5年級；1～4班，記錄為501～504。
- 座號1～28號，每次1～5位，排序後補足兩位。
- 實驗主題必填，最多10個 Unicode 可見字元；說明選填（防止異常請求的上限為5000字元）。
- 單檔1～100,000,000 bytes，4MiB分塊。
- 支援 JPG、JPEG、PNG、GIF、WebP、HEIC、HEIF、MP4、MOV、M4V、WebM；副檔名白名單與檔案標頭檢查，不轉檔、不壓縮。
- 後臺以 Asia/Taipei 產生名稱，保留副檔名：`20260929_1520_501_01.03.17.22_光的折射.mov`。
- 同名不同次提交各自保留；同一上傳工作的重試不重複建立檔案。
- 每次登入及開始新上傳均即時核對試算表密碼，登入憑證1小時。密碼變更後須重新登入，已開始的上傳可在24小時工作憑證期限內完成。
- 憑證只在頁面記憶體中；重新整理、關頁後必須重新登入。斷線後保留頁面可重試續傳；不支援關頁後恢復原工作。

## Google 設定

- 共用雲端硬碟資料夾與試算表 ID 存在 Render 的 `collect-config.json` Secret File，不寫入原始碼。
- 工作表1 A1:E1：`時間、班級、座號、主題、說明`。
- 工作表2 A1：`密碼`；A2：目前密碼（純文字，保留前導零）。
- 只需服務帳戶可讀寫，學生不必有 Google 檔案權限。
- Google Drive API 與 Google Sheets API 需在服務帳戶所屬專案啟用。

## 紀錄可靠性與使用限制

Render 正式環境採無本機狀態設計：上傳工作以加密短效憑證交由同一個頁面保存，進度以 Google Drive 為準。試算表以原子批次同時寫入五欄資料與該列的隱藏識別資料，重試時先核對識別資料，避免重複紀錄。檔案與紀錄都完成才顯示成功。

請不要在收件期間排序、刪除、插入「工作表1」的列，或讓另一套收件程式同時寫入該表。查看排序可使用獨立報表／複本。列內容衝突時系統停止寫入並保留工作，不覆蓋既有資料。老師隨時修改「工作表2」密碼不受此限制。

Render 免費方案可使用，不需要持久磁碟。免費服務閒置後會休眠，第一次開啟可能需要等待啟動。檔案分塊直接轉送 Drive，不落地保存整個檔案。

上傳期間保持頁面開啟、iPad 不休眠。格式檢查屬基本標頭驗證，不是完整媒體解碼或病毒掃描。

## 驗證

```powershell
npm.cmd run check
npm.cmd test
node --env-file=.env server/probe.js
```

實際上傳驗收（會建立明確標記的測試檔案與一筆紀錄，之後將該檔移至垃圾桶並清除經核對的測試列）：

```powershell
node --env-file=.env test/live-google.mjs
```

詳細操作見 `docs/DEPLOYMENT.md`；驗收紀錄見 `docs/TEST-REPORT.md`。

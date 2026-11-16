<p align="center"><img src="build/icon.png" width="96" alt="AgentDesk"></p>

# AgentDesk

[English](README.md) ｜ 繁體中文 ｜ [简体中文](README.zh-CN.md)

一個桌面對話介面，把好幾個 CLI 程式 Agent 放在同一個視窗裡：主要對話走 **Claude Code**，並可加入 **Codex CLI**、**Cursor Agent CLI**，或任何你自己設定的 CLI（例如 Antigravity CLI）。Claude 可以把工作委派給其他 Agent，畫面即時顯示它們在做什麼。

> 目前只支援 Windows。AgentDesk 不含任何 AI 模型，只是呼叫你電腦上已安裝、已登入的 CLI，用量與費用都算在各家帳號上。

## 需求
- Windows 10／11
- [Node.js](https://nodejs.org/) 18 以上
- [Claude Code](https://code.claude.com/docs/en/setup)（必要）；Codex CLI、Cursor Agent CLI 可選。沒裝也沒關係，設定頁可以一鍵安裝與登入。

## 安裝與啟動
AgentDesk 不提供 exe：沒有程式碼簽章的 exe 常被防毒軟體擋下，所以直接從原始碼執行。
1. 取得原始碼：到 [Releases](https://github.com/satan0124/AgentDesk/releases/latest) 下載「Source code (zip)」並解壓縮，或用 git：
   ```bash
   git clone https://github.com/satan0124/AgentDesk.git
   ```
2. 雙擊資料夾裡的 `AgentDesk.bat`。第一次會先執行 `npm install` 下載相依套件（需要網路，約一兩分鐘），之後雙擊就直接開啟。

想用命令列的話，在資料夾裡執行 `npm install`，再執行 `npm start`。

第一次開啟時，如果找不到 Claude Code 或還沒登入，會直接帶到設定頁，按「安裝」「登入」即可。

## 功能
- **對話**：左側對話記錄可搜尋，可切換依日期或依專案（工作資料夾）分組，Ctrl+N 開新對話；對話按右鍵可釘選、重新命名、封存、刪除。每個對話有自己的工作資料夾，輸入框草稿也各自保存。
- **對話模式與工作模式**：每個對話各自記一種模式，用左側欄右上角（「新對話」右邊）的 💬／🛠 切換目前開著的對話，回合執行中不能換。新對話預設是對話模式，Agent 只能讀不能改：Claude 用 `--permission-mode default`、Codex 用唯讀 sandbox、Cursor 用 `--mode ask`；自訂 Agent 沒有共通的唯讀旗標，只在 prompt 裡交代。Agent 需要改檔時會先說明要改什麼，訊息下方出現「切到工作模式並繼續」，按了才由同一個 Agent 接著做。Cursor 是例外：它的 session 用唯讀跑過就回不到可寫，所以 AgentDesk 會替它重開 session，先前的對話照附帶上下文的做法帶過去。工作模式照設定頁的權限。加入這個功能之前的舊對話也是對話模式，要讓 Agent 改檔得自己切過去。
- **工作與進程檔**：切到工作模式時可以取一個工作名，AgentDesk 會在工作資料夾建立 `docs/進程/<工作名>.md`。這份進程檔是交接檔，記任務清單、進度、決策與驗證。AgentDesk 會交代 Agent：先列任務、等你核准再動手，有進展的那一輪回寫進程檔。新對話可以按輸入框上方的「接續工作」，選現成的進程檔接著做；右欄的「工作現況」顯示續傳指引與任務清單。任務清單多完成一項、而且這個對話最大的 session 到 50,000 tokens 以上時，輸入框上方會提示可以重開 session，按「重開 session」就清掉這個對話所有 Agent 的 session；狀態都在進程檔裡，重開不會丟掉進度。有進程檔的對話，附帶上下文改用精簡上限、只附最近 6 則，背景讓 Agent 去讀進程檔。只是改個小地方、不想建檔，選「不建進程檔」。
- **多個 Agent**：預設只有 Claude。Codex、Cursor 和自訂 Agent 一樣，在設定最下方的「新增其他 CLI Agent」選好後按「＋ 新增 Agent」；輸入框下方切換對象（Alt+1～9）。
- **每個對話各自的模型**：右欄 Agent 卡片上的模型名稱可以點，選這個對話要用的模型與強度，其他對話照設定裡的預設。Claude 的清單跟 Claude 桌面程式一樣，常用四個，其餘在「更多模型」。
- **委派**：Claude 透過內建的 MCP 工具（`ask_<agent>`）把工作交給其他 Agent，委派卡片即時顯示對方的工具步驟與回覆。AgentDesk 會請被委派的 Agent 在回覆最後用三行收尾：做了什麼、改了哪些檔、沒做完或要注意的。回覆超過上限時，完整內容存成逐字稿資料夾裡的 `delegate-<序號>.md`，交給 Claude 的是截短的內容加上這個檔的路徑，它需要時可以自己去讀。
- **回覆裡的動作**：Agent 連續做兩個以上的動作（讀檔、跑指令等）時，回覆裡收成一行，顯示個數、失敗幾個與最新的一個動作，點了才展開。收合只影響畫面，動作照樣有做，花的額度一樣。
- **訊息的複製與分支**：滑鼠移到訊息上，下方會顯示時間與「複製」；Agent 的訊息多一顆「從這裡分支」，在訊息上按右鍵也有同樣的功能。分支會開一個新對話，帶著到那一則為止的內容（模式、工作、資料夾照舊），原本的對話不動。各 Agent 的 session 不會帶過去，新對話第一輪照附帶上下文的做法帶入先前內容。
- **省 token 規則**：設定頁每個 Agent 都能勾選附上「極度節省 token」規則。勾了之後，AgentDesk 在每個 session 開頭把規則附給它：工作過程不寫旁白、只在收尾回覆結果、不重述，壞消息與未驗證的事照常講。新增 CLI 時會問要不要加。規則只在 AgentDesk 裡有效，不會寫進各 CLI 自己的規則檔。
- **上下文接續**：每個對話記住各 Agent 的 session；直接跟某個 Agent 講話時，它沒看過的其他 Agent 往來會自動附在前面。附上的內容會算進該 Agent 的用量，所以有上限：設定裡的「附帶上下文」可選精簡（約 6,000 字）、標準（16,000 字，預設）或完整（40,000 字）。超過上限時保留最新的往來和對話開頭的需求；委派結果交回 Claude 時也照這個上限截短。每則回覆上會標出這一輪附了多少字。
- **壓縮**：對話很長時按頂列的 🗜。AgentDesk 請輸入框下方目前選的 Agent 替對話寫一份索引（會花它一輪額度），每行是 `#起–#迄｜主題｜結論｜相關檔案`。這個 Agent 在這個對話的 session 不到 100,000 tokens 時，就在原本的 session 裡寫；session 更大或沒有 session 時，改開乾淨的 session 讀逐字稿來寫，比較省。寫完由 AgentDesk 核對：那幾段沒出現過的相關檔案拿掉，那幾段改過的檔從動作記錄補上，Agent 漏掉的段落補一筆佔位。沒有進程檔的對話另外請它寫兩行「現況」「下一步」，每次壓縮整個換掉，之後接在索引後面。輸入框上方會有一行說明寫了幾筆、改了什麼。之後清掉各 Agent 的 session。之後 Agent 重新開 session 時拿到的是索引加最近幾則原文，不再是整段對話；要細節就照編號去讀逐字稿。逐字稿是 AgentDesk 每一輪結束後自己寫的 Markdown，每則訊息一段、有編號，不花額度。訊息之間有一條線標出索引涵蓋到哪，點了開啟索引檔。再壓一次只替新的段落補索引。
- **附件**：「＋」選單新增檔案／相片（Ctrl+U）或資料夾；也能 Ctrl+V 貼上截圖、拖曳檔案進視窗。
- **圖片**：回覆中的圖片縮到欄寬，點擊放大預覽（滾輪縮放、拖曳平移、←/→ 換張、Esc 關閉）。
- **右欄 Agent 工作狀況**：只看目前這個對話：每個 Agent 是閒置還是工作中、正在做什麼、經過多久，以及這個對話最近完成的工作。卡片上也顯示剩餘額度（5 小時、每週），Claude 每次回覆後更新，Codex 每 5 分鐘讀一次；Cursor CLI 沒有提供額度資訊。卡片上還有這個 Agent 在這個對話的 session 大小，也就是之後每一輪至少要重送多少 tokens（Claude 是準的，Codex、Cursor 是估的）。按「重開」只清這一個 Agent 的 session。超過 100,000 會提醒，旁邊多一顆「壓縮」：和頂列的 🗜 是同一件事，由這張卡片的 Agent 寫索引。
- **連接 CLI**：設定頁偵測每個 CLI 是否安裝、版本、登入帳號；可安裝、登入、指定路徑。
- **自訂 Agent**：設定頁最下方「新增其他 CLI Agent」，範本有 Antigravity CLI（`agy`）、Claude 相容 stream-json、一般 CLI（純文字）。可設指令、參數、prompt 傳入方式、輸出格式、模型、接續 session 旗標、給 Claude 的說明等。
- **語言**：介面有繁體中文、簡體中文與英文。預設跟隨系統：繁體中文系統用繁中、簡體中文系統用簡中，其他一律英文；可在設定切換。

## 權限提醒
對話模式下 Agent 不能改檔，也不能執行會改動檔案的指令。工作模式下 Agent 會在對話的工作資料夾裡讀寫檔案、執行指令，預設權限：Claude「自動接受改檔」、Codex「可寫工作資料夾」、Cursor「自動執行指令（--force）」，可在設定調整。

對話模式有兩種情況擋不住：你自己在 Claude Code 設定裡允許的規則（`permissions.allow`）照樣放行；自訂 Agent 只收到文字說明，它不照做也攔不住。請只在你信任的資料夾使用。

## 資料位置
`%APPDATA%\AgentDesk\`：`settings.json`、`conversations\*.json`、`attachments\`、`limits.json`（最近讀到的額度）、`transcripts\<對話 id>\`（逐字稿 `transcript.md` 與壓縮後的索引 `index.md`）。全部存在本機，不會上傳到任何地方（Agent 本身呼叫的雲端服務除外）。

進程檔不在這裡，在各個工作資料夾的 `docs/進程/` 底下。

## 程式結構
- `src/main.js`：主程序、對話儲存、委派用的本機 HTTP。
- `src/agents.js`：各 CLI 的指令組成與串流解析（Claude、Codex、Cursor、自訂 Agent）。
- `src/context.js`：要附給 Agent 的先前對話與上限。
- `src/mode.js`：對話／工作模式的判定，以及給 Agent 的模式說明。
- `src/work.js`：工作名、進程檔的範本與讀取。
- `src/transcript.js`：把對話寫成有段落編號的逐字稿。
- `src/compress.js`：壓縮用的索引（給 Agent 的話、讀回索引、之後每一輪附的內容）。
- `src/cli.js`：找 CLI 實際執行檔（避開 Windows `.cmd` shim）。
- `src/connect.js`：設定頁的 CLI 偵測、安裝、登入。
- `src/proc.js`、`src/spawner.js`：在 worker thread 建立子行程，避免主程序卡住。
- `src/mcp-bridge.js`：給 Claude 用的 stdio MCP server。
- `src/shared/i18n.js`：介面語言對照。
- `src/renderer/`：介面。
- `tools/make-icon.js`：從 `build/icon.svg` 產生 icon。

## 使用 Antigravity
Google 已用 Antigravity CLI（`agy`）取代 Gemini CLI，Antigravity 桌面版本身不含這個 CLI，要另外裝：
1. 設定 →「新增其他 CLI Agent」選「Antigravity CLI（agy）」→「＋ 新增 Agent」→ 按「安裝」（執行 `irm https://antigravity.google/cli/install.ps1 | iex`）。
2. 按「登入」：會開一個互動模式的 `agy`，在裡面完成登入精靈後關掉。
3. 儲存。AgentDesk 用 stdin 的 stream-json 傳 prompt 給 `agy`，並用 `--conversation` 接續對話。

## 驗證
```bash
node tools/validate.js          # 靜態檢查、單元測試、假 Agent 整合（約 3 秒，不花額度）
node tools/validate.js --e2e    # 再加 Electron 畫面測試（假 Agent）
node tools/validate.js --live   # 再加真的 Claude／Codex／Cursor 兩輪接續（會用額度）
```
假 Agent 放在 `tools/validate/fixtures/`，結果也會寫到 `.claude/validate-last.md`。

## 授權
[MIT](LICENSE)

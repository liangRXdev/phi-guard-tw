# Codex 審查原始輸出

- 審查日期：2026-10-09
- Codex：MCP `codex`（預設模型），read-only sandbox，thread `01a11fd2-7392-7db3-aad2-988bcfd99b17`
- 範圍：整個 repo（hooks/、tests/、.claude-plugin/、README.md、.ai-review/plan.md）
- Commit：無（尚未首次 commit，審的是 working tree）

---

以下為唯讀靜態覆審結果；未修改檔案，也未執行可能建立暫存檔或 transcript 的測試命令。

型別契約核對結論：

- `tool.call` 未設 matcher 會涵蓋 built-in 與 MCP；`ToolCallEnvelope` 明確包含 `McpToolCallInput`。
- `prompt.submit` 可用 `next({ ...e, text, context })` 改寫 context。
- `.catch` 中的 `next` 是 replay-safe；`next.called ? next(e) : deny/drop` 符合契約，不會再次執行下游。
- engine 產生的 `session.append` 列不能直接 deny，因此 catch 用佔位內容呼叫 `next(...)` 是正確方向；問題在佔位實作沒有清除所有 block。

## 1. Code review

### 遮罩漏網與 fail-closed

1. `hooks/mask.ts:263-289 / High / maskBlocks 只處理頂層 text 與 tool_result.content；image、document、resource、未知 block 及其巢狀文字全部原樣放行。型別契約指出 conversation 可包含 image/document，且 media block 可以被移除。因此文字附件、MCP embedded resource 或媒體附件中的 PHI 可能直接進模型 context，與 S4「附件也遮罩」不符。 / 對模型可讀的文字型 resource/document 遞迴掃描；無法檢查的二進位 media 採 fail-closed 移除。若須維持 S9 對非敏感 Read 媒體的放行，應由 tool.call 記錄已核准的 tool_use_id，只有該次結果可保留媒體。`

2. `hooks/mask.ts:298-306 / High / session.append 掃描失敗後，placeholderBlocks 只替換 text、tool_result 與非物件元素，其他 document、image、resource、未知 block 仍原樣保留。若同一列因另一個 malformed block 觸發 catch，敏感 block 仍會進模型，fail-closed 並未在整列成立。 / catch 路徑應產生只含單一純文字佔位 block 的新 content；不要逐 block 保留任何原始資料。這也比嘗試保留結構更符合「整列移除」註解。`

3. `hooks/mask.ts:82,137,208 / High / 所有病歷號與健保卡號值都被硬限制為最多 20 個英數字元；S1/S3 沒有此上限。合法但超過 20 字元的有標籤識別值完全不遮，屬直接漏網。 / 改用無任意 20 字元上限的線性英數掃描，或在規格明訂足以涵蓋實際資料的上限；若超長值無法可靠處理，應 fail-closed，而不是放行。`

4. `hooks/mask.ts:105-161 / High / 宣稱支援 CSV，但實作只是用逗號切割，不理解 quoted field、escaped quote 或欄位內逗號。常見 CSV 如備註欄含逗號時，欄數改變會讓 active header 失效，該列病歷號原文漏網。 / 實作有限狀態 CSV tokenizer，正確處理雙引號、雙引號跳脫與欄內換行；保留原始 offset 後再套 span。`

5. `hooks/mask.ts:194-203 / High / JSON 走訪在 depth &gt; 32 時直接停止。深層物件中的 Sheets 二維陣列不會產生 spans，與 S4 全域資料及 S10 全量掃描的宣稱不符。 / 改為 iterative stack 走訪，避免 call-stack 問題且不設靜默略過深度；若需要資源上限，超限必須拋錯讓 session.append 進入佔位 fail-closed。`

6. `hooks/mask.ts:187-190,207-213 / Low / JSON grid 沒有套用「值至少含一個數字」條件；病歷號欄中的純英文字串也會被遮，弱於 S3 的驗證性質。 / 將 tableSpans 的數字檢查抽成共用 predicate，JSON 收集值前也套用。`

7. `hooks/mask.ts:175-215 / Low / JSON grid 先收集值，再於整段 JSON 搜尋所有同值 token；相同字串即使出現在非敏感欄、property key 或其他物件，也會一起被遮。 / 解析 JSON 時記錄實際目標節點，使用具 offset 的 tokenizer 定位該節點；若維持文字搜尋，至少限制 occurrence 數及所在 grid row/column。`

8. `hooks/mask.ts:77 / Low / TWID_RE 的尾端只排除數字，沒有排除字母；合法 ID 後接英文字母時，前十碼仍會被當成獨立身分證遮掉。現有「嵌在更長英數串」測試只測數字後綴，因此沒有抓到。 / 尾界線改成排除所有 ASCII 英數，與開頭界線對稱。`

### 工具守門與正常工作流

9. `hooks/register.ts:15-18,70-78 / Medium / 讀取類豁免靠固定工具名稱清單；所有 MCP 工具即使 server 宣告為 read-only，仍會被當成可能寫入。Google Sheets 等唯讀 MCP 查詢若參數含遮罩 token 會被誤擋，造成正常開發流程中斷。 / 維護明確的 MCP 唯讀 allowlist，或使用 MCP tool annotation/schema 中可在執行前取得的 read-only 宣告；未知工具維持預設阻擋。不能依賴 ToolCallResult.isReadOnly，因為那要工具執行後才知道。`

10. `hooks/register.ts:62-67 / Medium / 敏感目錄判斷只看未正規化的字串 path。含 .. 的路徑會誤擋已離開敏感目錄的檔案，symlink/junction 則可能指向敏感目錄而未被識別。前者造成過度阻擋，後者使 S9 守門可繞過。 / 使用契約提供的 $.fs.stat(path, { resolve: true }) 取得 realPath；無法 resolve 時依 fail-closed 擋下。檢查解析後的完整目錄 segment。`

11. `hooks/register.ts:37-39 / Low / sessionMasked 在 next 成功儲存前就累加並更新狀態列；若下游拒絕、驗證失敗或 catch 改成佔位列，顯示數量會大於實際儲存的遮罩數。 / await next(...) 成功後再累加；catch 進佔位時不要計入原遮罩數，或另計為失敗列。`

### 效能與 ReDoS

12. `hooks/mask.ts:175-215 / Medium / jsonGridSpans 對每個 distinct value 建立一次 regex，並重新掃描整份輸入，複雜度約 O(值數 × 輸入長度)。大型且值幾乎都不同的 Sheets JSON 可遠慢於 5 MB log 測試，觸發 hook budget 並使整列被 fail-closed 移除。 / 單次 tokenize JSON 並直接產生目標 value 的 offsets，將處理降為 O(n)。`

13. `hooks/mask.ts:77-92,314-317 / Low / 未發現典型 nested-quantifier 或 backtracking 型 ReDoS；動態 JSON regex 的值也先限制為英數字。主要效能風險是上述 O(V×N)，不是 regex ReDoS。 / 保留 regex 的線性結構，補 adversarial benchmark。`

### Hook 契約

14. `hooks/register.ts:40-42 / Low / session.append catch 呼叫 next 改寫佔位列符合契約；engine 自己的 append 不能以 deny 拒絕。真正缺陷是 placeholderBlocks 沒有清空全部原始 block，而不是 catch 必須改成 deny。 / 保留 next(...)，但令 content 成為單一安全佔位 block。`

15. `hooks/register.ts:46-55 / Low / prompt.submit 的 text/context 改寫及 next.called catch 形式符合型別契約；未發現 API 用法錯誤。 / 補 context 與 catch 的 engine-level 測試即可。`

16. `hooks/register.ts:58-80 / Low / 無 matcher 的 tool.call 確實涵蓋 MCP；next.called catch 也符合 replay-safe 契約。 / 不需為涵蓋 MCP 另加 matcher，但應修正唯讀 MCP 的分類。`

### 重複實作

17. `hooks/mask.ts:17-19；hooks/register.ts:49-53 / Low / Counts 合併規則一處使用 addCounts，另一處重新逐欄相加。新增 Kind 或修改計數規則時，prompt toast 可能漏算或產生型別漂移。 / register.ts 的 reduce 直接使用 addCounts，並以 emptyCounts 作 initial value。`

18. `hooks/mask.ts:268-273；hooks/mask.ts:277-282 / Low / text block 與字串型 tool_result 各自重複 maskText、totalOf、addCounts、changed 更新流程。未來修正其中一條分支時可能只更新一端，造成不同 block 類型行為漂移。 / 抽出 maskStringField(block, field) 或 applyMaskedText 回傳更新後 block，兩種 block 共用。`

## 2. Test gap analysis

1. `tests/mask.test.ts:83-106 / High / 表格測試沒有任何真正 CSV quoting 案例，因此逗號位於 quoted field 時的漏遮完全未覆蓋。 / 加入 quoted comma、escaped quote、quoted header、CRLF、quoted multiline field。`

2. `tests/mask.test.ts:45-81 / High / 沒有測試超過 20 字元的有標籤值，未揭露實作額外縮限 S1。 / 加入 20、21、極長值邊界；21 碼以上仍應遮罩或明確觸發 fail-closed。`

3. `tests/mask.test.ts:108-130；tests/hooks.test.ts:42-61 / High / content block 測試反而明確要求 image 原樣保留；失敗測試只證明 tool_result 被整體替換，沒有測頂層 document/resource/unknown block 是否仍洩漏。 / 加入 text document、embedded resource、頂層 media 與 malformed sibling 的組合，斷言 catch 後整列不含任何原始 payload。`

4. `tests/hooks.test.ts:63-71 / High / prompt.submit 只驗 text；未驗 context 遮罩、toast 類型/數量、maskText 先於模型進入點，也未觸發 prompt catch 的 drop。 / 增加由上游 hook 注入 context 的測試、toast mock，以及令掃描函式或輸入 shape 失敗的 catch 測試。`

5. `tests/hooks.test.ts:73-137 / Medium / 沒有 MCP tool.call 測試，無法證明未設 matcher 的實際涵蓋，也未覆蓋唯讀 MCP 誤擋、write MCP 應擋及 tool.call catch。 / 建立合成 read-only/write MCP tool，分別驗證豁免、拒絕與 catch fail-closed。`

6. `tests/hooks.test.ts:117-127 / Medium / S9 只測 PNG；沒有 PDF、其他副檔名、大小寫副檔名、敏感 segment 大小寫、..、symlink/junction 或 toast。 / 補齊路徑矩陣並驗證 realPath。`

7. `tests/mask.test.ts:39-42 / Low / 英數邊界只測前綴字母及後綴數字，未測後綴字母，因而放過 TWID_RE 非對稱邊界。 / 加入合法 ID 後接 A–Z/a–z 的案例。`

8. `tests/mask.test.ts:94-100 / Low / JSON 測試只驗敏感值消失，沒有驗證非敏感欄同值、property key、純字母值與 count kind，屬較弱性質。 / 斷言精確完整輸出、counts，以及非目標 occurrence 保持不變。`

9. `tests/mask.test.ts:148-157 / Medium / 5 MB 效能測試是重複 log，沒有進入 JSON 的 O(V×N) 路徑，也沒有大量 unique ID。 / 加入大型 unique-value Sheets JSON benchmark及深層 JSON案例。`

10. `tests/hooks.test.ts:26-40 / Medium / 「子代理」測試只是手動填 agentId，沒有真的 spawn 子代理並驗證其工具輸出經過同一 hook。這只能證明欄位存在時的分支，不能證明實際子代理資料流。 / 使用 engine 測試環境建立真實子代理或 Agent tool 流程，於子代理執行 Read/MCP 後攔截 append。`

11. `tests/hooks.test.ts:42-61 / Medium / 唯一 failure 測試使用型別系統不會正常產生的 null block；prompt/tool catch 與真實 budget、misreturn、下游拒絕均未驗。 / 使用測試框架提供的 throw/misreturn/downstream failure 注入，分別驗證三個 catch。`

## 3. Dependency audit

`.claude-plugin/plugin.json:1-6 / Low / Repo 沒有 package.json、lockfile、node_modules 或第三方 runtime dependency；只有 host 提供的 claude-code 型別/API 與專案內相對 import。沒有可做的 npm CVE 稽核。 / 維持零依賴；若日後加入 CSV parser，需同步加入可重現鎖檔與套件來源稽核。`

`README.md:41-44 / Low / 文件稱 31 個測試，但目前可見 32 個 test block（mask 22、hooks 10）。 / 更新數量或避免寫死測試數。`

## 4. 規格符合度稽核

- `S1 + hooks/mask.ts:82,137,208 / High / 規格沒有 20 字元上限，但三條識別值路徑均限制 1–20；超長有標籤值未做到。CSV 也未真正遵循 CSV quoting。 / 移除未規格化上限並實作 CSV tokenizer。`

- `S2 + hooks/mask.ts:1-3 / 無缺失 / 實作未處理姓名、地址、電話、帶分隔符 ID、base64/URL，與明列取捨相符。 / 不建議擴大成遮所有長數字，該作法會與專案前提衝突。`

- `S3 + hooks/mask.ts:187-190 / Low / JSON grid 未驗證至少一個數字，實際只驗了較弱的「string 或 number」性質。 / 使用共用 value validator。`

- `S4 + hooks/mask.ts:263-289 / High / 規格宣稱附件及所有寫入對話資料都處理，但 document/resource/media 與未知 block 從未掃描或移除；只走訪了特定 content 形狀。 / 遞迴處理可讀文字；不透明內容採前述 tool_use_id 核准或移除策略。`

- `S5 + hooks/register.ts:46-55 / 無實作缺失 / text 與已存在的 context 都會改寫，toast 不含原值。惟測試未證明 context 與 toast。 / 補測試。`

- `S6 + hooks/mask.ts:298-306；hooks/register.ts:40-42 / High / 規格宣稱整列換成佔位文字，但實際 catch 仍保留未知與 media block；宣稱的 fail-closed 性質比實作強。 / catch 一律用單一佔位 block 取代整列 content。`

- `S7 + hooks/register.ts:15-18,70-78 / Medium / 規格說讀取類工具豁免，但實作依名稱硬編碼，唯讀 MCP 從未被辨識為讀取類，因此規格做弱且會過度阻擋。 / 加入可信 read-only metadata 或明確 allowlist；未知 MCP 預設仍擋。`

- `S8 + hooks/mask.ts:32-41,77-92 / 無主要缺失 / 全形逐字轉半形且比對使用 i flag；索引維持 1:1。 / 補更多全形標籤與 separator 測試即可。`

- `S9 + hooks/register.ts:62-68 / Medium / 字面 path segment 與副檔名規則有實作，但未解析 realPath，symlink/junction 可讓實際敏感位置與字面路徑不一致；測試也只涵蓋 PNG。 / 以 $.fs.stat(resolve) 檢查實際路徑，失敗時擋下。`

- `S10 + hooks/mask.ts:194-203,207-215 / High / 沒有輸入大小上限，但 JSON 深度 32 是另一個靜默跳過上限；且 unique-value JSON 為 O(V×N)，可能超時後整列被移除。 / iterative 單次 tokenizer，深度或資源超限時明確 fail-closed。`

- `S11 + tests/hooks.test.ts:26-40；tests/mask.test.ts:148-157；repo 無 fixture/tsconfig / Medium / 有單元測試及 5 MB log 計時，但沒有合成 fixture 檔、真實子代理流程；5 MB 測試未涵蓋最慢 JSON 路徑。Repo 也沒有保存 validate/tsc 成功證據，且無 tsconfig 可獨立重現 tsc 宣稱。 / 加入 fixture、真實子代理整合測試、JSON benchmark，以及 CI/驗收紀錄執行 plugin validate、plugin test 和適用的型別檢查。`

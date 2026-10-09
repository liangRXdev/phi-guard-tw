# Codex 審查覆核判定（2026-10-09）

依據：逐項回讀 `hooks/mask.ts`、`hooks/register.ts`、`tests/*.test.ts`，以及型別檔、reference.md 中 `session.append` 的改寫規則。

**影響 #1、#2 判定的契約原文**（reference.md「session.append」節）：hook 可以改寫 text block，也可以改寫 tool_result 的 `content`；image／document block **只能移除或搬移，不能修改**；engine 會把 thinking、tool_use、**所有它不認得的 block** 原封放回原位，**每個 tool_result 的 id 和整組 id 也會被放回**。

## Code review

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| 1 | maskBlocks 不處理 document／resource／未知 block | High | 部分接受 | 屬實：`mask.ts:263-289` 只處理 text 和 tool_result。但修法要受契約限制：document **不能改寫**，只能移除；未知 block（如 MCP resource）會被 engine **放回原位，hook 拿不掉**。正確做法：文字型 document 先掃描，命中就整塊移除並補一段說明文字；未知 block 寫進 README 限制，不宣稱涵蓋。tool_use_id 核准機制過度設計，不採用。 |
| 2 | placeholderBlocks 保留其他 block | High | 部分接受 | 屬實：`mask.ts:298-306` 原樣保留 image、document 和未知 block。**但 Codex 的修法（整列換成單一 text block）反而危險**：tool_result 的 id 組是釘住的，engine 會把 tool_result 放回去，放回的內容可能是原文。正確做法：tool_result 保留結構，content 換成佔位文字；text 換成佔位文字；image、document 移除；未知 block 無法處理，列為限制。 |
| 3 | 標籤值限 20 字元，超過就不遮 | High | 部分接受 | 屬實（`mask.ts:82,137,208`），而且 `(?![A-Za-z0-9*])` 讓超過 20 碼的值**整個不遮**。實際病歷號和健保卡號（12 碼）都遠短於 20，嚴重度降為 Low。上限改成 64 即可。 |
| 4 | CSV 不認得引號 | High | 接受 | 屬實：`splitWithOffsets`（`mask.ts:105`）只按分隔符切開。備註欄含逗號時欄數會變，`mask.ts:131` 判定欄數不符後就停止沿用表頭，**之後的病歷號全部漏遮**。CSV 匯出是 PHI 很可能出現的地方，維持 High。 |
| 5 | JSON 走訪超過 32 層就停 | High | 部分接受 | 屬實（`mask.ts:195`），但 Sheets 的資料只有 2 到 3 層，嚴重度降為 Low。改成 iterative 走訪、不設深度上限，零成本。 |
| 6 | JSON 表格沒檢查值要含數字 | Low | 接受 | `mask.ts:190` 屬實。只會多遮，但和 S3 不一致；改用共用的判斷函式。 |
| 7 | JSON 同值全域遮罩 | Low | 拒絕 | 屬實，但結果只是多遮。依威脅模型，多遮的代價低。要精準定位得自己寫 JSON tokenizer，複雜度不值得。 |
| 8 | 身分證 regex 尾端不排除字母 | Low | 拒絕 | `mask.ts:77` 的不對稱是沿用 `wiki_lint.py` 的刻意做法：ID 後面接字母時照樣遮，**偏向多遮**。照 Codex 改成對稱，反而會讓 `A123456789X` 這類黏字的情況漏遮。 |
| 9 | 唯讀 MCP 被當成寫入 | Medium | 部分接受 | 屬實（`register.ts:15-18`）。不過唯讀 MCP 的參數會含遮罩字樣，代表在用遮罩值查詢，這本身就查不到東西，擋下的實際損失很小，嚴重度降為 Low。加上 Sheets 唯讀工具（`get_values`、`get_spreadsheet`）的豁免清單即可。 |
| 10 | 路徑未正規化，symlink 可繞過 | Medium | 接受 | 屬實（`register.ts:62-67`）。reference.md 確認有 `$.fs.stat(path, { resolve: true })` 可取得 `realPath`。改成檢查原路徑和 realPath 兩者；resolve 失敗時擋下，維持 fail-closed。 |
| 11 | 計數在 next 之前累加 | Low | 接受 | `register.ts:37` 屬實，只影響顯示。改成 await 之後再累加。 |
| 12 | jsonGridSpans 是 O(值數 × 長度) | Medium | 接受 | 屬實（`mask.ts:207-215`）：每個不同的值都重新掃描整份輸入一次。大型 Sheets 會逾時，逾時後整列被換成佔位文字，等於資料遺失。改成單次掃描英數 token、再查 Set，變成 O(n)。 |
| 13 | 沒有 ReDoS | Low | 拒絕（不需處理） | 這是確認，不是缺陷。 |
| 14 | session.append 的 catch 契約 | Low | 拒絕（不需處理） | 這是確認；真正的問題已併入 #2。 |
| 15 | prompt.submit 契約 | Low | 拒絕（不需處理） | 這是確認。 |
| 16 | tool.call 不設 matcher 也涵蓋 MCP | Low | 拒絕（不需處理） | 這是確認，正好消除需求摘要裡的假設 1。 |
| 17 | 計數合併寫了兩遍 | Low | 接受 | `register.ts:52` 自己重寫逐欄相加，`mask.ts` 已經有 `addCounts`。改用 `addCounts`。 |
| 18 | text 和 tool_result 兩個分支重複 | Low | 接受 | `mask.ts:268-273` 和 `277-282` 屬實。抽成共用函式。 |

## Test gap

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| T1 | 缺 CSV 引號案例 | High | 接受 | 和 #4 一起補。 |
| T2 | 缺超過 20 字元的案例 | High | 部分接受 | 和 #3 一起補，嚴重度 Low。 |
| T3 | 缺 document 和失敗時的組合案例 | High | 接受 | 和 #1、#2 一起補；斷言改成「失敗後整列不含任何原始內容」。 |
| T4 | 提問的 context、toast、catch 沒測 | High | 部分接受 | 屬實，補 context 遮罩和 catch 的 drop。toast 在測試環境沒有實作（實測記錄：`ui.status` 被丟棄），改成驗「toast 沒丟錯也不影響送出」，嚴重度 Medium。 |
| T5 | 缺 MCP 的 tool.call 測試 | Medium | 接受 | 補一個 mcp__ 開頭的寫入工具要擋、Sheets 唯讀工具要豁免、以及 catch 的案例。 |
| T6 | 圖片守門的路徑案例不足 | Medium | 接受 | 補 pdf、副檔名大寫、目錄名大寫、`..` 等案例。symlink 在測試環境無 fs，無法測，改由 realPath 的程式路徑涵蓋。 |
| T7 | 缺 ID 後接字母的案例 | Low | 部分接受 | 補測試，但斷言的是「後接字母時仍然遮」（見 #8）。 |
| T8 | JSON 斷言太弱 | Low | 接受 | 改成比對完整輸出和計數。 |
| T9 | 缺大型 JSON 的效能測試 | Medium | 接受 | 和 #12 一起補，用大量不同值的 JSON。 |
| T10 | 子代理測試是手動填 agentId | Medium | 部分接受 | 屬實，但真實子代理已在 2026-10-09 實機驗證過（子代理讀到的是遮罩值）。測試環境無法啟動真實子代理，改為在 README 記錄實測方法和結果，嚴重度 Low。 |
| T11 | 三個 catch 只測了一個 | Medium | 接受 | 補 prompt 和 tool.call 的失敗注入測試。 |

## Dependency／文件

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| D1 | 零依賴 | Low | 拒絕（不需處理） | 這是確認。 |
| D2 | README 寫 31 個測試，實際 32 個 | Low | 接受 | README 改成不寫死數量。 |

## 規格符合度

| 條款 | 判定 | 理由 |
|---|---|---|
| S1 | 部分接受 | 20 字元上限見 #3；CSV 引號見 #4。 |
| S3 | 接受 | 見 #6。 |
| S4 | 部分接受 | 見 #1；規格補上「engine 會放回的未知 block 不在保證範圍內」。 |
| S6 | 部分接受 | 見 #2；規格文字改成「所有可移除或可改寫的 block 都清除，engine 放回的除外」。 |
| S7 | 部分接受 | 見 #9。 |
| S9 | 接受 | 見 #10。 |
| S10 | 接受 | 見 #5、#12。 |
| S11 | 部分接受 | 合成 fixture 移進 repo 的 `tests/fixtures/`；validate、test、tsc 的指令寫進 README。不另建 CI：mod 需要 Claude Code 執行環境，GitHub runner 上沒有。 |
| S2、S5、S8 | 不需處理 | Codex 確認無缺失。 |

## 統計
接受 18、部分接受 14、拒絕 7。拒絕的 7 項中，#13～#16 和 D1 共 5 項是確認類，不需處理；真正駁回的只有 #7、#8 兩項。

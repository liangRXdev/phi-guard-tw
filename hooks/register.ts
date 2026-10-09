import type { Register } from 'claude-code'
import {
  addCounts,
  describeCounts,
  emptyCounts,
  findMaskTokens,
  isMediaPath,
  isSensitivePath,
  maskBlocks,
  maskText,
  placeholderBlocks,
  totalOf,
} from './mask'

// 不寫回資料的工具：讀取類、代理之間傳訊息的工具（子代理的回報、SendMessage），
// 以及明確列出的唯讀 MCP 工具。輸入裡出現遮罩字樣也不會寫壞任何來源檔，不擋。
// 其他 MCP 工具一律當成可能寫入（未知即擋）。
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite', 'Skill',
  'Agent', 'Task', 'SubagentHandback', 'SendMessage',
  'mcp__claude_ai_Google_Sheets__get_values',
  'mcp__claude_ai_Google_Sheets__get_spreadsheet',
])

const MEDIA_FIELDS = ['file_path', 'path', 'notebook_path'] as const

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of MEDIA_FIELDS) {
    const v = input[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

export const register: Register = on => {
  let sessionMasked = 0

  // ① 每一筆寫進對話的列（工具結果、MCP、附件、提問、子代理的對話）：模型讀到之前遮罩。
  on('session.append', async ($, e, next) => {
    const r = maskBlocks(e.message.content)
    if (!r.changed) return next(e)
    const stored = await next({ ...e, message: { ...e.message, content: r.blocks } })
    sessionMasked += totalOf(r.counts)
    $.ui.status(`phi-guard：本 session 已遮罩 ${sessionMasked} 處`)
    return stored
  }).catch(($, e, next) =>
    // 掃描失敗：可改寫的換成佔位文字、媒體移除，寧可多擋（engine 自己的列不能拒絕，只能改寫）。
    // next 已呼叫過（例如失敗發生在狀態列更新）時重播同一結果，不重複儲存。
    next.called ? next(e) : next({ ...e, message: { ...e.message, content: placeholderBlocks(e.message.content) } }),
  )

  // ② 提問：送出前遮罩，toast 只報類型與數量，不顯示原值。
  on('prompt.submit', ($, e, next) => {
    const t = maskText(e.text)
    const ctx = e.context?.map(c => maskText(c))
    const merged = [t.counts, ...(ctx ?? []).map(c => c.counts)].reduce(addCounts, emptyCounts())
    if (totalOf(merged) === 0) return next(e)
    $.ui.toast(`phi-guard：提問已遮罩 ${describeCounts(merged)}`)
    return next({ ...e, text: t.text, ...(ctx ? { context: ctx.map(c => c.text) } : {}) })
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'phi-guard-tw 掃描失敗，提問未送出；請重送或移除可能的識別資料' }))

  // ③ 工具呼叫：敏感目錄的圖片／PDF 擋下；輸入帶遮罩字樣（會把遮罩值寫回來源）擋下。
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)

    const p = tool === 'Read' ? pathOf(input) : undefined
    if (p !== undefined && isMediaPath(p)) {
      // 字面路徑與實際落點（解析 symlink、junction、..）都要檢查；解析不到就擋（fail-closed）。
      const stat = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
      const real = stat?.realPath
      if (real === undefined || isSensitivePath(p) || isSensitivePath(real)) {
        const why = real === undefined ? '無法解析實際路徑' : '位於敏感目錄'
        return { deny: `phi-guard-tw：${p} 是圖片／PDF 且${why}，影像內容無法遮罩，已擋下。需要時請先去識別化或轉成文字再讀。` }
      }
      $.ui.toast(`phi-guard：圖片／PDF 未經 PHI 掃描（${p.split(/[\\/]/).pop()}）`)
    }

    if (!READ_ONLY_TOOLS.has(tool)) {
      const { tool: _t, tool_use_id: _id, agentId: _a, consent: _c, ...args } = input
      const hits = findMaskTokens(JSON.stringify(args))
      if (hits.length > 0) {
        return {
          deny: `phi-guard-tw：${tool} 的輸入含遮罩字樣（${hits.length} 處），執行會把遮罩值寫回來源資料而損毀原檔，已擋下。請改用不經遮罩的方式處理該欄位（例如由使用者手動編輯）。`,
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'phi-guard-tw：守門檢查失敗，為安全起見已擋下此工具呼叫' }))
}

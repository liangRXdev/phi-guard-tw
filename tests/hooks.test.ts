// 經 engine 的 $ 觸發事件，驗證 hook 行為。測試自己的 on() 站在最底層代表 engine。
import { expect, test } from 'claude-code/testing'
import { FAILED_PLACEHOLDER } from '../hooks/mask'

const NID = 'A123456789' // 合成

test('session.append：工具結果在儲存前被遮罩', async ($, on) => {
  let stored: unknown
  on('session.append', ($, e, next) => {
    stored = e.message.content
    return next(e)
  })
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: `病歷號: 12345689\n${NID}` }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'u1',
  })
  expect(stored).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '病歷號: 12****89\nA12****89' }])
})

test('session.append：子代理的列同樣遮罩', async ($, on) => {
  let stored: unknown
  on('session.append', ($, e, next) => {
    stored = e.message.content
    return next(e)
  })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: `身分證 ${NID}` }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Grep' },
    uuid: 'u2',
    agentId: 'sub-1',
  })
  expect(stored).toEqual([{ type: 'text', text: '身分證 A12****89' }])
})

test('session.append：掃描出錯時整段換成佔位文字（不放行原文）', async ($, on) => {
  let stored: unknown
  on('session.append', ($, e, next) => {
    stored = e.message.content
    return next(e)
  })
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      // null block 讓遮罩函式丟錯
      content: [{ type: 'tool_result', tool_use_id: 't3', content: [null as unknown as { type: string }, { type: 'text', text: NID }] }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'u3',
  })
  expect(JSON.stringify(stored)).not.toContain(NID)
  expect(JSON.stringify(stored)).toContain(FAILED_PLACEHOLDER)
})

test('prompt.submit：提問送出前遮罩', async ($, on) => {
  let seen = ''
  on('prompt.submit', ($, e) => {
    seen = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: `幫我查 ${NID} 的用藥`, wait: false, origin: { kind: 'composer' } })
  expect(seen).toBe('幫我查 A12****89 的用藥')
})

test('tool.call：Write 內容含遮罩字樣時擋下', async ($, on) => {
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'ok' }
  })
  const r = await $.tool.call({ tool: 'Write', file_path: '/tmp/x.csv', content: '病歷號,藥品\n12****89,A' })
  expect(ran).toBe(false)
  expect(r.isError === true || typeof r.deny === 'string').toBe(true)
})

test('tool.call：Bash 指令含遮罩字樣時擋下', async ($, on) => {
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/X/A12****89/' f.txt" })
  expect(ran).toBe(false)
})

test('tool.call：§4 示範字樣與一般內容放行', async ($, on) => {
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/a.md', content: '遮罩格式：A12****90、12****89' })
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/a.md', old_string: 'a', new_string: 'b' })
  expect(ran).toBe(2)
})

test('tool.call：子代理回報與 SendMessage 含遮罩字樣不擋（實測誤擋的回歸測試）', async ($, on) => {
  const STARS = '*'.repeat(4) // 執行時才組出遮罩字樣，原始碼本身不含，否則編輯本檔會被守門擋下
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'SubagentHandback', report: `身分證 F23${STARS}98` } as never)
  await $.tool.call({ tool: 'SendMessage', to: 'x', message: `病歷號: 87${STARS}21` } as never)
  expect(ran).toBe(2)
})

test('tool.call：敏感目錄的圖片擋下，其他目錄放行', async ($, on) => {
  let ran = 0
  // 實際路徑等於字面路徑（無 symlink）
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('tool.call', () => {
    ran++
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\data\\00_private\\scan.png' })
  expect(ran).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\assets\\logo.png' })
  expect(ran).toBe(1)
})

test('tool.call：Grep 等讀取工具的輸入含遮罩字樣不擋', async ($, on) => {
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Grep', pattern: 'A12****89' })
  expect(ran).toBe(1)
})

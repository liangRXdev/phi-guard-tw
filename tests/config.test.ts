// userConfig（開源版）的測試：預設值、自訂值、異常值。全部為合成資料。
// 遮罩字樣在執行時才組出，原始碼不含四個連續星號。
import { describe, expect, test } from 'claude-code/testing'
import { buildRules, DEFAULT_CONFIG, findMaskTokens, maskText, normalizeConfig } from '../hooks/mask'

const STARS = '*'.repeat(4)
const S = (head: string, tail: string): string => `${head}${STARS}${tail}`

describe('normalizeConfig 異常值', () => {
  test('沒有設定時等於預設值，沒有警告', () => {
    expect(normalizeConfig(undefined)).toEqual({ config: DEFAULT_CONFIG, warnings: [] })
    expect(normalizeConfig({})).toEqual({ config: DEFAULT_CONFIG, warnings: [] })
  })

  test('標籤：空白、少於 2 字元者忽略，其餘去頭尾空白', () => {
    const { config } = normalizeConfig({ extraMrnLabels: ['', '  ', '號', ' 院內編號 ', 'ID'] })
    expect(config.extraMrnLabels).toEqual(['院內編號', 'ID'])
  })

  test('不是字串陣列時用預設值並警告', () => {
    const r = normalizeConfig({ sensitiveDirs: 'private' })
    expect(r.config.sensitiveDirs).toEqual(DEFAULT_CONFIG.sensitiveDirs)
    expect(r.warnings).toHaveLength(1)
  })

  test('sensitiveDirs 為空陣列時照設定，但警告', () => {
    const r = normalizeConfig({ sensitiveDirs: [] })
    expect(r.config.sensitiveDirs).toEqual([])
    expect(r.warnings.join()).toContain('sensitiveDirs')
  })

  test('豁免值不像遮罩字樣者忽略', () => {
    const { config } = normalizeConfig({ exemptMaskExamples: ['abc', S('A12', '90'), STARS, 'x'] })
    expect(config.exemptMaskExamples).toEqual([S('A12', '90')])
  })

  test('唯讀 MCP 只接受 mcp__ 開頭的全名', () => {
    const { config } = normalizeConfig({ readOnlyMcpTools: ['Write', 'mcp__x__read'] })
    expect(config.readOnlyMcpTools).toEqual(['mcp__x__read'])
  })
})

describe('extraMrnLabels', () => {
  test('自訂標籤生效：行內與表頭都遮', () => {
    const rules = buildRules({ ...DEFAULT_CONFIG, extraMrnLabels: ['院內編號'] })
    expect(maskText('院內編號：12345689', rules).text).toBe(`院內編號：${S('12', '89')}`)
    expect(maskText('院內編號\t藥品\n12345689\tA', rules).text).toBe(`院內編號\t藥品\n${S('12', '89')}\tA`)
  })

  test('regex 特殊字元當純文字：ID(院內) 只比對字面', () => {
    const rules = buildRules(normalizeConfig({ extraMrnLabels: ['ID(院內)', '.*'] }).config)
    expect(maskText('ID(院內): 12345689', rules).text).toBe(`ID(院內): ${S('12', '89')}`)
    // '.*' 若被當成 regex 會吃掉一切；當純文字時只比對字面 ".*"
    expect(maskText('order 12345689 done', rules).text).toBe('order 12345689 done')
    expect(maskText('.*: 12345689', rules).text).toBe(`.*: ${S('12', '89')}`)
  })

  test('自訂標籤後的遮罩字樣，資料完整性守門也認得', () => {
    const rules = buildRules({ ...DEFAULT_CONFIG, extraMrnLabels: ['院內編號'] })
    expect(findMaskTokens(`院內編號: ${STARS}`, rules)).toHaveLength(1)
  })

  test('沒設定時自訂標籤不生效', () => {
    expect(maskText('院內編號：12345689').text).toBe('院內編號：12345689')
  })
})

describe('經由 userConfig 注入 hook', () => {
  test('extraMrnLabels：session.append 依設定遮罩', { options: { extraMrnLabels: ['院內編號'] } }, async ($, on) => {
    let stored: unknown
    on('session.append', ($, e, next) => {
      stored = e.message.content
      return next(e)
    })
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: '院內編號: 12345689' }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'c1',
    })
    expect(stored).toEqual([{ type: 'text', text: `院內編號: ${S('12', '89')}` }])
  })

  test('extraMrnLabels：提問也依設定遮罩', { options: { extraMrnLabels: ['院內編號'] } }, async ($, on) => {
    let seen = ''
    on('prompt.submit', ($, e) => {
      seen = e.text
      return { text: e.text }
    })
    await $.prompt.submit({ text: '查 院內編號 12345689', wait: false, origin: { kind: 'composer' } })
    expect(seen).toBe(`查 院內編號 ${S('12', '89')}`)
  })

  test('sensitiveDirs：加入 raw 後擋下 raw 底下的圖片', { options: { sensitiveDirs: ['raw'] } }, async ($, on) => {
    let ran = 0
    on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }))
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\vault\\raw\\a.png' })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\vault\\private\\a.png' }) // 設定取代預設，private 不再擋
    expect(ran).toBe(1)
  })

  test('預設 sensitiveDirs 不含 raw', async ($, on) => {
    let ran = 0
    on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }))
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\vault\\raw\\a.png' })
    expect(ran).toBe(1)
  })

  test('readOnlyMcpTools：自訂唯讀工具放行，預設的 Sheets 唯讀工具被設定取代後改擋', { options: { readOnlyMcpTools: ['mcp__lab__query'] } }, async ($, on) => {
    const ran: string[] = []
    on('tool.call', ($, e) => {
      ran.push(String(e.tool))
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'mcp__lab__query', q: S('87', '21') } as never)
    await $.tool.call({ tool: 'mcp__claude_ai_Google_Sheets__get_values', range: S('87', '21') } as never)
    expect(ran).toEqual(['mcp__lab__query'])
  })

  test('exemptMaskExamples 預設為空：示範字樣寫入時也擋', async ($, on) => {
    let ran = 0
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/a.md', content: `格式：${S('A12', '90')}` })
    expect(ran).toBe(0)
  })
})

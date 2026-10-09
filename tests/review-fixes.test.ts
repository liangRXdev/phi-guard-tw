// Codex 覆審（.ai-review/verdict.md）各項的回歸測試。全部為合成資料。
// 遮罩字樣在執行時才組出（S()），原始碼不含四個連續星號，否則編輯本檔會被本 mod 的守門擋下。
import { describe, expect, test } from 'claude-code/testing'
import { DOCUMENT_REMOVED, FAILED_PLACEHOLDER, maskBlocks, maskText, placeholderBlocks } from '../hooks/mask'

const STARS = '*'.repeat(4)
const S = (head: string, tail: string): string => `${head}${STARS}${tail}`
const NID = 'A123456789' // 教科書範例

const fsAnswer = (realPath: unknown) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: realPath as string } })

describe('#4 CSV 引號', () => {
  test('引號內含逗號的備註欄不會讓後續列漏遮', () => {
    const csv = '病歷號,備註,藥品\n12345689,"腎功能差, 減量",Warfarin\n98765432,"x",Digoxin'
    expect(maskText(csv).text).toBe(`病歷號,備註,藥品\n${S('12', '89')},"腎功能差, 減量",Warfarin\n${S('98', '32')},"x",Digoxin`)
  })

  test('跳脫引號 "" 與引號包住的值', () => {
    const csv = '"病歷號","備註"\n"12345689","他說 ""好, 再說"""\n"98765432","b"'
    expect(maskText(csv).text).toBe(`"病歷號","備註"\n"${S('12', '89')}","他說 ""好, 再說"""\n"${S('98', '32')}","b"`)
  })

  test('CRLF 換行', () => {
    expect(maskText('病歷號,藥品\r\n12345689,A\r\n').text).toBe(`病歷號,藥品\r\n${S('12', '89')},A\r\n`)
  })
})

describe('#3 值長度', () => {
  test('21 碼與 64 碼的有標籤值都遮', () => {
    const v21 = '1'.repeat(21)
    const v64 = '2'.repeat(64)
    expect(maskText(`MRN: ${v21}`).text).toBe(`MRN: ${S('11', '11')}`)
    expect(maskText(`MRN: ${v64}`).text).toBe(`MRN: ${S('22', '22')}`)
  })
})

describe('#5 #6 #12 JSON 表格', () => {
  test('精確輸出：只遮目標欄的值，純英文值不遮，計數正確', () => {
    const json = JSON.stringify({ values: [['病歷號', '藥品'], ['12345689', 'Warfarin'], ['ABCDEF', 'Digoxin']] })
    const r = maskText(json)
    expect(r.text).toBe(JSON.stringify({ values: [['病歷號', '藥品'], [S('12', '89'), 'Warfarin'], ['ABCDEF', 'Digoxin']] }))
    expect(r.counts.mrn).toBe(1)
  })

  test('數字型的值也遮', () => {
    const json = JSON.stringify([['病歷號'], [12345689]])
    expect(maskText(json).text).toBe(`[["病歷號"],[${S('12', '89')}]]`)
  })

  test('深度 40 層的表格仍會遮（不再有深度上限）', () => {
    let v: unknown = [['病歷號'], ['12345689']]
    for (let i = 0; i < 40; i++) v = { a: v }
    expect(maskText(JSON.stringify(v)).text).not.toContain('12345689')
  })

  test('2 萬筆不同值的 JSON 在 2 秒內掃完', () => {
    const rows: string[][] = [['病歷號', '藥品']]
    for (let i = 0; i < 20000; i++) rows.push([String(10000000 + i), 'X'])
    const json = JSON.stringify({ values: rows })
    const t0 = Date.now()
    const r = maskText(json)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.counts.mrn).toBe(20000)
  })
})

describe('#8 身分證邊界（刻意偏向多遮）', () => {
  test('ID 後面直接接英文字母時仍然遮', () => {
    expect(maskText(`${NID}X`).text).toBe(`${S('A12', '89')}X`)
  })
})

describe('#1 document block', () => {
  test('文字型 document 含識別資料就整塊換成說明文字；不含就原樣', () => {
    const hit = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: `病歷號: 12345689` } }
    const clean = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' } }
    const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }
    const r = maskBlocks([hit, clean, pdf])
    expect(r.blocks[0]).toEqual({ type: 'text', text: DOCUMENT_REMOVED })
    expect(r.blocks[1]).toBe(clean)
    expect(r.blocks[2]).toBe(pdf)
    expect(r.counts.mrn).toBe(1)
  })

  test('tool_result 內層的文字型 document 也處理', () => {
    const doc = { type: 'document', source: { type: 'text', data: NID } }
    const r = maskBlocks([{ type: 'tool_result', tool_use_id: 't', content: [doc] }])
    expect(JSON.stringify(r.blocks)).not.toContain(NID)
  })
})

describe('#2 失敗時的佔位處理', () => {
  test('媒體移除、tool_result 保留結構但內容換掉、tool_use 保留，整列不含原始內容', () => {
    const out = placeholderBlocks([
      { type: 'text', text: NID },
      { type: 'image', source: { data: 'img' } },
      { type: 'document', source: { type: 'text', data: NID } },
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: NID }, { type: 'image', source: {} }] },
      { type: 'tool_use', id: 'u1', name: 'Read', input: {} },
    ])
    expect(out).toEqual([
      { type: 'text', text: FAILED_PLACEHOLDER },
      { type: 'tool_result', tool_use_id: 't1', content: FAILED_PLACEHOLDER },
      { type: 'tool_use', id: 'u1', name: 'Read', input: {} },
    ])
  })

  test('整列只有媒體時補一段佔位文字', () => {
    expect(placeholderBlocks([{ type: 'image', source: {} }])).toEqual([{ type: 'text', text: FAILED_PLACEHOLDER }])
  })

  test('hook：同一列有壞掉的 block 與 image／document 時，儲存的列不含任何原始內容', async ($, on) => {
    let stored: unknown
    on('session.append', ($, e, next) => {
      stored = e.message.content
      return next(e)
    })
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'SECRETIMG' } },
          { type: 'document', source: { type: 'text', data: `MRN: 12345689` } },
          { type: 'tool_result', tool_use_id: 't9', content: [null as unknown as { type: string }, { type: 'text', text: NID }] },
        ],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'u9',
    })
    const s = JSON.stringify(stored)
    expect(s).not.toContain(NID)
    expect(s).not.toContain('SECRETIMG')
    expect(s).not.toContain('12345689')
    expect(s).toContain(FAILED_PLACEHOLDER)
  })
})

describe('T4 提問', () => {
  test('context 也遮罩', async ($, on) => {
    let ctx: readonly string[] | undefined
    on('prompt.submit', ($, e) => {
      ctx = e.context
      return { text: e.text, context: e.context }
    })
    await $.prompt.submit({ text: 'hi', context: [`身分證 ${NID}`], wait: false, origin: { kind: 'composer' } })
    expect(ctx).toEqual([`身分證 ${S('A12', '89')}`])
  })

  test('掃描出錯時提問不送出（drop）', async ($, on) => {
    let reached = false
    on('prompt.submit', ($, e) => {
      reached = true
      return { text: e.text }
    })
    const r = await $.prompt.submit({ text: null as unknown as string, wait: false, origin: { kind: 'composer' } })
    expect(reached).toBe(false)
    expect(typeof r.drop).toBe('string')
  })
})

describe('T5 MCP 工具', () => {
  test('寫入型 MCP（Sheets update_values）輸入含遮罩字樣時擋下；唯讀 get_values 放行', async ($, on) => {
    let ran: string[] = []
    on('tool.call', ($, e) => {
      ran.push(String(e.tool))
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'mcp__claude_ai_Google_Sheets__update_values', values: [[S('87', '21')]] } as never)
    await $.tool.call({ tool: 'mcp__claude_ai_Google_Sheets__get_values', range: S('87', '21') } as never)
    await $.tool.call({ tool: 'mcp__other__anything', note: 'clean' } as never)
    expect(ran).toEqual(['mcp__claude_ai_Google_Sheets__get_values', 'mcp__other__anything'])
  })
})

describe('#10 T6 圖片／PDF 路徑', () => {
  const cases: Array<[string, string, boolean]> = [
    ['C:\\proj\\data\\00_private\\scan.PDF', 'C:\\proj\\data\\00_private\\scan.PDF', false],
    ['C:\\proj\\PRIVATE\\a.jpg', 'C:\\proj\\PRIVATE\\a.jpg', false],
    ['C:\\proj\\assets\\logo.png', 'C:\\proj\\assets\\logo.png', true],
    // symlink：字面路徑乾淨，實際落點在敏感目錄
    ['C:\\proj\\assets\\link.png', 'D:\\vault\\phi\\real.png', false],
    // 字面含 ..：字面段含敏感目錄就擋（偏向多擋）
    ['C:\\proj\\00_private\\..\\assets\\a.png', 'C:\\proj\\assets\\a.png', false],
  ]
  for (const [path, real, allowed] of cases) {
    test(`${path} → ${allowed ? '放行' : '擋下'}`, async ($, on) => {
      let ran = 0
      on('fs.stat', () => fsAnswer(real))
      on('tool.call', () => {
        ran++
        return { result: 'ok' }
      })
      await $.tool.call({ tool: 'Read', file_path: path })
      expect(ran).toBe(allowed ? 1 : 0)
    })
  }

  test('實際路徑解析失敗時擋下', async ($, on) => {
    let ran = 0
    on('fs.stat', () => {
      throw new Error('ENOENT')
    })
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\assets\\gone.png' })
    expect(ran).toBe(0)
  })

  test('T11：守門程式本身出錯時擋下（catch）', async ($, on) => {
    let ran = 0
    on('fs.stat', () => fsAnswer(12345)) // realPath 型別錯誤，讓守門程式丟錯
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    const r = await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\assets\\a.png' })
    expect(ran).toBe(0)
    expect(r.isError === true || typeof r.deny === 'string').toBe(true)
  })
})

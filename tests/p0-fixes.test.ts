// 2026-10-10 外部覆審 P0 兩項的回歸測試。全部為合成資料。
// 遮罩字樣在執行時才組出，原始碼不含四個連續星號，否則編輯本檔會被本 mod 的守門擋下。
import { describe, expect, test } from 'claude-code/testing'
import { findMaskTokens, maskText } from '../hooks/mask'

const STARS = '*'.repeat(4)

const fsAnswer = (realPath: string) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath } })

describe('P0-1 短值全遮的遮罩字樣', () => {
  test('表格欄遮出的短值（旁邊沒有標籤）也認得', () => {
    const masked = maskText('病歷號,藥品\n12345,A').text
    expect(masked).toBe(`病歷號,藥品\n${STARS},A`)
    expect(findMaskTokens(masked)).toHaveLength(1)
  })

  test('JSON 二維陣列遮出的短值也認得', () => {
    const masked = maskText('[["病歷號","藥品"],["12345","A"]]').text
    expect(findMaskTokens(masked)).toHaveLength(1)
  })

  test('標籤加引號、經 JSON.stringify 跳脫後仍認得', () => {
    const args = JSON.stringify({ content: `{"MRN": "${STARS}"}` })
    expect(findMaskTokens(args)).toHaveLength(1)
  })

  test('三或五個星號、Markdown 粗體不算', () => {
    expect(findMaskTokens('**bold** 與 ***、*****')).toEqual([])
  })

  test('Write 寫回遮過的短值表格時擋下', async ($, on) => {
    let ran = false
    on('tool.call', () => {
      ran = true
      return { result: 'ok' }
    })
    const r = await $.tool.call({ tool: 'Write', file_path: '/tmp/x.csv', content: `病歷號,藥品\n${STARS},A` })
    expect(ran).toBe(false)
    expect(r.isError === true || typeof r.deny === 'string').toBe(true)
  })

  test('寫入內容中位於行首的遮罩字樣也擋（不受 JSON 跳脫影響）', async ($, on) => {
    let ran = 0
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/a.txt', content: `身分證\nA12${STARS}89` })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/b.txt', content: `病歷號\t${STARS}` })
    await $.tool.call({ tool: 'Edit', file_path: '/tmp/c.json', old_string: 'x', new_string: `{"MRN": "${STARS}"}` })
    expect(ran).toBe(0)
  })

  test('一般內容不受影響', async ($, on) => {
    let ran = 0
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/d.md', content: '**粗體**\n\n---\n密碼欄位顯示 ***' })
    expect(ran).toBe(1)
  })
})

describe('P0-2 無副檔名的 symlink', () => {
  const cases: Array<[string, string, boolean]> = [
    // 字面無副檔名，實際落點是敏感目錄內的 PDF／圖片
    ['C:\\proj\\assets\\scan', 'D:\\vault\\phi\\real.pdf', false],
    ['C:\\proj\\assets\\photo', 'D:\\vault\\00_private\\a.JPG', false],
    // 字面無副檔名，實際落點是非敏感目錄的圖片：放行
    ['C:\\proj\\assets\\logo', 'C:\\proj\\img\\logo.png', true],
    // 一般無副檔名文字檔：放行
    ['C:\\proj\\Makefile', 'C:\\proj\\Makefile', true],
  ]
  for (const [path, real, allowed] of cases) {
    test(`${path} → ${real} → ${allowed ? '放行' : '擋下'}`, async ($, on) => {
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

  test('非媒體路徑解析失敗時放行（交給 Read 自己報錯）', async ($, on) => {
    let ran = 0
    on('fs.stat', () => {
      throw new Error('ENOENT')
    })
    on('tool.call', () => {
      ran++
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\notes.txt' })
    expect(ran).toBe(1)
  })
})

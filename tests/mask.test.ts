// 全部為合成資料：身分證以檢核碼演算法產生，非真實個人。
import { describe, expect, test } from 'claude-code/testing'
import { buildRules, DEFAULT_CONFIG, findMaskTokens, isSensitivePath, isValidTwId, maskBlocks, maskText } from '../hooks/mask'

const NID = 'A123456789' // 教科書範例，合法檢核碼
const NID2 = 'F234567898'
const ARC_NEW = 'B912345674'
const ARC_OLD = 'FC12345674'

describe('身分證／居留證', () => {
  test('檢核碼正確者通過，錯者不通過', () => {
    for (const id of [NID, NID2, ARC_NEW, ARC_OLD, 'A800000014']) expect(isValidTwId(id)).toBe(true)
    for (const id of ['A123456788', 'B912345675', 'FC12345675', 'A323456789']) expect(isValidTwId(id)).toBe(false)
  })

  test('遮成前 3＋****＋後 2', () => {
    expect(maskText(`ID ${NID} 與 ${NID2}`).text).toBe('ID A12****89 與 F23****98')
  })

  test('新式與舊式居留證都遮', () => {
    const r = maskText(`${ARC_NEW} ${ARC_OLD}`)
    expect(r.text).toBe('B91****74 FC1****74')
    expect(r.counts.twid).toBe(2)
  })

  test('檢核碼錯的不遮', () => {
    expect(maskText('A123456788').text).toBe('A123456788')
  })

  test('全形與小寫照樣抓', () => {
    expect(maskText('Ａ１２３４５６７８９').text).toBe('A12****89')
    expect(maskText('a123456789').text).toBe('A12****89')
  })

  test('有分隔符的不抓（已知限制）', () => {
    expect(maskText('A123-456-789').text).toBe('A123-456-789')
  })

  test('嵌在更長英數串中的不抓', () => {
    expect(maskText('XA123456789').text).toBe('XA123456789')
    expect(maskText('A1234567890').text).toBe('A1234567890')
  })
})

describe('有標籤的病歷號／健保卡號', () => {
  test('五種標籤寫法', () => {
    for (const label of ['病歷號', '病歷號碼', 'MRN', 'ChartNo', 'chart_no']) {
      expect(maskText(`${label}: 12345689`).text).toBe(`${label}: 12****89`)
    }
  })

  test('全形冒號、等號、空白、JSON 引號', () => {
    expect(maskText('病歷號：12345689').text).toBe('病歷號：12****89')
    expect(maskText('mrn=12345689').text).toBe('mrn=12****89')
    expect(maskText('病歷號 12345689').text).toBe('病歷號 12****89')
    expect(maskText('{"chart_no": "12345689"}').text).toBe('{"chart_no": "12****89"}')
  })

  test('6 碼以下全遮', () => {
    expect(maskText('病歷號: 1234').text).toBe('病歷號: ****')
    expect(maskText('病歷號: 123456').text).toBe('病歷號: ****')
  })

  test('健保卡號', () => {
    const r = maskText('健保卡號：000012345678')
    expect(r.text).toBe('健保卡號：00****78')
    expect(r.counts.nhi).toBe(1)
  })

  test('沒有標籤的長數字不遮', () => {
    const s = 'gh run 37562732508 size 20261009'
    expect(maskText(s).text).toBe(s)
  })

  test('已遮過的不再遮（冪等）', () => {
    const once = maskText(`病歷號: 12345689 ${NID}`).text
    const twice = maskText(once)
    expect(twice.text).toBe(once)
    expect(twice.counts.mrn + twice.counts.twid).toBe(0)
  })
})

describe('表格欄', () => {
  test('TSV 欄名為病歷號的那一欄', () => {
    const tsv = '姓名\t病歷號\t藥品\n王○明\t12345689\tWarfarin\n李○華\t98765432\tDigoxin'
    expect(maskText(tsv).text).toBe('姓名\t病歷號\t藥品\n王○明\t12****89\tWarfarin\n李○華\t98****32\tDigoxin')
  })

  test('Markdown 表格', () => {
    const md = '| 病歷號 | 藥品 |\n|---|---|\n| 12345689 | Warfarin |'
    expect(maskText(md).text).toBe('| 病歷號 | 藥品 |\n|---|---|\n| 12****89 | Warfarin |')
  })

  test('JSON 二維陣列（Sheets get_values）', () => {
    const json = JSON.stringify({ values: [['病歷號', '藥品'], ['12345689', 'Warfarin'], [98765432, 'Digoxin']] })
    const out = maskText(json).text
    expect(out).not.toContain('12345689')
    expect(out).not.toContain('98765432')
    expect(out).toContain('Warfarin')
  })

  test('空行後不再沿用欄位', () => {
    const s = '病歷號,藥品\n12345689,A\n\n55555555,B'
    expect(maskText(s).text).toBe('病歷號,藥品\n12****89,A\n\n55555555,B')
  })
})

describe('content blocks', () => {
  test('巢狀 tool_result 與 text 都遮，其他 block 原樣、結構不變', () => {
    const blocks = [
      { type: 'text', text: `看 ${NID}` },
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '病歷號: 12345689' }, { type: 'image', source: { x: 1 } }] },
      { type: 'tool_use', id: 'u', name: 'Read', input: { file_path: NID } },
    ]
    const r = maskBlocks(blocks)
    expect(r.changed).toBe(true)
    expect(r.blocks[0]).toEqual({ type: 'text', text: '看 A12****89' })
    expect(r.blocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: '病歷號: 12****89' }, { type: 'image', source: { x: 1 } }],
    })
    expect(r.blocks[2]).toBe(blocks[2])
    expect(r.counts.twid + r.counts.mrn).toBe(2)
  })

  test('沒有命中時 changed 為 false', () => {
    expect(maskBlocks([{ type: 'text', text: 'hello' }]).changed).toBe(false)
  })
})

describe('資料完整性與路徑', () => {
  test('偵測遮罩字樣；示範字樣預設不豁免，設定後才豁免', () => {
    expect(findMaskTokens('id A12****89')).toEqual(['A12****89'])
    expect(findMaskTokens('病歷號: ****')).toHaveLength(1)
    const ex = '範例 A12****90 與 12****89'
    expect(findMaskTokens(ex)).toHaveLength(2)
    const withExempt = buildRules({ ...DEFAULT_CONFIG, exemptMaskExamples: ['A12****90', '12****89'] })
    expect(findMaskTokens(ex, withExempt)).toEqual([])
    expect(findMaskTokens('**bold** 與 ****')).toEqual([])
  })

  test('敏感目錄判斷看目錄段，不看檔名', () => {
    expect(isSensitivePath('C:\\proj\\data\\00_private\\scan.png')).toBe(true)
    expect(isSensitivePath('/vault/raw/a.pdf')).toBe(false) // raw 不在開源預設內
    expect(isSensitivePath('/vault/raw/a.pdf', buildRules({ ...DEFAULT_CONFIG, sensitiveDirs: ['raw'] }))).toBe(true)
    expect(isSensitivePath('/proj/assets/private.png')).toBe(false)
    expect(isSensitivePath('/proj/assets/logo.png')).toBe(false)
  })
})

describe('效能', () => {
  test('5 MB 合成 log 在 2 秒內掃完', () => {
    const line = `2026-10-09 INFO run 37562732508 ok 病歷號: 12345689 ${NID}\n`
    const big = line.repeat(Math.ceil((5 * 1024 * 1024) / line.length))
    const t0 = Date.now()
    const r = maskText(big)
    const ms = Date.now() - t0
    expect(r.text).not.toContain(NID)
    expect(ms).toBeLessThan(2000)
  })
})

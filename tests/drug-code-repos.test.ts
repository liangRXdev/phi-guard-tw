// drugCodeRepos：藥品代號 repo 只豁免舊式居留證偵測。全部為合成資料。
// 證號在執行時依檢核碼算出，原始碼不含任何像證號的字串（否則本 mod 會擋下這個檔案的寫入）。
import { describe, expect, test } from 'claude-code/testing'
import {
  buildRules, DEFAULT_CONFIG, isUnderAny, isValidTwId, maskText, normalizeConfig, normalizePath, rulesForRoot,
} from '../hooks/mask'

/** 前 9 碼固定、窮舉最後一碼，回傳第一個通過檢核碼的 10 碼。 */
function synth(head9: string): string {
  for (let d = 0; d <= 9; d++) {
    const id = `${head9}${d}`
    if (isValidTwId(id)) return id
  }
  throw new Error(`找不到合法檢核碼：${head9}`)
}

const OLD_ARC = synth('AC4809210')      // 第二碼 C：舊式居留證格式＝健保藥品代號格式
const NATIONAL = synth('A12345678')     // 第二碼 1：身分證
const NEW_ARC = synth('A80000001')      // 第二碼 8：新式居留證
const REPO = 'C:\\Users\\x\\projects\\NHI-drug-price-history'
const exemptRules = rulesForRoot(buildRules({ ...DEFAULT_CONFIG, drugCodeRepos: [REPO] }), `${REPO}\\tests`)

describe('normalizeConfig：drugCodeRepos', () => {
  test('預設為空', () => {
    expect(normalizeConfig(undefined).config.drugCodeRepos).toEqual([])
  })

  test('只接受絕對路徑；相對路徑忽略並警告', () => {
    const r = normalizeConfig({ drugCodeRepos: ['C:\\a\\NHI', '/home/u/TFDA', 'relative/x', '  '] })
    expect(r.config.drugCodeRepos).toEqual(['C:\\a\\NHI', '/home/u/TFDA'])
    expect(r.warnings.join()).toContain('drugCodeRepos')
  })
})

describe('isUnderAny：路徑比對', () => {
  const repos = [normalizePath('C:\\Users\\x\\projects\\NHI')]
  test('repo 本身與子目錄命中；斜線方向、大小寫、尾端斜線不影響', () => {
    expect(isUnderAny('C:\\Users\\x\\projects\\NHI', repos)).toBe(true)
    expect(isUnderAny('c:/users/x/projects/nhi/tests/', repos)).toBe(true)
  })
  test('以路徑段為界：同名前綴的其他資料夾不命中', () => {
    expect(isUnderAny('C:\\Users\\x\\projects\\NHI-main-fix', repos)).toBe(false)
    expect(isUnderAny('C:\\Users\\x\\projects', repos)).toBe(false)
  })
})

describe('maskText：只關舊式居留證', () => {
  test('合成值的類型正確（前提）', () => {
    for (const id of [OLD_ARC, NATIONAL, NEW_ARC]) expect(isValidTwId(id)).toBe(true)
  })

  test('預設規則：三種都遮', () => {
    for (const id of [OLD_ARC, NATIONAL, NEW_ARC]) expect(maskText(`x ${id} y`).text).not.toContain(id)
  })

  test('drugCodeRepos 底下：舊式居留證格式不遮', () => {
    expect(maskText(`藥品代號 ${OLD_ARC}`, exemptRules).text).toBe(`藥品代號 ${OLD_ARC}`)
  })

  test('drugCodeRepos 底下：身分證、新式居留證、病歷號照常遮', () => {
    expect(maskText(`x ${NATIONAL} y`, exemptRules).text).not.toContain(NATIONAL)
    expect(maskText(`x ${NEW_ARC} y`, exemptRules).text).not.toContain(NEW_ARC)
    expect(maskText('病歷號：12345689', exemptRules).counts.mrn).toBe(1)
  })

  test('session 根目錄不在清單內或取不到：完整規則', () => {
    const rules = buildRules({ ...DEFAULT_CONFIG, drugCodeRepos: [REPO] })
    expect(rulesForRoot(rules, 'C:\\Users\\x\\projects\\other').oldArc).toBe(true)
    expect(rulesForRoot(rules, undefined).oldArc).toBe(true)
  })
})

describe('經由 hook：依 session 根目錄切換', () => {
  const msg = (text: string) => ({
    message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text', text }] },
    door: 'tool-result' as const,
    origin: { kind: 'tool' as const, tool: 'Bash' },
    uuid: 'd1',
  })

  test('repo 底下：舊式居留證格式保留、身分證仍遮', { options: { drugCodeRepos: [REPO] } }, async ($, on) => {
    let stored = ''
    on('session.root', () => ({ value: `${REPO}\\e2e` }))
    on('session.append', ($, e, next) => {
      stored = JSON.stringify(e.message.content)
      return next(e)
    })
    await $.session.append(msg(`${OLD_ARC} ${NATIONAL}`))
    expect(stored).toContain(OLD_ARC)
    expect(stored).not.toContain(NATIONAL)
  })

  test('repo 以外：舊式居留證照常遮', { options: { drugCodeRepos: [REPO] } }, async ($, on) => {
    let stored = ''
    on('session.root', () => ({ value: 'C:\\Users\\x\\projects\\clinic-notes' }))
    on('session.append', ($, e, next) => {
      stored = JSON.stringify(e.message.content)
      return next(e)
    })
    await $.session.append(msg(OLD_ARC))
    expect(stored).not.toContain(OLD_ARC)
  })

  test('取不到根目錄：寧可多遮', { options: { drugCodeRepos: [REPO] } }, async ($, on) => {
    let stored = ''
    on('session.root', () => {
      throw new Error('boom')
    })
    on('session.append', ($, e, next) => {
      stored = JSON.stringify(e.message.content)
      return next(e)
    })
    await $.session.append(msg(OLD_ARC))
    expect(stored).not.toContain(OLD_ARC)
  })

  test('提問同樣依根目錄切換', { options: { drugCodeRepos: [REPO] } }, async ($, on) => {
    let seen = ''
    on('session.root', () => ({ value: REPO }))
    on('prompt.submit', ($, e) => {
      seen = e.text
      return { text: e.text }
    })
    await $.prompt.submit({ text: `查 ${OLD_ARC}`, wait: false, origin: { kind: 'composer' } })
    expect(seen).toBe(`查 ${OLD_ARC}`)
  })
})

// 純函式：偵測與遮罩。不碰 $，方便單元測試。
// 只處理格式固定的欄位：身分證／居留證（regex + 檢核碼）、有標籤的病歷號與健保卡號。
// 姓名、地址、電話、生日、帶分隔符的 ID、base64／URL 編碼內容一律不處理（見 README 限制）。

export type Kind = 'twid' | 'mrn' | 'nhi'

export type Counts = Record<Kind, number>

export const KIND_LABEL: Record<Kind, string> = {
  twid: '身分證／居留證',
  mrn: '病歷號',
  nhi: '健保卡號',
}

export const emptyCounts = (): Counts => ({ twid: 0, mrn: 0, nhi: 0 })

export function addCounts(a: Counts, b: Counts): Counts {
  return { twid: a.twid + b.twid, mrn: a.mrn + b.mrn, nhi: a.nhi + b.nhi }
}

export const totalOf = (c: Counts): number => c.twid + c.mrn + c.nhi

export function describeCounts(c: Counts): string {
  return (Object.keys(c) as Kind[])
    .filter(k => c[k] > 0)
    .map(k => `${KIND_LABEL[k]}×${c[k]}`)
    .join('、')
}

// ---------- 全形 → 半形（逐字 1:1，索引不位移） ----------

export function toHalfWidth(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0)
    else if (c === 0x3000) out += ' '
    else out += s[i]
  }
  return out
}

// ---------- 身分證／居留證檢核碼 ----------

const LETTER_CODE: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
}

/** 身分證、新式居留證（第二碼 8/9）、舊式居留證（第二碼 A–D）。輸入須已是半形大寫 10 碼。 */
export function isValidTwId(id: string): boolean {
  if (!/^[A-Z][1289A-D][0-9]{8}$/.test(id)) return false
  const first = id.charAt(0)
  const second = id.charAt(1)
  const head = LETTER_CODE[first]
  if (head === undefined) return false
  const secondDigit = /[A-D]/.test(second) ? (LETTER_CODE[second] ?? 0) % 10 : Number(second)
  const digits = [secondDigit, ...id.slice(2).split('').map(Number)]
  const weights = [8, 7, 6, 5, 4, 3, 2, 1, 1]
  let sum = Math.floor(head / 10) + (head % 10) * 9
  digits.forEach((d, i) => {
    sum += d * (weights[i] ?? 0)
  })
  return sum % 10 === 0
}

// ---------- 遮罩格式 ----------

/** A123456789 → A12****89 的格式：前 3 + **** + 後 2 */
export const maskTwId = (id: string): string => `${id.slice(0, 3)}****${id.slice(-2)}`

/** 病歷號／健保卡號：頭尾各留 2 碼；6 碼以下全遮（留 4 碼等於沒遮） */
export const maskLabeled = (v: string): string => (v.length <= 6 ? '****' : `${v.slice(0, 2)}****${v.slice(-2)}`)

// ---------- 偵測規則 ----------

const TWID_RE = /(?<![A-Za-z0-9])[A-Za-z][1289A-Da-d][0-9]{8}(?![0-9])/g

const MRN_LABELS = String.raw`病歷號碼|病歷號|MRN|Chart[ _]?No`
const NHI_LABELS = String.raw`健保卡號碼|健保卡號`
const SEP = String.raw`["']?[ \t]*[:：=][ \t]*["']?|[ \t]+`
// 值長度上限 64：遠大於實際病歷號（約 7–12 碼）與健保卡號（12 碼），只為避免病態長字串。
const MAX_VALUE = 64
const VALUE = String.raw`(?=[A-Za-z]*[0-9])([A-Za-z0-9]{1,${MAX_VALUE}})(?![A-Za-z0-9*])`
const CELL_VALUE_RE = new RegExp(String.raw`^([ "']*)([A-Za-z0-9]{1,${MAX_VALUE}})([ "']*)$`)

/** 病歷號／健保卡號的值：英數、長度在上限內、至少含一個數字（S3）。表格欄、JSON 表格共用。 */
const isIdValue = (v: string): boolean => v.length <= MAX_VALUE && /^[A-Za-z0-9]+$/.test(v) && /[0-9]/.test(v)

const LABELED_RES: Array<[Kind, RegExp]> = [
  ['mrn', new RegExp(String.raw`(?:${MRN_LABELS})(?:${SEP})${VALUE}`, 'gi')],
  ['nhi', new RegExp(String.raw`(?:${NHI_LABELS})(?:${SEP})${VALUE}`, 'gi')],
]

const HEADER_RE: Array<[Kind, RegExp]> = [
  ['mrn', new RegExp(String.raw`^["' ]*(?:${MRN_LABELS})["' ]*$`, 'i')],
  ['nhi', new RegExp(String.raw`^["' ]*(?:${NHI_LABELS})["' ]*$`, 'i')],
]

type Span = { start: number; end: number; replacement: string; kind: Kind }

function headerKind(cell: string): Kind | undefined {
  for (const [kind, re] of HEADER_RE) if (re.test(cell)) return kind
  return undefined
}

// ---------- 逐行表格：欄名是標籤的那一欄（CSV／TSV／Markdown pipe） ----------

const DELIMS = ['\t', '|', ','] as const

/** 切欄並保留每欄起點。CSV／TSV 認得雙引號：引號內的分隔符不切（`""` 是跳脫，兩次切換後狀態不變）。 */
function splitWithOffsets(line: string, d: string): Array<{ text: string; start: number }> {
  const cells: Array<{ text: string; start: number }> = []
  const quoteAware = d === ',' || d === '\t'
  let inQuotes = false
  let start = 0
  for (let i = 0; i <= line.length; i++) {
    const ch = line[i]
    if (quoteAware && ch === '"') inQuotes = !inQuotes
    if (i === line.length || (ch === d && !inQuotes)) {
      cells.push({ text: line.slice(start, i), start })
      start = i + 1
    }
  }
  return cells
}

function tableSpans(norm: string): Span[] {
  const spans: Span[] = []
  const lines: Array<{ text: string; start: number }> = []
  let s = 0
  for (let i = 0; i <= norm.length; i++) {
    if (i === norm.length || norm[i] === '\n') {
      lines.push({ text: norm.slice(s, i).replace(/\r$/, ''), start: s })
      s = i + 1
    }
  }
  let active: { d: string; cols: Array<[number, Kind]>; width: number } | undefined
  for (const line of lines) {
    if (active) {
      const cells = splitWithOffsets(line.text, active.d)
      if (line.text.trim() === '' || cells.length !== active.width) {
        active = undefined
      } else {
        for (const [col, kind] of active.cols) {
          const cell = cells[col]
          if (!cell) continue
          const m = CELL_VALUE_RE.exec(cell.text)
          const lead = m?.[1] ?? ''
          const value = m?.[2]
          if (!value || !isIdValue(value)) continue
          const start = line.start + cell.start + lead.length
          spans.push({ start, end: start + value.length, replacement: maskLabeled(value), kind })
        }
        continue
      }
    }
    for (const d of DELIMS) {
      const cells = splitWithOffsets(line.text, d)
      if (cells.length < 2) continue
      const cols: Array<[number, Kind]> = []
      cells.forEach((c, i) => {
        const k = headerKind(c.text.trim())
        if (k) cols.push([i, k])
      })
      if (cols.length > 0) {
        active = { d, cols, width: cells.length }
        break
      }
    }
  }
  return spans
}

// ---------- JSON 二維陣列（Google Sheets get_values 等）：表頭列是標籤的那一欄 ----------

function jsonGridSpans(norm: string): Span[] {
  const t = norm.trim()
  if (!t.startsWith('[') && !t.startsWith('{')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return []
  }
  const values = new Map<string, Kind>()
  const visitGrid = (grid: unknown[]): void => {
    if (!grid.every(r => Array.isArray(r))) return
    const rows = grid as unknown[][]
    const header = rows[0]
    if (!header) return
    const cols: Array<[number, Kind]> = []
    header.forEach((h, i) => {
      const k = typeof h === 'string' ? headerKind(h.trim()) : undefined
      if (k) cols.push([i, k])
    })
    if (cols.length === 0) return
    for (const row of rows.slice(1)) {
      for (const [c, k] of cols) {
        const v = row[c]
        if (typeof v !== 'string' && typeof v !== 'number') continue
        const s = String(v).trim()
        if (isIdValue(s)) values.set(s, k)
      }
    }
  }
  // 以堆疊走訪，不設深度上限（遞迴會受 call stack 限制，設上限則會靜默略過深層資料）
  const stack: unknown[] = [parsed]
  while (stack.length > 0) {
    const v = stack.pop()
    if (Array.isArray(v)) {
      visitGrid(v)
      for (const x of v) stack.push(x)
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) stack.push(x)
    }
  }
  if (values.size === 0) return []
  // 回到原字串單次掃描英數 token，命中集合者遮罩：O(n)。
  // 同值出現在非目標欄也會被遮（偏向多遮，見 verdict #7）。
  const spans: Span[] = []
  for (const m of norm.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]+(?![A-Za-z0-9])/g)) {
    const kind = values.get(m[0])
    if (kind === undefined) continue
    const start = m.index ?? 0
    spans.push({ start, end: start + m[0].length, replacement: maskLabeled(m[0]), kind })
  }
  return spans
}

// ---------- 主函式 ----------

export function maskText(input: string): { text: string; counts: Counts } {
  const counts = emptyCounts()
  if (input.length === 0) return { text: input, counts }
  const norm = toHalfWidth(input)
  const spans: Span[] = []

  for (const m of norm.matchAll(TWID_RE)) {
    const id = m[0].toUpperCase()
    if (!isValidTwId(id)) continue
    const start = m.index ?? 0
    spans.push({ start, end: start + 10, replacement: maskTwId(id), kind: 'twid' })
  }
  for (const [kind, re] of LABELED_RES) {
    for (const m of norm.matchAll(re)) {
      const value = m[1]
      if (value === undefined) continue
      const start = (m.index ?? 0) + m[0].length - value.length
      spans.push({ start, end: start + value.length, replacement: maskLabeled(value), kind })
    }
  }
  spans.push(...tableSpans(norm), ...jsonGridSpans(norm))

  if (spans.length === 0) return { text: input, counts }

  // 由前往後套用；重疊時取先出現且較長者，避免重複遮
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  for (const sp of spans) {
    if (sp.start < cursor) continue
    out += input.slice(cursor, sp.start) + sp.replacement
    cursor = sp.end
    counts[sp.kind]++
  }
  out += input.slice(cursor)
  return { text: out, counts }
}

// ---------- 對話列的 content blocks ----------

type Block = { type: string; [field: string]: unknown }

// 依 session.append 契約：text 可改寫；tool_result 的 content 可改寫；
// image／document 只能移除或搬移、不能改寫；其他（tool_use、thinking、未知類型）engine 會原樣放回。

export const DOCUMENT_REMOVED = '[phi-guard-tw：此文件含識別資料，已整份移除（document 依規格不能改寫）]'

/** 文字型 document（source.type 為 text）的內文；其他 document（PDF base64 等）無法掃描，回 undefined。 */
function documentText(b: Block): string | undefined {
  const src = b.source as { type?: unknown; data?: unknown } | undefined
  return src && src.type === 'text' && typeof src.data === 'string' ? src.data : undefined
}

/** 遮罩 text block、tool_result 的 content（字串或 block 陣列）；命中識別資料的文字型 document 整塊換成說明文字。 */
export function maskBlocks(blocks: readonly Block[]): { blocks: Block[]; counts: Counts; changed: boolean } {
  let counts = emptyCounts()
  let changed = false
  /** 遮罩一段字串；沒有命中回 undefined，呼叫端保留原 block（保持參照不變）。 */
  const apply = (s: string): string | undefined => {
    const r = maskText(s)
    if (totalOf(r.counts) === 0) return undefined
    counts = addCounts(counts, r.counts)
    changed = true
    return r.text
  }
  const maskOne = (b: Block): Block => {
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = apply(b.text)
      return t === undefined ? b : { ...b, text: t }
    }
    if (b.type === 'document') {
      const data = documentText(b)
      return data !== undefined && apply(data) !== undefined ? { type: 'text', text: DOCUMENT_REMOVED } : b
    }
    if (b.type === 'tool_result') {
      const c = b.content
      if (typeof c === 'string') {
        const t = apply(c)
        return t === undefined ? b : { ...b, content: t }
      }
      if (Array.isArray(c)) {
        const inner = c.map(x => maskOne(x as Block))
        return inner.some((x, i) => x !== c[i]) ? { ...b, content: inner } : b
      }
    }
    return b
  }
  const out = blocks.map(maskOne)
  return { blocks: out, counts, changed }
}

/** 遮罩失敗時的替代內容：寧可移除，也不放行原文。 */
export const FAILED_PLACEHOLDER = '[phi-guard-tw：掃描失敗，此段內容已移除以免洩漏]'

const MEDIA_TYPES = new Set(['image', 'document'])

/**
 * 掃描失敗時的整列替代：text 與 tool_result 的內容換成佔位文字；image／document 移除；
 * 其餘 block 保留（tool_use、thinking、未知類型由 engine 原樣放回，hook 移不掉）。
 * 不把整列換成單一 text block：tool_result 的 id 組是釘住的，engine 會把它放回，內容可能是原文。
 */
export function placeholderBlocks(blocks: unknown): Block[] {
  if (!Array.isArray(blocks)) return [{ type: 'text', text: FAILED_PLACEHOLDER }]
  const out: Block[] = []
  for (const b of blocks as unknown[]) {
    if (!b || typeof b !== 'object') {
      out.push({ type: 'text', text: FAILED_PLACEHOLDER })
      continue
    }
    const blk = b as Block
    if (MEDIA_TYPES.has(blk.type)) continue
    if (blk.type === 'text') out.push({ ...blk, text: FAILED_PLACEHOLDER })
    else if (blk.type === 'tool_result') out.push({ ...blk, content: FAILED_PLACEHOLDER })
    else out.push(blk)
  }
  if (!out.some(b => b.type === 'text' || b.type === 'tool_result')) out.push({ type: 'text', text: FAILED_PLACEHOLDER })
  return out
}

// ---------- 資料完整性：偵測本 mod 產生的遮罩字樣 ----------

/** CLAUDE.md §4 的示範字樣，文件中合法出現，不擋。 */
export const CANONICAL_EXAMPLES = ['A12****90', '12****89']

const MASK_TOKEN_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9])[A-Za-z0-9]{2,3}\*{4}[A-Za-z0-9]{2}(?![A-Za-z0-9])|(?:${MRN_LABELS}|${NHI_LABELS})(?:${SEP})\*{4}(?!\*)`,
  'gi',
)

export function findMaskTokens(s: string): string[] {
  const hits: string[] = []
  for (const m of s.matchAll(MASK_TOKEN_RE)) {
    if (!CANONICAL_EXAMPLES.includes(m[0])) hits.push(m[0])
  }
  return hits
}

// ---------- 圖片／掃描檔 ----------

const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|pdf)$/i
const SENSITIVE_SEGMENTS = new Set(['00_private', 'raw', 'private', 'phi'])

export const isMediaPath = (p: string): boolean => MEDIA_EXT_RE.test(p)

export function isSensitivePath(p: string): boolean {
  return p
    .split(/[\\/]+/)
    .slice(0, -1)
    .some(seg => SENSITIVE_SEGMENTS.has(seg.toLowerCase()))
}

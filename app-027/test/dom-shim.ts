/**
 * 极简 XML / DOMParser 垫片：仅供命令行测试在 Node 下运行既有验收自检使用。
 * 只实现 importer.ts 用到的能力：标签名 / 属性 / children / getElementsByTagName。
 * 不是通用 DOM，浏览器环境不会加载本文件。
 */

type ShElement = {
  tagName: string
  nodeName: string
  attributes: Record<string, string>
  children: ShElement[]
  parent: ShElement | null
  getAttribute(name: string): string | null
  getElementsByTagName(name: string): ShElement[]
}

function makeElement(tag: string, parent: ShElement | null): ShElement {
  const el: ShElement = {
    tagName: tag,
    nodeName: tag,
    attributes: {},
    children: [],
    parent,
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    getElementsByTagName(name: string) {
      const out: ShElement[] = []
      const walk = (n: ShElement): void => {
        for (const c of n.children) {
          if (c.tagName === name) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
  }
  return el
}

class ParseError extends Error {}

/** 极简 XML 解析：支持元素 / 属性 / 自闭合 / 注释 / 声明 / 文本（忽略） */
function parseXml(text: string): ShElement {
  const root = makeElement('#document', null)
  let cur: ShElement = root
  let i = 0
  const n = text.length

  const fail = (msg: string): never => {
    throw new ParseError(`XML 解析失败（位置 ${i}）：${msg}`)
  }

  while (i < n) {
    if (text[i] !== '<') {
      // 文本节点，跳过
      const next = text.indexOf('<', i)
      i = next === -1 ? n : next
      continue
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end === -1) fail('注释未闭合')
      i = end + 3
      continue
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end === -1) fail('声明未闭合')
      i = end + 2
      continue
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE / CDATA 等，测试用 SVG 中没有 CDATA
      const end = text.indexOf('>', i + 2)
      if (end === -1) fail('声明未闭合')
      i = end + 1
      continue
    }
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i + 2)
      if (end === -1) fail('结束标签缺少 >')
      const tag = text.slice(i + 2, end).trim().toLowerCase()
      if (cur.tagName !== tag) fail(`结束标签不匹配：</${tag}> 位于 <${cur.tagName}>`)
      cur = cur.parent ?? root
      i = end + 1
      continue
    }

    // 起始标签
    let end = i + 1
    let quote: string | null = null
    while (end < n) {
      const ch = text[end]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      end += 1
    }
    if (end >= n) fail('起始标签缺少 >')
    const raw = text.slice(i + 1, end)
    const selfClose = raw.endsWith('/')
    const head = (selfClose ? raw.slice(0, -1) : raw).trim()
    const sp = head.search(/\s/)
    const tag = (sp === -1 ? head : head.slice(0, sp)).toLowerCase()
    if (!tag) fail('空标签名')
    const attrText = sp === -1 ? '' : head.slice(sp + 1)
    const el = makeElement(tag, cur)
    parseAttributes(attrText, el, fail)
    cur.children.push(el)
    if (!selfClose) cur = el
    i = end + 1
  }

  if (cur !== root) fail(`标签 <${cur.tagName}> 未闭合`)
  return root
}

function parseAttributes(s: string, el: ShElement, fail: (m: string) => never): void {
  let i = 0
  const n = s.length
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i += 1
    if (i >= n) break
    const eq = s.indexOf('=', i)
    const ws = s.slice(i).search(/\s/)
    const nameEnd = ws === -1 ? n : i + ws
    if (eq === -1 || eq > nameEnd) fail('属性缺少 =')
    const name = s.slice(i, eq).trim()
    i = eq + 1
    while (i < n && /\s/.test(s[i])) i += 1
    const q = s[i]
    if (q !== '"' && q !== "'") fail('属性值缺少引号')
    i += 1
    let val = ''
    while (i < n && s[i] !== q) {
      val += s[i]
      i += 1
    }
    if (i >= n) fail('属性值未闭合')
    i += 1
    // 属性名保留原大小写：SVG 区分大小写（viewBox 不能被压成 viewbox）
    el.attributes[name] = decodeEntities(val)
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

export type ShDocument = {
  documentElement: ShElement
  getElementsByTagName(name: string): ShElement[]
}

/** 安装全局 DOMParser 垫片（幂等） */
export function installDomShim(): void {
  const g = globalThis as unknown as { DOMParser?: unknown }
  if (g.DOMParser) return
  class ShimDOMParser {
    parseFromString(text: string, _mime: string): ShDocument {
      const doc = parseXml(text)
      const svgEl = doc.getElementsByTagName('svg')[0]
      return {
        documentElement: svgEl ?? doc,
        getElementsByTagName: (name: string) => doc.getElementsByTagName(name),
      }
    }
  }
  g.DOMParser = ShimDOMParser
}

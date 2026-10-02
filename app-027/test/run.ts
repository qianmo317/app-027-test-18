/**
 * 几何内核命令行测试入口：一条命令跑完所有判定 / 归属 / 取值 / 换算测试，
 * 并复跑页面里的既有验收自检（headless）作为回归。
 *
 * 运行：npm test
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cyclicMatch,
  findSelfIntersections,
  pointAtArcLength,
  type Pt,
} from '../src/logic/geometry'
import { buildContainmentTree } from '../src/logic/nesting'
import { cleanupContours, makeContour } from '../src/logic/cleanup'
import { computePlacement, exportGcode, exportPlt, type ExportMeta } from '../src/logic/exporters'
import { DEFAULT_CUT_SETTINGS, type ExportCfg, type MaterialPreset, type Sheet } from '../src/logic/types'
import { defaultMaterials } from '../src/data/materials'
import { runSelfTest } from '../src/logic/selftest'
import type { CutStep } from '../src/logic/order'
import { installDomShim } from './dom-shim'

declare const __PATTERN_DIR__: string

/* ------------------------------------------------------------------ */
/* 迷你测试框架：失败时给出真实实际值 / 期望值，并标注错误类别          */
/* ------------------------------------------------------------------ */

type Kind = '判定错' | '归属错' | '取值错' | '换算错' | '回归自检'

type Check = { name: string; pass: boolean; detail: string; kind: Kind }
type Section = { title: string; kind: Kind; checks: Check[] }

const sections: Section[] = []
let current: Section | null = null

function section(title: string, kind: Kind): void {
  current = { title, kind, checks: [] }
  sections.push(current)
}

/** 断言失败：消息里必须带看得见的实际值 */
class AssertFail extends Error {}

function fail(msg: string): never {
  throw new AssertFail(msg)
}

function it(name: string, body: () => string): void {
  if (!current) throw new Error('it() 必须在 section() 内调用')
  try {
    const detail = body()
    current.checks.push({ name, pass: true, detail, kind: current.kind })
  } catch (e) {
    current.checks.push({ name, pass: false, detail: (e as Error).message, kind: current.kind })
  }
}

function isTrue(cond: boolean, msg: string): void {
  if (!cond) fail(msg)
}

function eqNum(actual: number, expected: number, label: string): void {
  if (actual !== expected) fail(`${label}：期望 ${expected}，实际 ${actual}`)
}

function approx(actual: number, expected: number, tol: number, label: string): void {
  if (Math.abs(actual - expected) > tol) {
    fail(`${label}：期望 ${expected} ±${tol}，实际 ${round(actual)}`)
  }
}

function ptApprox(actual: Pt, x: number, y: number, tol: number, label: string): void {
  if (Math.abs(actual.x - x) > tol || Math.abs(actual.y - y) > tol) {
    fail(`${label}：期望 (${x}, ${y})，实际 (${round(actual.x)}, ${round(actual.y)})`)
  }
}

function round(v: number): number {
  return Math.round(v * 100000) / 100000
}

const pt = (x: number, y: number): Pt => ({ x, y })
const square = (x0: number, y0: number, w: number, h: number): Pt[] => [
  pt(x0, y0),
  pt(x0 + w, y0),
  pt(x0 + w, y0 + h),
  pt(x0, y0 + h),
]

/* ------------------------------------------------------------------ */
/* 1. 自交检测（判定错）                                                */
/* ------------------------------------------------------------------ */

section('一、自交检测：相邻段 / 共线重叠 / 明显交叉', '判定错')

it('三角形：共享端点的相邻段不算自交（闭合，3 条边两两相邻）', () => {
  const tri = [pt(0, 0), pt(10, 0), pt(5, 8)]
  const hits = findSelfIntersections(tri, true)
  eqNum(hits.length, 0, '自交点数')
  return `findSelfIntersections(三角形, closed) 返回 ${hits.length} 个交点（相邻段共享端点被跳过）`
})

it('开放折线首尾相接回到起点：非相邻索引但只在端点相碰，不算自交', () => {
  const loop = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 0)]
  const hits = findSelfIntersections(loop, false)
  eqNum(hits.length, 0, '自交点数')
  return `开口折线末点回到起点，返回 ${hits.length} 个交点（端点接触不等于交叉）`
})

it('共线重叠：两条非相邻段在 y=3 上重叠，唯一交点 (5, 3)', () => {
  const poly = [
    pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10),
    pt(0, 3), pt(8, 3), pt(8, 4), pt(3, 4),
    pt(3, 3), pt(7, 3),
  ]
  const hits = findSelfIntersections(poly, false)
  eqNum(hits.length, 1, '共线重叠交点数')
  const h = hits[0]
  isTrue(h.ai === 4 && h.bi === 8, `重叠段下标：期望 4/8，实际 ${h.ai}/${h.bi}`)
  ptApprox(h.p, 5, 3, 1e-6, '重叠段返回的点应落在重叠区间中点')
  return `交点 ${hits.length} 个：段 ${h.ai}×段 ${h.bi} 在 (${round(h.p.x)}, ${round(h.p.y)}) 共线重叠`
})

it('明显交叉：蝴蝶结四边形 (0,0)-(10,10)-(10,0)-(0,10) 在 (5, 5) 交叉', () => {
  const bow = [pt(0, 0), pt(10, 10), pt(10, 0), pt(0, 10)]
  const hits = findSelfIntersections(bow, true)
  eqNum(hits.length, 1, '交叉点数量')
  const h = hits[0]
  isTrue(h.ai === 0 && h.bi === 2, `交叉段下标：期望 0/2，实际 ${h.ai}/${h.bi}`)
  ptApprox(h.p, 5, 5, 1e-6, '交叉点坐标')
  return `交叉点 1 个：段 0×段 2 在 (${round(h.p.x)}, ${round(h.p.y)})（相邻段 0-1、1-2、2-3、3-0 不误报）`
})

/* ------------------------------------------------------------------ */
/* 2. 包含关系树（归属错）                                              */
/* ------------------------------------------------------------------ */

section('二、包含关系树：同心三层 / 贴边 / 外框断开', '归属错')

const rectC = (id: string, x0: number, y0: number, x1: number, y1: number, closed = true) =>
  makeContour(square(x0, y0, x1 - x0, y1 - y0), closed)
// makeContour 内部会重新分配 id，这里用显式 id 再包一层
const contour = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  closed = true,
) => {
  const c = rectC(id, x0, y0, x1, y1, closed)
  c.id = id
  return c
}

it('同心三层方框：层深 1/2/3，子轮廓逐级归属于直接外框（不跨级）', () => {
  const outer = contour('outer', 0, 0, 100, 100)
  const mid = contour('mid', 20, 20, 80, 80)
  const inner = contour('inner', 40, 40, 60, 60)
  const tree = buildContainmentTree([outer, mid, inner])
  eqNum(tree.maxDepth, 3, 'maxDepth')
  eqNum(tree.depthOf.get('outer')!, 1, '外层深度')
  eqNum(tree.depthOf.get('mid')!, 2, '中层深度')
  eqNum(tree.depthOf.get('inner')!, 3, '内层深度')
  const outerHoles = outer.holes.join(',')
  const midHoles = mid.holes.join(',')
  isTrue(outerHoles === 'mid', `最外层 holes 只应含直接子级 mid，实际 [${outerHoles}]`)
  isTrue(midHoles === 'inner', `中层 holes 应含 inner，实际 [${midHoles}]`)
  isTrue(tree.nestedCount === 2, `nestedCount 期望 2，实际 ${tree.nestedCount}`)
  return `深度 outer=${tree.depthOf.get('outer')} / mid=${tree.depthOf.get('mid')} / inner=${tree.depthOf.get('inner')}；` +
    `outer.holes=[${outerHoles}]，mid.holes=[${midHoles}]，maxDepth=${tree.maxDepth}`
})

it('两条轮廓贴边（共一条 x=40 的边）：互不包含，都是根', () => {
  const a = contour('A', 0, 0, 40, 40)
  const b = contour('B', 40, 0, 80, 40)
  const tree = buildContainmentTree([a, b])
  eqNum(tree.depthOf.get('A'), 1, 'A 深度')
  eqNum(tree.depthOf.get('B'), 1, 'B 深度')
  eqNum(tree.roots.length, 2, '根轮廓数量')
  eqNum(tree.nestedCount, 0, '被包含轮廓数量')
  isTrue(a.holes.length === 0 && b.holes.length === 0, `贴边双方 holes 应为空，实际 A=[${a.holes}] B=[${b.holes}]`)
  return `贴边（边界接触而非内部）：roots=${tree.roots.length}，A.holes=[${a.holes}]，B.holes=[${b.holes}]，nestedCount=0`
})

it('外框断开（未闭合 U 形框）：断框不能成为父级，内部小框不归它管', () => {
  // 开口方框：缺最后一条边（左竖边），rep 点判定不允许落在未闭合轮廓里
  const frame = makeContour(
    [pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)],
    false,
  )
  frame.id = 'broken_frame'
  const inner = contour('inner', 40, 40, 60, 60)
  const tree = buildContainmentTree([frame, inner])
  eqNum(tree.maxDepth, 1, '断框场景 maxDepth')
  eqNum(tree.depthOf.get('broken_frame'), 1, '断框深度')
  eqNum(tree.depthOf.get('inner'), 1, '内部小框深度（无父级）')
  isTrue(frame.holes.length === 0, `断框 holes 应为空，实际 [${frame.holes}]`)
  isTrue(tree.nestedCount === 0, `nestedCount 应为 0，实际 ${tree.nestedCount}`)

  // 对照：把外框闭合后，同一小框必须变成 depth 2 —— 证明差异来自“断开”而非小框位置
  const closed = contour('closed_frame', 0, 0, 100, 100)
  const ctrl = buildContainmentTree([closed, contour('inner2', 40, 40, 60, 60)])
  eqNum(ctrl.depthOf.get('inner2'), 2, '闭合对照：小框应为 depth 2')
  return `断框 maxDepth=${tree.maxDepth}，inner 深度=${tree.depthOf.get('inner')}（无父级）；` +
    `闭合外框对照 inner 深度=${ctrl.depthOf.get('inner2')}`
})

/* ------------------------------------------------------------------ */
/* 3. 按弧长取点（取值错）                                              */
/* ------------------------------------------------------------------ */

section('三、按弧长取点：首尾跨越与总长为零', '取值错')

const arcSq: Pt[] = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)] // 闭合周长 40

it('s=0：取首点 (0, 0)', () => {
  const p = pointAtArcLength(arcSq, true, 0)
  ptApprox(p, 0, 0, 1e-9, 's=0')
  return `pointAtArcLength(s=0) = (${p.x}, ${p.y})`
})

it('s=5：落在第一段上 (5, 0)', () => {
  const p = pointAtArcLength(arcSq, true, 5)
  ptApprox(p, 5, 0, 1e-9, 's=5')
  return `pointAtArcLength(s=5) = (${p.x}, ${p.y})`
})

it('s=35：跨越首尾接缝，落在最后一条边上 (0, 5)', () => {
  const p = pointAtArcLength(arcSq, true, 35)
  ptApprox(p, 0, 5, 1e-9, 's=35 跨接缝')
  return `周长 40，s=35 越过 (10,10)→(0,10) 的角点后 = (${p.x}, ${p.y})`
})

it('s=40（恰为总长）：回到首点 (0, 0)', () => {
  const p = pointAtArcLength(arcSq, true, 40)
  ptApprox(p, 0, 0, 1e-9, 's=40')
  return `pointAtArcLength(s=40) = (${p.x}, ${p.y})（闭合同一周回到起点）`
})

it('s=45（超过总长）：夹回首点而非跑到轮廓外', () => {
  const p = pointAtArcLength(arcSq, true, 45)
  ptApprox(p, 0, 0, 1e-9, 's=45')
  return `pointAtArcLength(s=45) = (${p.x}, ${p.y})`
})

it('总长为零（三个重合点）任意 s 都不产生 NaN，返回该点 (3, 7)', () => {
  const deg = [pt(3, 7), pt(3, 7), pt(3, 7)]
  const p = pointAtArcLength(deg, true, 2)
  isTrue(Number.isFinite(p.x) && Number.isFinite(p.y), `返回值必须是有限数，实际 (${p.x}, ${p.y})`)
  ptApprox(p, 3, 7, 1e-9, '零周长取值')
  return `零周长闭合轮廓 s=2 → (${p.x}, ${p.y})（退化段长度 0，按段首点返回）`
})

it('空点数组：返回原点 (0, 0) 而不抛异常', () => {
  const p = pointAtArcLength([], true, 2)
  ptApprox(p, 0, 0, 1e-9, '空数组')
  return `pointAtArcLength([], s=2) = (${p.x}, ${p.y})`
})

/* ------------------------------------------------------------------ */
/* 4. 重复路径判定（判定错）                                            */
/* ------------------------------------------------------------------ */

section('四、重复路径判定：起点不同 / 方向相反', '判定错')

const base = square(0, 0, 10, 10)
const shiftedStart = [pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)]
const reversed = [pt(0, 0), pt(0, 10), pt(10, 10), pt(10, 0)]
const almost = square(0, 0, 10, 10.5)

it('起点不同（循环移位）：cyclicMatch 判定为同一条', () => {
  const same = cyclicMatch(base, shiftedStart, 0.02)
  isTrue(same, '起点不同的同一方框应匹配')
  return `基准首点 (0,0) vs 另一版本首点 (10,0)：cyclicMatch = ${same}`
})

it('方向相反（点序反转）：cyclicMatch 判定为同一条', () => {
  const same = cyclicMatch(base, reversed, 0.02)
  isTrue(same, '反向遍历的同一方框应匹配')
  return `顺时针 vs 逆时针同一方框：cyclicMatch = ${same}`
})

it('高 0.5mm 之差的另一个方框：不能误判为重复（tol 0.02mm）', () => {
  const same = cyclicMatch(base, almost, 0.02)
  isTrue(!same, '几何上不同的轮廓不得匹配')
  return `10×10 方框 vs 10×10.5 方框：cyclicMatch = ${same}（差异远超 0.02mm 容差）`
})

it('清理流水线：原框 + 移位框 + 反向框 + 平移到 (20,20) 的框 → 保留 2 条、合并 2 条', () => {
  const translated = square(20, 20, 10, 10)
  const raw = [base, shiftedStart, reversed, translated].map((points) => ({ points, closed: true }))
  const res = cleanupContours(raw, { toleranceMm: 0.15, closeToleranceMm: 0.2 })
  eqNum(res.report.kept, 2, '保留轮廓数')
  eqNum(res.report.duplicates, 2, '被合并的重复路径数')
  eqNum(res.report.duplicateGroups.length, 1, '重复分组数')
  const removed = res.report.duplicateGroups[0]?.removed.length ?? 0
  eqNum(removed, 2, '组内被合并路径数')
  return `输入 4 条 → 保留 ${res.report.kept} 条（原框、平移框），合并 ${res.report.duplicates} 条（起点不同 1 条 + 方向相反 1 条）`
})

/* ------------------------------------------------------------------ */
/* 5. 导出坐标翻转（换算错）                                            */
/* ------------------------------------------------------------------ */

section('五、导出：左上原点翻到左下后仍落在纸幅内', '换算错')

const A4: Sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
const mat: MaterialPreset = defaultMaterials()[0]

function cutRect(w: number, h: number): CutStep[] {
  const points = square(0, 0, w, h)
  return [
    {
      seq: 1,
      contourId: 'rect',
      runIndex: 0,
      runCount: 1,
      points,
      closed: true,
      startPt: points[0],
      endPt: points[points.length - 1],
      travelFromPrevMm: 0,
      level: 1,
      layer: 0,
      lengthMm: 2 * (w + h),
    },
  ]
}

function metaFor(sheet: Sheet): ExportMeta {
  return {
    projectName: 'CLI 测试',
    formName: '坐标翻转矩形',
    material: mat,
    bridgeWidthMm: DEFAULT_CUT_SETTINGS.bridgeWidthMm,
    passes: mat.passes,
    sheet,
    cutLengthMm: 0,
    travelMm: 0,
  }
}

const pltCfg: ExportCfg = { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 }

function parsePltCoords(text: string): Array<{ cmd: string; x: number; y: number }> {
  const out: Array<{ cmd: string; x: number; y: number }> = []
  const re = /(PU|PD)(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ cmd: m[1], x: Number(m[2]), y: Number(m[3]) })
  return out
}

it('PLT：190×277mm 矩形（10mm 边距）翻转后全部落在 A4 纸幅内', () => {
  const steps = cutRect(190, 277)
  const pl = computePlacement(steps, A4, 1)
  const plt = exportPlt(steps, pltCfg, A4, metaFor(A4), pl)
  isTrue(!plt.outOfSheet, `outOfSheet 应为 false，实际 true（范围 ${plt.minX},${plt.minY}~${plt.maxX},${plt.maxY}）`)
  isTrue(plt.minX >= 0 && plt.minY >= 0 && plt.maxX <= plt.sheetMaxX && plt.maxY <= plt.sheetMaxY,
    `坐标越界：${plt.minX},${plt.minY}~${plt.maxX},${plt.maxY} / 纸幅 ${plt.sheetMaxX}×${plt.sheetMaxY}`)
  // 真实可见的换算值（0.025mm/unit）
  eqNum(plt.minX, 400, 'PLT minX')
  eqNum(plt.maxX, 8000, 'PLT maxX')
  eqNum(plt.minY, 400, 'PLT minY（内部顶边 y=287）')
  eqNum(plt.maxY, 11480, 'PLT maxY（内部底边 y=10）')
  return `放置范围 10,10~200,287mm → PLT X ${plt.minX}~${plt.maxX}｜Y ${plt.minY}~${plt.maxY}（纸幅 0~${plt.sheetMaxX}×${plt.sheetMaxY}）`
})

it('PLT 翻转数值：首点（内部左下 (0,0)）必须导出为 (400,11480)，而左上 (0,277) 才是 (400,400)', () => {
  const steps = cutRect(190, 277)
  const pl = computePlacement(steps, A4, 1)
  const plt = exportPlt(steps, pltCfg, A4, metaFor(A4), pl)
  const coords = parsePltCoords(plt.text)
  // 矩形四个角翻转前后坐标集合相同，必须按书写顺序核对配对关系才能证明真的翻了
  const first = coords[0]
  isTrue(first.cmd === 'PU' && first.x === 400 && first.y === 11480,
    `首点应为 PU400,11480（内部左下 (0,0) → y′=297−10），实际 ${first.cmd}${first.x},${first.y}`)
  const ordered = coords.map((c) => `(${c.x},${c.y})`).slice(0, 4).join('→')
  const expectSeq = '(400,11480)→(8000,11480)→(8000,400)→(400,400)'
  isTrue(ordered === expectSeq, `前四点顺序应为 ${expectSeq}，实际 ${ordered}`)
  return `书写顺序：${ordered}；手算 (297−10)/0.025=11480、(297−287)/0.025=400`
})

it('G-code（mm 单位）：同一矩形翻转后范围 X 10~200、Y 10~287，全部在纸幅内', () => {
  const steps = cutRect(190, 277)
  const pl = computePlacement(steps, A4, 1)
  const gc = exportGcode(
    steps,
    { format: 'gcode', unit: 'mm', origin: 'bottom_left', yFlip: true, scale: 1 },
    A4,
    metaFor(A4),
    pl,
  )
  isTrue(!gc.outOfSheet, `G-code outOfSheet 应为 false，实际 ${gc.minX},${gc.minY}~${gc.maxX},${gc.maxY}`)
  approx(gc.minX, 10, 0.001, 'G-code minX')
  approx(gc.maxX, 200, 0.001, 'G-code maxX')
  approx(gc.minY, 10, 0.001, 'G-code minY')
  approx(gc.maxY, 287, 0.001, 'G-code maxY')
  // 第一条定位指令就是内部左下点：翻到左下后必须是 X10 Y287（不是 X10 Y10）
  const firstMove = /G0 X(\S+) Y(\S+) F/.exec(gc.text)
  isTrue(!!firstMove && firstMove[1] === '10.000' && firstMove[2] === '287.000',
    `首条定位应为 G0 X10.000 Y287.000，实际 ${firstMove ? `G0 X${firstMove[1]} Y${firstMove[2]}` : '未找到'}`)
  return `首点 G0 X10.000 Y287.000（内部左下 (0,0)）；整体 X ${gc.minX}~${gc.maxX}｜Y ${gc.minY}~${gc.maxY}mm（纸幅 210×297）`
})

it('超高矩形（290mm）越界时必须如实标出 outOfSheet，不允许假装在纸幅内', () => {
  const steps = cutRect(200, 290)
  const pl = computePlacement(steps, A4, 1)
  const plt = exportPlt(steps, pltCfg, A4, metaFor(A4), pl)
  isTrue(plt.outOfSheet, '290mm 高矩形 + 10mm 上下边距 = 310mm > 297mm，必须报越界')
  isTrue(plt.minY < 0, `翻转后最高点应为负（297−300）×40 = −120，实际 minY=${plt.minY}`)
  approx(plt.minY, -120, 1, '越界数值 PLT minY')
  isTrue(pl.placedBounds.maxY > A4.heightMm, `排版本身就应越界，实际 maxY=${pl.placedBounds.maxY}`)
  return `200×290mm 矩形放置到 10~300mm，翻转后 PLT Y 范围 ${plt.minY}~${plt.maxY}（<0 越界），outOfSheet=${plt.outOfSheet}`
})

/* ------------------------------------------------------------------ */
/* 6. 既有页面验收自检回归（headless 复跑，结论必须与页面一致：全过）  */
/* ------------------------------------------------------------------ */

async function runLegacySelfTest(): Promise<number> {
  installDomShim()
  // patterns.ts 用 fetch(`${BASE_URL}patterns/${file}`) 读本地纹样；Node 下改读 public 文件
  const g = globalThis as unknown as { fetch?: typeof fetch }
  g.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    const file = url.slice(url.lastIndexOf('/') + 1)
    const text = readFileSync(join(__PATTERN_DIR__, file), 'utf8')
    return new Response(text, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
  }) as typeof fetch

  section('六、既有验收自检回归（与页面“开始自检”同一份 runSelfTest）', '回归自检')
  const report = await runSelfTest(DEFAULT_CUT_SETTINGS, defaultMaterials()[0])
  let failures = 0
  for (const c of report.checks) {
    current = sections[sections.length - 1]
    current.checks.push({
      name: `[${c.id}] ${c.title}`,
      pass: c.pass,
      detail: c.detail,
      kind: '回归自检',
    })
    if (!c.pass) failures += 1
  }
  return failures
}

/* ------------------------------------------------------------------ */
/* 汇总输出                                                            */
/* ------------------------------------------------------------------ */

function report(): number {
  let pass = 0
  let fail = 0
  const lines: string[] = []
  lines.push('几何内核 CLI 测试')
  lines.push('=' .repeat(72))
  for (const s of sections) {
    const sp = s.checks.filter((c) => c.pass).length
    const sf = s.checks.length - sp
    lines.push('')
    lines.push(`${s.title}  ——  ${sp} 通过 / ${sf} 失败`)
    lines.push('-'.repeat(72))
    for (const c of s.checks) {
      if (c.pass) {
        lines.push(`  ✓ ${c.name}`)
        lines.push(`      ${c.detail}`)
      } else {
        const tag = c.kind === '回归自检' ? '【回归自检不通过】' : `【${c.kind}】`
        lines.push(`  ✗ ${c.name} ${tag}`)
        lines.push(`      ${c.detail}`)
      }
    }
    pass += sp
    fail += sf
  }
  lines.push('')
  lines.push('='.repeat(72))
  lines.push(fail === 0 ? `全部通过：${pass} 项通过，0 项失败` : `合计 ${pass} 项通过，${fail} 项失败`)
  if (fail > 0) {
    lines.push('')
    lines.push('失败归类：')
    const byKind = new Map<Kind, string[]>()
    for (const s of sections) {
      for (const c of s.checks) {
        if (!c.pass) {
          const arr = byKind.get(c.kind) ?? []
          arr.push(`  - ${c.name}`)
          byKind.set(c.kind, arr)
        }
      }
    }
    for (const [kind, arr] of byKind) {
      lines.push(`  ${kind}（${arr.length}）：`)
      lines.push(...arr)
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
  return fail
}

runLegacySelfTest()
  .then(() => {
    const fail = report()
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((e: unknown) => {
    process.stderr.write(`测试运行器异常：${(e as Error).stack ?? e}\n`)
    process.exit(2)
  })

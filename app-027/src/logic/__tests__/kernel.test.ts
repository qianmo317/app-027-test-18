/**
 * 几何内核命令行测试（npm test）
 *
 * 覆盖：
 *  1. 自交检测：相邻段 / 共线重叠 / 明显交叉
 *  2. 包含关系树：同心三层 / 两条轮廓贴边 / 外框断开（含闭合对照）
 *  3. 按弧长取点：首尾跨越 / 总长为零
 *  4. 重复路径判定：起点不同 / 方向相反（含不同形状对照与清理管线合并）
 *  5. 导出换算：坐标从左上原点翻到左下后仍落在纸幅内（PLT 0.025mm / G-code mm）
 *
 * 失败分类：【判定错】内核判断与预期不符；【归属错】层深 / 子轮廓归属错；【换算错】导出坐标换算错。
 * 本文件只调用内核函数做断言，不修改任何内核实现，页面内「验收自检」（selftest.ts）结论不受影响。
 */
import type { CutStep } from '../order'
import type { ExportCfg, MaterialPreset, Pt } from '../types'
import { DEFAULT_SHEET } from '../types'
import { cleanupContours, makeContour } from '../cleanup'
import { computePlacement, exportGcode, exportPlt, type ExportMeta } from '../exporters'
import { cyclicMatch, findSelfIntersections, pointAtArcLength, polylineLength } from '../geometry'
import { buildContainmentTree } from '../nesting'

// tsx（Node）运行时提供的 process，用于失败时退出码 1；避免为此引入 @types/node
declare const process: { exit(code?: number): void }

type Cat = '判定' | '归属' | '换算'
type Result = { id: string; cat: Cat; title: string; pass: boolean; detail: string }
const results: Result[] = []

function run(id: string, cat: Cat, title: string, fn: () => { pass: boolean; detail: string }): void {
  let pass = false
  let detail = ''
  try {
    const r = fn()
    pass = r.pass
    detail = r.detail
  } catch (e) {
    detail = `异常：${(e as Error).message}`
  }
  results.push({ id, cat, title, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${pass ? '' : `【${cat}错】`}${id} ${title}`)
  console.log(`    ${detail}`)
}

function section(name: string): void {
  console.log(`\n${name}`)
}

const pt = (x: number, y: number): Pt => ({ x, y })
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const fmt = (p: Pt): string => `(${r3(p.x)}, ${r3(p.y)})`
const near = (p: Pt, x: number, y: number, eps = 1e-6): boolean => Math.abs(p.x - x) <= eps && Math.abs(p.y - y) <= eps

function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
}

function mkStep(seq: number, points: Pt[], closed: boolean): CutStep {
  return {
    seq,
    contourId: `t${seq}`,
    runIndex: 0,
    runCount: 1,
    points,
    closed,
    startPt: points[0],
    endPt: points[points.length - 1],
    travelFromPrevMm: 0,
    level: 1,
    layer: 0,
    lengthMm: polylineLength(points, closed),
  }
}

console.log('几何内核命令行测试（app-027）')
console.log('失败分类：【判定错】内核判断不符预期｜【归属错】层深/子轮廓归属错｜【换算错】导出坐标换算错')
const t0 = performance.now()

// ── 一、自交检测 ─────────────────────────────────────────────
section('一、自交检测（相邻段 / 共线重叠 / 明显交叉）')

run('si-adjacent-closed', '判定', '闭合正方形：相邻段共享端点不判自交', () => {
  const hits = findSelfIntersections(rectPts(0, 0, 10, 10), true)
  return { pass: hits.length === 0, detail: `闭合正方形 4 段 → 交点 ${hits.length} 个（期望 0）` }
})

run('si-adjacent-open', '判定', '开放折线：相邻段共享端点不判自交', () => {
  const hits = findSelfIntersections([pt(0, 0), pt(5, 5), pt(5, 0), pt(10, 5)], false)
  return { pass: hits.length === 0, detail: `之字形开放折线 3 段 → 交点 ${hits.length} 个（期望 0）` }
})

run('si-collinear-overlap', '判定', '共线重叠：非相邻段在 x=0 上重叠 4mm 判 1 个自交点', () => {
  // 段 3 = (0,10)→(0,3)，段 7（闭合段）= (0,7)→(0,0)，在 y 3~7 共线重叠
  const spur = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 3), pt(5, 3), pt(5, 7), pt(0, 7)]
  const hits = findSelfIntersections(spur, true)
  const h = hits[0]
  const pass = hits.length === 1 && h.ai === 3 && h.bi === 7 && near(h.p, 0, 5, 1e-9)
  const got = h ? `交点 ${hits.length} 个 @ ${fmt(h.p)}，段 ${h.ai}×${h.bi}` : `交点 ${hits.length} 个`
  return { pass, detail: `回折贴边轮廓 8 段（段 3 与段 7 共线重叠 y 3~7）→ ${got}（期望 1 个 @ (0, 5)，段 3×7）` }
})

run('si-clear-crossing', '判定', '明显交叉：蝴蝶结对角线判 1 个自交点', () => {
  const bowtie = [pt(0, 0), pt(10, 10), pt(10, 0), pt(0, 10)]
  const hits = findSelfIntersections(bowtie, true)
  const h = hits[0]
  const pass = hits.length === 1 && h.ai === 0 && h.bi === 2 && near(h.p, 5, 5, 1e-9)
  const got = h ? `交点 ${hits.length} 个 @ ${fmt(h.p)}，段 ${h.ai}×${h.bi}` : `交点 ${hits.length} 个`
  return { pass, detail: `蝴蝶结 4 段（段 0 与段 2 对角交叉）→ ${got}（期望 1 个 @ (5, 5)，段 0×2）` }
})

// ── 二、包含关系树 ───────────────────────────────────────────
section('二、包含关系树（同心三层 / 贴边 / 外框断开）')

run('tree-concentric-3', '归属', '同心三层：层深 1/2/3，子轮廓逐级归属', () => {
  const outer = makeContour(rectPts(20, 20, 60, 60), true)
  const mid = makeContour(rectPts(30, 30, 40, 40), true)
  const inner = makeContour(rectPts(40, 40, 20, 20), true)
  const tree = buildContainmentTree([outer, mid, inner])
  const dO = tree.depthOf.get(outer.id)
  const dM = tree.depthOf.get(mid.id)
  const dI = tree.depthOf.get(inner.id)
  const holesOk =
    outer.holes.length === 1 && outer.holes[0] === mid.id &&
    mid.holes.length === 1 && mid.holes[0] === inner.id &&
    inner.holes.length === 0
  const pass = dO === 1 && dM === 2 && dI === 3 && tree.maxDepth === 3 && tree.nestedCount === 2 && holesOk
  return {
    pass,
    detail: `depth 外=${dO} 中=${dM} 内=${dI}｜maxDepth=${tree.maxDepth}｜holes 外=${outer.holes.length} 中=${mid.holes.length} 内=${inner.holes.length}（期望 depth 1/2/3，maxDepth 3，holes 1/1/0）`,
  }
})

run('tree-edge-touching', '归属', '两条轮廓贴边（共用 x=10 边）：互不归属，同为第 1 层', () => {
  const a = makeContour(rectPts(0, 0, 10, 10), true)
  const b = makeContour(rectPts(10, 0, 10, 10), true)
  const tree = buildContainmentTree([a, b])
  const dA = tree.depthOf.get(a.id)
  const dB = tree.depthOf.get(b.id)
  const pass = dA === 1 && dB === 1 && tree.maxDepth === 1 && tree.nestedCount === 0 && a.holes.length === 0 && b.holes.length === 0
  return { pass, detail: `depth A=${dA} B=${dB}｜maxDepth=${tree.maxDepth}｜nested=${tree.nestedCount}｜holes A=${a.holes.length} B=${b.holes.length}（期望 1/1，maxDepth 1，无归属）` }
})

run('tree-open-frame', '归属', '外框断开（未闭合）：内层不被吞并，同为第 1 层', () => {
  const frame = makeContour(rectPts(0, 0, 40, 40), false)
  const inner = makeContour(rectPts(15, 15, 10, 10), true)
  const tree = buildContainmentTree([frame, inner])
  const dF = tree.depthOf.get(frame.id)
  const dI = tree.depthOf.get(inner.id)
  const pass = dF === 1 && dI === 1 && tree.maxDepth === 1 && tree.nestedCount === 0 && frame.holes.length === 0
  return { pass, detail: `外框 closed=false → depth 框=${dF} 内=${dI}｜maxDepth=${tree.maxDepth}｜框.holes=${frame.holes.length}（期望 1/1，无归属）` }
})

run('tree-closed-frame', '归属', '对照：外框闭合时内层正常归属为第 2 层', () => {
  const frame = makeContour(rectPts(0, 0, 40, 40), true)
  const inner = makeContour(rectPts(15, 15, 10, 10), true)
  const tree = buildContainmentTree([frame, inner])
  const dI = tree.depthOf.get(inner.id)
  const pass = dI === 2 && tree.maxDepth === 2 && tree.nestedCount === 1 && frame.holes.length === 1 && frame.holes[0] === inner.id
  return { pass, detail: `外框 closed=true → depth 内=${dI}｜maxDepth=${tree.maxDepth}｜框.holes=${frame.holes.length}（期望 内=2，holes=1）` }
})

// ── 三、按弧长取点 ───────────────────────────────────────────
section('三、按弧长取点（首尾跨越 / 总长为零）')

run('arc-wrap-closed', '判定', '首尾跨越：s 落在闭合段上取点正确，s=周长回到起点', () => {
  const sq = rectPts(0, 0, 10, 10) // 周长 40mm
  const p35 = pointAtArcLength(sq, true, 35)
  const p40 = pointAtArcLength(sq, true, 40)
  const pass = near(p35, 0, 5) && near(p40, 0, 0)
  return { pass, detail: `闭合正方形周长 40mm：s=35 → ${fmt(p35)}（期望 (0, 5)，在首尾闭合段中点）｜s=40=周长 → ${fmt(p40)}（期望起点 (0, 0)）` }
})

run('arc-zero-length', '判定', '总长为零：所有点重合时返回该点，不产生 NaN', () => {
  const zero = [pt(5, 5), pt(5, 5), pt(5, 5)]
  const z0 = pointAtArcLength(zero, true, 0)
  const z1 = pointAtArcLength(zero, true, 1.5)
  const finite = [z0, z1].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const pass = finite && near(z0, 5, 5) && near(z1, 5, 5)
  return { pass, detail: `三点重合（总长 0）：s=0 → ${fmt(z0)}｜s=1.5 → ${fmt(z1)}（期望均 (5, 5) 且有限）` }
})

// ── 四、重复路径判定 ─────────────────────────────────────────
section('四、重复路径判定（起点不同 / 方向相反）')

const rectA = rectPts(0, 0, 12, 8)
const rectRotated = [pt(12, 8), pt(0, 8), pt(0, 0), pt(12, 0)] // 同一矩形，起点平移 2 位
const rectReversed = [pt(12, 0), pt(0, 0), pt(0, 8), pt(12, 8)] // 同一矩形，点序反向

run('dup-rotated-start', '判定', '起点不同：循环平移的点序列判为同一条', () => {
  const same = cyclicMatch(rectA, rectRotated, 0.02)
  return { pass: same, detail: `cyclicMatch(矩形, 起点平移 2 位) = ${same}（期望 true）` }
})

run('dup-reversed', '判定', '方向相反：点序反向判为同一条', () => {
  const same = cyclicMatch(rectA, rectReversed, 0.02)
  return { pass: same, detail: `cyclicMatch(矩形, 反向点序) = ${same}（期望 true）` }
})

run('dup-different-shape', '判定', '对照：不同形状不误判为重复', () => {
  const same = cyclicMatch(rectA, rectPts(0, 0, 12, 5), 0.02)
  return { pass: !same, detail: `cyclicMatch(12×8 矩形, 12×5 矩形) = ${same}（期望 false）` }
})

run('dup-cleanup-merge', '判定', '清理管线：起点旋转 + 反向的重复路径被合并并打标', () => {
  const { contours, report } = cleanupContours(
    [
      { points: rectA, closed: true },
      { points: rectRotated, closed: true },
      { points: rectReversed, closed: true },
      { points: rectPts(50, 50, 10, 10), closed: true },
    ],
    { toleranceMm: 0.15, closeToleranceMm: 0.2 },
  )
  const kept = contours.find((c) => c.warnings.includes('duplicate'))
  const removed = report.duplicateGroups.reduce((n, g) => n + g.removed.length, 0)
  const pass = report.duplicates === 2 && contours.length === 2 && !!kept && removed === 2
  return {
    pass,
    detail: `输入 4 条（同矩形×3：原始/起点旋转/反向 + 远处矩形×1）→ 保留 ${contours.length} 条｜合并 ${report.duplicates} 条｜保留者警告 [${kept ? kept.warnings.join(',') : '无'}]（期望 保留 2｜合并 2｜警告 duplicate）`,
  }
})

// ── 五、导出换算 ─────────────────────────────────────────────
section('五、导出换算（左上 → 左下原点后仍在纸幅内）')

const MAT: MaterialPreset = {
  id: 'test-card',
  name: '测试卡纸',
  paper: 'cardstock',
  force: 120,
  speedMmS: 40,
  passes: 1,
  bladeOffsetMm: 0.25,
  backing: '蓝色中硬垫板',
}
const sheet = DEFAULT_SHEET // A4 纵向 210×297
const rect40x30 = rectPts(0, 0, 40, 30)
const steps: CutStep[] = [mkStep(1, rect40x30, true)]
const pl = computePlacement(steps, sheet, 1) // 放置后加 10mm 边距：内部 x 10~50，y 10~40
const meta: ExportMeta = {
  projectName: '内核测试',
  formName: '矩形 40×30',
  material: MAT,
  bridgeWidthMm: 0.5,
  passes: 1,
  sheet,
  cutLengthMm: polylineLength(rect40x30, true),
  travelMm: 0,
}
const PLT_CFG: ExportCfg = { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 }
const G_CFG: ExportCfg = { format: 'gcode', unit: 'mm', origin: 'bottom_left', yFlip: true, scale: 1 }
const plt = exportPlt(steps, PLT_CFG, sheet, meta, pl)
const gcode = exportGcode(steps, G_CFG, sheet, meta, pl)

run('export-plt-flip', '换算', 'PLT：y 翻转到左下原点（y′=297−y），x 不翻', () => {
  // 内部 y 10~40mm → 导出 y′ (297−40)~(297−10) = 257~287mm → 10280~11480（0.025mm/单位）
  const expMinY = Math.round((sheet.heightMm - 40) / 0.025)
  const expMaxY = Math.round((sheet.heightMm - 10) / 0.025)
  const pass = plt.minX === 400 && plt.maxX === 2000 && plt.minY === expMinY && plt.maxY === expMaxY
  return { pass, detail: `内部 y 10~40mm（左上原点）→ 导出 Y ${plt.minY}~${plt.maxY}（期望 ${expMinY}~${expMaxY}）｜X ${plt.minX}~${plt.maxX}（期望 400~2000）` }
})

run('export-plt-in-sheet', '换算', 'PLT：翻转后全部坐标落在纸幅内，文本含预期落笔点', () => {
  const inSheet = plt.minX >= 0 && plt.minY >= 0 && plt.maxX <= plt.sheetMaxX && plt.maxY <= plt.sheetMaxY && !plt.outOfSheet
  const firstPen = plt.text.includes('PU400,11480;')
  const pass = inSheet && firstPen
  return { pass, detail: `X ${plt.minX}~${plt.maxX}｜Y ${plt.minY}~${plt.maxY}｜纸幅上限 ${plt.sheetMaxX}×${plt.sheetMaxY}｜outOfSheet=${plt.outOfSheet}｜首笔 PU400,11480 出现=${firstPen}` }
})

run('export-gcode-flip', '换算', 'G-code：mm 单位翻转一致且落在纸幅内', () => {
  const expMin = sheet.heightMm - 40
  const expMax = sheet.heightMm - 10
  const firstMove = gcode.text.includes('G0 X10.000 Y287.000')
  const pass = gcode.minX === 10 && gcode.maxX === 50 && gcode.minY === expMin && gcode.maxY === expMax && !gcode.outOfSheet && firstMove
  return { pass, detail: `导出 X ${gcode.minX}~${gcode.maxX}mm｜Y ${gcode.minY}~${gcode.maxY}mm（期望 Y ${expMin}~${expMax}）｜纸幅 ${sheet.widthMm}×${sheet.heightMm}｜outOfSheet=${gcode.outOfSheet}｜首行 G0 X10.000 Y287.000 出现=${firstMove}` }
})

// ── 汇总 ─────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass)
const byCat = (cat: Cat): string => {
  const list = results.filter((r) => r.cat === cat)
  return `${cat} ${list.filter((r) => r.pass).length}/${list.length}`
}
console.log('\n' + '─'.repeat(56))
console.log(`通过 ${passed}/${results.length}（${(['判定', '归属', '换算'] as Cat[]).map(byCat).join('｜')}），耗时 ${(performance.now() - t0).toFixed(1)}ms`)
if (failed.length > 0) {
  console.log('\n失败详情：')
  for (const f of failed) {
    console.log(`  【${f.cat}错】${f.id} ${f.title}`)
    console.log(`      ${f.detail}`)
  }
  process.exit(1)
}

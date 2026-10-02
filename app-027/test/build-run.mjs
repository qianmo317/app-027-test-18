#!/usr/bin/env node
/**
 * 用项目自带的 esbuild（vite 依赖，无需额外安装）把 TS 测试打包后交给 Node 执行。
 * 等价命令：npm test
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(tmpdir(), `geometry-test-${process.pid}.mjs`)

try {
  await build({
    entryPoints: [join(root, 'run.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    outfile: out,
    logLevel: 'warning',
    alias: { '@': join(root, '..', 'src') },
    define: {
      'import.meta.env.BASE_URL': '"/"',
      __PATTERN_DIR__: JSON.stringify(join(root, '..', 'public', 'patterns')),
    },
  })
  await import(out)
} catch (e) {
  // esbuild 自身错误
  process.stderr.write(`测试构建失败：${e?.message ?? e}\n`)
  process.exitCode = 2
}
// run.ts 内部用 process.exit 反映测试结果，临时文件留到进程退出时清理
process.on('exit', () => rmSync(out, { force: true }))

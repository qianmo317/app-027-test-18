/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/** 命令行测试构建时由 esbuild define 注入：纹样 SVG 目录绝对路径 */
declare const __PATTERN_DIR__: string
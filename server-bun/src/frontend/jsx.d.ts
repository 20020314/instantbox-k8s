/**
 * JSX 全局类型。配合 tsconfig 的 `jsxImportSource: "./frontend"`，
 * TypeScript 会去找 `./frontend/jsx-runtime` 里的 jsx/jsxs 工厂函数。
 */

import type { Raw } from './jsx-runtime'

declare global {
  namespace JSX {
    /** 我们渲染出来的东西是一段已经拼好的 HTML */
    type Element = Raw

    interface ElementChildrenAttribute {
      children: {}
    }

    interface IntrinsicElements {
      [tag: string]: any
    }
  }
}

export {}

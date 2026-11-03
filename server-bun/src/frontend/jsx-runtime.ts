/**
 * 极简 JSX 运行时（对应 tsconfig 的 `jsxImportSource`）。
 *
 * 为什么不用 Elysia 的 html() 插件 / preact：
 *   我们只需要「把树拍平成 HTML 字符串」，不需要 vdom、不需要 hydration、
 *   不需要客户端运行时。手写 40 行就够，且零依赖、零构建步骤——
 *   前端从此不再需要 npm install，Bun 直接吃 .tsx。
 *
 * 支持：
 *   - 元素、属性（className / class、style 对象、布尔属性）
 *   - 数组子节点、null/undefined/false 自动跳过（可以写 `{cond && <X/>}`）
 *   - 文本自动转义；用 <Raw> 或 dangerouslySetInnerHTML 注入原始 HTML
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

export function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type Child = JSX.Element | string | number | null | undefined | boolean | Child[]

export interface JsxProps {
  children?: Child | Child[]
  [key: string]: unknown
}

/** 已序列化好的 HTML 片段（不再转义） */
export class Raw {
  constructor(readonly html: string) {}
}

export function raw(html: string): Raw {
  return new Raw(html)
}

function styleToCss(style: Record<string, string | number>): string {
  return Object.entries(style)
    .map(([k, v]) => {
      // camelCase -> kebab-case
      const prop = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
      return `${prop}:${v}`
    })
    .join(';')
}

function renderChild(c: Child): string {
  if (c === null || c === undefined || c === false || c === true) return ''
  if (c instanceof Raw) return c.html
  if (Array.isArray(c)) return c.map(renderChild).join('')
  if (typeof c === 'number') return String(c)
  if (typeof c === 'string') return esc(c)
  return ''
}

export function jsx(tag: string | ((props: JsxProps) => JSX.Element), props: JsxProps | null): Raw {
  if (typeof tag === 'function') return tag(props ?? {}) as Raw

  const { children, ...rest } = props ?? {}
  const attrs: string[] = []

  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined || value === false) continue

    if (key === 'dangerouslySetInnerHTML') {
      continue // 在下面统一处理
    }

    let name = key
    if (name === 'className') name = 'class'
    if (name === 'htmlFor') name = 'for'

    if (key === 'style' && typeof value === 'object') {
      attrs.push(`style="${esc(styleToCss(value as Record<string, string>))}"`)
      continue
    }
    if (value === true) {
      attrs.push(name)
      continue
    }
    attrs.push(`${name}="${esc(String(value))}"`)
  }

  const open = attrs.length ? `<${tag} ${attrs.join(' ')}>` : `<${tag}>`
  if (VOID.has(tag)) return new Raw(open)

  const inner =
    (rest as JsxProps).dangerouslySetInnerHTML &&
    typeof (rest as any).dangerouslySetInnerHTML === 'object'
      ? ((rest as any).dangerouslySetInnerHTML as { __html: string }).__html
      : renderChild(children as Child)

  return new Raw(`${open}${inner}</${tag}>`)
}

export const jsxs = jsx
export const jsxDEV = jsx
export const Fragment = (props: JsxProps): JSX.Element => {
  return new Raw(renderChild(props.children as Child)) as unknown as JSX.Element
}

/** 把整棵树渲染成字符串 */
export function renderToString(node: unknown): string {
  if (node instanceof Raw) return node.html
  return renderChild(node as Child)
}

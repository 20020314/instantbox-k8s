/**
 * JSX 运行时 + 语言包单测。
 * 重点覆盖「会不会 XSS」——这是手写 JSX 最容易翻车的地方。
 */

import { describe, expect, test } from 'bun:test'

import { esc, raw, renderToString } from '../src/frontend/jsx-runtime'
import { fromAcceptLanguage, pickLocale, strings, LOCALES } from '../src/frontend/i18n'

describe('转义', () => {
  test('五个字符都转', () => {
    expect(esc('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  test('JSX 文本子节点自动转义', () => {
    const evil = '<script>alert(1)</script>'
    const out = renderToString(<div>{evil}</div>)
    expect(out).toBe('<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>')
    expect(out).not.toContain('<script>')
  })

  test('属性值也转义', () => {
    const out = renderToString(<a href={'" onmouseover="alert(1)'}>x</a>)
    expect(out).not.toContain('onmouseover="alert(1)"')
    expect(out).toContain('&quot;')
  })

  test('raw() 不转义（内部使用，别拿用户输入调用）', () => {
    expect(renderToString(<div>{raw('<b>hi</b>')}</div>)).toBe('<div><b>hi</b></div>')
  })
})

describe('渲染', () => {
  test('嵌套元素', () => {
    const out = renderToString(
      <div class="a">
        <span>x</span>
        <span>y</span>
      </div>,
    )
    expect(out).toBe('<div class="a"><span>x</span><span>y</span></div>')
  })

  test('数组子节点', () => {
    const items = ['a', 'b', 'c'].map((x) => <li>{x}</li>)
    expect(renderToString(<ul>{items}</ul>)).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>')
  })

  test('null / false / undefined 被跳过', () => {
    expect(renderToString(<div>{null}{false}{undefined}{'x'}</div>)).toBe('<div>x</div>')
  })

  test('className 映射成 class', () => {
    expect(renderToString(<p className="k">x</p>)).toBe('<p class="k">x</p>')
  })

  test('style 对象转成 CSS 文本', () => {
    expect(renderToString(<div style={{ marginTop: '4px', color: 'red' }} />)).toContain(
      'style="margin-top:4px;color:red"',
    )
  })

  test('布尔 true 输出无值属性，false 不输出', () => {
    expect(renderToString(<input required disabled={false} />)).toBe('<input required>')
  })

  test('void 元素不闭合', () => {
    expect(renderToString(<br />)).toBe('<br>')
    expect(renderToString(<img src="a.png" />)).toBe('<img src="a.png">')
  })

  test('dangerouslySetInnerHTML 原样注入（用于内联 CSS）', () => {
    const out = renderToString(<style dangerouslySetInnerHTML={{ __html: 'a{color:red}' }} />)
    expect(out).toBe('<style>a{color:red}</style>')
  })
})

describe('语言判定', () => {
  test('pickLocale 认常见写法', () => {
    expect(pickLocale('zh')).toBe('zh')
    expect(pickLocale('zh-CN')).toBe('zh')
    expect(pickLocale('zh-TW')).toBe('zh_tw')
    expect(pickLocale('zh-Hant')).toBe('zh_tw')
    expect(pickLocale('zh_hk')).toBe('zh_tw')
    expect(pickLocale('en-US')).toBe('en')
    expect(pickLocale('fr')).toBe('fr')
    expect(pickLocale(null)).toBe('zh')
    expect(pickLocale('de')).toBe('zh') // 不认识就回落默认
  })

  test('fromAcceptLanguage 取第一个认得的', () => {
    expect(fromAcceptLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('en')
    expect(fromAcceptLanguage('fr-FR,fr;q=0.9')).toBe('fr')
    expect(fromAcceptLanguage(null)).toBeNull()
  })
})

describe('语言包完整性', () => {
  test('四种语言的 key 结构一致（缺 key 会导致页面出现 undefined）', () => {
    const shape = (o: unknown, prefix = ''): string[] => {
      if (o && typeof o === 'object') {
        return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
          shape(v, prefix ? `${prefix}.${k}` : k),
        )
      }
      return [prefix]
    }

    const base = shape(strings.zh).sort()
    for (const l of LOCALES) {
      expect({ locale: l, keys: shape(strings[l]).sort() }).toEqual({ locale: l, keys: base })
    }
  })

  test('没有空字符串（空文案会渲染成空白）', () => {
    for (const l of LOCALES) {
      const walk = (o: unknown): string[] => {
        if (typeof o === 'string') return [o]
        if (o && typeof o === 'object') {
          return Object.values(o as Record<string, unknown>).flatMap(walk)
        }
        return []
      }
      const empties = walk(strings[l]).filter((s) => s.trim() === '')
      expect({ locale: l, empties }).toEqual({ locale: l, empties: [] })
    }
  })
})

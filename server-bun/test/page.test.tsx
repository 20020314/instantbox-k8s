/**
 * 本地冒烟：不连集群，只验证页面渲染 + 路由分发是否正常。
 *
 * 做法：直接调 renderPage，检查关键元素都在。
 * 不做 HTTP 层测试是因为 Bun.serve 在测试里跑会占端口，
 * 真正的 HTTP 验证放到集群里做（见 README 的验收清单）。
 */

import { describe, expect, test } from 'bun:test'

import { renderPage } from '../src/frontend/page'
import { renderToString } from '../src/frontend/jsx-runtime'
import { LOCALES } from '../src/frontend/i18n'

const OS_LIST = [
  {
    label: 'Ubuntu',
    value: 'ubuntu',
    logoUrl: 'https://example.com/ubuntu.png',
    subList: [
      { label: '22.04', osCode: 'ghcr.io/x/sandbox-ubuntu-22.04:latest' },
      { label: '24.04', osCode: 'ghcr.io/x/sandbox-ubuntu-24.04:latest' },
    ],
  },
  {
    label: 'Debian',
    value: 'debian',
    logoUrl: 'https://example.com/debian.png',
    subList: [{ label: '12', osCode: 'ghcr.io/x/sandbox-debian-12:latest' }],
  },
]

function render(extra: Record<string, unknown> = {}): string {
  return renderToString(
    renderPage({
      locale: 'zh',
      osList: OS_LIST,
      selectedOs: 'ghcr.io/x/sandbox-ubuntu-22.04:latest',
      ...extra,
    } as any),
  )
}

describe('首页', () => {
  test('完整 HTML 骨架', () => {
    const html = render()
    expect(html.startsWith('<!doctype html>')).toBe(false) // doctype 由 index.ts 的 html() 补
    expect(html.startsWith('<html')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<meta name="viewport"')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  test('表单指向 /create，且带三个参数输入', () => {
    const html = render()
    expect(html).toContain('action="/create"')
    expect(html).toContain('name="cpu"')
    expect(html).toContain('name="mem"')
    expect(html).toContain('name="ttl"')
    expect(html).toContain('name="os"')
  })

  test('系统列表都渲染出来', () => {
    const html = render()
    expect(html).toContain('Ubuntu')
    expect(html).toContain('Debian')
    expect(html).toContain('sandbox-ubuntu-22.04:latest')
    expect(html).toContain('sandbox-debian-12:latest')
  })

  test('只显示当前系统对应的版本（Ubuntu 两个，不含 Debian 12）', () => {
    const html = render()
    expect(html).toContain('value="ghcr.io/x/sandbox-ubuntu-24.04:latest"')
    // Debian 的版本不该出现在版本区（它只在 os-opt 的 value 里出现一次）
    const debianCode = 'ghcr.io/x/sandbox-debian-12:latest'
    expect(html.split(debianCode).length - 1).toBe(1)
  })

  test('四种语言都能渲染，且语言栏有 4 个链接', () => {
    for (const l of LOCALES) {
      const html = render({ locale: l })
      expect(html).toContain('class="lang"')
      expect(html.split('?lang=').length - 1).toBe(4)
    }
  })

  test('默认参数是 1 核 / 512M / 24H', () => {
    const html = render()
    expect(html).toContain('value="1"')
    expect(html).toContain('value="512"')
    expect(html).toContain('value="24"')
  })

  test('没有结果时不渲染结果卡片', () => {
    const html = render()
    expect(html).not.toContain('class="btn danger"')
  })
})

describe('结果页', () => {
  const html = render({
    shareUrl: '/console/instantbox-managed-abc123',
    containerId: 'instantbox-managed-abc123',
    cpu: '2',
    mem: '1024',
    ttl: '4',
  })

  test('显示 webshell 入口，且是相对路径', () => {
    expect(html).toContain('href="/console/instantbox-managed-abc123"')
    expect(html).toContain('target="_blank"')
    // 绝不能再出现没有前缀的绝对地址（老 bug）
    expect(html).not.toMatch(/href="\/?instantbox-managed-/)
  })

  test('显示删除按钮，走 POST /purge', () => {
    expect(html).toContain('action="/purge"')
    expect(html).toContain('name="containerId"')
    expect(html).toContain('value="instantbox-managed-abc123"')
  })

  test('回显填写的参数', () => {
    expect(html).toContain('value="2"')
    expect(html).toContain('value="1024"')
    expect(html).toContain('value="4"')
  })
})

describe('错误页', () => {
  test('错误提示会显示', () => {
    const html = render({ error: '内存大小范围：64 ~ 3584' })
    expect(html).toContain('class="notice err"')
    expect(html).toContain('内存大小范围')
  })

  test('错误文案里的 HTML 会被转义', () => {
    const html = render({ error: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('XSS 防护', () => {
  test('恶意 osCode 不会逃出属性', () => {
    const evil = [
      {
        label: '"><script>alert(1)</script>',
        value: 'x',
        logoUrl: '" onerror="alert(1)',
        subList: [{ label: '<b>x</b>', osCode: '"><img src=x>' }],
      },
    ]
    const html = renderToString(
      renderPage({
        locale: 'zh',
        osList: evil as any,
        selectedOs: '"><img src=x>',
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('onerror="alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })
})

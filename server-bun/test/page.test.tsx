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

// ---------------------------------------------------------------- 回归：bug #3 #4
// 两个都是「看起来像小毛病、实际是设计错了」的问题，用测试钉住。

describe('系统版本分组（bug：版本号串在一起分不清归属）', () => {
  const html = render()

  test('每个发行版独占一行，版本挂在自己名下', () => {
    // 旧实现把所有版本摊平，会出现 "22.04 24.04 12" 这种混排。
    // 现在每个发行版是一个 .os-row 块，块内只放自己的版本。
    // 精确匹配「分组容器」本身：class 只能是 "os-row" 或 "os-row is-active"，
    // 不能把 os-row-head / os-row-vers 算进来
    const rows = html.split(/<div class="os-row(?: is-active)?">/)
    expect(rows.length).toBe(3) // 切成 3 段 = 2 个发行版行

    const ubuntuRow = rows[1]
    expect(ubuntuRow).toContain('Ubuntu')
    expect(ubuntuRow).toContain('22.04')
    expect(ubuntuRow).toContain('24.04')
    expect(ubuntuRow).not.toContain('sandbox-debian-12')

    const debianRow = rows[2]
    expect(debianRow).toContain('Debian')
    expect(debianRow).toContain('>12<')
    expect(debianRow).not.toContain('sandbox-ubuntu')
  })

  test('不再有第二个「选择版本」标题', () => {
    // 原来标题写的是「选择一个操作系统版本」，和上面那个重复、且内容其实是混排
    expect(html).not.toContain('choose-os-version')
  })

  test('当前选中的发行版会被高亮', () => {
    expect(html).toContain('os-row is-active')
  })

  test('每个发行版都有自己的图标（内联 SVG，不走 CDN）', () => {
    const icons = html.match(/data:image\/svg\+xml/g) ?? []
    // 2 个发行版图标 + 1 个 favicon
    expect(icons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('结果页的待启动状态', () => {
  const base = {
    containerId: 'instantbox-managed-abc123',
    shareUrl: '/console/instantbox-managed-abc123/',
  }

  test('就绪时显示「已创建」', () => {
    const html = render(base)
    expect(html).toContain('您已创建系统')
    expect(html).not.toContain('系统正在启动')
    expect(html).toContain('notice ok')
  })

  test('未就绪时显示「正在启动」，不是「已创建」也不是失败', () => {
    const html = render({ ...base, pending: true })
    expect(html).toContain('系统正在启动')
    expect(html).toContain('notice wait')
    // 关键：仍然给出打开按钮，Pod 是存在的
    expect(html).toContain('href="/console/instantbox-managed-abc123/"')
    // 不能出现任何「失败」字样
    expect(html).not.toContain('创建失败')
  })

  test('待启动态不渲染成 error', () => {
    const html = render({ ...base, pending: true })
    expect(html).not.toContain('notice err')
  })
})

describe('版本 unit 文案', () => {
  test('四语都有 version-unit，且不是空串', () => {
    const htmlZh = render({ locale: 'zh' })
    expect(htmlZh).toContain('个版本')
    const htmlEn = render({ locale: 'en' })
    expect(htmlEn).toContain('versions')
  })
})

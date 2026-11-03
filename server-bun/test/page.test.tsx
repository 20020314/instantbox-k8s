/**
 * 页面渲染冒烟：不连集群，直接调 renderPage 看输出。
 *
 * ★ 断言的立足点是「和上游 instantbox-frontend 一致」：
 *   上游是 React + antd 3 的 SPA，这里是 SSR + 原生 form，
 *   实现不同但 DOM 结构 / class 名 / 语义要对得上，否则「看着不像原版」。
 *   所以这里检查的是结构锚点（.app / .app__title / .app__text-editor-wrap /
 *   .ant-steps / .os-card / .ant-select / .mask），不是随便的文案。
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

const UBUNTU = 'ghcr.io/x/sandbox-ubuntu-22.04:latest'

function render(extra: Record<string, unknown> = {}): string {
  return renderToString(
    renderPage({
      locale: 'zh',
      osList: OS_LIST,
      selectedOs: UBUNTU,
      ...extra,
    } as any),
  )
}

/** 只取 <body> 里的部分：CSS 里有 `.os-card` 这类选择器，不剥掉会误判 */
function body(html: string): string {
  const i = html.indexOf('<body>')
  return i < 0 ? html : html.slice(i)
}

// ---------------------------------------------------------------- 原版骨架
describe('和原版一致的骨架', () => {
  const html = render()

  test('完整 HTML 骨架', () => {
    expect(html.startsWith('<html')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<meta name="viewport"')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  test('800px 居中容器 + 60px 细体大标题（App.scss 原值）', () => {
    expect(html).toContain('.app{width:800px;margin:0 auto')
    expect(html).toContain('.app__title{text-align:center;margin:30px 0;font-size:60px;font-weight:300')
    expect(body(html)).toContain('<div class="app">')
    expect(body(html)).toContain('<h1 class="app__title">')
  })

  test('终端窗口三件套：外壳 / 渐变标题栏 / 120px 黑底正文', () => {
    const b = body(html)
    expect(b).toContain('class="app__text-editor-wrap"')
    expect(b).toContain('class="app__title-bar"')
    expect(b).toContain('class="app__text-body"')
    // $ 打头的提示符
    expect(b).toContain('<span class="prompt-sign">$</span>')
    // 原版数值
    expect(html).toContain('.app__text-body{height:120px;background-color:rgba(0,0,0,.85)')
    expect(html).toContain('linear-gradient(to bottom,#e8e8e8,#bcbbbc)')
    expect(html).toContain('box-shadow:rgba(0,0,0,.8) 0 20px 70px')
  })

  test('右上角「Language | 中文」语言切换', () => {
    const b = body(html)
    expect(b).toContain('class="app__lang-switcher"')
    // 原版形态：当前语言 + 竖线 + 另一种语言
    expect(b).toMatch(/<span>[^<]+ \| <\/span>/)
    expect(html).toContain('.app__lang-switcher{position:absolute;top:10px;right:12px')
  })

  test('带文字的 Divider（原版 marginTop:100）', () => {
    expect(html).toContain('.ant-divider.plain{margin-top:100px}')
    expect(body(html)).toMatch(/<div class="ant-divider plain"><span>[^<]+<\/span><\/div>/)
  })

  test('antd Steps 两步：系统 / 性能参数', () => {
    const b = body(html)
    expect(b).toContain('class="ant-steps"')
    // 第一步是 is-process，第二步还没到
    expect(b).toContain('class="step is-process"')
    expect(b.split('class="step-body"').length - 1).toBe(2)
  })
})

// ---------------------------------------------------------------- 第一步
describe('第一步：选系统（200px 卡片横排 + 版本下拉）', () => {
  const html = render()
  const b = body(html)

  test('每个发行版一张卡片，卡片里只有自己的版本', () => {
    // 精确匹配卡片本身：class 只能是 "os-card" 或 "os-card is-selected"
    const cards = b.split(/<div class="os-card(?: is-selected)?">/)
    expect(cards.length).toBe(3) // 切成 3 段 = 2 张卡

    const ubuntu = cards[1]
    expect(ubuntu).toContain('Ubuntu')
    expect(ubuntu).toContain('22.04')
    expect(ubuntu).toContain('24.04')
    expect(ubuntu).not.toContain('sandbox-debian-12')

    const debian = cards[2]
    // 卡片段在 </div></div></form> 之后就被切走了，但 actions 里的 hidden input
    // 还带着当前选中的 osCode —— 那是全局状态，不是这张卡的版本列表。
    // 所以只验「版本列表里没有别的发行版」：看 option 标签。
    expect(debian).toContain('Debian')
    expect(debian).toContain('>12</option>')
    expect(debian).not.toContain('sandbox-ubuntu-22.04:latest">22.04')
    expect(debian).not.toContain('sandbox-ubuntu-24.04:latest">24.04')
  })

  test('卡片尺寸照抄原版：200px 宽 / 图标 120px / 下拉 182px', () => {
    expect(html).toContain('.os-card{width:200px;margin:10px 25px')
    expect(html).toContain('width:120px;height:120px')
    expect(html).toContain('.ant-select{width:182px;margin-top:10px')
  })

  test('每张卡都有版本下拉，选中的卡图标去灰度', () => {
    expect(b.split('class="ant-select"').length - 1).toBe(2)
    expect(b).toContain('os-card is-selected')
    // 原版是 className={classNames({isSelect})}，配合 scss 里的灰度规则
    expect(html).toContain('.select-system-config img{filter:grayscale(100%)}')
    expect(html).toContain('.select-system-config .isSelect{filter:none}')
    expect(b).toContain('<img class="isSelect"')
    expect(b).toContain('<img class=""')
  })

  test('切换版本走 /wizard，绝不能打到 /create', () => {
    // 老 bug：下拉的 requestSubmit 打到 /create，还没点创建就建了 Pod
    const formF = b.match(/<form id="f"[^>]*>/)
    expect(formF).not.toBeNull()
    expect(formF![0]).toContain('action="/wizard"')
    expect(formF![0]).not.toContain('/create')
    // 下拉挂在 f 上，并且不带 required（避免挡住 requestSubmit）
    expect(b).toMatch(/<select name="os" form="f"[^>]*onchange="this\.form\.requestSubmit\(\)"/)
    expect(b).toMatch(/<select name="os" form="f"[^>]*>/)
    const sel = b.match(/<select name="os"[^>]*>/g) ?? []
    for (const s of sel) expect(s).not.toContain('required')
  })

  test('第一步的 Create 是禁用的（原版行为）', () => {
    expect(b).toMatch(/<button class="ant-btn ant-btn-primary" type="button" disabled>创建<\/button>/)
    // 上一步也禁用
    expect(b).toMatch(/name="action" value="back" disabled/)
    // 下一步可用
    expect(b).toMatch(/name="action" value="next">/)
  })

  test('第一步不渲染资源输入框', () => {
    expect(b).not.toContain('name="cpu" id="cpu"')
    expect(b).not.toContain('class="res-form"')
  })

  test('图标用 manifest 的 logoUrl（原版就是直接吃 logoUrl）', () => {
    // 原版：<img src={item.logoUrl} />，manifest 指向 instantbox-images 的 CDN
    expect(b).toContain('src="https://example.com/ubuntu.png"')
    expect(b).toContain('src="https://example.com/debian.png"')
  })
})

// ---------------------------------------------------------------- 第二步
describe('第二步：选资源', () => {
  const html = render({ step: 1 })
  const b = body(html)

  test('换成资源表单，label 右对齐（labelCol 10 / wrapperCol 14）', () => {
    expect(b).toContain('class="res-form"')
    expect(html).toContain('.res-item>label{width:41.6667%')
    expect(html).toContain('.res-item .ctrl{width:58.3333%')
    // 三个字段都在
    for (const id of ['cpu', 'mem', 'ttl']) {
      expect(b).toContain(`id="${id}"`)
      expect(b).toContain(`name="${id}"`)
    }
  })

  test('默认参数是 1 核 / 512M / 24H', () => {
    expect(b).toContain('value="1"')
    expect(b).toContain('value="512"')
    expect(b).toContain('value="24"')
  })

  test('这一步的 Create 可用，且指向 /create', () => {
    // 按钮都在右下角的 __steps-action 容器里
    const i = b.indexOf('select-system-config__steps-action')
    expect(i).toBeGreaterThan(-1)
    const actions = b.slice(i)
    expect(actions).toContain('action="/create"')
    expect(actions).toContain('ant-btn ant-btn-primary" type="submit">创建')
    // 下一步在这里禁用，上一步可用
    expect(actions).toMatch(/name="action" value="next" disabled/)
    expect(actions).toMatch(/name="action" value="back">/)
  })

  test('向导包在 .select-system-config 白卡片里（原版的边框 + min-height:420）', () => {
    expect(html).toContain('.select-system-config{border:1px solid #c0c0c0')
    expect(html).toContain('min-height:420px')
    expect(html).toContain('margin:100px auto')
    expect(b).toContain('class="select-system-config"')
    expect(b).toContain('class="select-system-config__step-content"')
  })

  test('第一步的步骤圆圈变成已完成（打勾）', () => {
    expect(b).toContain('class="step is-done"')
    expect(b).toContain('<span class="step-icon">✓</span>')
  })

  test('表单回填用户填过的值', () => {
    const h = body(render({ step: 1, cpu: '2', mem: '1024', ttl: '4' }))
    expect(h).toContain('value="2"')
    expect(h).toContain('value="1024"')
    expect(h).toContain('value="4"')
  })
})

// ---------------------------------------------------------------- 确认 Modal
describe('确认 Modal（原版 modalVisible）', () => {
  const html = render({ step: 1, confirm: true, cpu: '2', mem: '1024', ttl: '4' })
  const b = body(html)

  test('弹出遮罩 + 配置回显', () => {
    expect(b).toContain('class="mask"')
    expect(b).toContain('class="modal"')
    expect(b).toContain('class="cfg-form"')
    // 内存按原版格式「1024 M（1.00 G）」
    expect(b).toContain('1024 M（1.00 G）')
    // 系统与版本用竖线分隔
    expect(b).toContain('class="vert-divider"')
    expect(b).toContain('Ubuntu')
    expect(b).toContain('22.04')
  })

  test('Cancel 回 /wizard，不建任何东西', () => {
    const foot = b.slice(b.indexOf('class="modal-foot"'))
    const w = foot.indexOf('action="/wizard"')
    const c = foot.indexOf('action="/create"')
    expect(w).toBeGreaterThan(-1)
    expect(c).toBeGreaterThan(w) // Cancel 在前、OK 在后，和原版按钮顺序一致
    const cancelForm = foot.slice(w, c)
    expect(cancelForm).not.toContain('name="confirm"')
    // Cancel 要带回当前 step，否则点取消会掉回第一步
    expect(cancelForm).toContain('name="step" value="1"')
  })

  test('OK 才带 confirm=1 去 /create（这是唯一真正建 Pod 的入口）', () => {
    const foot = b.slice(b.indexOf('class="modal-foot"'))
    const okForm = foot.slice(foot.indexOf('action="/create"'))
    expect(okForm).toContain('name="confirm" value="1"')
    expect(okForm).toContain('ant-btn ant-btn-primary')
    // 配置要原样带过去，否则确认后建出来的和看到的不是一台
    expect(okForm).toContain('name="cpu" value="2"')
    expect(okForm).toContain('name="mem" value="1024"')
    expect(okForm).toContain('name="ttl" value="4"')
  })

  test('不确认时（正常第二步）没有 Modal', () => {
    expect(body(render({ step: 1 }))).not.toContain('class="mask"')
  })

  test('第一步即使被传了 confirm 也不弹', () => {
    expect(body(render({ step: 0, confirm: true }))).not.toContain('class="mask"')
  })
})

// ---------------------------------------------------------------- 布局回归
// 这三条守的是「页面元素错位」这个真实反馈：
// 少了 .select-system-config 外壳、.app 上多了 padding、按钮没有绝对定位，
// 都会让内容贴左、按钮乱跑。用 CSS 原值钉住，别再退化。
describe('布局回归（错位问题）', () => {
  const html = render()
  const b = body(html)

  test('.app 是 800px 硬宽且没有左右 padding（原版就是纯 width）', () => {
    expect(html).toContain('.app{width:800px;margin:0 auto}')
    // 不能出现 padding 把内容往里挤
    expect(html).not.toContain('.app{width:800px;margin:0 auto;padding')
  })

  test('向导卡片宽度和容器一致（800px），不会左右溢出', () => {
    expect(html).toContain('.select-system-config{border:1px solid #c0c0c0')
    expect(html).toContain('width:800px;margin:100px auto')
    // 卡片有 20px 内边距，内容区是 758px；.app 不能再加 padding，否则会溢出
    expect(html).toContain('padding:20px')
  })

  test('内容区和按钮区是卡片的直接子级（DOM 层级对得上）', () => {
    const card = b.slice(b.indexOf('class="select-system-config"'))
    const content = card.indexOf('select-system-config__step-content')
    const action = card.indexOf('select-system-config__steps-action')
    expect(content).toBeGreaterThan(-1)
    expect(action).toBeGreaterThan(content) // 按钮区在内容之后
  })

  test('卡片内图片统一灰度，选中项单独去灰度（原版 scss 两条规则）', () => {
    expect(html).toContain('.select-system-config img{filter:grayscale(100%)}')
    expect(html).toContain('.select-system-config .isSelect{filter:none}')
  })

  test('Steps 连接线只在两个图标之间，不拉满整格', () => {
    expect(html).toContain('.ant-steps .step:not(:last-child)::after')
    // 关键：right 是负的 50% 偏移（连到下一格图标），不是 right:0
    expect(html).toMatch(/\.ant-steps \.step:not\(:last-child\)::after\{[^}]*right:calc\(-50% \+ 28px\)/)
  })

  test('antd Card body 的 8px 内边距生效（上游用 !important 改过）', () => {
    expect(html).toContain('.os-card{padding:8px}')
    expect(html).toContain('margin:10px 25px')
  })
})

// ---------------------------------------------------------------- 结果页
describe('结果页（原版 isExistContainer 分支）', () => {
  const html = render({
    created: true,
    shareUrl: '/console/instantbox-managed-abc123/',
    containerId: 'instantbox-managed-abc123',
    cpu: '2',
    mem: '1024',
    ttl: '4',
  })
  const b = body(html)

  test('换成配置卡片，不再显示向导', () => {
    expect(b).toContain('class="result-card"')
    expect(b).toContain('class="cfg-form"')
    expect(b).not.toContain('class="ant-steps"')
    expect(b).not.toContain('class="os-card')
  })

  test('回显配置：内存 512M 显示成「0.50 G」', () => {
    expect(b).toContain('1024 M（1.00 G）')
    expect(b).toContain('>2</dd>')
    expect(b).toContain('>4</dd>')
    expect(b).toContain('instantbox-managed-abc123')
  })

  test('Launch webshell 是 outline 按钮，rel 相对路径新窗口', () => {
    expect(b).toContain('ant-btn-lg ant-btn-outline-primary')
    expect(b).toContain('href="/console/instantbox-managed-abc123/"')
    expect(b).toContain('target="_blank"')
    // 绝不能再出现没有前缀的绝对地址（老 bug）
    expect(b).not.toMatch(/href="\/?instantbox-managed-/)
  })

  test('Purge 是 outline danger 按钮，走 POST /purge', () => {
    expect(b).toContain('ant-btn-lg ant-btn-outline-danger')
    expect(b).toContain('action="/purge"')
    expect(b).toContain('name="containerId"')
    expect(b).toContain('value="instantbox-managed-abc123"')
  })

  test('没 created 标记时即便给了 shareUrl 也还是向导', () => {
    const h = body(render({ shareUrl: '/console/x/', containerId: 'x' }))
    expect(h).toContain('class="ant-steps"')
    expect(h).not.toContain('class="result-card"')
  })
})

describe('待启动状态', () => {
  const base = {
    created: true,
    containerId: 'instantbox-managed-abc123',
    shareUrl: '/console/instantbox-managed-abc123/',
  }

  test('就绪：标题是「您已创建系统」，没有启动中提示', () => {
    const b = body(render(base))
    expect(b).toContain('您已创建系统')
    expect(b).not.toContain('class="spin-text"')
    expect(b).not.toContain('系统正在启动')
  })

  test('未就绪：说系统还在启动，仍然给打开按钮', () => {
    const b = body(render({ ...base, pending: true }))
    expect(b).toContain('class="spin-text"')
    expect(b).toContain('启动中')
    // 关键：Pod 是存在的，按钮必须在
    expect(b).toContain('href="/console/instantbox-managed-abc123/"')
    // 不能出现任何「失败」措辞（这就是老 bug：建好了却显示失败）
    expect(b).not.toContain('class="err-banner"')
    expect(b).not.toContain('创建失败')
  })
})

// ---------------------------------------------------------------- 错误 / 安全
describe('错误提示', () => {
  test('错误显示在 err-banner 里', () => {
    const b = body(render({ step: 1, error: '内存大小范围：64 ~ 3584' }))
    expect(b).toContain('class="err-banner"')
    expect(b).toContain('内存大小范围')
  })

  test('错误文案里的 HTML 会被转义', () => {
    const b = body(render({ error: '<img src=x onerror=alert(1)>' }))
    expect(b).not.toContain('<img src=x')
    expect(b).toContain('&lt;img')
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

// ---------------------------------------------------------------- i18n
describe('多语言', () => {
  test('四种语言都能渲染，切换语言不报错', () => {
    for (const l of LOCALES) {
      const html = render({ locale: l })
      expect(html).toContain('class="app__lang-switcher"')
      expect(html).toContain('?lang=')
      // 每次提交都带 lang，否则下一步会掉回默认语言
      expect(html).toContain(`value="${l}"`)
    }
  })

  test('语言切换只有两种目标（当前 + 另一种），不像以前那样摊成 4 个链接', () => {
    const b = body(render())
    expect(b.split('?lang=').length - 1).toBe(1)
  })
})

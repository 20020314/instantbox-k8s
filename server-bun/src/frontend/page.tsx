/**
 * 页面渲染 —— 真正的 JSX，服务端直接拍平成 HTML。
 *
 * ★ 设计原则：**视觉和布局复刻上游 instantbox-frontend**
 *   （React + antd 3 + CRA，源码 github.com/instantbox/instantbox-frontend）。
 *   这是「换个技术栈重写」，不是重设计，所以原来是长什么样的，这里就该是长什么样：
 *     * 800px 居中容器、60px 细体大标题
 *     * `$` 打头的终端窗口（标题栏渐变 + 黑色正文）
 *     * 右上角「Language | 中文」语言切换
 *     * 带文字居中的 Divider（"选择一个操作系统"）
 *     * antd Steps 两步向导：① OS ② Resources
 *     * 第一步是系统卡片横排（卡片：系统名 / 120px 图标 / 版本下拉）
 *     * 第二步点 Create 弹 Modal 展示 SystemConfiguration，确认后才建
 *     * 已创建时换成 SystemConfiguration 卡片 + Launch / Purge 两个按钮
 *
 * 技术实现（不影响视觉）：
 *   * 不要客户端框架。原版是 SPA，这里是 SSR + 原生 <form>，
 *     用一次 form.requestSubmit() 完成「换版本 / 下一步 / 上一步」的重渲染。
 *   * antd 组件用纯 CSS 复刻（Card / Steps / Select / Button / Modal / Divider），
 *     内联在 <style> 里：没有构建步骤，也不依赖 CDN（内网集群拉不到）。
 */

import type { OsItem } from '../sandbox'
import { strings, type Locale } from './i18n'
import { osIconDataUrl } from './icons'
import { Raw, raw } from './jsx-runtime'

export interface PageState {
  locale: Locale
  osList: OsItem[]
  selectedOs: string
  shareUrl?: string
  containerId?: string
  error?: string
  cpu?: string
  mem?: string
  ttl?: string
  /** 已经建好一台（原版的 isExistContainer）：换掉向导，显示配置 + 按钮 */
  created?: boolean
  /** Pod 还没进入 Running（镜像还在拉）——要说「正在启动」而不是「已创建」 */
  pending?: boolean
  /** 向导当前步：0 = 选系统，1 = 选资源 */
  step?: 0 | 1
  /** 第二步点了 Create，正在弹确认框（原版的 modalVisible） */
  confirm?: boolean
  /**
   * 正在等待系统启动（点了确定、Pod 已建但 ttyd 还没应答）。
   *
   * 这一页会带自动轮询脚本：每 1.5s 查 /api/job/<id>，
   * 状态变了就改文案，就绪就跳结果页。见 index.ts 的 handleCreating。
   */
  creating?: {
    podPhase: string
    shellReady: boolean
  }
}

// ---------------------------------------------------------------- 样式
// 数值全部照抄上游 App.scss / index.css，antd 组件样式手写。
const CSS = `
/* ---------- 上游 index.css ---------- */
body{margin:0;padding:0;font-family:sans-serif,'Helvetica','Roboto','Arial';
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
  background:#fafafa;color:rgba(0,0,0,.65);font-size:14px;line-height:1.5}
*,*::before,*::after{box-sizing:border-box}
code{font-family:source-code-pro,Menlo,Monaco,Consolas,'Courier New',monospace}
a{color:#1890ff;text-decoration:none}
a:hover{color:#40a9ff}

/* ---------- 上游 App.scss ---------- */
/* 原版没有 padding；800px 是硬宽度（不是 max-width），所以内容不会被左右挤偏 */
.app{width:800px;margin:0 auto}
.app__title{text-align:center;margin:30px 0;font-size:60px;font-weight:300;
  color:rgba(0,0,0,.85)}
.app__title-span{position:relative}
.app__desc{margin:25px 0;text-align:center}
.app__lang-switcher{position:absolute;top:10px;right:12px;font-size:14px;color:rgba(0,0,0,.45)}
.app__lang-switcher p{margin:0}

/* 终端窗口 */
.app__text-editor-wrap{display:block;margin:auto;max-width:740px;border-radius:10px;
  box-shadow:rgba(0,0,0,.8) 0 20px 70px;clear:both;overflow:hidden;
  transition:all .5s ease-out}
.app__title-bar{padding:5px 0;font-family:'Lucida Grande',sans-serif;font-size:.75em;
  text-align:center;text-shadow:rgba(255,255,255,.8) 0 1px 0;
  background-color:#f8f8f8;
  background-image:linear-gradient(to bottom,#e8e8e8,#bcbbbc);
  box-shadow:inset rgba(255,255,255,.7) 0 1px 1px;
  border-bottom:#6a6a6a 1px solid;color:#333}
.app__text-body{height:120px;background-color:rgba(0,0,0,.85);padding:10px;
  color:#f0f0f0;text-shadow:#000 0 1px 0;font-family:'Consolas','Courier New','Courier';
  font-weight:bold;text-align:left;overflow:hidden;transition:all .5s ease-out}
.app__text-body .prompt-sign{margin-right:10px}
.app__desc-content{white-space:pre-wrap}
/* 打字机光标（原版是 typed.js，视觉上就是一根闪的光标） */
.app__desc-content::after{content:'';display:inline-block;width:8px;height:15px;
  background:#f0f0f0;margin-left:2px;vertical-align:-2px;
  animation:blink 1.05s step-end infinite}
@keyframes blink{50%{opacity:0}}

/* ---------- antd Divider（带文字） ---------- */
.ant-divider{display:flex;align-items:center;margin:16px 0;font-size:16px;
  color:rgba(0,0,0,.85);font-weight:500;white-space:nowrap}
.ant-divider::before,.ant-divider::after{content:'';flex:1;border-top:1px solid #e8e8e8}
.ant-divider>span{padding:0 1em}
/* 页面顶部那个 Divider 是 <Divider style={{marginTop:100}}> */
.ant-divider.plain{margin-top:100px}
/* Divider type="vertical"：系统名 | 版本号 之间的竖线 */
.ant-divider.vertical{display:inline-block;flex:none;width:1px;height:.9em;
  margin:0 8px;background:#e8e8e8;vertical-align:-1px;border:0}
.ant-divider.vertical::before,.ant-divider.vertical::after{display:none}

/* ---------- 上游 SelectSystemConfig.scss ---------- */
/* ★ 整个向导是一张白卡片：边框 + min-height:420 + margin:100px auto + padding-bottom:60。
   少了这层，下面的 Steps / 卡片 / 按钮全都贴着页面左边，按钮也没地方绝对定位。 */
.select-system-config{border:1px solid #c0c0c0;border-radius:2px;background:#fff;
  min-height:420px;width:800px;margin:100px auto;padding:20px;
  padding-bottom:60px;position:relative}
.select-system-config__step-content{display:flex;flex-wrap:wrap;
  justify-content:center;align-items:space-around}
/* 三个按钮钉在卡片右下角。
   原版每个 button 都是 float:right，容器又绝对定位在右边 —— 结果第一个
   （Create）最靠右，依次往左是 Next、Back。
   这里用 flex + row-reverse 复刻：DOM 第一项排在最右边。 */
.select-system-config__steps-action{position:absolute;right:20px;bottom:20px;
  margin-top:20px;display:flex;flex-direction:row-reverse;align-items:center}
.select-system-config__steps-action form,
.select-system-config__steps-action button{margin:0 4px}
.select-system-config img{filter:grayscale(100%)}
.select-system-config .isSelect{filter:none}
/* antd Card 的 body 内边距被上游改成了 8px（!important） */
.os-card{padding:8px}

/* ---------- antd Steps（horizontal，默认 size） ---------- */
/* antd 3 的 Steps：每个 step 是 flex:1，图标 32px 圆，标题和描述在图标右侧，
   图标和文字整体在各自格子里居中。
   连接线只连「本步图标右侧」到「下一步图标左侧」，而不是拉满整格 ——
   这里用 left/right 相对图标位置算：图标在格子中心偏左 4px（gap 8 的一半）。 */
.ant-steps{display:flex;margin-bottom:16px}
.ant-steps .step{flex:1;display:flex;position:relative;min-width:0}
.ant-steps .step:not(:last-child)::after{content:'';position:absolute;top:16px;
  /* 从本步图标右边 4px 起，到下一格图标左边 4px 止 */
  left:calc(50% + 16px + 8px);right:calc(-50% + 28px);height:1px;background:#e8e8e8}
.ant-steps .step-body{display:flex;gap:8px;align-items:flex-start;
  margin:0 auto;text-align:left;min-width:0}
.ant-steps .step-icon{width:32px;height:32px;border-radius:32px;flex:none;
  display:flex;align-items:center;justify-content:center;font-size:16px;
  border:1px solid rgba(0,0,0,.25);color:rgba(0,0,0,.45);background:#fff;
  position:relative;z-index:1}
.ant-steps .step.is-process .step-icon{border-color:#1890ff;color:#1890ff}
.ant-steps .step.is-done .step-icon{border-color:#1890ff;background:#1890ff;color:#fff}
.ant-steps .step-title{font-size:16px;font-weight:500;color:rgba(0,0,0,.45);
  line-height:32px;white-space:nowrap}
.ant-steps .step.is-process .step-title,
.ant-steps .step.is-done .step-title{color:rgba(0,0,0,.85);font-weight:500}
.ant-steps .step-desc{font-size:14px;color:rgba(0,0,0,.45);margin-top:2px}

/* ---------- 第一步：系统卡片（原版 200px 宽的 antd Card 横排） ---------- */
/* 原版：<Card style={{width:200, margin:'10px 25px'}}>，body padding 被改成 8px。
   Card 本身 padding 0 + 内层 body 8px，所以这里合并成一层 8px。
   antd Card 没有边框色变化，也没有外发光 —— 选中只靠图标去掉灰度。 */
.os-cards{display:flex;flex-wrap:wrap;justify-content:center;align-items:space-around}
.os-card{width:200px;margin:10px 25px;background:#fff;border:1px solid #e8e8e8;
  border-radius:2px;padding:8px;text-align:center}
.os-card-name{text-align:center;color:rgba(0,0,0,.65);font-size:14px}
.os-card img{display:block;width:120px;height:120px;margin:0 auto;
  filter:grayscale(100%)}
.os-card img.isSelect{filter:none}

/* antd Select */
.ant-select{width:182px;margin-top:10px;position:relative}
.ant-select select{width:100%;height:32px;padding:0 26px 0 11px;font-size:14px;
  color:rgba(0,0,0,.65);background:#fff;border:1px solid #d9d9d9;border-radius:2px;
  appearance:none;-webkit-appearance:none;cursor:pointer;font-family:inherit}
.ant-select:hover select{border-color:#40a9ff}
.ant-select select:focus{outline:none;border-color:#40a9ff;box-shadow:0 0 0 2px rgba(24,144,255,.2)}
.ant-select::after{content:'';position:absolute;right:11px;top:50%;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid rgba(0,0,0,.25);transform:translateY(-50%);pointer-events:none}

/* ---------- 第二步：资源表单（原版 SelectForm：Form layout="horizontal"） ---------- */
/* antd 3 FormItem horizontal：
     .ant-form-item            display:flex; 整行居中（justify-content:flex-end 的反向）
     .ant-form-item-label      labelCol=10/24 → 41.6667%，text-align:right
     .ant-form-item-control    wrapperCol=14/24 → 58.3333%
   行与行之间 margin-bottom:24px。
   原版 Form 没有居中容器，宽度撑满卡片（800 - 20*2 = 760），所以这里不要 max-width。 */
.res-form{width:100%}
.res-item{display:flex;align-items:flex-start;margin-bottom:24px;font-size:14px}
.res-item>label{width:41.6667%;padding:0 8px;text-align:right;
  color:rgba(0,0,0,.85);line-height:40px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;font-weight:bold}
.res-item>label::after{content:':';margin:0 8px 0 2px;position:relative;top:-.5px}
.res-item .ctrl{width:58.3333%}
.ant-input{width:200px;height:32px;padding:4px 11px;font-size:14px;font-family:inherit;
  color:rgba(0,0,0,.65);background:#fff;border:1px solid #d9d9d9;border-radius:2px}
.ant-input:hover{border-color:#40a9ff}
.ant-input:focus{outline:none;border-color:#40a9ff;box-shadow:0 0 0 2px rgba(24,144,255,.2)}

/* ---------- antd Button ---------- */
.ant-btn{font-family:inherit;font-size:14px;height:32px;padding:0 15px;border-radius:2px;
  border:1px solid #d9d9d9;background:#fff;color:rgba(0,0,0,.65);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;transition:all .3s;
  line-height:1.5;text-decoration:none}
.ant-btn:hover{border-color:#40a9ff;color:#40a9ff;text-decoration:none}
.ant-btn:disabled,.ant-btn:disabled:hover{cursor:not-allowed;color:rgba(0,0,0,.25);
  background:#f5f5f5;border-color:#d9d9d9}
.ant-btn-primary{background:#1890ff;border-color:#1890ff;color:#fff}
.ant-btn-primary:hover{background:#40a9ff;border-color:#40a9ff;color:#fff}
.ant-btn-primary:disabled,.ant-btn-primary:disabled:hover{background:#f5f5f5;
  border-color:#d9d9d9;color:rgba(0,0,0,.25)}
.ant-btn-lg{height:40px;padding:0 15px;font-size:16px}
.ant-btn-outline-primary{background:#fff;border-color:#1890ff;color:#1890ff}
.ant-btn-outline-primary:hover{background:#1890ff;color:#fff}
.ant-btn-outline-danger{background:#fff;border-color:#ff4d4f;color:#ff4d4f}
.ant-btn-outline-danger:hover{background:#ff4d4f;color:#fff}

/* 向导按钮的定位由 .select-system-config__steps-action 负责（右下角），
   这里只保留兜底：万一外壳没生效也不至于全挤在一起 */
.actions{display:flex;justify-content:center;gap:8px;margin-top:20px}
.select-system-config__steps-action .actions{position:static;margin:0}

/* ---------- 结果页（原版 isExistContainer 分支） ---------- */
/* 原版：<Card><div className="app__ports"><SystemConfiguration .../></div></Card>
   Card 撑满 800px，SystemConfiguration 是 labelCol 12 / wrapperCol 12 的 Form。 */
.result-card{background:#fff;border:1px solid #e8e8e8;border-radius:2px;
  padding:24px;font-weight:bold}
.cfg-form{margin:0;width:100%}
.cfg-item{display:flex;margin-bottom:24px;line-height:1.5;font-size:14px;font-weight:normal}
/* 原版 customLabel：固定 110px 右对齐，然后才是 labelCol 12 的格子 */
.cfg-item>dt{width:50%;padding-right:8px;text-align:right;color:rgba(0,0,0,.85)}
.cfg-item>dt::after{content:':';margin:0 8px 0 2px}
.cfg-item>dd{margin:0;width:50%;color:rgba(0,0,0,.65);word-break:break-all}
/* 等价于 antd <Divider type="vertical"> */
.vert-divider{display:inline-block;width:1px;height:.9em;background:#e8e8e8;
  margin:0 8px;vertical-align:-1px}
/* 原版是两个 size="large" 的 outline 按钮，各带 margin:10 */
.result-actions{margin-top:20px;text-align:center}
.result-actions .ant-btn{margin:10px}
.notice-line{text-align:center;color:rgba(0,0,0,.45);font-size:13px;margin:8px 0 0}
.spin-text{text-align:center;color:#1890ff;font-size:13px;margin:0 0 12px}

/* ---------- 等待系统启动（点了确定之后） ---------- */
.creating-box{display:flex;flex-direction:column;align-items:center;
  justify-content:center;min-height:280px;padding:20px 0}
.spinner{width:40px;height:40px;border:3px solid #f0f0f0;border-top-color:#1890ff;
  border-radius:50%;animation:ib-spin .9s linear infinite}
@keyframes ib-spin{to{transform:rotate(360deg)}}
.creating-title{margin:20px 0 6px;font-size:16px;color:rgba(0,0,0,.85)}
.creating-phase{margin:0;font-size:13px;color:rgba(0,0,0,.45)}
.creating-elapsed{margin:4px 0 0;font-size:12px;color:rgba(0,0,0,.35)}

/* ---------- antd Modal ---------- */
.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;
  align-items:flex-start;justify-content:center;padding-top:100px;z-index:1000}
.modal{background:#fff;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.15);
  width:520px;max-width:calc(100vw - 32px)}
.modal-head{padding:16px 24px;border-bottom:1px solid #e8e8e8;font-weight:500;
  font-size:16px;color:rgba(0,0,0,.85)}
.modal-body{padding:24px;max-height:60vh;overflow:auto}
.modal-foot{padding:10px 16px;border-top:1px solid #e8e8e8;
  display:flex;gap:8px;justify-content:flex-end}

.err-banner{background:#fff2f0;border:1px solid #ffccc7;border-radius:2px;
  padding:8px 15px;margin-bottom:16px;color:#cf1322;font-size:14px}

@media (max-width:840px){
  .app{width:100%}
  .app__title{font-size:40px;margin:20px 0}
  .os-card{margin:10px;width:calc(50% - 20px)}
  .res-item{flex-direction:column}
  .res-item>label{width:100%;text-align:left}
  .res-item .ctrl{width:100%}
  .app__lang-switcher{position:static;text-align:center;margin-bottom:8px}
}
`

// ---------------------------------------------------------------- 组件

/**
 * 全局隐藏语言域 —— 每次提交都带上，保证下一步还知道用哪种语言。
 *
 * 不能塞进 <form id="f">：`requestSubmit()` 会被表单的约束校验挡住
 * （第二步的 number 输入框还空着时，选个系统版本就提交不了）。
 */
function LangField({ locale }: { locale: Locale }) {
  return <input type="hidden" name="lang" form="f" value={locale} />
}

/** 右上角语言切换 —— 原版是「Language | 中文」 */
function LangSwitcher({ locale }: { locale: Locale }) {
  const t = strings[locale]
  const other: Locale = locale === 'en' ? 'zh' : 'en'
  return (
    <div class="app__lang-switcher">
      <p>
        <span>{t.language} | </span>
        <a href={`?lang=${other}`}>{other === 'zh' ? '中文' : 'English'}</a>
      </p>
    </div>
  )
}

/** 终端窗口 —— 原版的 __text-editor-wrap / __title-bar / __text-body */
function TerminalBox({ title, text }: { title: string; text: string }) {
  return (
    <div class="app__text-editor-wrap">
      <div class="app__title-bar">{title}</div>
      <div class="app__text-body">
        <span class="prompt-sign">$</span>
        <span class="app__desc-content">{text}</span>
      </div>
    </div>
  )
}

/** antd Steps：两步 */
function Steps({ locale, step }: { locale: Locale; step: number }) {
  const t = strings[locale]
  const items = [
    { title: t.keyword.os, desc: t.prompt['choose-os'] },
    { title: t.keyword.resources, desc: t.prompt['choose-resources'] },
  ]
  return (
    <div class="ant-steps">
      {items.map((it, i) => {
        const cls = i < step ? 'step is-done' : i === step ? 'step is-process' : 'step'
        return (
          <div class={cls}>
            <div class="step-body">
              <span class="step-icon">{i < step ? '✓' : i + 1}</span>
              <div>
                <div class="step-title">{it.title}</div>
                <div class="step-desc">{it.desc}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 第一步：系统卡片横排。
 *
 * 原版每张 Card：系统名 / 120px 图标 / antd Select 版本下拉；
 * 选中某张卡 = 选中它下拉里的 osCode（`selectsObj[index]`）。
 * 这里用原生 <select>，onchange 提交表单 —— 等价于原版的 onChange + setState。
 */
function OsCards({
  osList,
  selected,
  locale,
}: {
  osList: OsItem[]
  selected: string
  locale: Locale
}) {
  const t = strings[locale]
  return (
    <div class="os-cards">
      {osList.map((o) => {
        const active = o.subList.some((s) => s.osCode === selected)
        return (
          <div class={active ? 'os-card is-selected' : 'os-card'}>
            <div class="os-card-name">{o.label}</div>
            <img
              className={active ? 'isSelect' : ''}
              // 原版就是 <img src={item.logoUrl}>，logoUrl 指向
              // cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/<name>.png。
              // manifest 里没填（或填了但断网拉不到）时，src 挂真实 PNG 的内联
              // 副本兜底；再认不出的发行版才用 SVG 字母块，避免破图。
              src={o.logoUrl || osIconDataUrl(o.value, o.label)}
              alt={o.label}
            />
            <div class="ant-select">
              {/* form="f" + 不带 required：选版本要能自由提交，不能被别的字段挡住 */}
              <select
                name="os"
                form="f"
                onchange="this.form.requestSubmit()"
                aria-label={t.prompt['choose-os-version']}
              >
                {o.subList.map((s) => (
                  <option value={s.osCode} selected={s.osCode === selected}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 第二步：资源表单（原版 SelectForm：Form layout="horizontal"，labelCol 10 / wrapperCol 14） */
function ResourceForm({ state }: { state: PageState }) {
  const t = strings[state.locale]
  // 字段和上下限照抄上游 SelectForm.getRules()：
  //   cpu 1~4 / mem 1~3584 / timeout 1~24（port 已被去掉，K8s 下没有对外开放端口这回事）
  const fields = [
    {
      id: 'cpu',
      label: t.keyword['cpu-core-count'],
      value: state.cpu ?? '1',
      min: '1',
      max: '4',
      ph: t.sentence['eg-cpu-core-count'],
    },
    {
      id: 'mem',
      label: t.keyword['memory-in-mb'],
      value: state.mem ?? '512',
      min: '1',
      max: '3584',
      ph: t.sentence['eg-memory-in-mb'],
    },
    {
      id: 'ttl',
      label: t.keyword['ttl-in-hours'],
      value: state.ttl ?? '24',
      min: '1',
      max: '24',
      ph: t.sentence['eg-ttl-in-hours'],
    },
  ]
  return (
    <div class="res-form">
      {fields.map((f) => (
        <div class="res-item">
          <label for={f.id}>{f.label}</label>
          <div class="ctrl">
            <input
              class="ant-input"
              id={f.id}
              name={f.id}
              type="number"
              inputmode="numeric"
              min={f.min}
              max={f.max}
              step="1"
              required
              value={f.value}
              placeholder={f.ph}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 原版 SystemConfiguration：dt/dd 两列，OS 用竖线分隔系统与版本 */
function ConfigList({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const label = osLabel(state.osList, state.selectedOs)
  const sp = label.lastIndexOf(' ')
  const sys = sp > 0 ? label.slice(0, sp) : label
  const ver = sp > 0 ? label.slice(sp + 1) : ''
  const memNum = Number(state.mem ?? 512)
  return (
    <dl class="cfg-form">
      <div class="cfg-item">
        <dt>{t.keyword.os}</dt>
        <dd>
          {sys}
          {ver ? <span class="vert-divider" /> : null}
          {ver}
        </dd>
      </div>
      <div class="cfg-item">
        <dt>{t.keyword['cpu-core-count']}</dt>
        <dd>{state.cpu ?? '1'}</dd>
      </div>
      <div class="cfg-item">
        <dt>{t.keyword.memory}</dt>
        <dd>
          {state.mem ?? '512'} M（{(memNum / 1024).toFixed(2)} G）
        </dd>
      </div>
      <div class="cfg-item">
        <dt>{t.keyword['ttl-in-hours']}</dt>
        <dd>{state.ttl ?? '24'}</dd>
      </div>
      {state.containerId ? (
        <div class="cfg-item">
          <dt>ID</dt>
          <dd>{state.containerId}</dd>
        </div>
      ) : null}
    </dl>
  )
}

function osLabel(osList: OsItem[], code: string): string {
  for (const o of osList) {
    for (const s of o.subList) if (s.osCode === code) return `${o.label} ${s.label}`
  }
  return code
}

/** 第二步点 Create 后的确认 Modal（原版 modalVisible + SystemConfiguration） */
function ConfirmModal({ state }: { state: PageState }) {
  const t = strings[state.locale]
  return (
    <div class="mask">
      <div class="modal">
        <div class="modal-head">{t.prompt['selected-os-resources']}</div>
        <div class="modal-body">
          <ConfigList state={state} />
        </div>
        {/* 两个按钮各自一个 form：Cancel 回到第二步，OK 才真正 POST /create */}
        <div class="modal-foot">
          <form method="post" action="/wizard">
            <input type="hidden" name="lang" value={state.locale} />
            <input type="hidden" name="os" value={state.selectedOs} />
            <input type="hidden" name="cpu" value={state.cpu ?? '1'} />
            <input type="hidden" name="mem" value={state.mem ?? '512'} />
            <input type="hidden" name="ttl" value={state.ttl ?? '24'} />
            <input type="hidden" name="step" value="1" />
            <button class="ant-btn" type="submit">
              {t.keyword.cancel}
            </button>
          </form>
          <form method="post" action="/create">
            <input type="hidden" name="lang" value={state.locale} />
            <input type="hidden" name="os" value={state.selectedOs} />
            <input type="hidden" name="cpu" value={state.cpu ?? '1'} />
            <input type="hidden" name="mem" value={state.mem ?? '512'} />
            <input type="hidden" name="ttl" value={state.ttl ?? '24'} />
            <input type="hidden" name="confirm" value="1" />
            <button class="ant-btn ant-btn-primary" type="submit">
              {t.keyword.confirm}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

/**
 * 等待页：点了「确定」到系统真能开 shell 之间。
 *
 * ★ 为什么不在这里阻塞渲染：拉镜像 + 起 ttyd 要 20~90 秒。
 *   在服务端 await 会让浏览器转圈几十秒、还可能被网关掐断。
 *   所以页面立刻返回，靠下面这段轮询脚本自己推进。
 *
 * 轮询目标 /api/job/<id> 返回：
 *   { phase: 'pending'|'ready'|'timeout'|'failed', podPhase, shellReady, ... }
 *   * pending → 改文案继续等（区分「调度中」「拉镜像」「起容器」）
 *   * ready   → location 跳 /created
 *   * timeout → 跳到 /created?pending=1（Pod 还在，给按钮让用户自己重试）
 *   * failed  → 跳到 /created?...&failed=1 或直接显示错误
 */
function CreatingView({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const c = state.creating
  const podPhase = c?.podPhase ?? 'Pending'

  // Pod phase 翻译成人话，比裸的 Pending/Running 有用得多
  const phaseText =
    podPhase === 'Pending'
      ? t.sentence['os-starting']
      : podPhase === 'Running'
        ? t.prompt['os-starting']
        : podPhase
  const id = state.containerId ?? ''

  return (
    <div class="select-system-config">
      <div class="creating-box">
        <div class="spinner" />
        <p class="creating-title">{t.prompt['os-starting']}</p>
        <p class="creating-phase" id="ib-phase">
          {phaseText}
        </p>
        <p class="creating-elapsed" id="ib-elapsed">
          0s
        </p>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function(){
  var id=${JSON.stringify(id)};
  var lang=${JSON.stringify(state.locale)};
  if(!id) return;
  var t0=Date.now(), el=document.getElementById('ib-elapsed'),
      ph=document.getElementById('ib-phase'), tries=0;
  var texts=${JSON.stringify({
    pending: t.sentence['os-starting'],
    running: t.prompt['os-starting'],
  })};
  function tick(){
    if(el) el.textContent=Math.round((Date.now()-t0)/1000)+'s';
  }
  tick(); var timer=setInterval(tick,1000);
  function poll(){
    tries++;
    if(tries>240){ clearInterval(timer); location.reload(); return; }
    fetch('/api/job/'+encodeURIComponent(id),{headers:{accept:'application/json'}})
      .then(function(r){return r.json()})
      .then(function(j){
        if(j.phase==='ready'){
          clearInterval(timer);
          // 已经能连 shell 了：直接进终端，不用再绕一次结果页点「打开系统」
          location.replace(j.shellUrl || ('/created?'+j.query));
          return;
        }
        if(j.phase==='failed'||j.phase==='timeout'){
          clearInterval(timer);
          location.replace('/created?'+j.query);
          return;
        }
        // 还在等：更新阶段文案
        if(ph){
          ph.textContent = (j.podPhase==='Running')?texts.running:texts.pending;
        }
        setTimeout(poll,1500);
      })
      .catch(function(){ setTimeout(poll,3000) });
  }
  setTimeout(poll,800);
})();
`,
        }}
      />
    </div>
  )
}

/** 结果页（原版 isExistContainer 为 true 的分支） */
function ResultView({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const pending = state.pending === true
  return (
    <div>
      {pending ? <p class="spin-text">{t.sentence['os-starting']}</p> : null}
      {/* 原版：<Card><div className="app__ports"><SystemConfiguration/></div></Card> */}
      <div class="result-card">
        <div class="app__ports">
          <ConfigList state={state} />
        </div>
      </div>
      <div class="result-actions">
        <a
          class="ant-btn ant-btn-lg ant-btn-outline-primary"
          href={state.shareUrl}
          target="_blank"
          rel="noopener"
          title={t.sentence['open-webshell-try-again']}
        >
          {t.prompt['open-os']}
        </a>
        <form method="post" action="/purge" style="display:inline">
          <input type="hidden" name="containerId" value={state.containerId ?? ''} />
          <input type="hidden" name="lang" value={state.locale} />
          <button class="ant-btn ant-btn-lg ant-btn-outline-danger" type="submit">
            {t.prompt['purge-os']}
          </button>
        </form>
      </div>
      <p class="notice-line">{t.sentence['open-webshell']}</p>
    </div>
  )
}

// ---------------------------------------------------------------- 页面
export function renderPage(state: PageState) {
  const t = strings[state.locale]
  const selected = state.selectedOs || state.osList[0]?.subList[0]?.osCode || ''
  const step = state.step ?? 0
  const created = state.created === true && !!state.shareUrl
  const osTitles = state.osList.map((o) => o.label).join(' / ') || t.site.heading

  return (
    <html lang={state.locale.replace('_', '-')}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{t.site.heading}</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f2f2f'/%3E%3Ctext x='16' y='23' font-size='16' font-family='monospace' fill='white' text-anchor='middle'%3E%3E_%3C/text%3E%3C/svg%3E"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="app">
          <h1 class="app__title">
            <span class="app__title-span">{t.site.heading}</span>
          </h1>

          <div class="app__desc">
            <TerminalBox title={osTitles} text={t.site.typed} />
          </div>

          <LangSwitcher locale={state.locale} />

          <div class="ant-divider plain">
            <span>
              {state.creating
                ? t.prompt['os-starting']
                : created
                  ? t.prompt['created-os']
                  : t.prompt['select-os']}
            </span>
          </div>

          {state.error ? <div class="err-banner">{state.error}</div> : null}

          {state.creating ? (
            <CreatingView state={state} />
          ) : created ? (
            <ResultView state={state} />
          ) : (
            <>
              {/* 原版结构：.select-system-config 白卡片 > Steps > Divider > 内容 > 右下角按钮 */}
              <div class="select-system-config">
                {/* 只负责接住第一步版本下拉的 requestSubmit：这时候只换系统，绝不建 Pod */}
                <form id="f" method="post" action="/wizard">
                  <input type="hidden" name="step" value={String(step)} />
                  <LangField locale={state.locale} />

                  <Steps locale={state.locale} step={step} />
                  <div class="ant-divider" />

                  <div class="select-system-config__step-content">
                    {step === 0 ? (
                      <OsCards osList={state.osList} selected={selected} locale={state.locale} />
                    ) : (
                      <ResourceForm state={state} />
                    )}
                  </div>
                </form>

                {/*
                  三个按钮各自一个 form（HTML 不允许 form 嵌套）：
                    * Next / Back 只是重渲染另一屏 → /wizard
                    * Create 只有第二步才可用 → /create，服务端先弹 Modal，
                      带 confirm=1 才是真建（原版 modalVisible 的等价物）
                  原版顺序是 Create / Next / Back，容器用了 row-reverse 让它们在
                  右下角从右往左排 —— 视觉上第一个是最右边的 Create。
                */}
                <div class="select-system-config__steps-action">
                  {step === 1 ? (
                    <form method="post" action="/create">
                      <LangField locale={state.locale} />
                      <input type="hidden" name="os" value={selected} />
                      <input type="hidden" name="cpu" value={state.cpu ?? '1'} />
                      <input type="hidden" name="mem" value={state.mem ?? '512'} />
                      <input type="hidden" name="ttl" value={state.ttl ?? '24'} />
                      <button class="ant-btn ant-btn-primary" type="submit">
                        {t.keyword.create}
                      </button>
                    </form>
                  ) : (
                    <button class="ant-btn ant-btn-primary" type="button" disabled>
                      {t.keyword.create}
                    </button>
                  )}

                  <form method="post" action="/wizard">
                    <LangField locale={state.locale} />
                    <input type="hidden" name="os" value={selected} />
                    <input type="hidden" name="cpu" value={state.cpu ?? '1'} />
                    <input type="hidden" name="mem" value={state.mem ?? '512'} />
                    <input type="hidden" name="ttl" value={state.ttl ?? '24'} />
                    <input type="hidden" name="step" value={String(step)} />
                    <button class="ant-btn" type="submit" name="action" value="next" disabled={step === 1}>
                      {t.keyword.next}
                    </button>
                  </form>

                  <form method="post" action="/wizard">
                    <LangField locale={state.locale} />
                    <input type="hidden" name="os" value={selected} />
                    <input type="hidden" name="cpu" value={state.cpu ?? '1'} />
                    <input type="hidden" name="mem" value={state.mem ?? '512'} />
                    <input type="hidden" name="ttl" value={state.ttl ?? '24'} />
                    <input type="hidden" name="step" value={String(step)} />
                    <button class="ant-btn" type="submit" name="action" value="back" disabled={step === 0}>
                      {t.keyword.back}
                    </button>
                  </form>
                </div>
              </div>

              {state.confirm && step === 1 ? <ConfirmModal state={state} /> : null}
            </>
          )}
        </div>
      </body>
    </html>
  )
}

export { raw, Raw }

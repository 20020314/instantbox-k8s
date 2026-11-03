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
.app{width:800px;margin:0 auto;padding:0 12px 80px}
.app__title{text-align:center;margin:30px 0;font-size:60px;font-weight:300;
  color:rgba(0,0,0,.85);letter-spacing:-.02em}
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
.ant-divider.plain{margin-top:100px}

/* ---------- antd Steps ---------- */
.ant-steps{display:flex;margin-bottom:16px}
.ant-steps .step{flex:1;display:flex;align-items:flex-start;position:relative}
.ant-steps .step:not(:last-child)::after{content:'';position:absolute;top:16px;
  left:calc(50% + 20px);right:0;height:1px;background:#e8e8e8}
.ant-steps .step.is-done:not(:last-child)::after{background:#1890ff}
.ant-steps .step-body{display:flex;gap:8px;align-items:flex-start;
  margin:0 auto;text-align:left;padding-right:8px}
.ant-steps .step-icon{width:32px;height:32px;border-radius:32px;flex:none;
  display:flex;align-items:center;justify-content:center;font-size:16px;
  border:1px solid rgba(0,0,0,.25);color:rgba(0,0,0,.45);background:#fff}
.ant-steps .step.is-process .step-icon{border-color:#1890ff;color:#1890ff}
.ant-steps .step.is-done .step-icon{border-color:#1890ff;background:#1890ff;color:#fff}
.ant-steps .step-title{font-size:16px;font-weight:500;color:rgba(0,0,0,.45);line-height:32px}
.ant-steps .step.is-process .step-title,
.ant-steps .step.is-done .step-title{color:rgba(0,0,0,.85);font-weight:600}
.ant-steps .step-desc{font-size:14px;color:rgba(0,0,0,.45);margin-top:2px}

/* ---------- 第一步：系统卡片（原版 200px 宽的 antd Card 横排） ---------- */
.os-cards{display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start}
.os-card{width:200px;margin:10px 25px;background:#fff;border:1px solid #e8e8e8;
  border-radius:2px;padding:24px;text-align:center;transition:all .3s}
.os-card.is-selected{border-color:#1890ff;box-shadow:0 0 0 2px rgba(24,144,255,.15)}
.os-card-name{text-align:center;color:rgba(0,0,0,.85);font-size:14px}
.os-card img{display:block;width:120px;height:120px;margin:0 auto;object-fit:contain;
  opacity:.45;filter:grayscale(1);transition:all .3s}
.os-card img.isSelect{opacity:1;filter:none}

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

/* ---------- 第二步：资源表单（labelCol 10 / wrapperCol 14） ---------- */
.res-form{max-width:460px;margin:0 auto}
.res-item{display:flex;align-items:flex-start;margin-bottom:24px}
.res-item>label{width:41.6667%;padding-right:8px;text-align:right;line-height:32px;
  color:rgba(0,0,0,.85)}
.res-item>label::after{content:':';margin:0 8px 0 2px;position:relative;top:-.5px}
.res-item .ctrl{width:58.3333%}
.res-hint{font-size:12px;color:rgba(0,0,0,.45);line-height:1.6;margin-top:4px}
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

.actions{display:flex;justify-content:center;gap:8px;margin-top:20px}

/* ---------- 结果页（原版 isExistContainer 分支） ---------- */
.result-card{background:#fff;border:1px solid #e8e8e8;border-radius:2px;padding:24px}
.cfg-form{margin:0;max-width:520px;margin-left:auto;margin-right:auto}
.cfg-item{display:flex;margin-bottom:16px;line-height:1.5}
.cfg-item>dt{width:50%;padding-right:8px;text-align:right;color:rgba(0,0,0,.85);font-weight:bold}
.cfg-item>dt::after{content:':';margin:0 8px 0 2px}
.cfg-item>dd{margin:0;width:50%;color:rgba(0,0,0,.65);word-break:break-all}
.vert-divider{display:inline-block;width:1px;height:.9em;background:#e8e8e8;
  margin:0 8px;vertical-align:-1px}
.result-actions{margin-top:20px;text-align:center}
.result-actions .ant-btn{margin:10px}
.notice-line{text-align:center;color:rgba(0,0,0,.45);font-size:13px;margin:8px 0 0}
.spin-text{text-align:center;color:#1890ff;font-size:13px;margin:0 0 12px}

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
              src={osIconDataUrl(o.value, o.label)}
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

/** 第二步：资源表单（原版 SelectForm：label 右对齐 + 200px 输入框） */
function ResourceForm({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const fields = [
    {
      id: 'cpu',
      label: t.keyword['cpu-core-count'],
      value: state.cpu ?? '1',
      min: '1',
      max: '4',
      ph: t.sentence['eg-cpu-core-count'],
      hint: t.sentence['msg-cpu-core-count'],
    },
    {
      id: 'mem',
      label: t.keyword['memory-in-mb'],
      value: state.mem ?? '512',
      min: '64',
      max: '3584',
      ph: t.sentence['eg-memory-in-mb'],
      hint: t.sentence['msg-memory-in-mb'],
    },
    {
      id: 'ttl',
      label: t.keyword['ttl-in-hours'],
      value: state.ttl ?? '24',
      min: '1',
      max: '24',
      ph: t.sentence['eg-ttl-in-hours'],
      hint: t.sentence['msg-ttl-in-hours'],
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
            <div class="res-hint">{f.hint}</div>
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

/** 结果页（原版 isExistContainer 为 true 的分支） */
function ResultView({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const pending = state.pending === true
  return (
    <div>
      {pending ? <p class="spin-text">{t.sentence['os-starting']}</p> : null}
      <div class="result-card">
        <ConfigList state={state} />
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
            <span>{created ? t.prompt['created-os'] : t.prompt['select-os']}</span>
          </div>

          {state.error ? <div class="err-banner">{state.error}</div> : null}

          {created ? (
            <ResultView state={state} />
          ) : (
            <div>
              {/* 只负责接住第一步版本下拉的 requestSubmit：这时候只换系统，绝不建 Pod */}
              <form id="f" method="post" action="/wizard">
                <input type="hidden" name="step" value={String(step)} />
                <LangField locale={state.locale} />

                <Steps locale={state.locale} step={step} />
                <div class="ant-divider" />

                {step === 0 ? (
                  <OsCards osList={state.osList} selected={selected} locale={state.locale} />
                ) : (
                  <ResourceForm state={state} />
                )}
              </form>

              {/*
                三个按钮各自一个 form：
                  * Next / Back 只是重渲染另一屏 → /wizard
                  * Create 只有第二步才可用 → /create，且服务端先弹 Modal，
                    带 confirm=1 才是真建（原版 modalVisible 的等价物）
                原版第一步的 Create 是 disabled，这里保持。
              */}
              <div class="actions">
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

              {state.confirm && step === 1 ? <ConfirmModal state={state} /> : null}
            </div>
          )}
        </div>
      </body>
    </html>
  )
}

export { raw, Raw }

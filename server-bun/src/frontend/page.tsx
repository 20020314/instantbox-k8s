/**
 * 页面渲染 —— 真正的 JSX，服务端直接拍平成 HTML。
 *
 * 设计取舍：
 *   * 不要客户端框架。这个项目只有「选系统 → 填参数 → 提交」三步，
 *     用原生 <form> + 服务端 POST 就够，页面关掉 JS 也能用。
 *   * 唯一需要 JS 的地方是「切换系统时联动版本列表」：用原生
 *     `onchange="this.form.requestSubmit()"` 提交一次，服务端重渲染，
 *     20 行代码都不需要写。
 *   * 样式内联在 <style> 里，没有构建步骤、没有 CSS 打包、没有 FOUC。
 */

import type { OsItem } from '../sandbox'
import { strings, type Locale, LOCALES } from './i18n'
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
  /** Pod 还没进入 Running（镜像还在拉）——结果页要说「正在启动」而不是「已创建」 */
  pending?: boolean
}

// ---------------------------------------------------------------- 样式
const CSS = `
:root{
  --bg:#f5f6f8; --card:#ffffff; --text:#17191d; --muted:#6b7280;
  --line:#e2e5ea; --accent:#2f6feb; --accent-weak:#eaf1fe;
  --ok:#0f7a58; --err:#c0392b; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#131519; --card:#1b1e23; --text:#e9ebee; --muted:#9aa0a6;
    --line:#2b3037; --accent:#6ba1ff; --accent-weak:#1d2940;
    --ok:#4ecb9b; --err:#ff7b6b;
    color-scheme:dark;
  }
}
*,*::before,*::after{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,
       "Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:880px;margin:0 auto;padding:40px 20px 72px}
header.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:26px;margin:0;letter-spacing:-.02em}
.tag{font-size:12px;color:var(--muted);border:1px solid var(--line);
     padding:1px 8px;border-radius:999px}
.spacer{flex:1}
.typed{color:var(--muted);margin:8px 0 26px;font-size:14px}
nav.lang{display:flex;gap:3px}
nav.lang a{font-size:12px;padding:4px 9px;border-radius:6px;color:var(--muted);
  border:1px solid transparent;white-space:nowrap}
nav.lang a:hover{background:var(--card);text-decoration:none;color:var(--text)}
nav.lang a[aria-current]{background:var(--accent-weak);color:var(--accent);
  border-color:var(--accent);font-weight:600}

.card{background:var(--card);border:1px solid var(--line);
      border-radius:10px;padding:20px 22px 24px;margin-bottom:16px}
.card>h2{font-size:15px;margin:0 0 14px;font-weight:600;display:flex;align-items:center;gap:9px}
.step{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;
  border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:700;flex:none}

/* ---- 系统总览：一个发行版一行，版本号挂在它自己名下 ---- */
.os-overview{display:flex;flex-direction:column;gap:8px}
.os-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:11px 14px;border:1px solid var(--line);border-radius:9px;
  background:var(--bg);transition:border-color .12s,background .12s}
.os-row:hover{border-color:var(--accent)}
.os-row.is-active{border-color:var(--accent);background:var(--accent-weak);
  box-shadow:inset 0 0 0 1px var(--accent)}
.os-row-head{display:flex;align-items:center;gap:10px;min-width:168px;flex:none}
.os-row-head img{width:26px;height:26px;object-fit:contain;flex:none}
.os-row-head .nm{font-weight:600}
.os-row-head .cnt{font-size:11.5px;color:var(--muted);
  border:1px solid var(--line);border-radius:999px;padding:0 7px}
.os-row-vers{display:flex;flex-wrap:wrap;gap:7px}

/* ---- 版本 chip ---- */
.ver-opt{position:relative;cursor:pointer}
.ver-opt input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.ver-chip{display:inline-block;padding:5px 14px;border-radius:999px;font-size:13px;
  border:1px solid var(--line);background:var(--card);
  font-variant-numeric:tabular-nums;transition:all .12s}
.ver-opt:hover .ver-chip{border-color:var(--accent)}
.ver-opt input:checked+.ver-chip{background:var(--accent);border-color:var(--accent);
  color:#fff;font-weight:600}
.ver-opt input:focus-visible+.ver-chip{outline:2px solid var(--accent);outline-offset:2px}

.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.hint{display:block;font-size:12px;color:var(--muted);margin-top:5px;font-weight:400}
.field input,.field select{
  width:100%;padding:9px 11px;font:inherit;font-size:14px;color:var(--text);
  background:var(--bg);border:1px solid var(--line);border-radius:7px;
  font-variant-numeric:tabular-nums;
}
.field input:focus,.field select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-weak)}

.actions{display:flex;gap:10px;align-items:center;margin-top:20px;flex-wrap:wrap}
.btn{font:inherit;font-weight:600;font-size:14px;padding:9px 20px;border-radius:7px;
  border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;
  display:inline-block;line-height:1.35}
.btn:hover{filter:brightness(1.07);text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border-color:var(--line)}
.btn.ghost:hover{background:var(--bg);filter:none}
.btn.danger{background:var(--err);border-color:var(--err)}
.mono{font-family:var(--mono);font-size:12.5px}

.notice{padding:12px 14px;border-radius:8px;font-size:13.5px;margin-bottom:16px;
  border:1px solid var(--line);background:var(--bg);line-height:1.6}
.notice.err{border-color:var(--err);color:var(--err);
  background:var(--bg)}
.notice.ok{border-color:var(--ok);background:var(--bg)}
.notice.wait{border-color:var(--accent);background:var(--accent-weak)}
.step.wait{background:var(--accent-weak);color:var(--accent);
  border:1px solid var(--accent)}
.notice b{color:inherit}
code{font-family:var(--mono);font-size:12.5px;background:rgba(128,128,128,.14);
  padding:1px 5px;border-radius:4px;word-break:break-all}

dl.summary{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;
  margin:16px 0 0;font-size:14px}
dl.summary dt{color:var(--muted)}
dl.summary dd{margin:0;font-weight:500}

footer{margin-top:32px;font-size:12px;color:var(--muted);text-align:center}
.empty{padding:16px;border:1px dashed var(--line);border-radius:8px;
  color:var(--muted);font-size:13.5px}
`

// ---------------------------------------------------------------- 组件
function LangNav({ locale }: { locale: Locale }) {
  return (
    <nav class="lang">
      {LOCALES.map((l) => (
        <a href={`?lang=${l}`} aria-current={l === locale ? 'page' : undefined}>
          {strings[l].language}
        </a>
      ))}
    </nav>
  )
}

function VersionPicker({ osList, selected }: { osList: OsItem[]; selected: string }) {
  const parent = osList.find((o) => o.subList.some((s) => s.osCode === selected))
  if (!parent) return <div class="empty">—</div>
  return (
    <div class="versions">
      {parent.subList.map((s) => (
        <label class="ver-opt">
          <input
            type="radio"
            name="os"
            value={s.osCode}
            checked={s.osCode === selected}
            form="f"
            onchange="this.form.requestSubmit()"
          />
          <span class="ver-chip">{s.label}</span>
        </label>
      ))}
    </div>
  )
}

/**
 * 系统总览 —— 每个发行版一行，列出它有哪些版本。
 *
 * 原来的做法是把所有版本摊平成一个横向列表，结果 Ubuntu / Debian / Alpine
 * 的版本号混在一起（"20.04 22.04 24.04 12 3.20"），根本看不出 12 是 Debian 的、
 * 3.20 是 Alpine 的。现在按发行版分组，每组带自己的图标和名字。
 */
function OsOverview({
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
    <div class="os-overview">
      {osList.map((o) => {
        const active = o.subList.some((s) => s.osCode === selected)
        return (
          <div class={`os-row${active ? ' is-active' : ''}`}>
            <div class="os-row-head">
              <img src={osIconDataUrl(o.value, o.label)} alt="" />
              <span class="nm">{o.label}</span>
              <span class="cnt">
                {o.subList.length} {t.keyword['version-unit'] ?? ''}
              </span>
            </div>
            <div class="os-row-vers">
              {o.subList.map((s) => {
                const on = s.osCode === selected
                return (
                  <label class={`ver-opt${on ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name="os"
                      value={s.osCode}
                      checked={on}
                      form="f"
                      onchange="this.form.requestSubmit()"
                    />
                    <span class="ver-chip">{s.label}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function osLabel(osList: OsItem[], code: string): string {
  for (const o of osList) {
    for (const s of o.subList) if (s.osCode === code) return `${o.label} ${s.label}`
  }
  return code
}

function ResultCard({ state }: { state: PageState }) {
  const t = strings[state.locale]
  const id = state.containerId ?? ''
  const pending = state.pending === true
  return (
    <div class="card">
      <h2>
        <span class={pending ? 'step wait' : 'step'}>{pending ? '⋯' : '✓'}</span>
        {pending ? (t.prompt['os-starting'] ?? t.prompt['created-os']) : t.prompt['created-os']}
      </h2>
      <div class={`notice ${pending ? 'wait' : 'ok'}`}>
        {pending
          ? (t.sentence['os-starting'] ?? t.sentence['open-webshell'])
          : t.sentence['open-webshell']}
        <br />
        <span class="hint">{t.sentence['open-webshell-try-again']}</span>
      </div>
      <dl class="summary">
        <dt>{t.keyword.os}</dt>
        <dd>{osLabel(state.osList, state.selectedOs)}</dd>
        <dt>{t.keyword['cpu-core-count']}</dt>
        <dd>{state.cpu ?? ''}</dd>
        <dt>{t.keyword['memory-in-mb']}</dt>
        <dd>{state.mem ?? ''}</dd>
        <dt>{t.keyword['ttl-in-hours']}</dt>
        <dd>{state.ttl ?? ''}</dd>
        <dt>ID</dt>
        <dd class="mono">{id}</dd>
      </dl>
      <div class="actions">
        <a class="btn" href={state.shareUrl} target="_blank" rel="noopener">
          {t.prompt['open-os']}
        </a>
        <form method="post" action="/purge">
          <input type="hidden" name="containerId" value={id} />
          <input type="hidden" name="lang" value={state.locale} />
          <button class="btn danger" type="submit">
            {t.prompt['purge-os']}
          </button>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 页面
export function renderPage(state: PageState) {
  const t = strings[state.locale]
  const selected = state.selectedOs || state.osList[0]?.subList[0]?.osCode || ''

  return (
    <html lang={state.locale.replace('_', '-')}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{t.site.heading}</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6feb'/%3E%3Ctext x='16' y='23' font-size='16' font-family='monospace' fill='white' text-anchor='middle'%3E%3E_%3C/text%3E%3C/svg%3E"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="wrap">
          <header class="top">
            <h1>{t.site.heading}</h1>
            <span class="tag">Kubernetes</span>
            <span class="spacer" />
            <LangNav locale={state.locale} />
          </header>
          <p class="typed">{t.site.typed}</p>

          {state.error ? <div class="notice err">{state.error}</div> : null}
          {state.shareUrl ? <ResultCard state={state} /> : null}

          <form id="f" method="post" action="/create">
            <input type="hidden" name="lang" value={state.locale} />

            <div class="card">
              <h2>
                <span class="step">1</span>
                {t.prompt['select-os']}
              </h2>
              <OsOverview osList={state.osList} selected={selected} locale={state.locale} />
            </div>

            <div class="card">
              <h2>
                <span class="step">2</span>
                {t.prompt['choose-resources']}
              </h2>
              <div class="fields">
                <div class="field">
                  <label for="cpu">
                    {t.keyword['cpu-core-count']}
                    <span class="hint">{t.sentence['msg-cpu-core-count']}</span>
                  </label>
                  <input
                    id="cpu"
                    name="cpu"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max="4"
                    step="1"
                    required
                    value={state.cpu ?? '1'}
                    placeholder={t.sentence['eg-cpu-core-count']}
                  />
                </div>
                <div class="field">
                  <label for="mem">
                    {t.keyword['memory-in-mb']}
                    <span class="hint">{t.sentence['msg-memory-in-mb']}</span>
                  </label>
                  <input
                    id="mem"
                    name="mem"
                    type="number"
                    inputmode="numeric"
                    min="64"
                    max="3584"
                    step="64"
                    required
                    value={state.mem ?? '512'}
                    placeholder={t.sentence['eg-memory-in-mb']}
                  />
                </div>
                <div class="field">
                  <label for="ttl">
                    {t.keyword['ttl-in-hours']}
                    <span class="hint">{t.sentence['msg-ttl-in-hours']}</span>
                  </label>
                  <input
                    id="ttl"
                    name="ttl"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max="24"
                    step="1"
                    required
                    value={state.ttl ?? '24'}
                    placeholder={t.sentence['eg-ttl-in-hours']}
                  />
                </div>
              </div>
              <div class="actions">
                <button class="btn" type="submit">
                  {t.keyword.create}
                </button>
              </div>
            </div>
          </form>

          <footer>instantbox · Kubernetes edition</footer>
        </div>
      </body>
    </html>
  )
}

export { raw, Raw }

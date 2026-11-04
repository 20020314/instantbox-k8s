"""沙箱「等待就绪」中转页。

## 为什么需要这个页面

官方前端的 `shareUrl` 直接指向 `/console/<pod>`，点「打开」就开窗。
但在 Pod 刚创建时，Caddy 反代到 `<pod>.<ns>.svc:1588` 会因为 DNS 没有
Service、或者 Pod 已经 Running 但 ttyd 还没起监听而返回 **502**。
用户看到的就是一个白底 502 错误页，既不知道发生了什么，也不知道该不该刷新。

## 做法

把 `/console/<pod>` 拆成两层：

    浏览器  ->  gateway 的 /console/<pod>          （静态页：等待界面）
            ->  gateway 的 /console/<pod>/_console  （真 ttyd 反代）
            ->  API 的   /_state/<pod>              （状态轮询）

中转页自己轮询状态，ready 之后用 `location.replace` 跳进真终端。
**这里不用 `location.href`** —— 用 replace 才不会在浏览器历史里留下中转页，
用户在终端里按后退能直接回到 instantbox 主页，而不是卡在"正在启动"。

状态查询走 API 而不是让前端猜，是因为只有服务端能看 Pod 的
`containerStatuses[].ready`；光看 HTTP 状态码的话，「DNS 还没建好」
和「Pod 真的很慢」两种情况分不出来。
"""

# 页面整体不依赖任何外部资源（不用 CDN 字体 / 图标），
# 内网集群常常没有外网出口，加载第三方资源会让这个页面自己先卡住。
PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>instantbox · 正在准备沙箱</title>
<style>
  :root {
    --bg: #f7f8fa;
    --card: #ffffff;
    --text: #1f2329;
    --muted: #8a919f;
    --accent: #0070f3;
    --track: #e8ebf0;
    --danger: #d93026;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d;
      --card: #1e2128;
      --text: #e8eaed;
      --muted: #8b93a1;
      --track: #2c313a;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI",
          "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card);
    border-radius: 14px;
    padding: 40px 36px 32px;
    width: 100%;
    max-width: 460px;
    text-align: center;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 32px rgba(0,0,0,.06);
  }
  .spinner {
    width: 46px; height: 46px;
    margin: 0 auto 22px;
    border: 3px solid var(--track);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .card.done .spinner, .card.error .spinner { animation: none; }
  .card.done .spinner { border-color: var(--accent); }
  .card.error .spinner { border-color: var(--danger); border-top-color: var(--danger); }

  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 26px; }

  .bar { height: 3px; background: var(--track); border-radius: 2px; overflow: hidden; margin-bottom: 14px; }
  .bar > i {
    display: block; height: 100%; width: 0%;
    background: var(--accent);
    border-radius: 2px;
    transition: width .45s ease;
  }
  .status {
    font-size: 13px; color: var(--muted);
    min-height: 20px; margin-bottom: 6px;
    font-variant-numeric: tabular-nums;
  }
  .detail {
    font-size: 12px; color: var(--muted); opacity: .75;
    min-height: 18px; word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .hint { font-size: 12px; color: var(--muted); margin-top: 22px; }
  .hint code {
    background: var(--track); padding: 1px 5px; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .actions { margin-top: 20px; display: none; gap: 10px; justify-content: center; }
  .card.error .actions { display: flex; }
  a.btn, button.btn {
    appearance: none; border: 1px solid var(--track); background: transparent;
    color: var(--text); font: inherit; font-size: 13px;
    padding: 8px 18px; border-radius: 8px; cursor: pointer;
    text-decoration: none; line-height: 1.4;
  }
  a.btn:hover, button.btn:hover { border-color: var(--muted); }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="spinner" id="spinner"></div>
  <h1 id="title">正在准备沙箱环境</h1>
  <p class="sub" id="sub">首次启动需要拉取镜像，通常 10 ~ 60 秒</p>

  <div class="bar"><i id="bar"></i></div>
  <div class="status" id="status">正在连接…</div>
  <div class="detail" id="detail"></div>

  <div class="hint">沙箱 ID · <code id="pod"></code></div>
  <div class="actions">
    <button class="btn" id="retry">重新检测</button>
    <a class="btn" id="home" href="/">返回首页</a>
  </div>
</div>

<script>
(function () {
  "use strict";

  // 由服务端注入，避免在前端拼跨源地址
  var CFG = __CFG__;

  var POD    = CFG.pod;
  var TARGET = CFG.target;     // 真终端地址（/console/<pod>/_console）
  var STATE  = CFG.stateUrl;   // 状态轮询地址（/_state/<pod>）
  var GO     = CFG.goUrl;      // 就绪后的跳转目标（含 main=1，用于避免中转页自环）

  var el = {
    card:    document.getElementById("card"),
    spinner: document.getElementById("spinner"),
    title:   document.getElementById("title"),
    sub:     document.getElementById("sub"),
    bar:     document.getElementById("bar"),
    status:  document.getElementById("status"),
    detail:  document.getElementById("detail"),
    pod:     document.getElementById("pod"),
    retry:   document.getElementById("retry")
  };
  el.pod.textContent = POD;

  // ------------------------------------------------------------------ 进度
  //
  // 服务端给的是**粗粒度**状态（pending / ready），不可能知道真实百分比。
  // 所以这里画的是「渐进填充」：先快速增长到 90%，之后每秒挪一点点，
  // 真实就绪时才补到 100%。好处是用户始终感觉在动，坏处是它不是真进度条 ——
  // 但没有更诚实的做法，宁可这样也不要假装精确。
  var pct = 0;
  var tick = null;

  function setPct(next) {
    pct = Math.max(pct, Math.min(next, 99.5));
    el.bar.style.width = pct.toFixed(1) + "%";
  }

  function startTicker() {
    if (tick) return;
    tick = setInterval(function () {
      if (pct < 90) setPct(pct + Math.random() * 3 + 1);
      else setPct(pct + 0.12);
    }, 700);
  }

  function stopTicker() {
    if (tick) { clearInterval(tick); tick = null; }
  }

  // ------------------------------------------------------------------ 文案
  var TEXT = {
    "ContainerCreating":  "正在创建容器",
    "PodInitializing":    "正在初始化容器",
    "ImagePullBackOff":   "镜像拉取失败，正在重试",
    "ErrImagePull":       "镜像拉取失败，正在重试",
    "ErrImageNeverPull":  "镜像拉取失败（禁止拉取策略）",
    "InvalidImageName":   "镜像名无效",
    "CrashLoopBackOff":   "容器反复退出，正在重试",
    "CreateContainerError": "创建容器失败",
    "Scheduling":         "正在调度到节点",
    "Unschedulable":      "没有可用节点，等待调度",
    "not ready":          "容器启动中"
  };

  function humanize(detail) {
    if (!detail) return "启动中…";
    for (var key in TEXT) {
      if (detail.indexOf(key) !== -1) return TEXT[key];
    }
    return "启动中…";
  }

  function shortDetail(detail) {
    if (!detail || detail === "ok" || detail === "running") return "";
    // 把 "ImagePullBackOff: Back-off pulling image \"xxx\"" 截短一点
    var s = String(detail);
    if (s.length > 110) s = s.slice(0, 107) + "…";
    return s;
  }

  // ------------------------------------------------------------------ 状态机
  var attempts = 0;
  var MAX_MS   = 10 * 60 * 1000;   // 10 分钟还不行就告诉用户，别再无限转
  var started  = Date.now();
  var stopped  = false;

  function schedule(delay) {
    if (stopped) return;
    setTimeout(poll, delay);
  }

  function showError(title, sub, detail) {
    stopped = true;
    stopTicker();
    el.card.classList.remove("done");
    el.card.classList.add("error");
    el.title.textContent = title;
    el.sub.textContent = sub;
    el.status.textContent = "";
    el.detail.textContent = detail || "";
  }

  function enter() {
    stopped = true;
    stopTicker();
    el.card.classList.add("done");
    setPct(100);
    el.bar.style.width = "100%";
    el.title.textContent = "沙箱已就绪";
    el.sub.textContent = "正在进入终端…";
    el.status.textContent = "";
    el.detail.textContent = "";
    // replace 而不是 href：别让中转页留在历史记录里
    setTimeout(function () { window.location.replace(GO); }, 250);
  }

  function poll() {
    if (stopped) return;

    // 超时兜底：Pod 一直 pending 时，用户需要知道"这里卡住了"，
    // 而不是对着一个永远转的圈刷新页面
    if (Date.now() - started > MAX_MS) {
      showError("沙箱启动超时", "超过 10 分钟仍未就绪，请检查镜像仓库或节点资源",
                "pod=" + POD);
      return;
    }

    var ctrl = null;
    var timer = null;
    // 轮询也要有超时，否则请求挂住就再也不发下一次了
    if (window.AbortController) {
      ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, 5000);
    }

    fetch(STATE, {
      cache: "no-store",
      credentials: "same-origin",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      attempts += 1;
      var state = data.state;
      var detail = data.detail || "";

      if (state === "ready") { enter(); return; }

      if (state === "gone") {
        showError("沙箱不存在或已过期",
                  "它可能已被自动回收（TTL 到期或长时间未使用）",
                  detail);
        return;
      }

      if (state === "failed") {
        showError("沙箱启动失败", "容器已退出，请重新创建一个沙箱", detail);
        return;
      }

      if (state === "terminating") {
        showError("沙箱正在销毁", "该沙箱已被删除，请返回首页重新创建", detail);
        return;
      }

      if (state === "forbidden") {
        showError("无法查询沙箱状态", "服务端访问集群失败，请稍后重试", detail);
        return;
      }

      // pending
      startTicker();
      el.status.textContent = humanize(detail);
      el.detail.textContent = shortDetail(detail);
      // 前 20 秒密一点（通常这时候状态变化最快），之后拉长到 2 秒
      var next = attempts < 12 ? 900 : 2000;
      schedule(next);
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      // 网络抖动不该直接判死，继续重试，但要把上一步的文案留着，
      // 别让用户看到一个闪来闪去的空白
      attempts += 1;
      el.status.textContent = "等待服务端响应…";
      el.detail.textContent = String(err && err.message || err);
      startTicker();
      schedule(2000);
    });
  }

  el.retry.addEventListener("click", function () {
    stopped = false;
    started = Date.now();
    attempts = 0;
    el.card.classList.remove("error");
    el.title.textContent = "正在准备沙箱环境";
    el.sub.textContent = "首次启动需要拉取镜像，通常 10 ~ 60 秒";
    startTicker();
    poll();
  });

  startTicker();
  poll();
})();
</script>
</body>
</html>
"""


def render(container_name, target, state_url, go_url):
    """返回填好变量的 HTML。

    用 replace 而不是模板引擎：这台页面只有一个，引入 jinja 只会增加一层
    转义风险。CFG 用 json.dumps 序列化，天然处理引号和转义。
    """
    import json

    cfg = json.dumps({
        'pod': container_name,
        'target': target,
        'stateUrl': state_url,
        'goUrl': go_url,
    })
    # </script> 出现在字符串里会提前闭合 script 标签
    cfg = cfg.replace('</', '<\\/')
    return PAGE.replace('__CFG__', cfg)

/**
 * 发行版图标：内联 SVG，不依赖任何外部 CDN。
 *
 * 为什么不沿用原版的 jsdelivr 链接：
 *   项目跑在内网集群里，外网不通时图标加载不出来，页面上就是一排空白方块。
 *   图标本身很简单（一个圆 + 字母），内联进来还能少两个请求。
 *
 * 想要真实 logo：把 png 放进 server-bun/public/icons/，
 * 然后把 MANIFEST 里的 logoUrl 改成 /icons/xxx.png。
 */

const COLORS: Record<string, [string, string]> = {
  ubuntu: ['#E95420', 'U'],
  debian: ['#D70A53', 'D'],
  alpine: ['#0D597F', 'A'],
  centos: ['#932279', 'C'],
  fedora: ['#294172', 'F'],
  arch: ['#1793D1', 'A'],
  opensuse: ['#73BA25', 'S'],
}

/** 没见过的发行版就按 value 的哈希给个稳定颜色 */
function fallbackColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 55% 42%)`
}

export function osIconDataUrl(value: string, label: string): string {
  const known = COLORS[value.toLowerCase()]
  const color = known ? known[0] : fallbackColor(value || label)
  const letter = (known ? known[1] : (label[0] || '?')).toUpperCase()

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${color}"/>` +
    `<text x="16" y="23" font-family="-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`

  // 用 data: URL 而不是文件，省一次请求，也不会出现「加载前空白」
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

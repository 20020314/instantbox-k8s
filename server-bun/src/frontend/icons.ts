/**
 * 发行版图标。
 *
 * ★ 优先用真实 logo（icons-data.ts 里内联的 PNG，来自原版那套
 *   instantbox-images 图标），这样页面和原版长得一模一样。
 *   认不出的发行版才退回「彩色圆角方块 + 首字母」的 SVG 兜底 ——
 *   至少不会出现破图。
 *
 * 为什么内联 base64 而不直接引用 jsdelivr：
 *   项目跑在内网集群里，外网不一定通；断网时页面上就是一排空白方块。
 */

import { OS_ICONS } from './icons-data'

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

/**
 * 图标 URL。
 *
 * @param value manifest 里的 value（ubuntu / debian / …）
 * @param _label 显示名，只在兜底时用来取首字母
 */
export function osIconDataUrl(value: string, _label: string): string {
  const key = (value || '').toLowerCase()
  const real = OS_ICONS[key]
  if (real) return real

  const known = COLORS[key]
  const color = known ? known[0] : fallbackColor(value || _label)
  const letter = (known ? known[1] : (_label[0] || '?')).toUpperCase()

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${color}"/>` +
    `<text x="16" y="23" font-family="-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** 有没有真实 logo（测试用） */
export function hasRealIcon(value: string): boolean {
  return !!OS_ICONS[(value || '').toLowerCase()]
}

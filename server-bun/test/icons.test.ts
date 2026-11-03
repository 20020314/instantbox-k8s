/**
 * 发行版图标：必须和原版一样是真实 logo，不能是一排字母方块。
 *
 * 原版 instantbox-frontend 的 <img src={item.logoUrl}>，logoUrl 来自官方 manifest：
 *   https://cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/<name>.png
 * 这里两层保障：
 *   1. manifest.json 的 logoUrl 和官方地址一致
 *   2. 万一 CDN 断网（内网集群常见），osIconDataUrl 能给出内联 PNG 兜底
 */

import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { hasRealIcon, osIconDataUrl } from '../src/frontend/icons'

const CDN = 'https://cdn.jsdelivr.net/gh/instantbox/instantbox-images/icon/'

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'manifest.json'), 'utf8'),
) as { label: string; value: string; logoUrl: string }[]

describe('manifest 的 logoUrl', () => {
  test('每个发行版都填了官方 CDN 图片地址', () => {
    for (const o of manifest) {
      expect(o.logoUrl).toBe(`${CDN}${o.value}.png`)
    }
  })
})

describe('内联图标兜底', () => {
  test('六个官方发行版都有真实 PNG（不是 SVG 字母块）', () => {
    for (const name of ['ubuntu', 'debian', 'alpine', 'centos', 'fedora', 'arch']) {
      expect(hasRealIcon(name)).toBe(true)
      expect(osIconDataUrl(name, name)).toStartWith('data:image/png;base64,')
    }
  })

  test('manifest 里的发行版全部命中真实图标', () => {
    for (const o of manifest) {
      expect(osIconDataUrl(o.value, o.label)).toStartWith('data:image/png;base64,')
    }
  })

  test('认不出的发行版退回 SVG，不会破图也不会抛错', () => {
    const url = osIconDataUrl('nixos', 'NixOS')
    expect(url).toStartWith('data:image/svg+xml,')
    expect(hasRealIcon('nixos')).toBe(false)
  })

  test('大小写不敏感', () => {
    expect(hasRealIcon('Ubuntu')).toBe(true)
  })
})

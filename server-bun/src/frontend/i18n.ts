/**
 * 文案表。结构与旧 React 版 i18n/locale/*.json 的 translation 字段完全一致，
 * 方便直接对照；只把 zh_tw 的 locale 从 "zh" 修正成 "zh_tw"
 * （原版 zh 和 zh_tw 的 locale 都写成 "zh"，切换繁体时会被当成简体）。
 */

export type Locale = 'zh' | 'zh_tw' | 'en' | 'fr'

export const LOCALES: Locale[] = ['zh', 'zh_tw', 'en', 'fr']

export const DEFAULT_LOCALE: Locale = 'zh'

interface Dict {
  language: string
  site: { heading: string; typed: string }
  keyword: {
    notice: string
    confirm: string
    ok: string
    cancel: string
    create: string
    next: string
    back: string
    os: string
    resources: string
    'cpu-core-count': string
    memory: string
    'memory-in-mb': string
    'ttl-in-hours': string
  }
  prompt: {
    'created-os': string
    'choose-os': string
    'choose-os-version': string
    'select-os': string
    'open-os': string
    'choose-resources': string
    'selected-os-resources': string
    'purge-os': string
    purging: string
    'enter-cpu-core-count': string
    'enter-memory-in-mb': string
    'enter-ttl-in-hours': string
  }
  sentence: {
    'open-webshell': string
    'open-webshell-try-again': string
    'eg-cpu-core-count': string
    'eg-memory-in-mb': string
    'eg-ttl-in-hours': string
    'err-resources': string
    'err-creation': string
    'err-cpu-core-count': string
    'msg-cpu-core-count': string
    'err-memory-in-mb': string
    'msg-memory-in-mb': string
    'err-ttl-in-hours': string
    'msg-ttl-in-hours': string
    'err-empty-os': string
  }
}

export const strings: Record<Locale, Dict> = {
  zh: {
    language: '中文',
    site: {
      heading: 'instantbox',
      typed: "Want to experiment with something on a Linux distribution? Let's start!",
    },
    keyword: {
      notice: '提示',
      confirm: '确认',
      ok: '是',
      cancel: '取消',
      create: '创建',
      next: '下一步',
      back: '上一步',
      os: '系统',
      resources: '性能参数',
      'cpu-core-count': 'CPU 核心',
      memory: '内存',
      'memory-in-mb': '内存 (M)',
      'ttl-in-hours': '使用时长 (H)',
    },
    prompt: {
      'created-os': '您已创建系统',
      'choose-os': '选择系统',
      'choose-os-version': '选择系统版本',
      'select-os': '选择系统配置',
      'open-os': '打开已创建的系统',
      'choose-resources': '填写系统性能参数',
      'selected-os-resources': '所选系统及系统配置',
      'purge-os': '删除系统',
      purging: '删除中...',
      'enter-cpu-core-count': '请输入 CPU 核数',
      'enter-memory-in-mb': '请输入内存大小',
      'enter-ttl-in-hours': '请输入使用时长',
    },
    sentence: {
      'open-webshell': '系统已创建，是否跳转到系统页面？（关闭页面不会自动回收，请用「删除系统」）',
      'open-webshell-try-again': '若打开的页面报错，请重新点击',
      'eg-cpu-core-count': '如：1',
      'eg-memory-in-mb': '如：512',
      'eg-ttl-in-hours': '如：24',
      'err-resources': '性能参数有误，请重新填写',
      'err-creation': '创建失败，请重试',
      'err-cpu-core-count': 'CPU 格式或范围有误',
      'msg-cpu-core-count': 'CPU 范围：1 ~ 4',
      'err-memory-in-mb': '内存大小格式或范围有误',
      'msg-memory-in-mb': '内存大小范围：64 ~ 3584',
      'err-ttl-in-hours': '使用时长格式或范围有误',
      'msg-ttl-in-hours': '使用时长范围：1 ~ 24',
      'err-empty-os': '请先选择系统和系统版本',
    },
  },

  zh_tw: {
    language: '繁體中文',
    site: {
      heading: 'instantbox',
      typed: "Want to experiment with something on a Linux distribution? Let's start!",
    },
    keyword: {
      notice: '提示',
      confirm: '確認',
      ok: '是',
      cancel: '取消',
      create: '建立',
      next: '下一步',
      back: '上一步',
      os: '作業系統',
      resources: '資源分配',
      'cpu-core-count': 'CPU 核心',
      memory: '記憶體',
      'memory-in-mb': '記憶體 (M)',
      'ttl-in-hours': '使用時間 (H)',
    },
    prompt: {
      'created-os': '您已建立系統',
      'choose-os': '選擇作業系統',
      'choose-os-version': '選擇系統版本',
      'select-os': '選擇系統設定',
      'open-os': '打開已建立的系統',
      'choose-resources': '填寫系統資源分配',
      'selected-os-resources': '所選系統及系統設定',
      'purge-os': '刪除系統',
      purging: '刪除中...',
      'enter-cpu-core-count': '請輸入 CPU 核心數量',
      'enter-memory-in-mb': '請輸入記憶體大小',
      'enter-ttl-in-hours': '請輸入使用時間',
    },
    sentence: {
      'open-webshell': '系統已建立，是否開啟系統頁面？（關閉頁面不會自動回收，請用「刪除系統」）',
      'open-webshell-try-again': '若開啟的頁面出現錯誤，請重試',
      'eg-cpu-core-count': '如：1',
      'eg-memory-in-mb': '如：512',
      'eg-ttl-in-hours': '如：24',
      'err-resources': '資源分配錯誤，請重新填寫',
      'err-creation': '建立失敗，請重試',
      'err-cpu-core-count': 'CPU 格式或範圍錯誤',
      'msg-cpu-core-count': 'CPU 範圍：1 ~ 4',
      'err-memory-in-mb': '記憶體大小格式或範圍錯誤',
      'msg-memory-in-mb': '記憶體大小範圍：64 ~ 3584',
      'err-ttl-in-hours': '使用時間格式或範圍錯誤',
      'msg-ttl-in-hours': '使用時間範圍：1 ~ 24',
      'err-empty-os': '請先選擇系統和系統版本',
    },
  },

  en: {
    language: 'English',
    site: {
      heading: 'instantbox',
      typed: "Want to experiment with something on a Linux distribution? Let's start!",
    },
    keyword: {
      notice: 'Notice',
      confirm: 'Confirm',
      ok: 'Yes',
      cancel: 'Cancel',
      create: 'Create',
      next: 'Next',
      back: 'Back',
      os: 'OS',
      resources: 'Resources',
      'cpu-core-count': 'CPU cores',
      memory: 'Memory',
      'memory-in-mb': 'Memory (M)',
      'ttl-in-hours': 'Duration (H)',
    },
    prompt: {
      'created-os': 'Your instantbox',
      'choose-os': 'Choose OS',
      'choose-os-version': 'Choose version',
      'select-os': 'Choose OS',
      'open-os': 'Launch webshell',
      'choose-resources': 'Choose resources',
      'selected-os-resources': 'Selected OS',
      'purge-os': 'Purge',
      purging: 'Purging...',
      'enter-cpu-core-count': 'Enter CPU cores',
      'enter-memory-in-mb': 'Enter memory',
      'enter-ttl-in-hours': 'Enter duration',
    },
    sentence: {
      'open-webshell':
        'Instantbox has been created. Launch webshell? (Closing the tab does not purge it — use Purge.)',
      'open-webshell-try-again': 'Please click again if webshell encountered an error.',
      'eg-cpu-core-count': 'e.g. 1',
      'eg-memory-in-mb': 'e.g. 512',
      'eg-ttl-in-hours': 'e.g. 24',
      'err-resources': 'Validation failed, please re-enter.',
      'err-creation': 'Failed to create instantbox. Please try again later.',
      'err-cpu-core-count': 'Failed to validate CPU count',
      'msg-cpu-core-count': 'CPU core range: 1-4',
      'err-memory-in-mb': 'Failed to validate memory',
      'msg-memory-in-mb': 'Memory range: 64-3584',
      'err-ttl-in-hours': 'Failed to validate duration',
      'msg-ttl-in-hours': 'Duration range: 1-24',
      'err-empty-os': 'Please choose an OS.',
    },
  },

  fr: {
    language: 'Français',
    site: {
      heading: 'instantbox',
      typed: "Want to experiment with something on a Linux distribution? Let's start!",
    },
    keyword: {
      notice: 'Notice',
      confirm: 'Confirmer',
      ok: 'Oui',
      cancel: 'Annuler',
      create: 'Créer',
      next: 'Suivant',
      back: 'Retour',
      os: 'OS',
      resources: 'Resources',
      'cpu-core-count': 'CPU cores',
      memory: 'Mémoire',
      'memory-in-mb': 'Mémoire (M)',
      'ttl-in-hours': 'Durée (H)',
    },
    prompt: {
      'created-os': 'Votre instantbox',
      'choose-os': 'Choisir OS',
      'choose-os-version': 'Choisir version',
      'select-os': 'Choisir OS',
      'open-os': 'Ouvrir Shell',
      'choose-resources': 'Choisir resources',
      'selected-os-resources': 'Sélectionner OS',
      'purge-os': 'Purge',
      purging: 'Purge...',
      'enter-cpu-core-count': 'Entrer CPU cores',
      'enter-memory-in-mb': 'Entrer mémoire',
      'enter-ttl-in-hours': 'Entrer durée',
    },
    sentence: {
      'open-webshell':
        "Instantbox a été créé. Lancer shell? (Fermer l'onglet ne le supprime pas — utilisez Purge.)",
      'open-webshell-try-again': "Veuillez cliquer à nouveau si le webshell a rencontré une erreur.",
      'eg-cpu-core-count': 'Exemple 1',
      'eg-memory-in-mb': 'Exemple 512',
      'eg-ttl-in-hours': 'Exemple 24',
      'err-resources': 'La validation a échoué, merci de ressaisir.',
      'err-creation': "Echec de la création d'instantbox. Veuillez réessayer ultérieurement.",
      'err-cpu-core-count': 'Echec de la validation du nombre de processeurs',
      'msg-cpu-core-count': 'Plage CPU: 1-4',
      'err-memory-in-mb': 'Echec de la validation de la mémoire',
      'msg-memory-in-mb': 'Plage mémoire: 64-3584',
      'err-ttl-in-hours': 'Echec de la validation de la durée',
      'msg-ttl-in-hours': 'Plage durée: 1-24',
      'err-empty-os': 'Veuillez choisir un OS.',
    },
  },
}

export function pickLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE
  const v = raw.toLowerCase().replace('_', '-')
  if (v.startsWith('zh-tw') || v.startsWith('zh-hk') || v.startsWith('zh-hant')) return 'zh_tw'
  if (v.startsWith('zh')) return 'zh'
  if (v.startsWith('fr')) return 'fr'
  if (v.startsWith('en')) return 'en'
  return DEFAULT_LOCALE
}

/** Accept-Language 里取第一个能认的 */
export function fromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag) continue
    const v = tag.toLowerCase().replace('_', '-')
    if (v.startsWith('zh-tw') || v.startsWith('zh-hk') || v.startsWith('zh-hant')) return 'zh_tw'
    if (v.startsWith('zh')) return 'zh'
    if (v.startsWith('fr')) return 'fr'
    if (v.startsWith('en')) return 'en'
  }
  return null
}

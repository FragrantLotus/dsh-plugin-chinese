/**
 * dsh-plugin-chinese — 让每个已装插件的「功能简介」自动变成中文。
 *
 * 只补 description，绝不写 title：DSH 的 readPluginMeta 在缺少 title 时会回落到
 * package.json 的 name，所以插件名永远保持原样，方便按名字查找。
 *
 * 生效方式：
 * - 包已声明 `./locale/*.json` 导出 → 写完刷新页面即生效。
 * - 包里完全没有 exports 字段 → Node 走旧式解析，写完刷新页面即生效。
 * - 包有 exports 但没有 locale 映射 → 补映射后需要重启一次才会被解析器看到。
 *
 * 翻译走宿主自带的 translator 服务（google / bing，匿名免费），不依赖任何 API key。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createInjector, languagePacksOf, metaFromPacks, packageNameOf } from './inject.js'

export const name = 'auto-i18n'

/**
 * 只有在拿到 translator 时才翻译；拿不到就退化成「只补缓存里已有的译文」，
 * 绝不让一个缺失的服务把整个入口拖死。
 */
export const inject = []

/** 中文判定：出现这些区间的字符就当它已经是中文，无需再翻。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 一句话里至少要有这么多汉字，才有资格被当成中文（纯英文的 0 个直接排除）。 */
const CJK_ENOUGH = 4

/** 拉丁字母：用来算中文占比，避免「英文长句里夹几个中文词」被误判为中文。 */
const LATIN = /[A-Za-z]/

/**
 * 汉字占（汉字 + 拉丁字母）的比例达到这个数，就算「这段描述本来就是中文写的」。
 *
 * 这个数是从本机真实样本上量出来的，不是拍的：
 *   dsh-sidebar-entries 0.05  ← 英文长句 + 结尾几个中文词，必须翻
 *   dshmarket           0.15  ← 中英两句并列，作者自己写了 zh.json
 *   dsh-onebot-qq       0.27  ← 中文为主、尾部拖一段英文
 *   @a9i5k4/dsh-literature 0.57、dsh-cite 0.69、dsh-bili-scroll 0.88 ← 纯中文
 * 取 0.12 正好落在「英文长句夹中文」和「中英并列」之间。
 */
const CJK_SHARE = 0.12

/** 译文最长多少字符时送去翻译，超过就按句子切段。 */
const CHUNK = 900

/** 两次翻译之间的间隔，避免把免费通道打爆。 */
const GAP_MS = 1200

/** 扫描间隔（毫秒）。可被 config.intervalMinutes 覆盖。 */
const DEFAULT_INTERVAL_MINUTES = 30

/**
 * 术语纠错表：免费机翻常把专有名词译歪，这里按出现顺序做替换。
 * 只做「明显错译」的修正，不改写语序，避免二次伤害。
 */
const GLOSSARY = [
  [/\bDeepSeek\s+(?:Harness|harness)\b/g, 'DeepSeek Harness'],
  [/DeepSeek\s*(?:线束|工具带|束具)/g, 'DeepSeek Harness'],
  [/(?:网络|网页)图形(?:用户)?界面/g, 'Web 界面'],
  [/\bweb\s+GUI\b/gi, 'Web 界面'],
  [/斗宝/g, '豆包'],
  [/插件化配置包/g, '配置文件包'],
]

/** 翻译后再过一遍术语表。 */
export function polishDescription(text) {
  if (typeof text !== 'string') return text
  let out = text
  for (const [pattern, replacement] of GLOSSARY) out = out.replace(pattern, replacement)
  // 机翻常在两个汉字之间留下空格（如「界面 插件」），中文排版不需要。
  out = out.replace(/([\u3400-\u4dbf\u4e00-\u9fff])[ \t]+(?=[\u3400-\u4dbf\u4e00-\u9fff])/gu, '$1')
  return out
}

/**
 * 判断一段描述是不是「已经是中文」。
 *
 * 早期版本只看汉字个数（>= 4 就算），结果被 `dsh-sidebar-entries` 骗了：
 * 它是一整句英文，末尾带「文献 / 插件市场 / 远程访问」几个词，汉字数刚好 10 个，
 * 于是被判成中文、整包跳过，界面就一直显示英文。
 *
 * 现在的判据是「中文得占到一定比重」：汉字 / (汉字 + 拉丁字母) >= CJK_SHARE。
 * 实测分界很清楚 —— sidebar-entries 0.05（英文长句夹几个中文词，该翻），
 * dshmarket 0.15、dsh-onebot-qq 0.27（中英并列或中文为主，不该翻）。
 *
 * 判断错了不会破坏文件：漏判只是多翻一次，误判才会让界面留着英文，
 * 所以阈值取偏保守的低位。
 */
export function isChinese(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  let hits = 0
  let latin = 0
  for (const ch of text) {
    if (CJK.test(ch)) hits += 1
    else if (LATIN.test(ch)) latin += 1
  }
  if (hits < CJK_ENOUGH) return false
  return hits / (hits + latin) >= CJK_SHARE
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 先写临时文件再改名：中途失败不会留下半截 JSON，也不会破坏 pnpm 的硬链接。 */
function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.auto-i18n-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 该包的语言包目录叫什么：默认 locale，@fffangchenghao/dsh-web-search 这类映射到 locales。 */
export function localeDirOf(packageDir, manifest) {
  const exported = manifest?.exports
  if (exported !== null && typeof exported === 'object') {
    const mapping = exported['./locale/*.json']
    if (typeof mapping === 'string' && mapping.startsWith('./locales/')) return 'locales'
  }
  return 'locale'
}

/** 从已有语言包里挑出英文简介，没有就用 package.json 的 description。 */
function englishDescriptionOf(packageDir, manifest, localeDir) {
  const en = readJson(join(packageDir, localeDir, 'en.json'), undefined)
  if (en !== null && typeof en === 'object' && typeof en.meta?.description === 'string') {
    const text = en.meta.description.trim()
    if (text !== '') return text
  }
  const fromManifest = typeof manifest?.description === 'string' ? manifest.description.trim() : ''
  return fromManifest
}

function chineseDescriptionOf(packageDir, localeDir) {
  const zh = readJson(join(packageDir, localeDir, 'zh.json'), undefined)
  if (zh !== null && typeof zh === 'object' && typeof zh.meta?.description === 'string') {
    return zh.meta.description.trim()
  }
  return ''
}

/**
 * 作者自己写的中文语言包，但文件名不是 DSH 认的 `zh`（常见是 zh-CN.json、zh_CN.json）。
 * 这种译文是人写的，质量远好过机翻，必须优先采用。
 */
export function authorChineseOf(packageDir, localeDir) {
  const dir = join(packageDir, localeDir)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .filter((n) => n !== 'zh.json' && /^zh[-_]/i.test(n))
  for (const name of candidates) {
    const json = readJson(join(dir, name), undefined)
    const text = typeof json?.meta?.description === 'string' ? json.meta.description.trim() : ''
    if (text !== '' && isChinese(text)) return text
  }
  return ''
}

/** 把长句按句末标点切成不超过 CHUNK 的段，避免免费通道的长度上限。 */
export function chunkText(text) {
  if (text.length <= CHUNK) return [text]
  const parts = []
  let rest = text
  while (rest.length > CHUNK) {
    const window = rest.slice(0, CHUNK)
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('; '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf(', '),
    )
    const at = cut > CHUNK * 0.5 ? cut + 1 : CHUNK
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') parts.push(rest)
  return parts
}

/**
 * 扫描一遍 profile 下所有已装插件，给缺中文简介的补上。
 * 返回一份报告，调用方负责写日志/落盘。
 */
export async function sweep({ profileDir, translator, cache, cachePath, log, config }) {
  const report = { scanned: 0, translated: [], skipped: [], failed: [], restartNeeded: [] }

  const manifestPath = join(profileDir, 'package.json')
  const profileManifest = readJson(manifestPath, undefined)
  if (profileManifest === undefined) {
    report.failed.push({ package: '(profile)', reason: `无法读取 ${manifestPath}` })
    return report
  }

  const deps = Object.keys(profileManifest.dependencies ?? {})

  for (const packageName of deps) {
    if (packageName === 'dsh-plugin-chinese') continue // 自己不动自己
    const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
    const own = join(packageDir, 'package.json')
    if (!existsSync(own)) continue

    const manifest = readJson(own, undefined)
    if (manifest === undefined) {
      report.failed.push({ package: packageName, reason: 'package.json 无法解析' })
      continue
    }
    report.scanned += 1

    const localeDir = localeDirOf(packageDir, manifest)
    const languageDir = join(packageDir, localeDir)

    // 作者自己写的中文（可能叫 zh-CN.json / zh_CN.json）——人写的永远优于机翻。
    const authored = authorChineseOf(packageDir, localeDir)

    // 已经有中文简介：不覆盖别人的成果。
    const existingZh = chineseDescriptionOf(packageDir, localeDir)
    if (existingZh !== '') {
      // 例外：现有的 zh.json 其实就是本插件上次机翻的产物，而作者另有更好的中文稿 → 升级它。
      const englishNow = englishDescriptionOf(packageDir, manifest, localeDir)
      const oursBefore = typeof cache[englishNow] === 'string' && cache[englishNow] === existingZh
      if (authored !== '' && oursBefore && authored !== existingZh) {
        const zhFile = join(languageDir, 'zh.json')
        const zhJson = readJson(zhFile, {})
        const meta = zhJson.meta !== null && typeof zhJson.meta === 'object' ? zhJson.meta : {}
        meta.description = authored
        zhJson.meta = meta
        writeJsonAtomic(zhFile, zhJson)
        cache[englishNow] = authored
        writeJsonAtomic(cachePath, cache)
        report.translated.push({ package: packageName, description: authored, source: '作者原稿' })
        continue
      }
      report.skipped.push({ package: packageName, reason: '已有中文简介' })
      continue
    }

    // 本身没有 locale 目录、manifest 描述又不是中文 → 说明这个包原本就没有语言包；
    // 我们要新建一个，并把原文写进 en.json 作为回退。
    const english = englishDescriptionOf(packageDir, manifest, localeDir)
    if (english === '') {
      report.skipped.push({ package: packageName, reason: '没有可用描述' })
      continue
    }

    // manifest 的 description 本来就是中文 → 界面回退时已经是中文，无需动文件。
    if (isChinese(english) && !existsSync(join(languageDir, 'en.json'))) {
      report.skipped.push({ package: packageName, reason: '原始描述已是中文' })
      continue
    }

    const key = english
    let chinese = cache[key]
    // 作者写过中文稿就直接用，省一次机翻、质量还更高。
    if (authored !== '') chinese = authored
    if (typeof chinese !== 'string' || chinese.trim() === '') {
      if (translator === undefined) {
        report.skipped.push({ package: packageName, reason: '翻译服务不可用' })
        continue
      }
      try {
        const pieces = []
        for (const piece of chunkText(english)) {
          const spec = translator.resolve({ text: piece, targetLanguage: 'zh-CN', sourceLanguage: 'en' })
          pieces.push(await translator.translate(spec))
          await new Promise((r) => setTimeout(r, config.gapMs ?? GAP_MS))
        }
        chinese = polishDescription(pieces.join(''))
        if (!isChinese(chinese)) throw new Error('译文里没有中文，判定为失败')
        cache[key] = chinese
        writeJsonAtomic(cachePath, cache)
      } catch (error) {
        report.failed.push({ package: packageName, reason: String(error?.message ?? error) })
        continue
      }
    }

    // 写 en.json：只在缺失时补，已有内容一个字段都不动。
    const enPath = join(languageDir, 'en.json')
    if (!existsSync(enPath)) {
      writeJsonAtomic(enPath, { meta: { description: english } })
    } else {
      const en = readJson(enPath, {})
      const meta = en.meta !== null && typeof en.meta === 'object' ? en.meta : {}
      if (typeof meta.description !== 'string' || meta.description.trim() === '') {
        meta.description = english
        en.meta = meta
        writeJsonAtomic(enPath, en)
      }
    }

    // 写 zh.json：只写 description，**绝不写 title**。
    const zhPath = join(languageDir, 'zh.json')
    const zh = existsSync(zhPath) ? readJson(zhPath, {}) : {}
    const zhMeta = zh.meta !== null && typeof zh.meta === 'object' ? zh.meta : {}
    zhMeta.description = chinese
    zh.meta = zhMeta
    writeJsonAtomic(zhPath, zh)

    report.translated.push({ package: packageName, description: chinese, source: authored !== '' ? '作者原稿' : '机翻' })

    // 最后才看导出：补 exports 只有重启后才被解析器看到，单独记一笔告诉用户。
    const patched = ensureLocaleExport(own, manifest, localeDir)
    if (patched) report.restartNeeded.push(packageName)
  }

  return report
}

/**
 * 确保 package.json 的 exports 暴露了 `./locale/*.json`。
 * 返回 true 表示这次确实改了文件（→ 调用方据此提示「需要重启一次」）。
 */
export function ensureLocaleExport(manifestPath, manifest, localeDir) {
  const key = './locale/*.json'
  const target = `./${localeDir}/*.json`
  const exported = manifest.exports

  // 完全没有 exports 字段：Node 走旧式路径解析，不补反而更稳。
  if (exported === undefined) return false

  if (typeof exported === 'string' || exported === null) {
    // 形如 "exports": "./index.js" —— 改成对象后补上映射。
    manifest.exports = { '.': exported ?? './index.js', [key]: target }
    writeJsonAtomic(manifestPath, manifest)
    return true
  }

  if (typeof exported !== 'object') return false

  if (Object.keys(exported).some((k) => k.includes('locale'))) return false

  exported[key] = target
  writeJsonAtomic(manifestPath, manifest)
  return true
}

function logLine(logPath, message) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const stamp = new Date().toISOString()
    writeFileSync(logPath, `${stamp} ${message}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // 日志失败不能影响主流程。
  }
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用插件：关掉后不再扫描与翻译'),
  intervalMinutes: Schema.number()
    .default(DEFAULT_INTERVAL_MINUTES)
    .description('定时扫描间隔（分钟）：每隔这么久检查一次是否有新插件缺中文简介'),
  gapMs: Schema.number().default(GAP_MS).description('翻译请求间隔（毫秒）：避免请求过快被限流'),
})

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const settings = {
    gapMs: Number(config.gapMs) > 0 ? Number(config.gapMs) : GAP_MS,
    intervalMinutes: Number(config.intervalMinutes) > 0 ? Number(config.intervalMinutes) : DEFAULT_INTERVAL_MINUTES,
  }

  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const stateDir = join(home, 'auto-i18n')
  const cachePath = join(stateDir, 'cache.json')
  const logPath = join(stateDir, 'auto-i18n.log')
  const reportPath = join(stateDir, 'report.json')

  // profile 目录：优先用宿主注入的环境变量，其次从本插件的安装位置推断。
  const profileDir =
    process.env.DSH_PROFILE_DIR ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

  let running = false
  let timer

  /**
   * 内存注入层要用的「包名 → 中文元信息」查询。
   *
   * 直接读磁盘语言包，**不走 Node 模块解析** —— 这正是绕开解析缓存的关键：
   * 包里有没有 `exports['./locale/*.json']` 都不影响这里能不能读到。
   * 按 (package.json, locale/*.json) 的 mtime 做失效，文件一变下次取就是新的。
   */
  const packCache = new Map()

  function stampOf(paths) {
    let latest = 0
    for (const path of paths) {
      try {
        latest = Math.max(latest, statSync(path).mtimeMs)
      } catch {
        /* 文件不存在是常态（新装的包还没写语言包） */
      }
    }
    return latest
  }

  function lookup(name) {
    const packageName = packageNameOf(name)
    if (packageName === undefined || packageName === 'dsh-plugin-chinese') return undefined
    const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) return undefined

    const localeDir = existsSync(join(packageDir, 'locales')) ? 'locales' : 'locale'
    const stamp = stampOf([manifestPath, join(packageDir, localeDir)])
    const hit = packCache.get(packageName)
    if (hit !== undefined && hit.stamp === stamp) return hit.meta

    const meta = metaFromPacks(languagePacksOf(packageDir))
    packCache.set(packageName, { stamp, meta })
    return meta
  }

  const injector = createInjector({ lookup, log: (message) => logLine(logPath, message) })

  async function once(reason) {
    if (running) return
    running = true
    try {
      const cache = readJson(cachePath, {})
      const translator = ctx.get('translator')
      const report = await sweep({
        profileDir,
        translator,
        cache,
        cachePath,
        log: (m) => logLine(logPath, m),
        config: settings,
      })
      // 新写的语言包要立刻出现在界面上：丢掉注入层的缓存。
      packCache.clear()
      writeJsonAtomic(reportPath, {
        at: new Date().toISOString(),
        reason,
        ...report,
        inject: injector.status,
        injectCalls: injector.counters,
      })
      const done = report.translated.length
      if (done > 0 || report.failed.length > 0) {
        logLine(
          logPath,
          `sweep(${reason}): 新翻译 ${done}，跳过 ${report.skipped.length}，失败 ${report.failed.length}` +
            (report.restartNeeded.length > 0 ? `，待重启生效 ${report.restartNeeded.join(',')}` : ''),
        )
      }
    } catch (error) {
      logLine(logPath, `sweep(${reason}) 异常: ${String(error?.message ?? error)}`)
    } finally {
      running = false
    }
  }

  // 启动后稍等再跑，避免和宿主自己的启动流程抢文件。
  const kickoff = setTimeout(() => void once('startup'), 4_000)
  kickoff.unref?.()

  // 注入层稍晚一点装：等 pluginPackages / pluginManager 都就位。
  const injectTimers = [3_000, 8_000, 20_000].map((delay) => {
    const handle = setTimeout(() => {
      injector.install(ctx)
      if (!injector.anyInstalled) logLine(logPath, 'inject: 还没有可挂载的服务，稍后重试')
    }, delay)
    handle.unref?.()
    return handle
  })

  // 自检探针：光看计数器只能证明「皮被调到了」，证明不了「拿到的 meta 真是中文」。
  // 所以这里自己调一次 listBundles，直接数返回结果里有几条带 zh。
  let lastCalls = -1
  let lastProbeHits = -1
  const callWatch = setInterval(() => {
    void (async () => {
      if (!injector.anyInstalled) return
      const counts = injector.counters
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
      const result = await injector.probe()
      const line =
        `inject 自检: 调用合计 ${total} 次 ` +
        `[${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}]` +
        ` / 探针 ${result.service} 自增 ${result.calls} 次、${result.hit}/${result.total} 条带 zh`
      if (total === lastCalls && result.hit === lastProbeHits) return
      lastCalls = total
      lastProbeHits = result.hit
      logLine(logPath, result.hit > 0 ? line : `${line} —— 注入没落地`)
    })()
  }, 60_000)
  callWatch.unref?.()

  ctx.effect(() => {
    timer = setInterval(() => void once('interval'), settings.intervalMinutes * 60_000)
    timer.unref?.()
    return () => {
      clearTimeout(kickoff)
      clearInterval(callWatch)
      clearInterval(timer)
      for (const handle of injectTimers) clearTimeout(handle)
      injector.dispose()
    }
  }, 'auto-i18n.schedule()')

  // 安装/升级/卸载插件时立刻补一遍。
  ctx.on('plugin-manager/changed', () => {
    setTimeout(() => void once('changed'), 1_500).unref?.()
  })
}

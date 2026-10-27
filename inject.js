/**
 * dsh-plugin-chinese — 内存注入层。
 *
 * 为什么要这一层：
 *   只把译文写进 `<pkg>/locale/zh.json` 有两个先天慢半拍的问题 ——
 *     1. 包里没有 `exports['./locale/*.json']` 时，Node 把解析结果缓存住了，
 *        补完 exports 必须重启才认得；
 *     2. 宿主启动后已经读过一遍元信息，写完文件要等下一次列表刷新才重新读。
 *   结果就是「刚翻译好，但界面上还是英文」。
 *
 * 这一层的做法是：在宿主内存里把返回插件元信息的几个函数包一层，给 meta 补上
 * `zh` 字段。前端渲染时 `resolveText()` 从 `{ en, zh }` 里自然取到中文，
 * 整个过程不碰 DOM、不写别人的文件、也不需要重启。
 *
 * 译文从哪来：**直接读磁盘上的语言包文件**（readdir + readFile），
 * 完全不走 Node 的模块解析器 —— 这正是绕开解析缓存的关键。
 * 所以「重启后会显示成什么样」，这一层现在就给你显示成什么样，两者永远一致。
 *
 * 铺的四条通路（任一生效即可，全部由宿主官方代码读取）：
 *   pluginPackages.metaOf      —— 元信息的真正源头
 *   pluginManager.listBundles  —— 「已安装」分组的 bundle 列表
 *   pluginManager.listPlugins  —— Loader 条目列表（右侧启用开关所在）
 *   pluginInventory.list       —— 插件清单 Remote 网关
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 打在包装函数上的标记：既是「这层皮是我们套的」，也保证重复安装幂等。 */
export const PATCH_MARK = Symbol.for('dsh-plugin-chinese#patched')

/**
 * 调用计数**放在模块级**。
 *
 * 踩过的坑：计数原本是 `createInjector()` 里的局部对象，于是一个插件应用里
 * 就只有「最后造出来的那个注入器」的计数器。而 apply() 可能被调用多次、
 * 补丁本身有 PATCH_MARK 做幂等（第二次不装），于是真正被调用的老包装函数
 * 写的是老实例的计数器，读的却是新实例的 —— 读数永远是 0。
 * 看到「装上了但没人调用」先怀疑这里，别急着改注入策略。
 */
export const COUNTERS = { metaOf: 0, listBundles: 0, listPlugins: 0, inventoryList: 0 }

/** 要铺的四条通路。 */
export const TARGETS = Object.freeze([
  { key: 'metaOf', service: 'pluginPackages', method: 'metaOf', kind: 'meta' },
  { key: 'listBundles', service: 'pluginManager', method: 'listBundles', kind: 'bundles' },
  { key: 'listPlugins', service: 'pluginManager', method: 'listPlugins', kind: 'entries' },
  { key: 'inventoryList', service: 'pluginInventory', method: 'list', kind: 'snapshot' },
])

/** DSH 前端只认这两个语言 id（`_client_locale.js` 的 LOCALE_IDS）。 */
const LANGUAGE_FILE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readJsonQuiet(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 取非空字符串，其余一律当作「没有」。 */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 把 `dsh-ops/shell` 这类子路径拆回包名：
 * scoped 包（@scope/name）要保留两段，其余取第一段。
 */
export function packageNameOf(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  const parts = specifier.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
}

/**
 * 读出某个包在磁盘上的全部语言包，整理成 `{ 语言id: { title, description } }`。
 * 目录名默认 `locale`；包的 exports 把它映射到 `locales` 时跟随映射。
 */
export function languagePacksOf(packageDir) {
  const manifest = readJsonQuiet(join(packageDir, 'package.json'))
  let dirName = 'locale'
  const mapped = isPlainObject(manifest?.exports) ? manifest.exports['./locale/*.json'] : undefined
  if (typeof mapped === 'string' && mapped.startsWith('./locales/')) dirName = 'locales'

  const dir = join(packageDir, dirName)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const packs = {}
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!LANGUAGE_FILE.test(id)) continue
    const json = readJsonQuiet(join(dir, entry.name))
    const meta = json?.meta
    if (!isPlainObject(meta)) continue
    const pack = {}
    const title = textOf(meta.title)
    const description = textOf(meta.description)
    if (title !== undefined) pack.title = title
    if (description !== undefined) pack.description = description
    if (Object.keys(pack).length > 0) packs[id] = pack
  }
  return Object.keys(packs).length > 0 ? packs : undefined
}

/**
 * 把语言包摊成宿主 `meta` 的样式：`{ title: { en, zh }, description: { en, zh } }`。
 * 只收 `en` + 简体中文（`zh` 优先，其次 `zh-CN` 之类作者自留的文件名）。
 */
export function metaFromPacks(packs) {
  if (packs === undefined) return undefined

  // 语言 id 大小写不敏感（作者可能写 zh-CN.json、ZH.json），统一按小写找。
  const lower = {}
  for (const [id, pack] of Object.entries(packs)) lower[id.toLowerCase()] = pack

  const result = {}
  for (const field of ['title', 'description']) {
    const english = lower.en?.[field]
    const chinese = lower.zh?.[field] ?? lower['zh-cn']?.[field] ?? lower['zh-hans']?.[field] ?? lower['zh-hant']?.[field]
    if (english === undefined && chinese === undefined) continue
    const text = {}
    if (english !== undefined) text.en = english
    if (chinese !== undefined) text.zh = chinese
    result[field] = text
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 把「我们读到的中文」叠到宿主原本返回的 meta 上。
 *
 * 三条硬规矩：
 *   1. 绝不覆盖已有的 `zh` —— 作者的稿子、我们上次写的，都不动；
 *   2. 绝不新增 `title.zh` 里没有对应语言包的内容（即不给人改名）；
 *   3. 原本是纯字符串的字段（`resolveText` 会原样显示），转成对象时必须保留 `en`，
 *      否则英文界面会退化成显示 undefined。
 */
export function overlayMeta(original, extra) {
  if (extra === undefined) return original
  if (original === undefined || original === null) return extra
  if (!isPlainObject(original)) return original
  if (original.error !== undefined) return original

  const merged = { ...original }
  for (const field of ['title', 'description']) {
    const add = extra[field]
    if (add === undefined) continue
    const now = merged[field]

    if (now === undefined) {
      merged[field] = add
      continue
    }

    if (typeof now === 'string') {
      // 宿主已经给了纯字符串：它会被原样显示，补 zh 的同时必须留住 en。
      if (add.zh === undefined) continue
      merged[field] = { en: now, ...(add.en !== undefined ? { en: add.en } : {}), zh: add.zh }
      continue
    }

    if (!isPlainObject(now)) continue
    if (now.zh !== undefined) continue
    if (add.zh === undefined) continue

    // 只补 zh，保留宿主原有的其它语言键。
    merged[field] = { ...now, ...(now.en === undefined && add.en !== undefined ? { en: add.en } : {}), zh: add.zh }
  }
  return merged
}

function readMethod(owner, methodName) {
  if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return undefined
  try {
    const value = owner[methodName]
    return typeof value === 'function' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 给 `owner[methodName]` 套一层包装。
 * `make(original)` 必须返回普通函数 —— 包装函数要把调用点的 `this` 原样透传，
 * 装在原型上的那层皮会被任意实例调用，写死 bind 会把 this 钉死。
 */
function wrapMethod(owner, methodName, make) {
  const original = readMethod(owner, methodName)
  if (original === undefined) return { ok: false, restore() {} }
  if (original[PATCH_MARK] === true) return { ok: true, restore() {} }

  const hadOwn = Object.prototype.hasOwnProperty.call(owner, methodName)
  let wrapped
  try {
    wrapped = make(original)
  } catch {
    return { ok: false, restore() {} }
  }
  if (typeof wrapped !== 'function') return { ok: false, restore() {} }
  wrapped[PATCH_MARK] = true

  try {
    owner[methodName] = wrapped
  } catch {
    return { ok: false, restore() {} }
  }

  let attached = false
  try {
    attached = owner[methodName] === wrapped
  } catch {
    attached = false
  }
  if (!attached) return { ok: false, restore() {} }

  return {
    ok: true,
    restore() {
      try {
        if (hadOwn) owner[methodName] = original
        else delete owner[methodName]
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 造一个注入器。
 *
 * @param lookup `(specifier) => meta | undefined`，返回要叠加的中文元信息
 */
export function createInjector({ lookup, log }) {
  const restores = []
  const status = { metaOf: 'pending', listBundles: 'pending', listPlugins: 'pending', inventoryList: 'pending' }
  // 计数器跨实例共享，理由见文件顶部 COUNTERS 的注释。
  const counters = COUNTERS
  /** 上一次 install 的结果签名，用来避免重复日志。 */
  let lastSignature = ''

  const note = (message) => {
    try {
      log?.(message)
    } catch {
      /* ignore */
    }
  }

  /** 给一行带 meta 的记录补中文；`rows` 是 bundle 里嵌的子行，一并处理。 */
  function projectRow(row) {
    if (!isPlainObject(row)) return row
    const name = row.moduleName ?? row.name
    const extra = lookup(name)
    let next = row
    if (extra !== undefined) {
      const meta = overlayMeta(row.meta, extra)
      if (meta !== row.meta) next = { ...next, meta }
    }
    if (Array.isArray(row.rows) && row.rows.length > 0) {
      const rows = row.rows.map(projectRow)
      if (rows.some((r, i) => r !== row.rows[i])) next = { ...next, rows }
    }
    return next
  }

  function projectRows(value) {
    if (Array.isArray(value)) return value.map(projectRow)
    return value
  }

  /** pluginInventory.list 返回的可能是数组，也可能是 `{ plugins: [...] }` 快照。 */
  function projectSnapshot(value) {
    if (Array.isArray(value)) return projectRows(value)
    if (!isPlainObject(value)) return value
    for (const key of ['plugins', 'entries', 'rows']) {
      if (Array.isArray(value[key])) return { ...value, [key]: value[key].map(projectRow) }
    }
    return value
  }

  function install(serviceName, methodName, kind, key) {
    const online = ctxGet(serviceName)
    if (online === undefined) {
      status[key] = 'missing'
      return
    }
    // 关键：补在真身上，不是补在 traceable Proxy 的 shadow 上（见 unwrap 的注释）。
    const service = unwrap(online)

    const make = (original) => {
      if (kind === 'meta') {
        return function patchedMetaOf(specifier, parentURL) {
          counters[key] += 1
          const result = original.call(this, specifier, parentURL)
          return overlayMeta(result, lookup(specifier))
        }
      }
      const project = kind === 'snapshot' ? projectSnapshot : projectRows
      return function patchedList(...args) {
        const result = original.apply(this, args)
        if (result !== null && typeof result?.then === 'function') {
          return result.then((value) => {
            counters[key] += 1
            return project(value)
          })
        }
        counters[key] += 1
        return project(result)
      }
    }

    // 实例与原型都装：不同调用点拿到的可能不是同一个对象。
    const own = wrapMethod(service, methodName, make)
    let proto
    try {
      const parent = Object.getPrototypeOf(service)
      if (parent !== null && parent !== Object.prototype) proto = wrapMethod(parent, methodName, make)
    } catch {
      proto = undefined
    }

    if (own.ok || proto?.ok === true) {
      status[key] = 'installed'
      if (own.restore) restores.push(own.restore)
      if (proto?.restore) restores.push(proto.restore)
    } else {
      status[key] = 'failed'
    }
  }

  let ctxRef
  function ctxGet(name) {
    try {
      return ctxRef?.get(name)
    } catch {
      return undefined
    }
  }

  /**
   * 把 cordis 的 traceable Proxy 剥回真身。
   *
   * 为什么要剥：`ctx.get()` 走 `reflect.get()` → `getTraceable()`，函数服务会被
   * 包成 `new Proxy(service, {...})`；对它赋值会落到 per-context 的 shadow 上，
   * 而宿主网关（`api-gateway/lib/index.js` 的 `receiverContext.extend(...).get()`）
   * 用的是**另一个 context**，拿到的是另一份 shadow —— 补丁形同虚设。
   * cordis 在 proxy 的 get trap 里留了口子：`Symbol.for('cordis.original')` 返回 target。
   */
  function unwrap(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    try {
      const original = value[Symbol.for('cordis.original')]
      if (original !== undefined && original !== value) return original
    } catch {
      /* ignore */
    }
    return value
  }

  return {
    /** 在宿主服务就绪后调用；可重复调用，已装过的会跳过。 */
    install(ctx) {
      ctxRef = ctx
      for (const target of TARGETS) install(target.service, target.method, target.kind, target.key)
      const ok = TARGETS.filter((t) => status[t.key] === 'installed').map((t) => t.key)
      // 只在结果变化时写日志：重试路径每轮都会调 install，重复刷同一行没有信息量。
      const signature = `${ok.join(',')}|${TARGETS.map((t) => status[t.key]).join(',')}`
      if (signature !== lastSignature) {
        lastSignature = signature
        note(`inject: 已挂载 ${ok.length}/${TARGETS.length} 条通路 [${ok.join(', ')}]`)
      }
      return ok
    },

    get status() {
      return { ...status }
    },

    get counters() {
      return { ...counters }
    },

    /**
     * 自检探针：自己把通路调一遍，看返回里到底有没有 zh。
     *
     * 光看计数器不够 —— 计数器只能证明「我们的皮被调到了」，
     * 证明不了「前端拿到的 meta 确实是中文」。这里直接对比探针前后的
     * COUNTERS 差值，再看返回值里 zh 的命中率，一次把两件事都问清楚。
     *
     * @returns `{ service, calls, total, hit, sample }`
     */
    async probe() {
      const manager = ctxGet('pluginManager')
      if (manager === undefined) return { service: 'missing', calls: 0, total: 0, hit: 0, sample: undefined }
      const before = counters.listBundles + counters.listPlugins
      let rows
      try {
        rows = await manager.listBundles()
      } catch (error) {
        return { service: 'error', calls: 0, total: 0, hit: 0, sample: String(error?.message ?? error) }
      }
      const calls = counters.listBundles + counters.listPlugins - before
      const flat = Array.isArray(rows) ? rows : []
      let hit = 0
      let sample
      for (const row of flat) {
        const meta = row?.meta ?? row?.rows?.[0]?.meta
        if (meta?.description?.zh !== undefined || meta?.title?.zh !== undefined) {
          hit += 1
          if (sample === undefined) sample = meta.description?.zh ?? meta.title?.zh
        }
      }
      return { service: 'pluginManager', calls, total: flat.length, hit, sample }
    },

    get anyInstalled() {
      return TARGETS.some((t) => status[t.key] === 'installed')
    },

    projectRow,
    projectRows,
    projectSnapshot,
    overlayMeta,
    metaFromPacks,
    languagePacksOf,

    dispose() {
      while (restores.length > 0) {
        const restore = restores.pop()
        try {
          restore()
        } catch {
          /* ignore */
        }
      }
      for (const target of TARGETS) status[target.key] = 'pending'
    },
  }
}

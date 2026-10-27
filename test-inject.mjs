/**
 * 注入层的行为测试：不连宿主，全部用假的 service / 假的包目录。
 * 运行：node test-inject.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COUNTERS,
  PATCH_MARK,
  createInjector,
  languagePacksOf,
  metaFromPacks,
  overlayMeta,
  packageNameOf,
} from './inject.js'

let pass = 0
let fail = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}\n       实际 ${a}\n       期望 ${b}`)
  }
}

console.log('\n[1] packageNameOf：子路径要能拆回包名')
eq('裸包名', packageNameOf('dsh-cite'), 'dsh-cite')
eq('子路径', packageNameOf('dsh-ops/shell'), 'dsh-ops')
eq('scoped', packageNameOf('@fffangchenghao/dsh-web-search'), '@fffangchenghao/dsh-web-search')
eq('scoped 子路径', packageNameOf('@fffangchenghao/dsh-web-search/locale/en.json'), '@fffangchenghao/dsh-web-search')
eq('空值', packageNameOf(undefined), undefined)

console.log('\n[2] overlayMeta：只补 zh，绝不覆盖已有内容')
eq(
  '纯字符串 title + 有 zh → 转对象并留住 en',
  overlayMeta({ title: 'Old Name' }, { title: { en: 'Old Name', zh: '旧名字' } }),
  { title: { en: 'Old Name', zh: '旧名字' } },
)
eq(
  '已有 zh 的字段不动',
  overlayMeta({ description: { en: 'A', zh: '甲' } }, { description: { en: 'A', zh: '我们的译文' } }),
  { description: { en: 'A', zh: '甲' } },
)
eq(
  '原文没有 zh 时补上，其它语言键保留',
  overlayMeta({ description: { en: 'A', ja: 'エー' } }, { description: { en: 'A', zh: '甲' } }),
  { description: { en: 'A', ja: 'エー', zh: '甲' } },
)
eq('extra 为 undefined 时原样返回', overlayMeta({ description: { en: 'A' } }, undefined), { description: { en: 'A' } })
eq(
  'original 是 undefined 时直接用 extra',
  overlayMeta(undefined, { description: { zh: '甲' } }),
  { description: { zh: '甲' } },
)
eq(
  '带 error 的 meta 一律不动',
  overlayMeta({ error: 'Plugin metadata for x: boom' }, { description: { zh: '甲' } }),
  { error: 'Plugin metadata for x: boom' },
)
eq(
  '只有 zh 没有 en 时不给人改英文名',
  overlayMeta({ title: { en: 'Keep Me' } }, { title: { zh: '别名' } }),
  { title: { en: 'Keep Me', zh: '别名' } },
)

console.log('\n[3] languagePacksOf / metaFromPacks：直接读磁盘，不走模块解析')
const tmp = mkdtempSync(join(tmpdir(), 'dshzh-'))
try {
  // 包 A：有 exports 的 locale 映射，且带 zh-CN.json（DSH 不认的文件名）
  const a = join(tmp, 'node_modules', 'pkg-a')
  mkdirSync(join(a, 'locale'), { recursive: true })
  writeFileSync(
    join(a, 'package.json'),
    JSON.stringify({ name: 'pkg-a', exports: { '.': './index.js', './locale/*.json': './locale/*.json' } }),
  )
  writeFileSync(join(a, 'locale', 'en.json'), JSON.stringify({ meta: { description: 'English only' } }))
  writeFileSync(join(a, 'locale', 'zh-CN.json'), JSON.stringify({ meta: { description: '作者写的中文' } }))

  const packsA = languagePacksOf(a)
  eq('读到两份语言包', Object.keys(packsA).sort(), ['en', 'zh-CN'])
  eq('metaFromPacks 会采用 zh-CN 作为中文', metaFromPacks(packsA)?.description?.zh, '作者写的中文')

  // 包 B：完全没有 exports 字段 —— 模块解析器不认，但我们直接读目录照样能读
  const b = join(tmp, 'node_modules', 'pkg-b')
  mkdirSync(join(b, 'locale'), { recursive: true })
  writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'pkg-b', main: 'index.js' }))
  writeFileSync(join(b, 'locale', 'en.json'), JSON.stringify({ meta: { description: 'No exports here' } }))
  writeFileSync(join(b, 'locale', 'zh.json'), JSON.stringify({ meta: { description: '没有 exports 也能读' } }))
  eq('无 exports 的包照样读出中文', languagePacksOf(b)?.zh?.description, '没有 exports 也能读')

  // 包 C：locales 目录重映射（@fffangchenghao/dsh-web-search 的形态）
  const c = join(tmp, 'node_modules', 'pkg-c')
  mkdirSync(join(c, 'locales'), { recursive: true })
  writeFileSync(
    join(c, 'package.json'),
    JSON.stringify({ name: 'pkg-c', exports: { './locale/*.json': './locales/*.json' } }),
  )
  writeFileSync(join(c, 'locales', 'en.json'), JSON.stringify({ meta: { title: 'Web Search' } }))
  writeFileSync(join(c, 'locales', 'zh.json'), JSON.stringify({ meta: { title: '网页搜索' } }))
  eq('locales 重映射目录能读到', languagePacksOf(c)?.zh?.title, '网页搜索')

  // 包 D：目录都没有 → undefined，不能抛
  const d = join(tmp, 'node_modules', 'pkg-d')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'pkg-d' }))
  eq('没有语言包目录时返回 undefined', languagePacksOf(d), undefined)

  console.log('\n[4] createInjector：四条通路都要能装、能还原、能投影')
  const lookup = (specifier) => {
    const name = packageNameOf(specifier)
    if (name === 'pkg-a') return { description: { en: 'English only', zh: '作者写的中文' } }
    if (name === 'pkg-b') return { description: { en: 'No exports here', zh: '没有 exports 也能读' } }
    return undefined
  }

  class PluginPackages {
    metaOf(specifier) {
      if (specifier === 'pkg-a') return { description: { en: 'English only' } }
      if (specifier === 'pkg-b') return { description: 'No exports here' }
      return undefined
    }
  }
  const pluginPackages = new PluginPackages()

  const pluginManager = {
    async listBundles() {
      return [
        { name: 'pkg-a', meta: { description: { en: 'English only' } } },
        { name: 'other' },
        {
          name: 'pkg-b',
          meta: { description: 'No exports here' },
          rows: [{ moduleName: 'pkg-a', meta: { description: { en: 'English only' } } }, { moduleName: 'unknown' }],
        },
      ]
    },
    listPlugins() {
      return [{ moduleName: 'pkg-b', meta: { description: 'No exports here' }, enabled: true }]
    },
  }

  const pluginInventory = {
    async list() {
      return { plugins: [{ moduleName: 'pkg-a', meta: { description: { en: 'English only' } } }] }
    },
  }

  const fakeCtx = { get: (name) => ({ pluginPackages, pluginManager, pluginInventory })[name] }
  const injector = createInjector({ lookup, log: () => {} })
  const installed = injector.install(fakeCtx)
  eq('四条通路全装上', installed.sort(), ['inventoryList', 'listBundles', 'listPlugins', 'metaOf'])

  eq(
    'metaOf：纯对象 meta 补上 zh',
    pluginPackages.metaOf('pkg-a'),
    { description: { en: 'English only', zh: '作者写的中文' } },
  )
  eq(
    'metaOf：字符串 meta 转对象并留住 en',
    pluginPackages.metaOf('pkg-b'),
    { description: { en: 'No exports here', zh: '没有 exports 也能读' } },
  )
  eq('metaOf：不认识的包原样返回', pluginPackages.metaOf('unknown'), undefined)

  eq(
    'listBundles：bundle 的 meta 也补上',
    (await pluginManager.listBundles())[0].meta,
    { description: { en: 'English only', zh: '作者写的中文' } },
  )
  eq('listBundles：无关条目原样', (await pluginManager.listBundles())[1], { name: 'other' })
  eq(
    'listBundles：bundle 内嵌的 rows 也补中文',
    (await pluginManager.listBundles())[2].rows[0].meta,
    { description: { en: 'English only', zh: '作者写的中文' } },
  )
  eq('listBundles：rows 里不认识的包原样', (await pluginManager.listBundles())[2].rows[1], { moduleName: 'unknown' })
  eq(
    'listPlugins（同步）：条目 meta 补上',
    pluginManager.listPlugins()[0].meta,
    { description: { en: 'No exports here', zh: '没有 exports 也能读' } },
  )
  eq('listPlugins：enabled 开关不受影响', pluginManager.listPlugins()[0].enabled, true)
  eq(
    'pluginInventory.list：快照结构也要能投影',
    (await pluginInventory.list()).plugins[0].meta,
    { description: { en: 'English only', zh: '作者写的中文' } },
  )
  eq('计数：每条通路都真的被调用过', injector.counters.metaOf > 0 && injector.counters.listBundles > 0, true)

  // 幂等：再装一次不能套两层
  injector.install(fakeCtx)
  const again = pluginPackages.metaOf('pkg-a')
  eq('重复安装不会套两层', again.description.zh, '作者写的中文')
  eq('包装函数带 PATCH_MARK', pluginPackages.metaOf[PATCH_MARK], true)

  injector.dispose()
  eq('dispose 后恢复原样（纯对象）', pluginPackages.metaOf('pkg-a'), { description: { en: 'English only' } })
  eq('dispose 后恢复原样（字符串）', pluginPackages.metaOf('pkg-b'), { description: 'No exports here' })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\n[5] cordis traceable Proxy：补丁必须落在真身上')

// [4] 里的 lookup 定义在 try 块内，这里要一个等价的（只认 pkg-a）。
const proxiedLookup = (specifier) =>
  packageNameOf(specifier) === 'pkg-a' ? { description: { en: 'English only', zh: '作者写的中文' } } : undefined

// cordis 的 reflect.get() 每次都会过 getTraceable()，函数服务被包成 Proxy；
// 对它赋值只落在 per-context 的 shadow 上，网关用另一个 context 重新 get 就看不到了。
// 这里造一个同构的 Proxy（get trap 里剥出 Symbol.for('cordis.original')）复现该场景。
const ORIGINAL = Symbol.for('cordis.original')
function traceable(target) {
  return new Proxy(target, {
    get(object, property) {
      if (property === ORIGINAL) return object
      const value = Reflect.get(object, property)
      if (typeof value !== 'function') return value
      return new Proxy(value, {
        apply(fn, thisArg, args) {
          return Reflect.apply(fn, thisArg === undefined ? object : thisArg, args)
        },
      })
    },
  })
}

const rawManager = {
  async listBundles() {
    return [{ name: 'pkg-a', meta: { description: { en: 'English only' } } }]
  },
}
const proxiedCtx = { get: (name) => (name === 'pluginManager' ? traceable(rawManager) : undefined) }
const proxied = createInjector({ lookup: proxiedLookup, log: () => {} })
proxied.install(proxiedCtx)
eq('真身被套上皮（不是只套了 Proxy）', rawManager.listBundles[PATCH_MARK], true)
eq(
  '绕过 Proxy 直接调真身也能拿到中文',
  (await rawManager.listBundles())[0].meta.description.zh,
  '作者写的中文',
)

console.log('\n[6] 计数器跨实例共享（否则「装上了但 0 次调用」是假象）')
const firstBefore = COUNTERS.listBundles
const second = createInjector({ lookup: proxiedLookup, log: () => {} })
second.install(proxiedCtx) // 有 PATCH_MARK，不会再套一层
eq('第二个实例读到的是共享计数，不是 0', second.counters.listBundles >= firstBefore && second.counters.listBundles > 0, true)
eq('两个实例的计数完全一致', second.counters.listBundles, proxied.counters.listBundles)

console.log('\n[7] probe：一次问清「皮被调到」和「拿到的是中文」')
const probe = await proxied.probe()
eq('探针走的是 pluginManager', probe.service, 'pluginManager')
eq('探针观察到自增（皮真的挂了）', probe.calls > 0, true)
eq('探针命中中文', probe.hit > 0, true)

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

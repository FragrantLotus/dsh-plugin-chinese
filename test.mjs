/**
 * 用假 profile 跑一遍完整流程：不联网，翻译用假的 translator。
 * 目标是证明「只写 description、不写 title、不覆盖已有中文、该补 exports 时才补」。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sweep, isChinese, chunkText, localeDirOf } from './index.js'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

console.log('=== 中文判定 ===')
check('英文长句不是中文', isChinese('A calmer reading view for DeepSeek Harness.'), false)
check('纯中文是中文', isChinese('上下文洞察与管理插件'), true)
check('中英混排算中文', isChinese('DSH Literature 文献侧窗：在侧边栏识别 DOI'), true)
check('空串不是中文', isChinese(''), false)

console.log('=== 长文切分 ===')
const long = `${'Sentence one is here. '.repeat(60)}`
const parts = chunkText(long)
check('切段后能拼回原文长度', parts.join('').replace(/\s+/g, ' ').trim().length <= long.trim().length + 5, true)
check('每段不超上限', parts.every((p) => p.length <= 900), true)

console.log('=== locale 目录识别 ===')
check('默认 locale', localeDirOf('x', { exports: { '.': './i.js' } }), 'locale')
check('映射到 locales', localeDirOf('x', { exports: { './locale/*.json': './locales/*.json' } }), 'locales')
check('无 exports', localeDirOf('x', {}), 'locale')

console.log('=== 端到端：假 profile ===')
const root = join(tmpdir(), `auto-i18n-test-${Date.now()}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'node_modules'), { recursive: true })

function makePackage(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
}

// A: 有 locale 导出但没有语言包 → 应该补，且立即生效
makePackage(
  join(root, 'node_modules', 'pkg-a'),
  { name: 'pkg-a', description: 'Plain English description for A.', exports: { '.': './i.js', './locale/*.json': './locale/*.json' } },
)
// B: 有 exports 但缺 locale 映射 → 应该补映射并标记需要重启
makePackage(
  join(root, 'node_modules', 'pkg-b'),
  { name: 'pkg-b', description: 'Another English description for B.', exports: { '.': './i.js' } },
)
// C: 已有中文简介 → 一个字节都不该动
makePackage(
  join(root, 'node_modules', 'pkg-c'),
  { name: 'pkg-c', description: 'English C.', exports: { '.': './i.js', './locale/*.json': './locale/*.json' } },
  { 'locale/en.json': { meta: { title: 'C Name', description: 'English C.' } }, 'locale/zh.json': { meta: { title: 'C 中文名', description: '这里是现成的中文简介。' } } },
)
// D: 原版有中文名但没有中文简介 → 只补简介，名字必须保留
makePackage(
  join(root, 'node_modules', 'pkg-d'),
  { name: 'pkg-d', description: 'English D.', exports: { '.': './i.js', './locale/*.json': './locale/*.json' } },
  { 'locale/en.json': { meta: { title: 'D Original', description: 'English D.' } }, 'locale/zh.json': { meta: { title: 'D 原始中文名' } } },
)
// E: 没有 exports 字段 → 走旧式解析，不要乱加 exports
makePackage(join(root, 'node_modules', 'pkg-e'), { name: 'pkg-e', description: 'English E, no exports at all.' })
// F: 描述本来就是中文 → 跳过
makePackage(join(root, 'node_modules', 'pkg-f'), { name: 'pkg-f', description: '这个插件的简介本来就是中文写的。' })

writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'profile', dependencies: { 'pkg-a': '1', 'pkg-b': '1', 'pkg-c': '1', 'pkg-d': '1', 'pkg-e': '1', 'pkg-f': '1' } }, null, 2),
)

const fakeTranslator = {
  resolve: (req) => ({ text: req.text }),
  translate: async (spec) => `这是一个自动翻译出来的中文简介，原文长度大约 ${spec.text.length} 个字符。`,
}

const cachePath = join(root, 'cache.json')
const report = await sweep({
  profileDir: root,
  translator: fakeTranslator,
  cache: {},
  cachePath,
  log: () => {},
  config: { gapMs: 1 },
})

const translated = report.translated.map((t) => t.package).sort()
check('翻译了 A/B/D/E 四个', translated, ['pkg-a', 'pkg-b', 'pkg-d', 'pkg-e'])
check('跳过 C（已有中文）和 F（原文即中文）', report.skipped.map((s) => s.package).sort(), ['pkg-c', 'pkg-f'])
check('只有 B 需要重启', report.restartNeeded, ['pkg-b'])

const read = (p) => JSON.parse(readFileSync(join(root, 'node_modules', p), 'utf8'))

console.log('=== 关键断言：绝不凭空写 title ===')
// pkg-d 原版就有 title，属于「必须保留」的情况，单独在下面测；这里只测原本没有 title 的包。
for (const pkg of ['pkg-a', 'pkg-b', 'pkg-e']) {
  const zh = read(`${pkg}/locale/zh.json`)
  check(`${pkg} 的 zh.json 没有新造 title 字段`, 'title' in zh.meta, false)
  check(`${pkg} 的 zh.json 有中文简介`, isChinese(zh.meta.description), true)
}
check('pkg-d 有中文简介', isChinese(read('pkg-d/locale/zh.json').meta.description), true)

console.log('=== 原版中文名必须保留 ===')
check('pkg-d 保留了原版中文名', read('pkg-d/locale/zh.json').meta.title, 'D 原始中文名')
check('pkg-c 完全没被动过', read('pkg-c/locale/zh.json').meta.description, '这里是现成的中文简介。')

console.log('=== exports 处理 ===')
check('pkg-a 的 exports 未被重复添加', Object.keys(read('pkg-a/package.json').exports).filter((k) => k.includes('locale')), ['./locale/*.json'])
check('pkg-b 补上了 locale 映射', read('pkg-b/package.json').exports['./locale/*.json'], './locale/*.json')
check('pkg-e 仍然没有 exports 字段', read('pkg-e/package.json').exports, undefined)

console.log('=== 幂等：再跑一次不应该重复翻译 ===')
const cacheAfter = JSON.parse(readFileSync(cachePath, 'utf8'))
const second = await sweep({
  profileDir: root,
  translator: fakeTranslator,
  cache: cacheAfter,
  cachePath,
  log: () => {},
  config: { gapMs: 1 },
})
check('第二次一个都没翻译', second.translated, [])
check('第二次 B 不再要求重启', second.restartNeeded, [])

rmSync(root, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('全部通过 ✅')
} else {
  console.log(`${failures} 项失败 ❌`)
  process.exitCode = 1
}

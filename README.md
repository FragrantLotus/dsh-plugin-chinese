# dsh-plugin-chinese · 插件汉化

自动给**每个已安装的 DSH 插件**补上中文功能简介。

插件名一律保持原样 —— 只写 `description`，不写 `title`。DSH 在缺少 `title` 时会回落到 `package.json` 的 `name`，所以列表里显示的名字永远是包名或作者自带的中文名，**方便按名字找插件**。

## 安装

```bash
npm install dsh-plugin-chinese
```

装好后在 profile 的 `cordis.patch.yml` 里插一行，让它随宿主加载：

```yaml
- insert:
    - id: auto-i18n
      name: 'dsh-plugin-chinese'
```

重启 DSH 生效，之后新装插件自动补中文简介。

## 为什么需要它

DSH 读取插件显示信息的链路是：

```
插件页 → 宿主 readPluginMeta(specifier)
       → 读 <pkg>/locale/en.json
       → 扫同目录所有 *.json 当语言包
       → 前端按当前界面语言取对应字段
```

只有当包里存在 `locale/zh.json`、**且** `package.json` 的 `exports` 暴露 `./locale/*.json` 时，中文简介才会显示。大量插件作者只写了英文 `description`，于是插件页长期是英文。

本插件自动补这两样东西。

## 翻译来源（两级回退）

1. **作者原稿优先** —— 包里若已有 `zh-CN.json` / `zh_CN.json` 这类作者写的中文，直接采用，不再送机翻（避免把作者的好译文翻坏）。
2. **宿主 translator 服务** —— DSH 自带的 `ctx.get('translator')`；本机实测它走 Bing 匿名通道，不需要 API key。

拿不到 translator 时不会乱写：该插件会被记为 `翻译服务不可用` 跳过，等下次巡检再试。

译文落地前会过一遍术语表（`GLOSSARY`），修正机翻常译错的专有名词。

## 触发时机

| 时机 | 说明 |
| --- | --- |
| 启动后 4 秒 | 装完重启即自动补一遍 |
| 每 30 分钟 | 定时巡检（`intervalMinutes` 可调） |
| 插件变动后 1.5 秒 | 监听 `plugin-manager/changed`，新装或升级后立刻补 |

**新装插件自动生效**，不需要手工跑脚本。

本插件用**两条腿**走路：写磁盘语言包（长期、对所有入口都成立），加一层内存注入（立刻生效、不等重启）。

## 两条腿

### 一、内存注入（立刻生效）

宿主把插件元信息从磁盘读出来后，会在内存里缓存。只写文件的话，界面要等下次重读才变。

所以插件在启动几秒后，给返回插件元信息的四个函数各包一层，把 `zh` 字段补进 `meta` 里：

| 服务 | 方法 | 作用 |
| --- | --- | --- |
| `pluginPackages` | `metaOf` | 元信息的真正源头 |
| `pluginManager` | `listBundles` | 「已安装」分组的 bundle 列表（含内嵌 `rows`） |
| `pluginManager` | `listPlugins` | Loader 条目列表（右侧启用开关所在） |
| `pluginInventory` | `list` | 插件清单 Remote 网关 |

前端 `resolveText()` 从 `{ en, zh }` 里自然取到中文。**不碰 DOM、不改别人的文件、不需要重启。**

这一层读中文**直接读磁盘文件**（`readdir` + `readFile`），完全不走 Node 模块解析器 —— 这正是它能绕开 `exports` 解析缓存的原因：重启后会显示成什么样，它现在就显示成什么样，两者永远一致。

#### 补在「真身」上，不是补在代理上

DSH 的插件服务放在 Cordis 容器里，`ctx.get()` 拿到的是 `getTraceable()` 包出来的 Proxy：对它赋值只会落到「当前 context 的 shadow 副本」上，而宿主网关调用服务时是**用另一个 context 重新 get** 的（`api-gateway` 里 `receiverContext.extend(...).get(service)`），看到的是另一份 shadow —— 补丁就白打了。

所以这里先用 `Symbol.for('cordis.original')` 把 Proxy 剥回真身，再补到真身和它的原型上。

#### 自检看的是结果，不是次数

判断「注入有没有真的生效」，不能只看包装函数被调了几次：计数为 0 既可能是没人调用，也可能是计数写在了别的实例上。插件每 60 秒自己做一次探针 —— 真的调一遍 `listBundles`，数返回结果里有几条 `meta.description.zh`，把「皮挂上了」和「拿到的是中文」分开报告。

### 二、写磁盘语言包（长期生效）

同时把译文写进 `<pkg>/locale/zh.json`，这样即使哪天本插件被卸掉，中文简介仍然在。

## 生效条件

Node 会缓存 `package.json` 的 `exports`，因此分三种情况：

| 包的状态 | 写入磁盘后 |
| --- | --- |
| 已声明 `./locale/*.json` 导出，只是缺文件 | **刷新页面即生效** |
| 完全没有 `exports` 字段（旧式解析） | **刷新页面即生效** |
| 有 `exports` 但没有 locale 映射，被自动补上 | 磁盘语言包需重启一次；**内存注入层已即时生效** |

第三种情况会列在 `report.json` 的 `restartNeeded` 里。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不再扫描与翻译 |
| `intervalMinutes` | `30` | 定时扫描间隔（分钟） |
| `gapMs` | `1200` | 翻译请求间隔（毫秒），避免被限流 |

## 状态文件

都在 `$DSH_HOME/auto-i18n/`：

- `cache.json` —— 原文 → 译文缓存，避免重复请求
- `report.json` —— 最近一次扫描明细（scanned / translated / skipped / failed / restartNeeded）
- `auto-i18n.log` —— 出错或有大变动时记一行

## 安全约束

- **绝不写 `title`**，插件名永不被改；注入层也不会凭空造 `title.zh`
- 已有的 `zh` 一律不覆盖（作者的稿子、别家插件的成果都不动）
- 写入用「先写临时文件再 rename」，断开 pnpm 硬链接，不污染 pnpm store
- 只在 `locale/` / `locales/` 下动手，不改包的其它文件
- 原文已是中文的包直接跳过
- 插件被禁用/卸载时包装函数全部还原（`dispose()`）

## 开发

```bash
node test.mjs          # 磁盘翻译那条路：26 项断言
node test-inject.mjs   # 内存注入那条路：33 项断言
```

`test.mjs` 在临时目录造假插件包，覆盖：有导出缺文件 / 有 exports 缺映射 / 已有中文 / 有原版中文名 / 无 exports / 原文即中文，断言「不写 title」「保留原版名」「exports 该补才补」「幂等」。

`test-inject.mjs` 用假 service 覆盖四条通路，断言「只补 zh、不覆盖已有 zh」「纯字符串 meta 转对象要留住 en」「bundle 内嵌 rows 也投影」「幂等不套两层」「dispose 后完全还原」。

## 已知限制

- 升级插件会覆盖本插件写入的 `locale/zh.json`，但下次巡检会自动重新补上。
- 若插件作者后续自己加了中文简介，本插件会识别并跳过，不会覆盖。

## License

MIT

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

## 翻译来源（三级回退）

1. **作者原稿优先** —— 包里若已有 `zh-CN.json` / `zh_CN.json` 这类作者写的中文，直接采用，不再送机翻（避免把作者的好译文翻坏）。
2. **宿主 translator 服务** —— DSH 自带的 `ctx.get('translator')`（匿名免费通道）。
3. **MyMemory 免费接口** —— 前两条都不可用时的兜底。

译文落地前会过一遍术语表（`GLOSSARY`），修正机翻常译错的专有名词。

## 触发时机

| 时机 | 说明 |
| --- | --- |
| 启动后 4 秒 | 装完重启即自动补一遍 |
| 每 30 分钟 | 定时巡检（`intervalMinutes` 可调） |
| 插件变动后 1.5 秒 | 监听 `plugin-manager/changed`，新装或升级后立刻补 |

**新装插件自动生效**，不需要手工跑脚本。

## 生效条件

Node 会缓存 `package.json`，因此分三种情况：

| 包的状态 | 写入后 |
| --- | --- |
| 已声明 `./locale/*.json` 导出，只是缺文件 | **刷新页面即生效** |
| 完全没有 `exports` 字段（旧式解析） | **刷新页面即生效** |
| 有 `exports` 但没有 locale 映射，被自动补上 | **需重启一次** |

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

- **绝不写 `title`**，插件名永不被改
- 写入用「先写临时文件再 rename」，断开 pnpm 硬链接，不污染 pnpm store
- 只在 `locale/` / `locales/` 下动手，不改包的其它文件
- 原文已是中文的包直接跳过

## 开发

```bash
node test.mjs   # 需在能解析 @deepseek-ai/schemastery 的目录下运行
```

测试在临时目录造 6 个假插件包，覆盖：有导出缺文件 / 有 exports 缺映射 / 已有中文 / 有原版中文名 / 无 exports / 原文即中文，断言「不写 title」「保留原版名」「exports 该补才补」「幂等」。

## 已知限制

- 升级插件会覆盖本插件写入的 `locale/zh.json`，但下次巡检会自动重新补上。
- 若插件作者后续自己加了中文简介，本插件会识别并跳过，不会覆盖。

## License

MIT

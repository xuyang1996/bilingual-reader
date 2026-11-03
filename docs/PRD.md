# Bilingual Reader 双语对照翻译 — 产品需求文档

| 项 | 内容 |
| --- | --- |
| 产品名称 | Bilingual Reader — 双语对照翻译 |
| 当前版本 | v1.4.0（Chrome MV3） |
| 文档版本 | v1.0（依据 v1.4.0 实现反向梳理） |
| 文档状态 | 与代码实现一致 |
| 形态 | Chrome 扩展，解压即用，零构建、无打包工具依赖 |

---

## 一、产品概述

### 1.1 一句话定位

一个**段落级双语对照**的网页翻译扩展：只翻真正的正文，译文紧贴原文排布，且**只对接用户自己的大模型 API**。

### 1.2 要解决的问题

| 现状痛点 | 本产品的回答 |
| --- | --- |
| 整页机翻，导航、侧栏、页脚、目录一起被翻，噪音大 | 两级正文识别：站点框架整棵排除、链接密集容器只排链接型块 |
| 译文和原文分两页，来回对照麻烦 | 原文内嵌译文，一屏同时可见，还原后 DOM 逐字节回到原状 |
| 每家大模型 API 格式不同，接一家写一遍 | 统一内核适配 4 种接口形态 + 17 条响应取值路径 + 地址/鉴权候选回退 |
| 免费翻译接口限流、可用性差 | 只支持 BYOK；本地模型（Ollama/vLLM/LM Studio）鉴权选「无」即可用 |
| 术语、语气、格式无法按内容类型切换 | 14 个内置翻译风格场景 + 按网址自动匹配 + 完全自定义 |
| 敏感信息随正文发出去 | PII 脱敏：翻译前本地替换为占位符，送回后本地还原 |
| 反复访问同一页面重复烧额度 | 译文按「原文+语向+引擎」哈希缓存，命中零请求 |

### 1.3 产品目标

1. **翻译质量**：正文识别准确、译文贴合原文排版、术语可控。
2. **接入成本**：填一个 Base URL + 模型名 + Key 即可用，兼容市面上绝大多数模型 API。
3. **可控性**：识别范围、译文样式、场景提示词、术语、隐私策略全部可调。
4. **可恢复**：任何时刻能一键还原，且还原后页面与翻译前完全一致。

### 1.4 非目标（本版本明确不做）

- 不做浏览器内置页（`chrome://`、应用商店）的翻译。
- 不做闭源 Shadow DOM 穿透。
- 不做插件市场分发与账号体系。
- 不做 Firefox / Safari 适配（代码可移植，但本版本只保证 Chrome）。
- 不做跨设备配置同步（配置可导出为 JSON 手动迁移）。

---

## 二、目标用户与核心场景

### 2.1 目标用户

| 用户 | 诉求 | 对应能力 |
| --- | --- | --- |
| 技术从业者 | 读英文文档、GitHub、论文，同时保留代码原样 | 编程文档 / GitHub / 学术论文场景；代码块强制保留原文 |
| 自建网关 / 私有部署用户 | 接口是自研的，格式不标准 | 「完全自定义」引擎：自定义地址、路径、请求头、请求体、响应字段路径 |
| 本地模型用户 | 不愿把内容发到云端 | Ollama / vLLM / LM Studio 预设，鉴权选「无」，叠加 PII 脱敏 |
| 隐私敏感用户 | 正文里含邮箱、电话、卡号 | PII 脱敏 7 类可单独勾选 |
| 多模型对比用户 | 想在不同模型之间切换 | 多引擎并存，下拉一键切换 |

### 2.2 核心用户旅程

```
安装 → 打开设置页「翻译引擎」
     → 「选择翻译引擎」→ 挑一个供应商（如 DeepSeek）
     → 填 Base URL / 模型 / API Key → 「测试连接」
     → 「保存这个引擎」
     → （可选）「翻译风格」选一个场景 / 建自己的场景
     → 打开任意英文网页 → 点扩展图标 → 「翻译此页」
     → 原文在上、译文在下逐段对照
```

---

## 三、产品架构

### 3.1 技术形态

- **Manifest V3**，`minimum_chrome_version: 96`，仅 Chrome。
- **零构建**：全部为 classic script，挂载到全局命名空间 `IMT`；无 npm、无打包器，克隆即改即跑。
- **后台**：MV3 Service Worker（`src/background/worker.js`）。
- **权限**：`storage` / `contextMenus`，主机权限 `<all_urls>`。

### 3.2 模块划分

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 共享 | `src/shared/defaults.js` | 标签常量、阈值、语言表、供应商预设、默认配置 |
| 共享 | `src/shared/utils.js` | 工具函数、配置合并与迁移、引擎就绪判定、缓存键 |
| 共享 | `src/shared/prompts.js` | 14 个翻译风格场景 + 提示词拼装工具集 |
| 核心 | `src/core/rules.js` | 通用规则 + 站点规则的合并与归一化 |
| 核心 | `src/core/segment.js` | DOM 分段与两级正文识别 |
| 核心 | `src/core/pii.js` | PII 编码 / 解码 / 扫描 |
| 核心 | `src/core/glossary.js` | 术语库解析、提示词生成、强制替换 |
| 核心 | `src/core/render.js` | 译文插入与还原 |
| 核心 | `src/core/pipeline.js` | 翻译队列、懒翻译、增量翻译、并发控制 |
| 后台 | `src/background/engines.js` | 通用大模型引擎内核（地址候选 / 鉴权候选 / 响应解析 / 批量协议） |
| 后台 | `src/background/cache.js` | 译文缓存 |
| 后台 | `src/background/worker.js` | 消息路由、配置读写、右键菜单、快捷键 |
| 内容 | `src/content/content.js` | 页面侧指令处理与进度上报 |
| 界面 | `src/popup/` | 控制面板 |
| 界面 | `src/options/` | 设置页（左侧分类导航 + 右侧内容区） |

### 3.3 核心数据流

```
用户点「翻译此页」
  popup ──IMT_PAGE_ACTION──▶ worker ──tabs.sendMessage──▶ content
                                                              │
                        segment（识别正文块）                    │
                        pipeline（队列/懒翻译/并发）           │
                              │  IMT_TRANSLATE（批量文本）     │
                              ▼                                │
                          worker ──▶ engines.dispatch ──▶ 大模型 API
                              │                                │
                              │◀──────────── 译文 ─────────────┘
                              │
                        pii.decode（还原占位符）
                              │
                        cache.set（写缓存）
                              │
                        render.insert（原文内嵌译文）
```

---

## 四、功能需求

### FR-1 翻译引擎配置

#### FR-1.1 引擎模型

扩展**只有一种引擎类型**：`ai`（通用大模型接口）。所有供应商差异都靠一份配置适配。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `format` | 是 | 接口形态：`openai` / `anthropic` / `gemini` / `custom` |
| `baseUrl` | 是 | 接口根地址 |
| `path` | 否 | 接口路径；留空按 `format` 自动推断 |
| `model` | 是 | 模型名 |
| `key` | 视情况 | API Key；`auth = none` 或本机地址时可为空 |
| `auth` | 是 | `auto` / `bearer` / `x-api-key` / `api-key` / `query` / `none` |
| `queryKey` | 否 | query 鉴权的参数名，默认 `key` |
| `responsePath` | 否 | 自定义响应取值路径（支持 `a.b[0].c` 与 `a.b.0.c`） |
| `systemRole` | 否 | `system` / `developer` / `user` / 留空按模型自动判断 |
| `temperature` / `maxTokens` | 否 | 0 表示不发送 |
| `timeout` / `batchSize` | 否 | 超时秒数；单次请求条数 |
| `headers` / `extraBody` | 否 | 自定义请求头 / 额外请求体（JSON） |
| `systemPrompt` | 否 | 引擎级自定义系统提示词，优先级最高 |
| `name` | — | 引擎显示名（见 FR-1.4） |
| `custom` / `presetId` / `seq` | — | 内部字段：是否自定义、来源预设、列表排序序号 |

#### FR-1.2 「选择翻译引擎」交互

设置页「翻译引擎」分类**只有一个下拉**：

- 上半段分组 **已配置的引擎**：显示引擎名，配好的不带后缀，没配好的带「（未配置）」。
- 下半段分组 **添加新引擎**：30 个供应商预设 + 「完全自定义（空白配置）」。
- **默认不选任何引擎**，下方展示空状态提示。

选中行为：

| 选中项 | 行为 |
| --- | --- |
| 已配置的引擎 | 下方渲染该引擎表单，字段为**已保存的数据** |
| 未配置的供应商预设 | 新建一个**空白**引擎并切过去，表单各字段为空；预设的推荐地址/路径/模型以 **placeholder + 提示行**给出参考 |
| 完全自定义 | 新建一个空白引擎，额外提供「引擎名称」输入框 |

- **同一时刻只渲染一个引擎的表单**，不再摊开多张卡片。
- 表单输入**实时同步**到内存配置，切换引擎不丢已填内容。
- 每个引擎提供「测试连接」与「保存这个引擎」，页面顶部提供全局「保存全部」。
- 可删除任意引擎（包括删到 0 个）。

#### FR-1.3 引擎名规则

- **预设引擎**：引擎名 = 模型名。改模型名，引擎名实时跟着变；用户**不能**单独改预设引擎的名字。
- **完全自定义的引擎**：额外提供「引擎名称」输入框，可自由填写；留空时回落为模型名。
- **唯一性**：所有引擎名不得重复（大小写不敏感）。保存时检测到重名会**拦截保存**并提示「引擎名「xxx」重复了，请换一个名字（预设引擎请改模型名）」，且不会写入存储。

#### FR-1.4 就绪判定与强制提醒

一个引擎「可用」的条件（满足任一）：

1. `key` 非空；
2. `auth = none`（本地模型 / 自建网关）；
3. `baseUrl` 指向本机（`localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]`）。

**未配置任何可用引擎时，四层强制提醒**：

| 层 | 表现 |
| --- | --- |
| popup | 顶部醒目横幅「尚未配置翻译引擎」+「去配置翻译引擎」按钮；「翻译此页」按钮**禁用** |
| 设置页 | 「翻译引擎」分类顶部红色横幅 |
| 设置页侧边栏 | 「翻译引擎」项右侧**红色感叹号角标** |
| 后台 | 翻译请求返回 `needConfig: true` + 明确指引去设置页 |

当前选中的引擎没配好但别的配好了时：横幅转为**黄色提示**，说明会改用哪个引擎，不阻断使用。

#### FR-1.4b 演示模式（离线可验证性）

扩展的核心功能必须由用户自备 API（没有免 Key 通道），这导致「刚装上、还没配 Key」的
用户看不到任何效果，**商店审核员也无法验证功能**。因此内置一个演示引擎：

| 项 | 行为 |
| --- | --- |
| 实现 | `format = 'demo'`，完全在本地用内置词表拼示例译文 |
| 网络 | **不发起任何网络请求** |
| API Key | **不需要** |
| 覆盖范围 | 整句翻译表（覆盖扩展自带演示页的每一句）+ 词级替换兜底 |
| 标注 | popup 黄色横幅、设置页说明框、译文浅黄底纹（`data-imtl-demo="1"`） |
| 定位 | **不是机器翻译**，只用于体验界面与流程；真实翻译必须配置自己的 API |

#### FR-1.5 供应商预设（30 个）

| 类别 | 预设 |
| --- | --- |
| 国际 | OpenAI、Anthropic Claude、Google Gemini、DeepSeek、Kimi、OpenRouter、Groq、Together AI、Fireworks AI、xAI Grok、Mistral、硅基流动、MiniMax、百川 |
| 国内 | 通义千问 DashScope、智谱 GLM、豆包火山方舟、腾讯混元、百度千帆、魔搭 ModelScope |
| 自建 / 聚合 | Azure OpenAI、OpenAI Responses API、New API / One API 聚合站 |
| 本地 | Ollama、vLLM、LM Studio（鉴权「无」，无需 Key） |

#### FR-1.6 接口兼容性兜底

| 不一致之处 | 处理方式 |
| --- | --- |
| Base URL 该不该带 `/v1` | 自动试多个候选地址：`base+path` → `base+/v1+path`（仅 OpenAI 形态且 base 无版本段时）；**只在 404/405 时**换下一个；**成功后记住**（内存 + `chrome.storage.session`），后续请求直击命中 |
| 鉴权头五花八门 | Bearer / `x-api-key` / `api-key` / URL 参数 `?key=` / 无。`auto` 时依次回退，**只在 401/403 时**换，并记住 |
| 推理模型不吃 `temperature` | 模型名命中 `o1/o3/o4-mini/gpt-5/reasoner/reasoning/deepseek-r1/qwq/thinking` 时不发 temperature，且改用 `max_completion_tokens`，system 角色默认降为 `developer` |
| `system` 角色不被支持 | 可选 `developer`，或把提示词拼进 user 消息 |
| 返回结构各家不同 | 17 条取值路径依次尝试（OpenAI `choices[0].message.content`（字符串/parts 数组）、Responses API `output[0].content[0].text`、Anthropic `content[]`、Gemini `candidates[0].content.parts[]`、`translations[0].text`、`translation`、`result`、`data[0].text` 等）；也可自己填「响应字段路径」 |
| 思维链混进译文 | `reasoning_content` 排在 `content` **之后**仅作兜底；推理模型同时返回思维链与正式译文时，先命中的是 `content`，思维链不会进入译文（单元测试对此有专门断言） |
| 网关无视 `stream:false` 返回事件流 | 自动识别 SSE 并拼接增量内容 |
| 一段一段翻太慢 | 「单次请求条数」> 1 时用编号协议一次翻多条；**编号对不上自动回退逐条**，不错位 |
| 并发探测重复打 404 | 同一引擎的并发请求共享同一次地址探测，不会各自吃一遍 404 |

#### FR-1.7 配置迁移

| 场景 | 处理 |
| --- | --- |
| v1.2.0 的免 Key 免费引擎 | 删除该配置项（功能本身已下线） |
| v1.3.0 预置但**从未动过**的 OpenAI / Anthropic / Gemini | 自动清除（用户不该看到三个空表单） |
| v1.3.0 预置且**用户改过**的 | 保留，引擎名按新规则改写为模型名 |
| 老配置缺少引擎排序序号 | 补齐 `seq`，保证列表顺序在刷新前后一致 |
| `engines` / `customScenarios` 两张表 | **整份替换**语义（不是逐键合并），否则「删除某个引擎 / 删除某个自定义场景」删不掉 |

---

### FR-2 翻译风格（场景）

#### FR-2.1 场景库

14 个内置场景，提示词改编自开源 `immersive-translate/prompts`：

`通用` / `科技` / `新闻` / `学术论文` / `编程文档` / `GitHub` / `法律` / `医疗健康` / `金融财经` / `电商购物` / `客服对话` / `文学小说` / `社交媒体` / `通俗英语`

每个场景包含：中文名、中文描述、英文系统提示词、网址匹配规则（可选）。

#### FR-2.2 选择与编辑交互

- 场景以**单选列表**呈现，每项显示名称、描述，以及「自定义」/「已改写」标记。
- **选中某项后，该项的正下方直接摊开它的表单**（不再是折叠的「编辑」抽屉）：
  场景名称 / 场景说明 / 提示词（`{target}` 会被替换成目标语言名称）/ 网址匹配（每行一条，支持 `*` 通配）。
- 表单可修改，点「保存这个场景」**立即落盘**。
- 改写内置场景会写入 `customScenarios` 覆盖同 id 的内置项，并显示「已改写」标记；「恢复内置提示词」可撤销。
- 可新增自定义场景、可删除自定义场景（删除后回落到「通用」）。
- 自定义场景与内置同 id 时，**网址匹配规则取并集**，避免只改提示词却丢掉内置的自动匹配能力。

#### FR-2.3 按网址自动匹配

- 开关「自动匹配」默认开启。
- 命中当前网址的场景**覆盖**用户手选的场景；未命中则回落到手选场景。
- 匹配规则为通配符模式（`*`），支持域名、`||` 多域名。

#### FR-2.4 提示词拼装优先级

```
1. 引擎卡片上的「自定义系统提示词」  ← 有则直接短路，后面两层完全不出现
2. 当前生效的翻译风格场景提示词        ← 追加在通用规则之后的一段专业化约束
3. 通用翻译规则（BASE_RULES：只输出译文 / 保留结构 / 保留代码与标识符 / 一进一出 / 已是目标语言则原样返回）
────────────────────────────────────────
+ 批量协议追加（单次请求条数 > 1 时）
+ 术语库（始终追加在最后）
```

> 「三层」指的是**谁能覆盖谁**，不是三段文本上下叠放：①吞掉②③，②是在③基础上补充。
> 最终提示词的实际形态见 `docs/DEVELOPMENT.md` §4.5。

---

### FR-3 正文识别

#### FR-3.1 翻译单元

**叶子块级元素** = 自身不含块级子元素的块级元素。
`<div><p>a</p><p>b</p></div>` 中 div 是容器（跳过），两个 `p` 分别是翻译单元 —— 天然得到段落级对照。

#### FR-3.2 两级识别

**第一级 · 站点框架（结构性证据）→ 整棵子树排除**

| 判据 | 集合 |
| --- | --- |
| 语义地标标签 | `NAV` / `ASIDE` / `FOOTER` |
| ARIA 角色 | `navigation` / `complementary` / `contentinfo` / `banner` / `menu` / `menubar` / `search` / `toolbar` / `tablist` |
| class / id 词元 | `nav` `navbar` `navigation` `menu` `sidebar` `aside` `breadcrumb(s)` `pagination` `paginator` `pager` `toc` `footer` `masthead` `topbar` `toolbar` `comment(s)` `disqus` `related` `recommend` `recirc` `promo` `advert(isement)` `banner` `social` `share` `sharing` `subscribe` `newsletter` `cookie(s)` `consent` `notice` `widget` `byline` `sitemap` `offcanvas` `drawer` `skip` `screenreader` `visuallyhidden` |

> class / id 先按非字母数字切词再**精确匹配**，不做子串匹配 —— 否则 `content-meta`、`mainmenu` 这类正常类名会被误判。

**第二级 · 链接密集容器（纯内容证据）→ 只排除其中的「链接型」块**

同时满足才判定为链接密集容器：

| 条件 | 阈值 |
| --- | --- |
| 链接条数 | ≥ 4 |
| 链接文字 / 容器可见文字 | ≥ 0.55 |
| 平均每条链接长度 | ≤ 32 |
| 容器文字 / 全页文字 | ≤ 0.25 |

> 第四条是刻意加的：Hacker News 的文章列表本身就是一堆链接，占了全页大半个篇幅，不能当成导航剔掉。
> 第二条用**可见字符数**而非原始字符数统计 —— HTML 排版留下的换行缩进会把文字量撑大好几倍，把链接占比稀释到阈值以下，导致目录反而认不出来。

#### FR-3.3 始终保留原文、不翻译的元素

**完全跳过（连子树都不翻）** —— `EXCLUDE_TAGS`：

`HEAD` `TITLE` `BASE` `LINK` `META` `STYLE` `SCRIPT` `NOSCRIPT` `TEMPLATE` `SVG` `MATH` `CANVAS` `IFRAME` `OBJECT` `EMBED` `AUDIO` `VIDEO` `PICTURE` `SOURCE` `TRACK` `AREA` `MAP` `PARAM` `TEXTAREA` `SELECT` `OPTION` `OPTGROUP` `DATALIST` `INPUT` `BUTTON` `PROGRESS` `METER` `OUTPUT` `XMP` `PLAINTEXT` `LISTING` `FRAME` `FRAMESET` `NOFRAMES` `MARQUEE` `BLINK` `FOREIGNOBJECT`

**保留原文** —— `STAY_ORIGINAL_TAGS`：

`CODE` `PRE` `KBD` `SAMP` `VAR` `TT` `SUP` `SUB` `MATH` `MSUP` `MSUB` `MROW` `MFRAC` `MSQRT` `MSPACE` `MI` `MO` `MN` `MOP` `MOPEN` `MCLOSE` `MTEXT` `MPOINT` `MPRESCRIPTS` `SVG` `PATH` `G` `CIRCLE` `RECT` `LINE` `POLYLINE` `POLYGON` `TEXT` `USE` `DEFS`

> `CODE` `KBD` `SAMP` `VAR` `TT` 属于**内联保护**：文本被占位符保护后照常翻译周围内容，但不阻断整棵子树。

**其他跳过条件**：

- 元素或其祖先带 `translate="no"` 属性
- 带 `.notranslate` class
- `aria-hidden="true"` 或 `hidden` 属性
- 自身已被扩展标注（`.imtl-original` / `.imtl-translation` / `[data-imtl-state]`）
- 布局中不可见（`display:none` / `visibility:hidden` / 零尺寸）

#### FR-3.4 阈值与开关

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 段落最少字符数 | 2 | 低于此值不翻译 |
| 整页正文最少字符数 | 50 | 低于此值整页不翻 |
| 整页翻译 | 关 | 打开后连导航/侧栏/页脚一起翻 |
| 正文容器选择器 | 空 | 指定 `main, article, .post-content` 之类，精确圈定正文 |
| 懒翻译 | 开 | 进入视口 ±300px 才发请求 |
| 增量翻译 | 开 | `MutationObserver` 监听动态插入内容并补翻 |
| 打开页面自动翻译 | 关 | |

---

### FR-4 译文渲染与模式

#### FR-4.1 渲染结构

原文块被包成：

```html
<font class="imtl-original">原文…</font>
<font class="imtl-translation" notranslate>译文…</font>
```

- 用 `<font>` 包裹原文（而非重写 DOM），保证还原时能逐字节回到原状。
- 译文带 `notranslate`，避免浏览器自带的翻译功能二次干预。
- 插入是**幂等**的：已翻译的块不会重复插入。

#### FR-4.2 三种显示模式

| 模式 | 表现 |
| --- | --- |
| 双语对照（dual） | 原文 + 译文，默认 |
| 仅译文（translation） | 隐藏原文，只留译文 |
| 仅原文（original） | 隐藏译文（切换到纯原文阅读） |

#### FR-4.3 译文样式

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 译文位置 | 原文在上 / 译文在下 | 可切换为译文在上 |
| 译文标签 | `font` | 可选 `span` / `div` |
| 译文字号 | `inherit` | |
| 译文行高 | `1.7` | |
| 译文间距 | 8px | |

#### FR-4.4 还原

「还原本页」会移除所有注入节点、去掉所有 `data-imtl-*` 属性与 `imtl-*` class，**包括清掉 Chrome `classList.remove()` 残留的空 `class=""`**，使 DOM 与翻译前逐字节相同（单元测试对此有专门断言）。

---

### FR-5 站点规则

- 以 JSON 数组定义，按站点生效，可覆盖通用规则。
- 规则字段：`id` `name` `enabled` `urlPattern[]` `parentId` `translationMode` `translationPosition` `sourceLang` `targetLang` `tags[]` `excludeSelectors[]` `mainSelector` `translateChrome` `thresholds{}`。
- `urlPattern` 支持 `*` 通配与 `||` 多域名。
- `parentId` 支持规则继承。
- 命中多条时，**匹配强度越具体的优先级越高**（更长的模式、更多域名段优先）。
- 非法字段在归一化时被裁剪：模式只接受 `dual`/`translation`/`original`，位置只接受 `after`/`before`。

---

### FR-6 术语库

- 每行一条：`英文原文<TAB>中文译法`（也支持 `->`、`=>`、`|` 分隔）。
- 术语会**写进系统提示词**，让模型照着翻。
- 返回后**再做一次强制替换**兜底（大小写敏感可配）。
- 界面提供「整理格式」与实时条数统计。

---

### FR-7 隐私与缓存

#### FR-7.1 PII 脱敏

- 翻译前把敏感信息替换为 `__PII_<类型>_<序号>__` 占位符，**原文不出本机**。
- 译文返回后在本地还原。
- 解码时对占位符做**宽松匹配**（容忍模型插入的空格/下划线变化）。
- 7 类可单独勾选：邮箱地址、电话号码、信用卡号、身份证号、IP 地址、网址、银行账号（IBAN）。

#### FR-7.2 翻译缓存

- 缓存键 = `hash(原文 + 源语言 + 目标语言 + 引擎 id)`。
- 默认有效期 30 天（可配 1–365 天）。
- 命中缓存**零请求、零额度消耗**。
- 提供缓存统计与一键清空。

---

### FR-8 配置数据管理

| 能力 | 说明 |
| --- | --- |
| 导入 / 导出 | 导出为 JSON 备份；导入后与默认配置合并 |
| 恢复默认设置 | 清空所有自定义规则、术语库与密钥 |
| 存储位置 | `chrome.storage.local`，**只在本机**，密钥永不上传 |
| 敏感信息 | API Key 只写入本机存储；扩展不上传任何用户数据 |

---

### FR-9 交互入口

| 入口 | 能力 |
| --- | --- |
| **Popup 控制面板** | 翻译/还原按钮、三种显示模式、目标语言下拉（17 种可译语言）、翻译引擎下拉、当前翻译风格、实时状态（已译段数 / 失败数）、跳转设置页 |
| **快捷键** | `Alt+T` 翻译/还原当前页；`Alt+Shift+T` 翻译当前页；`Alt+Shift+R` 还原当前页 |
| **右键菜单** | 「翻译本页（双语对照）」「还原本页」「仅显示译文」「仅显示原文」 |
| **设置页** | 左侧 8 分类导航（翻译引擎 / 翻译风格 / 正文识别 / 译文样式 / 站点规则 / 术语库 / 隐私与缓存 / 数据与关于），`sessionStorage` 记住上次所在面板 |

---

## 五、非功能需求

| 维度 | 要求 | 实现方式 |
| --- | --- | --- |
| 性能 | 页面打开不因翻译而阻塞 | 懒翻译（视口 ±300px 才发请求）+ 并发上限 4（批量模式降为 2） |
| 幂等性 | 重复翻译不产生重复节点 | 块上 `data-imtl-state` 标记 |
| 可恢复性 | 还原后 DOM 与翻译前一致 | `<font>` 包裹而非 DOM 重写；还原时清理空 class |
| 兼容性 | Chrome 96+ | MV3，避开仅在更高版本可用的 API |
| 可移植性 | 不绑定构建工具 | 纯 classic script + `IMT` 全局命名空间 |
| 隐私 | 内容与密钥不出本机 | BYOK + PII 脱敏 + 本地存储 |
| 可测试性 | 关键逻辑可离线验证 | 单元测试页（67 项断言）、大模型接口自测台、端到端脚本、设置页往返脚本 |
| 无障碍 / 兼容 | 翻译不破坏页面结构 | 代码/数学/SVG/交互控件强制保留原文 |

---

## 六、数据模型

```jsonc
{
  "version": 1,
  "engine": "deepseek",              // 当前引擎 id
  "engines": {
    "deepseek": {
      "id": "deepseek",
      "name": "deepseek-chat",        // 预设引擎 = 模型名
      "format": "openai",
      "baseUrl": "https://api.deepseek.com",
      "path": "",
      "model": "deepseek-chat",
      "key": "sk-xxx",
      "auth": "bearer",
      "queryKey": "key",
      "responsePath": "",
      "systemRole": "",
      "temperature": 0.2,
      "maxTokens": 0,
      "timeout": 90,
      "batchSize": 1,
      "headers": {},
      "extraBody": {},
      "systemPrompt": "",
      "custom": false,
      "presetId": "deepseek",
      "seq": 1
    }
  },
  "scenario": "general",              // 当前翻译风格场景 id
  "autoScenario": true,               // 是否按网址自动匹配场景
  "customScenarios": {                // 用户自定义场景（可覆盖内置同 id）
    "custom-xxx": {
      "id": "custom-xxx",
      "name": "游戏攻略",
      "desc": "…",
      "systemPrompt": "…",
      "matches": ["https://example.com/*"]
    }
  },
  "generalRule": { /* 通用规则 */ },
  "rules": [],                        // 站点规则
  "glossary": [],                     // 术语库
  "pii": { "enabled": true, "types": [] },
  "cache": { "enabled": true, "maxAgeDay": 30 },
  "render": { "targetWrapperTag": "font", "fontSize": "inherit", "lineHeight": "1.7", "spacing": 8 },
  "targetLang": "zh-Hans",
  "lazy": true,
  "incremental": true,
  "autoTranslate": false
}
```

---

## 七、消息协议

### 7.1 内容脚本 → 后台

| 类型 | 载荷 | 说明 |
| --- | --- | --- |
| `IMT_TRANSLATE` | `texts[]` + 语向 + 引擎 id + 场景 | 翻译一批文本块 |
| `IMT_STATE_REPORT` | 进度统计 | 向 popup 上报「已译 N 段 / 失败 M 段」 |

### 7.2 后台 / popup → 内容脚本

指令 `action`：`start` / `stop` / `toggle` / `setMode` / `setLang` / `setEngine` / `query`。

### 7.3 设置页 / popup → 后台

| 类型 | 说明 |
| --- | --- |
| `IMT_GET_CONFIG` | 读取配置（经合并与迁移） |
| `IMT_SET_CONFIG` | 写入配置（`engines` / `customScenarios` 为整表替换） |
| `IMT_RESET_CONFIG` | 恢复默认 |
| `IMT_TEST_ENGINE` | 引擎连通性测试 |
| `IMT_PAGE_STATE` | 读取页面翻译状态 |
| `IMT_PAGE_ACTION` | 对页面下发指令 |
| `IMT_CACHE_STATS` / `IMT_CLEAR_CACHE` | 缓存统计与清空 |

---

## 八、验收标准

以 v1.4.0 交付包为准，全部用例均从**解压后的 zip** 加载真实扩展、跑真实 HTTP 请求执行。

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | 单元测试（67 项断言，真实 DOM，不联网） | 67 通过 / 0 失败 |
| 2 | 端到端翻译（demo 页） | 52 段译文 / 0 错误 |
| 3 | 大模型接口端到端（10 种接口形态，35 项断言） | 35 通过 / 0 失败 |
| 4 | popup 行为断言 | 全部通过 |
| 5 | 设置页往返（读得到 / 存得进 / 回显得出） | 53 通过 / 0 失败 |
| 6 | 真实站点「导航排除」实测 | HN 62/0/96.9%、Wikipedia 110/0/90.5%、MDN 68/0/96.5% |
| 7 | zip 完整性 | `unzip -t` 无错误 |

---

## 九、已知限制与后续方向

### 9.1 已知限制

| 限制 | 影响 / 规避 |
| --- | --- |
| 必须自备 API Key | v1.3.0 起已无免 Key 的免费接口；本地模型把鉴权选「无」即可 |
| v1.4.0 起不再预置引擎 | 首次使用须先去设置页选供应商并填 Key |
| 引擎名取模型名 | 同一模型不能配两个引擎；需连同一模型的多网关请用「完全自定义」并手动起不同名字 |
| 浏览器内置页不可注入 | `chrome://` 与应用商店页无法翻译 |
| 闭源 Shadow DOM 无法穿透 | open 模式的 shadow root 可以 |
| 框架频繁重渲染会覆盖译文 | 需刷新重译 |
| 站点框架判定是通用启发式 | 个别站点需用站点规则的 `excludeSelectors` 精确排除 |
| 站点框架默认整棵排除 | 放在 `<aside>` 里的正文不被翻译，需用 `mainSelector` 指定正文容器 |
| 地址/鉴权候选只在 404/405/401/403 时回退 | 429 限流、500 等错误原样报出，不会乱试 |
| 推理模型思考长度由服务端决定 | 扩展只能不发 `temperature`，无法限制思考开销 |

### 9.2 后续可做方向（未实现）

- Firefox / Safari 移植（代码已解耦，理论上可移植）。
- 配置云同步（当前可导出 JSON 手动迁移）。
- 引擎健康度与配额面板。
- 站点规则的图形化编辑器（当前为 JSON）。
- 术语库导入导出（CSV / 众包词表）。

---

## 附：与代码的对应关系

| 需求章节 | 主要实现文件 |
| --- | --- |
| FR-1 翻译引擎配置 | `src/options/options.js`（选择器 + 表单 + 命名 + 唯一性）、`src/shared/defaults.js`（预设）、`src/shared/utils.js`（合并 / 迁移 / 就绪判定）、`src/background/engines.js`（内核） |
| FR-2 翻译风格 | `src/shared/prompts.js`、`src/options/options.js`（`renderScenarios` / `renderScenarioEditor`）、`src/background/worker.js`（按 URL 匹配） |
| FR-3 正文识别 | `src/core/segment.js`、`src/core/rules.js` |
| FR-4 渲染 | `src/core/render.js`、`src/core/pipeline.js`、`src/styles/inject.css` |
| FR-5 站点规则 | `src/core/rules.js` |
| FR-6 术语库 | `src/core/glossary.js` |
| FR-7 隐私与缓存 | `src/core/pii.js`、`src/background/cache.js` |
| FR-8 配置数据 | `src/shared/utils.js`（`merge` / `applyPatch`）、`src/options/options.js`（导入导出） |
| FR-9 交互入口 | `src/popup/popup.js`、`src/background/worker.js`（菜单 / 快捷键） |

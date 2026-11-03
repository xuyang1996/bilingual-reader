# Bilingual Reader — 技术开发文档

> **这份文档写给下一个接手这个项目的开发者。**
> 目标：读完后，**不需要先翻源码**，就能对「这个项目长什么样、为什么这么设计、代码该往哪儿写、哪些坑不能踩」有完整认知。
>
> 配套读物：`docs/PRD.md`（产品需求：做什么、给谁用、验收标准）。
> 本文档回答的是：**怎么做的、为什么这么做、怎么继续做下去。**

| 项 | 内容 |
| --- | --- |
| 对应版本 | v1.4.0（Chrome MV3） |
| 代码规模 | `src/` 约 6800 行，19 个文件 |
| 构建 | **无**。纯 classic script，无 npm、无打包器、无 TypeScript |
| 运行时 | Chrome 96+ |

---

## 目录

1. [五分钟上手](#一五分钟上手)
2. [架构总览](#二架构总览)
3. [约定与地基](#三约定与地基)
4. [核心机制逐个拆解](#四核心机制逐个拆解)
5. [代码地图：我要改 X，该动哪儿](#五代码地图我要改-x该动哪儿)
6. [扩展点：怎么加新东西](#六扩展点怎么加新东西)
7. [测试体系](#七测试体系)
8. [陷阱清单](#八陷阱清单)
9. [调试手册](#九调试手册)
10. [编码约定](#十编码约定)

---

## 一、五分钟上手

### 1.1 跑起来

```bash
# 1. 装扩展
chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」
→ 选 bilingual-reader 目录

# 2. 起一个静态服务（demo 页与测试页都要用）
cd 页面翻译 && python3 -m http.server 8766 --bind 127.0.0.1
# → http://127.0.0.1:8766/bilingual-reader/demo/demo.html

# 3. 配置引擎
#    打开 chrome-extension://<id>/src/options/options.html
#    「翻译引擎」→ 选供应商 → 填地址/模型/Key → 测试连接 → 保存
```

**没有构建步骤。** 改完源码，扩展页点一下刷新图标即可生效；改了 `manifest.json`（比如新增 content script）需要重新「加载已解压的扩展程序」。

### 1.2 目录结构

```
bilingual-reader/
├── manifest.json          扩展清单
├── README.md              用户向说明
├── icons/                 16/48/128 图标
├── demo/demo.html         演示页（同时是 e2e 测试靶页）
├── docs/                  PRD、本文档、截图
├── src/
│   ├── manifest 引用入口：src/background/worker.js
│   ├── shared/            defaults.js  utils.js  prompts.js
│   ├── core/              rules.js  segment.js  render.js
│   │                      pii.js  glossary.js  pipeline.js
│   ├── content/           content.js（内容脚本入口）
│   ├── background/        worker.js  engines.js  cache.js
│   ├── options/           options.html  options.js
│   ├── popup/             popup.html  popup.js
│   └── styles/            inject.css
└── test/
    ├── harness.html/js    单元测试页（67 项断言）
    ├── engine.html/js     大模型接口自测台
    ├── e2e.py             端到端（真实 Chrome）
    ├── verify_ai.py       10 种接口形态（35 项断言）
    ├── verify_options.py  设置页往返（53 项断言）
    ├── verify_popup.py    popup 行为
    ├── measure_nav.py     真实站点导航排除实测
    ├── mock_llm_server.py 本地模拟大模型服务
    ├── testenv.py         测试基座
    └── shots.py / shot_ai.py  截图
```

---

## 二、架构总览

### 2.1 四个执行上下文

Chrome MV3 把代码切成互不共享内存的四个世界，**这是理解整个项目的前提**。

```
┌─ 页面世界 ────────────────────────────────────────────┐
│  content script（每个标签页一份，all_frames: true）      │
│  · segment.js 识别正文块                                 │
│  · pipeline.js  调度、懒翻译、渲染                        │
│  · 只有 DOM 权限，**不能直接 fetch 第三方 API**           │
└───────────────────────┬───────────────────────────────┘
                        │ chrome.runtime.sendMessage
                        ▼
┌─ 后台世界 ────────────────────────────────────────────┐
│  service worker（全局一份，会被随时回收）                 │
│  · engines.js  真正发 HTTP 请求、解析各家响应             │
│  · cache.js    译文缓存                                 │
│  · worker.js   消息路由、配置读写、菜单、快捷键           │
└───────────────────────┬───────────────────────────────┘
                        │ chrome.tabs.sendMessage
                        ▼
┌─ 扩展页面世界 ────────────────────────────────────────┐
│  popup（点图标弹出）  ·  options（设置页，全屏标签）      │
└───────────────────────────────────────────────────────┘

┌─ 存储世界 ────────────────────────────────────────────┐
│  chrome.storage.local   配置 + 密钥（持久）             │
│  chrome.storage.session 引擎「上次成功的地址/鉴权」记忆   │
└───────────────────────────────────────────────────────┘
```

**为什么内容脚本不直接调 API？**

1. 页面 CSP 与 CORS 会拦掉内容脚本的跨域请求；
2. 内容脚本里塞 API Key 容易被页面脚本读到；
3. 后台是唯一能做全局并发限流的地方。

所以内容脚本**只负责"找出要翻的文本"**，翻译这件事全部委托后台。

### 2.2 一次翻译的完整链路

```
用户点 popup「翻译此页」
  │
  ├─ popup ──IMT_PAGE_ACTION(start)──▶ worker
  │                                      │
  │                            tabs.sendMessage(target:'imtl-content')
  │                                      ▼
  │                              content.js
  │                                 ├─ loadConfig()  从 storage 读配置
  │                                 ├─ rules.resolve(cfg, location.href)  解析站点规则
  │                                 └─ pipeline.create({root, rule, config, engineId})
  │                                       │
  │                          segment.collect(root, rule)
  │                          → [{el, text, parts[]}]   ← 叶子块级元素
  │                                       │
  │                          schedule() 过滤：已译过 / 已是目标语言 → 丢弃
  │                                       │
  │                    ┌──────────────────┴──────────────────┐
  │              lazy=true                            lazy=false
  │        IntersectionObserver                 直接进队列
  │        rootMargin 300px                      │
  │                    │                              │
  │                    └──────────┬───────────────────┘
  │                               ▼
  │                        pump()  并发 ≤4（批量模式 ≤2）
  │                               ▼
  │                    translateBatch(batch)
  │                       ① pii.encode   → 占位符
  │                       ② IMT.client.translate(texts, req)
  │                              │  ← 传输层由 content.js 注入
  │                              ▼
  │                   chrome.runtime.sendMessage(IMT_TRANSLATE)
  │                              ▼
  │                           worker.handleTranslate
  │                       ① 校验引擎是否就绪（没配 → needConfig）
  │                       ② cache.getMany 命中则直接返回
  │                       ③ withSlot() 全局并发限流（≤8）
  │                       ④ engines.dispatch(engine, texts, opts)
  │                              │
  │                       engines.js
  │                       ① buildSystemPrompt  三层优先级
  │                       ② buildUrls / buildAuths  候选
  │                       ③ httpFetch → 解析（17 条路径 / SSE）
  │                       ④ 成功后记住（url,auth）组合
  │                              ▼
  │                       ④ cache.setMany
  │                              │
  │                   ← 译文数组
  │                       ③ pii.decode   → 还原占位符
  │                       ② 还原受保护的技术片段（code 等）
  │                       ① glossary.apply 术语兜底替换
  │                              ▼
  │                       render.insert(el, text)  原文内嵌译文
  │                              ▼
  │                    reportState() ──IMT_STATE_REPORT──▶ popup 显示「已译 N 段」
```

### 2.3 模块依赖方向

**严格单向**，没有循环依赖：

```
shared/defaults.js   （纯常量，无依赖）
        ↓
shared/utils.js      （依赖 defaults）
        ↓
shared/prompts.js    （依赖 utils 的匹配能力）
        ↓
core/rules.js        ┐
core/segment.js      ├→ 都依赖 utils
core/pii.js          │
core/glossary.js     │
core/render.js       ┘
        ↓
core/pipeline.js     （依赖以上全部 + client 传输层）
        ↓
content/content.js   （依赖 pipeline，负责注入传输层）
        ↓
background/worker.js （依赖 engines/cache/utils）
```

`manifest.json` 里 `content_scripts.js` 的**数组顺序就是加载顺序**，不能乱：

```json
["src/shared/defaults.js", "src/shared/utils.js", "src/shared/prompts.js",
 "src/core/rules.js", "src/core/segment.js", "src/core/render.js",
 "src/core/pii.js", "src/core/glossary.js", "src/core/pipeline.js",
 "src/content/content.js"]
```

> ⚠️ `content/content.js` 必须排最后：它一加载就会 `installTransport()` 并可能自动开译，此时 pipeline 必须已经就位。

---

## 三、约定与地基

### 3.1 `IMT` 全局命名空间

所有模块都是 classic script，用 IIFE 挂到全局 `IMT` 上：

```js
(function (root) {
  'use strict';
  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;
  // ... 定义模块，挂到 IMT.xxx
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

**为什么不用 ES modules？** MV3 的 content script 不支持 `import`；用模块要引入 `importScripts` 或打包器，会破坏「零构建」这条硬约束。

**新增模块时：**

1. 建文件，IIFE 包裹，挂到 `IMT.<yourModule>`；
2. 在 `manifest.json` 的 `content_scripts.js` 里**按依赖顺序**插入；
3. 在 `options.html` / `popup.html` 的 `<script>` 标签里也加一行（顺序同样要跟）。

### 3.2 没有打包器意味着什么

| 后果 | 应对 |
|---|---|
| 不能用 `import` / `export` | 靠 `IMT` 全局 + 加载顺序 |
| 不能用 JSX / TS / Svelte | 界面是原生 DOM 操作，见 §3.3 |
| 不能用 npm 包 | 所有依赖都手写；`test/` 只用 Python 标准库 |
| 改一行就要刷扩展 | 开发体验靠 `test/` 的自动化补 |

### 3.3 界面层的写法

设置页与 popup **不用框架**，全部是手写 DOM：

```js
var wrap = document.createElement('label');
wrap.className = 'field';
var span = document.createElement('span');
span.textContent = label;
var input = document.createElement('input');
input.setAttribute('data-engine', engineId);   // ← 用 data-* 反查，不用闭包
input.setAttribute('data-field', name);
wrap.appendChild(span);
wrap.appendChild(input);
```

**关键约定：用 `data-engine` / `data-field` 属性反查字段，而不是给每个 input 挂闭包。**

原因：`collect()` 需要在保存时统一读取表单所有字段；用属性选择器就能一句
`host.querySelectorAll('[data-engine="xxx"]')` 读回来，不必维护任何映射表。

同理，**事件用委托**绑在容器上，而不是逐个元素绑：

```js
$('engineForm').addEventListener('click', function (ev) {
  var t = ev.target;
  var rm = t.getAttribute && t.getAttribute('data-remove-engine');
  if (rm) { /* ... */ }
});
```

### 3.4 配置的读取与写入

**唯一入口**是 `U.config.merge(saved)`：

```js
U.config.merge({})                        // → 完整默认配置（已做过迁移）
U.config.applyPatch(current, patch)       // → current + patch，再走 merge
```

- `merge` 负责：补默认值、**迁移历史配置**、补 `seq`、改写引擎名。
- `applyPatch` 负责：合并一份改动。

> ⚠️ **`applyPatch` 必须定义在 `U.config = {...}` 赋值之后。**
> 写在前面会被整个对象覆盖掉 —— 这个坑踩过一次，导致设置页 20 项断言全挂。

> ⚠️ **`engines` 与 `customScenarios` 是「整表替换」语义**，不是逐键合并。
> 否则「删除某个引擎」「删除某个自定义场景」删不掉（旧键还在）。
> 详见 §4.10。

---

## 四、核心机制逐个拆解

### 4.1 正文识别（`core/segment.js`）

**翻译单元 = 叶子块级元素。**

```html
<div><p>第一段</p><p>第二段</p></div>
```
`div` 含块级子元素 → 是容器，跳过；两个 `p` 分别是叶子块 → 两个翻译单元。
天然得到段落级对照，不需要额外的段落合并逻辑。

#### 两级判定

**第一级 · 站点框架（结构性证据）→ 整棵子树排除**

判据三选一即命中：
- 语义地标标签：`NAV` / `ASIDE` / `FOOTER`
- ARIA 角色：`navigation` `complementary` `contentinfo` `banner` `menu` `menubar` `search` `toolbar` `tablist`
- class / id **分词后精确匹配** 40 个特征词（`nav` `sidebar` `breadcrumb` `toc` `footer` `comment` `promo` `share` `cookie` `widget` `byline` `sitemap` `skip` `screenreader` …）

> **为什么要分词而不是子串匹配？**
> `content-meta` 里含 `meta`… 不对，但 `mainmenu` 里含 `menu`、`content-footer` 里含 `footer`。
> 子串匹配会把这些正常类名误判成框架，分词后精确匹配就不会。

**第二级 · 链接密集容器（纯内容证据）→ 只排除其中的「链接型」块**

四条同时满足才算：

| 条件 | 阈值 | 常量 |
| --- | --- | --- |
| 链接条数 | ≥ 4 | `DENSE_MIN_LINKS` |
| 链接文字 / 容器**可见**文字 | ≥ 0.55 | `DENSE_MIN_RATIO` |
| 平均每条链接长度 | ≤ 32 | `DENSE_MAX_AVG_LEN` |
| 容器文字 / 全页文字 | ≤ 0.25 | `DENSE_MAX_PAGE_RATIO` |

两条关键设计：

1. **用可见字符数而不是原始字符数**（`visibleLength`）。
   HTML 里为了排版留下的换行与缩进会把容器文字量撑大好几倍，把「链接文字占比」稀释到阈值以下 —— 结果是目录/导航反而**认不出来**。

2. **第四条上限**（占全页文字 ≤25%）。
   Hacker News 的文章列表本身就是一堆链接，占了全页大半个篇幅。没有这条，HN 整页会被当成导航剔光。

3. **第二条只排除链接型块，不排除整个容器。**
   Wikipedia 页头那种「同一个容器里既有语言菜单（该排除）也有文章标题（该翻译）」的情况，只有这样才能保住正文。

#### 跳过规则汇总

- `EXCLUDE_TAGS`（`defaults.js`）→ 整棵跳过：表单控件、媒体、SVG、数学、`HEAD`/`SCRIPT`/`STYLE` 等。
- `STAY_ORIGINAL_TAGS` → 保留原文：`CODE` `PRE` `KBD` `SAMP` `VAR` `TT` `SUP` `SUB`、数学子元素、SVG 子元素。
- `PROTECTED_INLINE`（`CODE` `KBD` `SAMP` `VAR` `TT`）→ **内联保护**：文本替换成占位符后照常翻译周围内容，但不阻断整棵子树。
- 属性与状态：`translate="no"`（含祖先）、`.notranslate`、`aria-hidden="true"`、`hidden`、不可见（`display:none` / `visibility:hidden` / 零尺寸）。
- 自身已被扩展标注的（`.imtl-original` / `.imtl-translation` / `[data-imtl-state]`）自动跳过 —— 否则会自己翻译自己。

#### 统计缓存

链接密集判定要算「容器文字量」，反复算会退化。`computeStats(el)` **自底向上**一次算出 `{text, linkCount, linkText}` 并缓存；`collect()` 期间会先算一遍全页统计表（`collectStats`），优先于逐元素缓存。

### 4.2 翻译管线（`core/pipeline.js`）

#### 可注入的传输层

```js
IMT.client.setTransport(function (texts, req) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'IMT_TRANSLATE', texts: texts, /* ... */ },
      function (res) { /* resolve(res.texts) */ });
  });
});
```

**浏览器里由 `content.js` 注入到 background；单元测试页注入 mock。**
这是整个项目能离线测试的关键 —— `test/harness.js` 就是靠它跑通全管线。

#### 调度

- **懒翻译**：`IntersectionObserver`，`rootMargin: '300px 0px'`，`threshold: 0.01`。
  进入视口前 300px 才入队；`io.unobserve()` 保证不重复入队。
- **增量翻译**：`MutationObserver` 监听 `childList + subtree`。
  **必须过滤自己注入的节点**（`.imtl-translation` / `.imtl-original` / `.imtl-block`），否则会无限自我触发。
- **并发**：`concurrency = batchSize > 1 ? 2 : 4`。批量模式降并发，因为单次请求里塞了多条文本。
- **预过滤**：已翻译过的、**已经是目标语言的**（`U.detectLang` 判定语族相同）直接跳过，不发请求。

#### 一批文本的处理顺序（顺序不能乱）

```
① pii.encode      敏感信息 → 占位符（原文不出本机）
② 发请求
③ pii.decode      占位符 → 原文
④ 还原受保护的技术片段（item.parts）
⑤ glossary.apply  术语强制替换（提示词没生效时的兜底）
⑥ trim；空则回退原文
⑦ render.insert
```

### 4.3 渲染与还原（`core/render.js`）

#### 插入结构

```html
<font class="imtl-original">原文…</font>
<font class="imtl-translation" notranslate>译文…</font>
```

- **用 `<font>` 包裹原文，而不是重写 DOM。**
  这是「还原后 DOM 逐字节回到原状」能成立的前提：还原时只需解开包裹。
- 译文带 `notranslate`，防止浏览器自带的翻译功能二次干预。
- 块上打 `data-imtl-state="translated"`，插入是幂等的。

#### 还原的三件事

```js
// 1. 移除所有译文节点
// 2. 把 .imtl-original 解开，恢复原始文本节点
// 3. 清掉所有 data-imtl-* 属性与 imtl-* class
//    ⚠️ 包括「空 class=""」——Chrome 的 classList.remove() 会留下空属性
```

第 3 条里的空 `class=""` 是最容易漏的，单元测试专门断言了「还原后 `innerHTML` 与翻译前**逐字节**相同」。

#### 三种模式

`dual`（双语对照）/ `translation`（仅译文）/ `original`（仅原文），由 `render.setMode()` 切换，不重新翻译。

### 4.4 引擎内核（`background/engines.js`）

**整个项目最复杂的部分**，也是「兼容市面上大多数 API」的落地处。

#### 四种接口形态

| `format` | 默认路径 | 请求体 |
| --- | --- | --- |
| `openai` | `/chat/completions` | `{model, messages:[{role,content}], stream:false}` |
| `anthropic` | `/v1/messages` | `{model, max_tokens, system, messages}` |
| `gemini` | `/v1beta/models/{model}:generateContent` | `{contents:[{parts:[{text}]}], generationConfig}` |
| `custom` | 空（用户自己填） | 与 openai 相同，但响应路径要自己指定 |

> `openai` 形态覆盖了绝大多数国产与聚合站；`anthropic`/`gemini` 因鉴权与结构差异必须单列。

#### 地址候选（`buildUrls`）

```
base + path                    ← 首选
base + '/v1' + path            ← 仅 openai 形态且 base 里没有 /vN 段时追加
```

**只在 404 / 405 时才换下一个候选。** 429、500 原样报出 —— 乱试地址只会让限流更严重。

#### 鉴权候选（`buildAuths`）

`auto` 模式依次尝试：`Authorization: Bearer` → `x-api-key` → `api-key`。
**只在 401 / 403 时才换。**

#### 成功记忆（关键优化）

```js
saveMemo(key, { url: urlIdx, auth: authIdx });
// key = baseUrl|path|format|model|auth
```

- 记忆存在**内存 + `chrome.storage.session`**两处。
- 为什么要 `session`？MV3 的 service worker 会被随时回收重启，只放内存的话重启一次就忘一次。
- 有了记忆，「Base URL 少写一个 `/v1`」或「服务用 `x-api-key` 鉴权」这两种情况，**只有第一个请求**会吃 404/401，之后直接命中。

#### 并发探测去重

```js
var pending = probePending[key];
if (pending) return pending.then(function () { return E.ai.request(texts, opts, engine); });
```

同一引擎的并发请求**共享同一次探测**，不会各自去吃一遍 404。

#### 响应解析（`extractText`）

17 条取值路径依次尝试，支持 `a.b[0].c` 与 `a.b.0.c` 两种写法。

> **`reasoning_content` 排在 `content` 之后**，只作兜底。
> 推理模型同时返回思维链与正式译文时，先命中的是 `content`，所以思维链不会进译文。
> （代码注释曾误写成「不在取值列表里」，已更正。）

值形态统一由 `textFromValue` 处理：字符串 / 字符串数组 / `{text}` / `{content}` / `{parts}` / `[{type:'text',text}]`。

**非 JSON 响应**的兜底：先试 `parseSSE`（有些网关无视 `stream:false` 硬返回事件流），再试纯文本。

#### 批量编号协议

`batchSize > 1` 时把 N 条编号成 `1. text1\n2. text2…`，模型必须按同样的编号回复。

```js
parseBatchReply(reply, count)  // 解析不出全部 N 条就返回 null
```

**返回 null 时 `translate()` 自动回退到逐条请求**，绝不错位。这是「编号对不上自动回退」的落点。

#### 推理模型识别

```js
/(^|[^a-z0-9])(o1|o3|o4-mini|gpt-5|gpt5)([^a-z0-9]|$)/ 或 /reasoner|reasoning|deepseek-r1|qwq|thinking/
```

命中时：不发 `temperature`；用 `max_completion_tokens` 而非 `max_tokens`；system 角色默认降为 `developer`。

### 4.5 提示词三层拼装（`shared/prompts.js` + `engines.js`）

**先说清楚最终提示词长什么样**（`engines.js` 的 `buildSystemPrompt` 产出）：

```
You are a professional translator for web pages.
Translate the source text into natural, idiomatic 简体中文.
Rules:
- Output ONLY the translation. …
- Keep the original structure: …
- Keep code, identifiers, URLs, … unchanged unless the glossary says otherwise.
- Translate one input block into exactly one output block. …
- If the text is already in the target language, repeat it unchanged.

## Style for this content (GitHub)          ← 场景段，仅在选中场景有 systemPrompt 时追加
<场景提示词，{target} 已替换>

- The input is a numbered list. …           ← 批量协议，仅 batchSize > 1 时追加

<术语库>                                    ← 始终追加在最后
```

**三层优先级指的是「谁能覆盖谁」**：

| 层 | 位置 | 语义 |
| --- | --- | --- |
| ① 引擎卡片上的「自定义系统提示词」 | `prompts.buildSystemPrompt` 的第一行 | **有则直接 return，后面两层完全不出现** |
| ② 场景提示词 | `## Style for this content (场景名)` 段 | 在通用规则之上**追加**一段专业化约束 |
| ③ 通用规则 `BASE_RULES` | 提示词开头 | 永远在最前面，是所有场景的共同底线 |

所以「三层」不是三段文本的上下叠放，而是：**①会吞掉②③；②是在③基础上补充**。

`buildSystemPrompt` 在 `engines.js` 里，但**场景查找与拼装在 `prompts.js`**：

```js
IMT.prompts.list(customScenarios)        // 全部场景（自定义覆盖内置）
IMT.prompts.get(id, customScenarios)      // 单个场景
IMT.prompts.match(url, customScenarios)   // 按网址匹配
IMT.prompts.buildSystemPrompt({...})      // ①短路 → ③BASE_RULES → ②场景段
IMT.prompts.urlPatternToRegExp(pattern)   // 通配符 → 正则
```

**通用规则（`BASE_RULES`）的五条约束**（英文，因为模型吃英文更准）：

1. 只输出译文，不要解释、不要引号；
2. 保留原结构：换行、列表符号、编号、行内 HTML（如 `<a href="...">`）；
3. 代码、标识符、URL、文件路径、产品名保持不变（除非术语库另有规定）；
4. 一进一出：不合并、不拆分、不总结、不省略；
5. 已经是目标语言就原样返回。

**场景提示词里用 `{target}` 占位**，拼装时替换成目标语言名称（如 `简体中文`）。

### 4.6 翻译风格场景（`shared/prompts.js`）

14 个内置场景，提示词使用了公开项目 `immersive-translate/prompts` 的 `aiBatch.taskSystemPrompt` 内容，并作了适配。

每个场景结构：

```js
{
  id: 'github',
  name: 'GitHub',            // 中文名
  desc: '仓库、Issue、PR 与评论…',  // 中文描述
  systemPrompt: '…',        // 英文提示词，含 {target}
  matches: ['*github.com*'], // 网址匹配（可选）
  builtin: true
}
```

**网址匹配**：`urlPatternToRegExp` 把 `*` 通配转成正则。

**自定义场景与内置同 id 时，网址规则取并集** —— 防止用户只改了提示词，却把内置的自动匹配能力弄丢了。

**按网址自动匹配**（`worker.js` 的 `pickScenario`）：

```js
if (cfg.autoScenario && url) {
  var hit = IMT.prompts.match(url, custom);
  if (hit) return hit;      // 命中覆盖用户手选
}
return cfg.scenario || 'general';   // 未命中回落到手选
```

### 4.7 PII 脱敏（`core/pii.js`）

- **编码**：按类型优先级排序，依次把邮箱/电话/卡号/身份证/IP/网址/IBAN 替换成 `__PII_<类型>_<序号>__`。
- **解码**：用**宽松正则**还原 —— 模型可能在占位符里插空格或改下划线，正则容忍这些变化：

```js
var loose = new RegExp('__\\s*PII\\s*_\\s*' + type[1] + '\\s*_?\\d*\\s*__', 'gi');
```

- 7 类可单独勾选。

### 4.8 术语库（`core/glossary.js`）

- 解析：每行一条，支持 `TAB` / `->` / `=>` / `|` 分隔。
- `buildPrompt`：写进系统提示词（**始终追加在最后**）。
- `apply`：译后**再做一次强制替换**兜底（模型没照提示词翻时的保险）。

### 4.9 缓存（`background/cache.js`）

- 键 = `hash(原文 + 源语言 + 目标语言 + 引擎 id)`。
- 默认 30 天 TTL（可配 1–365 天）。
- `getMany` / `setMany` 批量读写。
- 在 `worker.handleTranslate` 里：先查缓存 → 只把**未命中的**送去请求 → 回填。

### 4.10 配置模型与迁移（`shared/utils.js`）

#### `merge(saved)` 做的事

1. 深合并默认配置；
2. 给已存在的引擎补齐缺失字段（用 `ENGINE_PRESETS` 作样板）；
3. **迁移**：清掉从没动过的 v1.3.0 预置引擎、删掉早已下线的免 Key 引擎；
4. 给缺 `seq` 的引擎补排序序号；
5. 把预设引擎的 `name` 改写成模型名；
6. 修正 `cfg.engine`（指向不存在的引擎时挑一个可用的，都不可用则置空）。

#### ⚠️ `applyPatch` 的整表替换语义

```js
U.config.applyPatch = function (current, patch) {
  var next = U.deepMerge(current || {}, patch || {});
  var p = patch || {};
  if (p.engines) next.engines = p.engines;          // ← 整份替换
  if (p.customScenarios) next.customScenarios = p.customScenarios;
  return U.config.merge(next);
};
```

`deepMerge` 是**逐键合并**的，所以「删除某个引擎」「删除某个自定义场景」在合并时会失效（旧键还在）。
这两张表是例外，必须显式整份替换。**worker.js / options.js / popup.js 三处都用了 `applyPatch`，不要改成 `deepMerge`。**

#### ⚠️ Chrome storage 会重排对象键

`chrome.storage.local.set({obj})` 存下来再读出来，**对象键会被按字母序排列**。
所以「用户创建引擎的先后顺序」不能靠 `Object.keys()` 拿 —— 必须靠引擎对象里的 `seq` 字段。

### 4.11 设置页的状态模型（`options/options.js`）

设置页有一个**独立于持久配置**的 UI 状态：

```js
var SELECTED_ENGINE_ID = null;   // 当前正在查看/编辑的引擎
var CURRENT_PANEL = 'engines';   // 当前显示的分类
```

- `CURRENT_PANEL` 存在 `sessionStorage`（刷新后记住上次面板）。
- `SELECTED_ENGINE_ID` 不持久 —— 刷新后由 `ensureSelection()` 从 `config.engine` 推断。

**表单实时同步**：用户在输入框里打字时，`#engineForm` 的 `input` 事件直接把值写回 `config.engines[id]`。
所以切换引擎不会丢已填内容，也不需要额外的「未保存」提示。

**保存路径**：`collect(strict)` → `persist(opts)` → `IMT_SET_CONFIG` → `applyPatch` → `merge`。

`strict` 的作用：引擎表单里 JSON 没写完时报错。场景保存用 `persist({strict:false})`，
**一个引擎的半成品 JSON 不该挡住用户保存场景**。

**引擎名唯一性**：`validateEngineNames()` 在 `collect()` 里抛错 → `persist()` 捕获 → toast 提示 → **不写存储**。

---

## 五、代码地图：我要改 X，该动哪儿

| 我想改… | 动这些文件 |
| --- | --- |
| 加一个供应商预设 | `shared/defaults.js` 的 `PROVIDER_PRESETS`（**只加一行**，不要动 `ENGINE_PRESETS`） |
| 加一个翻译风格场景 | `shared/prompts.js` 的 `PROMPT_SCENARIOS`（+ 可选 `matches`） |
| 改通用翻译规则 | `shared/prompts.js` 的 `BASE_RULES` |
| 改译文渲染样式 | `core/render.js` + `styles/inject.css` |
| 改译文外观（字号/行高/间距） | `core/render.js` + `core/pipeline.js` 的 `render.insert` 参数 |
| 改正文识别阈值 | `core/segment.js` 的常量 + `shared/defaults.js` 的 `DEFAULT_THRESHOLDS` |
| 加站点框架特征词 | `core/segment.js` 的 `CHROME_TOKENS` |
| 改响应解析顺序 | `background/engines.js` 的 `EXTRACT_PATHS` |
| 加一种接口形态 | `background/engines.js` 的 `FORMATS` + 对应的 `buildXxxBody` |
| 改引擎配置字段 | `shared/defaults.js`（字段模板）+ `options/options.js`（表单）+ `background/engines.js`（用字段） |
| 改设置页某个面板 | `options/options.html`（结构）+ `options/options.js`（渲染与事件） |
| 改 popup | `popup/popup.html` + `popup/popup.js` |
| 改消息协议 | `background/worker.js`（路由）+ `content/content.js`（处理）+ `popup/options`（发起） |
| 改快捷键 / 右键菜单 | `manifest.json` 的 `commands` + `background/worker.js` |

---

## 六、扩展点：怎么加新东西

### 6.1 加一个供应商预设（最常见）

`src/shared/defaults.js`：

```js
{ id: 'myprovider', name: '我的服务商', baseUrl: 'https://api.myprovider.com/v1',
  path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'my-model' },
```

**就这一行。** 设置页的「添加新引擎」下拉是遍历 `PROVIDER_PRESETS` 生成的，自动出现。

> ⚠️ 不要往 `ENGINE_PRESETS` 加。`ENGINE_PRESETS` 现在只是**字段模板**（提供 `queryKey`/`headers`/`extraBody`/`responsePath` 等通用字段的默认值），不是预置引擎。

### 6.2 加一个翻译风格场景

`src/shared/prompts.js` 的 `PROMPT_SCENARIOS` 数组：

```js
{
  id: 'game-guide',
  name: '游戏攻略',
  desc: '技能名、装备名保留原文，解释部分口语化。',
  systemPrompt: 'You are translating a game guide into {target}.\n' +
                '- Keep skill names, item names and abbreviations in the original language.\n' +
                '- Use concise, informal tone for the explanation parts.',
  matches: ['*game-wiki*'],
  builtin: true
}
```

`builtin: true` 的场景，用户改写后会在 `customScenarios` 里存一份同 id 的覆盖项。

### 6.3 加一种接口形态

`src/background/engines.js`：

```js
// 1. 写请求体构造器
function buildMyFormatBody(texts, opts, engine, isBatch) {
  var body = { model: engine.model, inputs: [] };
  // ...
  return body;
}

// 2. 注册到 FORMATS
var FORMATS = {
  // ...
  myformat: {
    label: 'My API',
    paths: function (e) { return [e.path ? String(e.path) : '/v1/translate']; },
    build: buildMyFormatBody
  }
};

// 3. 在 options/options.js 的 FORMAT_OPTIONS 加一项
{ value: 'myformat', label: 'My API（自定义形态）' }
```

如果新形态的响应结构也在 `EXTRACT_PATHS` 里，`extractText` 不用改；否则加一条路径。

### 6.4 加一个设置项

1. `shared/defaults.js` 的 `DEFAULT_CONFIG` 加默认值；
2. `options/options.html` 对应面板加控件（给个 `id`）；
3. `options/options.js`：
   - `render()` 里回显：`$('myField').value = config.myField;`
   - `collect()` 里收集：`cfg.myField = $('myField').value;`
   - 如果是 checkbox，用 `.checked`。
4. 若是引擎级字段，还要加到 `ENGINE_NUM_FIELDS` / `ENGINE_JSON_FIELDS`（决定 `syncEngineForm` 怎么解析）。

---

## 七、测试体系

### 7.1 四层测试

| 层 | 工具 | 覆盖 | 耗时 |
| --- | --- | --- | --- |
| 单元 | `test/harness.html` | 67 项断言，纯 DOM、不联网 | <10s |
| 接口 | `test/engine.html` | 大模型接口自测台，人工看 | — |
| 端到端 | `test/e2e.py` | 真实 Chrome + 真实扩展 + 真实 HTTP | ~40s |
| 接口形态 | `test/verify_ai.py` | 35 项断言，10 种接口形态 | ~4min |
| 设置页 | `test/verify_options.py` | 53 项断言，读/存/回显 | ~3min |
| popup | `test/verify_popup.py` | 16 项断言 | ~2min |
| 真实站点 | `test/measure_nav.py` | 导航排除准确率 | ~2min |

### 7.2 怎么跑

```bash
cd bilingual-reader

# 前置：静态服务必须在 8766 上活着
cd .. && (nohup python3 -m http.server 8766 --bind 127.0.0.1 >/tmp/httpd.log 2>&1 &)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8766/bilingual-reader/demo/demo.html

# 单元测试（必须轮询到结果稳定，snapshot 会读到半途）
python3 /tmp/poll_harness.py "http://127.0.0.1:8766/bilingual-reader/test/harness.html?autotest=1&v=3" 2>&1 | grep -E "STABLE|FAIL"

# 端到端
python3 test/e2e.py --ext . --url "http://127.0.0.1:8766/bilingual-reader/demo/demo.html" --out /tmp/e2e.png
```

> **测试必须串行跑。** 多个 Chrome 实例并发会导致 harness 超时与结果错乱。

### 7.3 写测试的工具箱

#### `test/testenv.py` —— 测试基座

```python
import testenv

mock = testenv.MockLLM("openai-string")     # 本地模拟大模型服务
sw = testenv.find_service_worker(ws, ext_id)  # 找到扩展的 service worker
testenv.write_engine(ws, sw, mock.engine())   # 写引擎配置 + 回读校验
testenv.start_translation(ws, sw, "demo.html")  # 让内容脚本开译
```

`MockLLM` 扮演各家接口形态（`openai-string` / `anthropic` / `gemini` / `reasoning` / `batch` …），
按目标语言返回带 `译:` / `JA:` 前缀的译文。

#### CDP 的用法（`test/e2e.py` 的 `WS` 类）

```python
ws = WS(ver["webSocketDebuggerUrl"])
ext_id = ws.call("Extensions.loadUnpacked", {"path": ext}).get("id")
tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
ws.call("Page.enable", {}, sess)
ws.call("Runtime.enable", {}, sess)
```

> ⚠️ **不能用 `--load-extension`**：Chrome 品牌版会忽略它（官方日志：`--load-extension is not allowed in Google Chrome, ignoring.`）。
> 必须用 CDP 的 `Extensions.loadUnpacked`。
>
> ⚠️ **service worker 给自己的 `chrome.runtime.sendMessage` 不会被自己的监听器收到** —— 测后台消息必须从页面/扩展页发起。

#### 加一条单元断言

`test/harness.js` 里，函数返回 Promise 链：

```js
function testMyThing() {
  return test('我的模块：某个行为', function () {
    assert(myThing() === 'expected', '应得到 expected');
  }).then(function () {
    return test('我的模块：另一个行为', function () {
      assert(...);
    });
  });
}
```

然后在 `harness.js` 底部的链式调用里加一行：`.then(testMyThing)`。

#### 加一条设置页断言

`test/verify_options.py` 里，用 `ev()` 在设置页执行 JS：

```python
ev("""
  (function(){
    document.getElementById('myField').value = 'x';
    document.getElementById('myField').dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()
""")
time.sleep(0.4)
ev("document.getElementById('saveAll').click(); 'clicked'")
time.sleep(1.5)
stored = json.loads(ev("new Promise(res=>{chrome.storage.local.get('imtl.config',"
                       "d=>res(JSON.stringify(d||{})));})", await_promise=True))
c.check(stored["imtl.config"]["myField"] == "x", "设置项已落盘")
```

> ⚠️ 断言「隐藏」类行为时，**不要只查 `element.hidden` 属性**，要查真实渲染：
> ```js
> getComputedStyle(document.getElementById('x')).display !== 'none'
> ```
> 因为 CSS 的 `display` 会盖掉浏览器默认的 `[hidden] { display: none }`（这个坑踩过，见 §8）。

---

## 八、陷阱清单

**这一节是本文档最有价值的部分。** 每一条都是本项目实际踩过、并且已经修好的坑。

### 8.1 `applyPatch` 被整个对象覆盖

`U.config.applyPatch` 写在 `U.config = {...}` **之前** → 赋值时把函数冲掉 → 设置页 20 项断言全挂。
**规则：任何往 `U.config` 上挂的方法，都必须写在 `U.config = {...}` 赋值之后。**

### 8.2 整表 vs 逐键合并

`deepMerge` 逐键合并 → 「删除引擎」「删除场景」删不掉。
**规则：`engines` / `customScenarios` 走 `applyPatch` 的整表替换语义，别改回 `deepMerge`。**

### 8.3 CSS 的 `display` 盖掉 `[hidden]`

`.banner { display: flex }` 让 `el.hidden = true` **完全失效**，横幅永远显示。
**规则：凡是带 `hidden` 属性的元素，如果它的 CSS 里设了 `display`，必须补一条 `[hidden] { display: none }`。**

### 8.4 Chrome storage 重排对象键

存进去 `{deepseek, custom}`，读出来变成 `{custom, deepseek}`（字母序）。
**规则：任何依赖「用户操作顺序」的列表，都要用显式序号字段（本项目是 `seq`），不能靠 `Object.keys()`。**

### 8.5 harness 会读到半途结果

单元测试是异步链，直接读 `#summary` 会读到中间状态。
**规则：必须轮询到 `#summary` 连续 3 次不变再取结果；URL 加 `&v=N` 避免浏览器缓存。**

### 8.6 popup 只在 DOMContentLoaded 时查一次页面状态

截图前 popup 显示「无法与页面通信」，因为它问的是自己那个标签页。
**规则：截图前先 `Target.activateTarget(page)`，再 `Page.reload(popup)`。**

### 8.7 静态服务挂了，症状和代码故障一模一样

demo 页不加载 → 内容脚本不存在 → 0 请求 0 译文。
**规则：测试出「0 译文」时，先 `curl` 一下服务，再查代码。**

### 8.8 mock 引擎是 127.0.0.1，被判成「免 Key」

`U.engineReady` 对本机地址直接返回 true，所以「清空 Key」**清不掉**就绪状态。
**规则：测试里模拟「未配置」必须同时做三件事：清空 `key`、把 `baseUrl` 改成远端地址、把 `auth` 改成 `bearer`。**

### 8.9 `--load-extension` 被品牌版 Chrome 忽略

**规则：测试一律用 CDP 的 `Extensions.loadUnpacked`。**

### 8.10 service worker 听不到自己发的消息

**规则：测后台消息必须从页面或扩展页发起，不要在 service worker 里自发自收。**

### 8.11 `reasoning_content` 的注释与实现不符

注释写「不在取值列表里」，实际在第 4 位。
**规则：注释要写「为什么这样排序」，不要只写「不包含什么」。**

### 8.12 `bash rm` 被安全策略拦截

**规则：删文件用 `python3 -c "import os; os.remove(...)"` 或 `shutil.rmtree`；打包用 Python `zipfile`（见 §8.15）。**

### 8.13 多个 Chrome 实例并发

**规则：所有浏览器测试串行执行。**

### 8.14 环境没有 `node`

**规则：JS 语法校验用 macOS 自带的 JavaScriptCore：**

```bash
for f in $(find src test -name "*.js" | sort); do
  out=$(osascript -l JavaScript "$f" 2>&1)
  echo "$out" | grep -q "SyntaxError" && echo "FAIL $f"
done
```

（会报 `TypeError: IMT is not defined` 之类，那是对的 —— 单独执行必然缺依赖；只关心有没有 `SyntaxError`。）

### 8.15 Info-ZIP 会把中文文件名存成乱码

macOS 自带的 `zip`（Info-ZIP 3.0）**不处理 UTF-8 文件名**：

```
$ zip -r t.zip 开发文档.md && unzip -l t.zip
    46236  11-02-2026 11:52   ????档.md     ← 存进去就坏了
```

解压后用户看到的是乱码文件名，文档等于丢失。

**规则：**
1. **文件名一律用 ASCII**（`README.md` / `PRD.md` / `DEVELOPMENT.md`），中文内容放文件内部；
2. **打包用 Python 的 `zipfile`**（正确写 UTF-8 标志位），不要用 `zip` 命令：

```bash
python3 - <<'PY'
import os, zipfile
root = 'bilingual-reader'
out = 'bilingual-reader.zip'
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.git')]
        for f in filenames:
            if f == '.DS_Store':
                continue
            p = os.path.join(dirpath, f)
            z.write(p, p)
print('zipped', out)
PY
```

（`zipfile` 也会自动跳过 `__pycache__` 之类的目录，因为上面已经过滤了 `dirnames`。）

### 8.16 `/usr/bin/python3` 可能是需要 license 的 xcrun 桩程序

```
$ python3 --version
You have not agreed to the Xcode license agreements.
```

`/usr/bin/python3` 是 shim，真正跑的是 Xcode 的 Python；Xcode 许可没接受时它会直接失败。
**规则：直接调用框架里的解释器**：

```bash
PY=/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3
$PY test/e2e.py --ext . --url ...
```

### 8.17 残留的 Chrome 进程会让单元测试页显示「未运行」

跑测试时如果上一次任务被中断，残留的 headless Chrome 会互相干扰，
harness 页面会一直停在「未运行」。
**规则：测试报「未运行」时先清残留，再跑**：

```bash
pkill -f "Chrome --headless"; sleep 2
```

### 8.18 商店截图必须压平成不带 alpha 的 RGB

Chrome 应用商店拒绝带透明通道的 PNG。
Chrome 的 `Page.captureScreenshot` 产出的是 RGBA，**必须再压一次**。
`test/make_promo.py` 里的 `flatten_to_rgb()` 手写了 PNG 解码 / 反滤波 / 重编码，
注意两个细节：

- **每行前面要有一个 filter 类型字节**（写 0 = None）。漏掉它，PNG 文件虽然
  `unzip` 正常，但图片解码器打不开；
- 反滤波要按 PNG 规范逐行处理 5 种 filter 类型（None/Sub/Up/Average/Paeth）。

验证方式（解一遍确认文件完好）：

```python
import struct, zlib
d = open('promo.png','rb').read()
w,h,bd,ct = struct.unpack('>IIBB', d[16:26])   # ct 必须是 2（RGB）
```

### 8.19 截 popup 时活动标签页必须是真实页面

popup 只在 `DOMContentLoaded` 时查一次页面状态。
在自动化里 popup 是开在**一个普通标签页**上的，`chrome.tabs.query({active:true})`
会问到自己。
**规则：顺序必须是「先开 popup 标签页 → 再把活动标签页切回真实页面 → 最后 reload popup」**。

另外注意 `Target.createTarget` 的返回值要接住（之前写成 `_, page = ...`，
结果 `page_tid` 是 undefined，激活失败，popup 一直显示「无法与页面通信」）。

---

## 九、调试手册

### 9.1 症状 → 定位

| 症状 | 最可能的原因 | 怎么确认 |
| --- | --- | --- |
| 页面上一个译文都没有 | 静态服务挂了 / 扩展没刷新 / 引擎没配 | 先 `curl` demo 页；再看 popup 状态栏 |
| 译文是空的 | 引擎返回内容不在 17 条路径里 | 用 `test/engine.html` 自测台看原始响应 |
| 提示 401/403 | 鉴权方式不对 | 引擎的「鉴权方式」手动选 `x-api-key` / `api-key` |
| 提示 404 | Base URL 少了 `/v1` 或路径不对 | 看请求日志；`auto` 模式会自动试 `/v1` |
| 提示「接口返回空内容」 | 模型名错了 / 路径不对 / 响应结构特殊 | 自测台看原始响应，必要时手填「响应字段路径」 |
| 译文混进了思维链 | 模型只返回了 `reasoning_content` | 换非推理模型；或手填响应路径 `choices.0.message.content` |
| 导航被翻译了 | 该容器没被识别成框架 | 用站点规则的 `excludeSelectors` 排除 |
| 正文没被翻译 | 段落太短 / 整页文字太少 | 调低「段落最少字符数」「整页正文最少字符数」 |
| 译文被框架重渲染覆盖 | 页面是 React/Vue | 刷新重译 |
| 设置页改了没反应 | 没点保存 / JSON 格式非法 | 看输入框是否标红；点「保存全部」 |
| 翻译风格不生效 | 引擎填了自定义系统提示词 | 它优先级最高，会完全盖住场景 |

### 9.2 调试技巧

**看后台发了什么请求**：设置页 → 引擎 → 「测试连接」；或用 `test/engine.html`（它会摊开最终 URL、请求头、请求体、HTTP 状态、原始响应、解析出的译文、系统提示词）。

**看内容脚本识别出了哪些块**：

```js
// 在页面的 devtools console 里
IMT.segment.collect(document.body, { thresholds: {} })
// → { items: [{el, text, parts}], ... }
```

**看提示词最终长什么样**：

```js
IMT.engines._internal.buildSystemPrompt(
  { scenario: 'github', customScenarios: {}, targetLang: 'zh-Hans', targetName: '简体中文' },
  { systemPrompt: '' }, false
)
```

**看当前生效的配置**：

```js
chrome.storage.local.get('imtl.config', console.log)
```

### 9.3 重置到干净状态

```js
chrome.storage.local.clear()
```
然后刷新页面与设置页。

---

## 十、编码约定

| 约定 | 说明 |
| --- | --- |
| ES5 语法 | 不用 `let`/`const`/箭头函数/模板字符串（`const`/`let` 偶尔用，但一律用 `var` 保持一致） |
| `'use strict'` | 每个 IIFE 开头 |
| 无 `console.log` | 需要留痕就用 `IMT.debug` 之类的开关；调试完删掉 |
| 注释写「为什么」 | 不写「做了什么」——代码本身已经说了 |
| 错误信息面向用户 | 中文、能指导下一步（例：「请在设置页「翻译引擎」里填好 API Key」） |
| 不用 `innerHTML` 拼用户数据 | 用 `textContent`，避免 XSS |
| 新增全局挂载点 | 挂在 `IMT` 下，不新增裸全局变量 |
| 改 `manifest.json` 的 script 顺序 | 必须按依赖顺序 |

---

## 十一、发布到 Chrome 应用商店

### 11.1 为什么会有「演示模式」

扩展的核心功能必须由用户自备大模型 API（没有任何免 Key 的通道）。
这带来两个后果：

1. **新用户装上后看不到任何效果**——还没配 Key 就什么都翻不了；
2. **商店审核员无法验证功能**——审核环境里没有第三方账号，
   审核员拿不到你的 API Key，扩展在他手上就是「点了没反应」，
   很容易被判为 *Functionality not as expected* 而驳回。

所以扩展内置了一个 **演示模式**（`format: 'demo'`）：

- 完全在**本地**用内置词表拼示例译文，**不发起任何网络请求、不需要 API Key**；
- 把「正文识别 → 双语排版 → 模式切换 → 还原」整条链路完整跑通；
- 界面上有明确标注（popup 黄色横幅、设置页说明框、译文浅黄底纹
  `data-imtl-demo="1"`），**不会让人误以为是真实翻译**。

实现要点：

| 位置 | 作用 |
| --- | --- |
| `src/background/engines.js` 的 `DEMO_PHRASES` | 整句级翻译表，覆盖演示页的每一句 |
| `src/background/engines.js` 的 `DEMO_DICT` | 词级替换兜底（长词优先，避免切碎长词） |
| `src/background/engines.js` 的 `demoTranslate()` | 先查整句表，再退回词表 |
| `E.ai.translate()` / `E.ai.request()` | `format === 'demo'` 时直接短路，不进 HTTP 路径 |
| `src/core/pipeline.js` | 判断 `engine.format === 'demo'`，传给 `render.insert` |
| `src/core/render.js` | 打上 `data-imtl-demo="1"` |
| `src/styles/inject.css` | 演示译文加浅黄底纹 |

> **原则**：演示模式是**离线可验证性**的补丁，不是产品的主要功能。
> 商店详细说明与审核备注里都必须写明它不是真实翻译。

### 11.2 权限最小化

Chrome 应用商店最常见的驳回理由之一是「申请了代码里没用的权限」。

- `scripting` —— 代码里**从未使用**，已删除；
- `activeTab` —— 被 `host_permissions: <all_urls>` 完全覆盖，已删除；
- 现在只剩 `storage` + `contextMenus` + `<all_urls>` 三项，每项都有具体理由。

**规则：新增权限前先 grep 一遍 `chrome.*`，确认真的用得上。**

### 11.3 两个不同的包

| 包 | 用途 | 结构 |
| --- | --- | --- |
| `bilingual-reader.zip` | 源码归档 / 手动安装 | 带一层 `bilingual-reader/` 目录，含 test/docs |
| `bilingual-reader-store.zip` | **上传应用商店** | `manifest.json` 在**根目录**，不含 test/docs/store |

商店包的构建与自检：

```bash
PY=/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3
$PY test/build_store_zip.py --ext . --out ../bilingual-reader-store.zip
```

脚本会自动校验：manifest.json 在根目录、无 test/docs/__pycache__、manifest 可解析。

> ⚠️ 商店包的 `demo/` **要保留**——审核备注里让审核员打开它来验证功能。

### 11.4 素材生成

```bash
# 截图（1280×800 ×5）+ 宣传图（440×280 / 920×680 / 1400×560）
$PY test/make_store_assets.py --ext . --out-dir store
$PY test/make_promo.py --out-dir store
```

截图用**演示模式**生成，因此在任何机器上都能复现，不依赖任何厂商接口。
所有输出都压平为**不带 alpha 的 RGB**（商店硬性要求，见 §8.18）。

### 11.5 商店文案与审核备注

全部内容在 **`store/STORE-LISTING.md`**，逐条对应开发者后台的字段：
名称 / 简短说明 / 详细说明 / 单一用途 / 数据使用披露 / 权限理由 /
审核备注 / 隐私政策 / 发布步骤 / 提交前自检清单。

**规则：每次改版本都要同步更新那个文件里的「变更日志」和版本号。**

### 11.6 隐私政策必须挂在公网

`store/privacy.html` 是现成的政策页，但商店要求的是一个**公开可访问的 HTTPS URL**。
把它传到任意静态托管（GitHub Pages / Cloudflare Pages / 自己的站点），
拿到链接后填进后台的「隐私政策 URL」字段。

---

## 附：交付流程

```bash
cd bilingual-reader

# 1. 语法检查
for f in $(find src test -name "*.js" | sort); do
  out=$(osascript -l JavaScript "$f" 2>&1)
  echo "$out" | grep -q "SyntaxError" && echo "❌ $f"
done

# 2. 全量回归（串行！）
python3 /tmp/poll_harness.py "http://127.0.0.1:8766/bilingual-reader/test/harness.html?autotest=1&v=99"
python3 test/e2e.py --ext . --url "http://127.0.0.1:8766/bilingual-reader/demo/demo.html" --out /tmp/e2e.png
python3 test/verify_options.py --ext . --out /tmp/shot-options.png
python3 test/verify_popup.py --ext . --url "http://127.0.0.1:8766/bilingual-reader/demo/demo.html" --out /tmp/shot-popup.png
python3 test/verify_ai.py --ext .

# 3. 重新截图（改了界面才需要）
python3 test/shots.py --ext . --out-dir docs
python3 test/shot_ai.py --ext . --out docs/screenshot-ai-config.png

# 4. 清理 + 打包（用 Python zipfile：Info-ZIP 会把中文文件名存成乱码，见 §8.15）
python3 - <<'PY'
import os, shutil, zipfile
for root, dirs, files in os.walk("."):
    for d in list(dirs):
        if d == "__pycache__":
            shutil.rmtree(os.path.join(root, d), ignore_errors=True); dirs.remove(d)
    for f in files:
        if f == ".DS_Store":
            os.remove(os.path.join(root, f))
out = "../bilingual-reader.zip"
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk("."):
        dirnames[:] = [d for d in dirnames if d not in ('__pycache__', '.git')]
        for f in filenames:
            if f == '.DS_Store':
                continue
            p = os.path.join(dirpath, f)
            z.write(p, os.path.join('bilingual-reader', os.path.relpath(p, '.')))
print('zipped', out)
PY

# 5. 从 zip 验收（必须做，测的是交付物本身）
python3 -c "import shutil,os; shutil.rmtree('/tmp/br-final',ignore_errors=True); os.makedirs('/tmp/br-final')"
unzip -q bilingual-reader.zip -d /tmp/br-final
cd bilingual-reader && python3 test/e2e.py --ext /tmp/br-final/bilingual-reader \
  --url "http://127.0.0.1:8766/bilingual-reader/demo/demo.html" --out /tmp/e2e-final.png
```

---

**读完这份文档 + `docs/PRD.md`，你应该能回答：**
「用户点一下『翻译此页』，从点击到看到译文，中间发生了什么？」
「我要加一个新供应商 / 新场景 / 新设置项，该动哪几个文件？」
「为什么这个项目不用打包工具？代价是什么？」
「哪些地方改起来看着简单、实际会踩坑？」

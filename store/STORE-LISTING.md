# Chrome 应用商店发布信息

发布日期准备：2026-11-04 · 版本：1.4.0

## 项目链接

- 源码：https://github.com/xuyang1996/bilingual-reader
- 网站：https://xuyang1996.github.io/bilingual-reader/
- 隐私政策：https://xuyang1996.github.io/bilingual-reader/privacy.html
- 演示页：https://xuyang1996.github.io/bilingual-reader/demo.html
- 支持：https://github.com/xuyang1996/bilingual-reader/issues

## 商店详情

名称：Bilingual Reader — 双语对照翻译

简短说明：段落级双语对照网页翻译：识别正文，原文与译文同屏阅读。支持自备大模型 API、本地模型及离线演示模式。

类别：生产力 / 工具（以后台可选类别为准）

语言：中文（简体）

详细说明：

把英文网页变成一页双语对照，读原文的同时看懂译文。

Bilingual Reader 识别网页正文并逐段翻译，把译文放在原文下方。标题、列表与表格都可对照阅读；代码块保持原文。可切换「双语对照」「仅译文」「仅原文」，随时还原页面。

【首次使用】
真实翻译需要配置你自己的大模型 API 地址、模型和 API Key；本地部署的模型可按服务配置选择免 Key 鉴权。扩展不提供内置免费翻译额度。

想先体验？在设置页添加「演示模式（本地示例，无需 Key）」并保存，然后打开项目演示页启动翻译。演示模式使用本地词表，不联网，只用于体验排版与操作，不代表真实机器翻译质量。

【模型与翻译风格】
支持 OpenAI 兼容接口、Anthropic、Gemini 和自定义接口，可接入 DeepSeek、Kimi、通义千问等服务，以及 Ollama、vLLM、LM Studio 本地模型。
可配置多个引擎；支持地址及鉴权候选回退、批量翻译、响应字段自定义。
内置通用、科技、新闻、学术、编程文档、GitHub、法律、医疗、金融、购物、客服、文学、社交媒体、通俗英语等场景，可编辑提示词或按网址匹配场景。

【阅读与效率】
正文识别默认排除导航、侧栏、页脚和目录；可用站点规则精确调整。
懒翻译按滚动位置发请求，动态新增内容可自动补翻。
本地缓存减少重复请求；术语库帮助统一专有名词。
使用工具栏按钮、页面右键菜单或 Alt+T 启动与还原。

【数据处理】
扩展作者不运营接收正文或密钥的服务器，没有广告与遥测。真实翻译会把处理后的正文、提示词和鉴权信息直接发送到你配置的模型接口。可选 PII 脱敏会尝试替换邮箱、电话等信息，但不能保证识别全部敏感内容。完整说明请见隐私政策。

本项目以 MIT 协议开源，独立实现，与「沉浸式翻译」无品牌或代码隶属关系。
浏览器内置页和 Chrome 应用商店页面无法翻译；部分动态网页需刷新重译。

## 单一用途

识别网页正文并翻译为与原文逐段对照显示的译文，方便双语阅读。

## 权限理由

- storage：在浏览器本地保存引擎配置、API Key、翻译偏好及译文缓存，支持设置恢复与减少重复请求。
- contextMenus：提供翻译本页、还原本页、仅显示译文、仅显示原文四项页面右键操作。
- 主机权限 <all_urls>：在用户打开的网页中识别正文、插入及还原译文，同时访问用户自行配置的模型 API（含自建网关和本地服务），仅用于网页翻译。
- 远程代码：不使用。扩展全部执行代码包含在上传包中；模型接口返回内容作为经过转义的文本显示，不执行远程代码。

## 数据处理披露

后台需按实际处理情况披露，不能因作者无服务器就填写「不处理任何数据」。

- 网站内容：会读取、处理并按用户配置向模型接口传输待翻译正文。
- 身份验证信息：会在本地保存用户输入的模型 API Key，并向指定接口发送鉴权信息。
- 正文可能包含个人身份、财务、健康、个人通讯或位置信息；脱敏为可选的规则匹配，不保证完整移除。后台同时勾选这些正文数据类型，隐私政策说明其仅在待翻译正文中出现时处理。
- 后台数据类型：个人身份信息、健康信息、财务和付款信息、身份验证信息、个人通讯、位置、网站内容。未选择网络记录和用户活动（不保存浏览历史列表或行为日志）。
- 不读取密码管理器、浏览器 Cookie、浏览历史数据库，不建立广告档案。
- 数据仅用于用户可见的翻译功能，不出售，不用于广告、信用或贷款判断；不传给与翻译无关的第三方。

## 审核备注

Bilingual Reader is an open-source, paragraph-level bilingual webpage translation extension.

No extension account or test credentials are required.

To verify without an API key:
1. Install the extension and open its Options page.
2. In 翻译引擎 (Translation engines), choose 演示模式（本地示例，无需 Key） from the engine picker, then click 保存这个引擎 (Save this engine). A fresh install has no engine selected; this step is required.
3. Open https://xuyang1996.github.io/bilingual-reader/demo.html (an ordinary public HTTPS page).
4. Click the toolbar icon and 翻译此页 (Translate this page). Scroll to translate additional paragraphs. Demo translations have a pale yellow background. Navigation and code blocks are skipped.
5. Switch between dual / translation-only / original-only modes, then click 还原本页 (Restore).

Demo mode uses a bundled local dictionary, makes no network requests, and is clearly labeled as a demonstration. It is not machine translation.
For real translation, users supply their own model API URL/model/key or use a local model server. The extension sends text and authentication directly to that configured endpoint; the developer receives none of it. Optional PII masking is heuristic and does not guarantee removal of all sensitive content.

Permissions: storage saves local settings/cache; contextMenus provides translation actions; <all_urls> enables paragraph recognition/rendering on user webpages and requests to user-configured API endpoints.
No remote executable code is downloaded or run. Model responses are escaped before rendering.
Chrome internal pages and Chrome Web Store pages cannot be translated.

Privacy: https://xuyang1996.github.io/bilingual-reader/privacy.html
Source: https://github.com/xuyang1996/bilingual-reader

## 发布材料与操作

- 商店包：仓库外 bilingual-reader-store.zip（manifest.json 位于根目录）。
- 图标：icons/icon128.png。
- 截图：store/screenshot-01-bilingual.png 至 screenshot-05-scenario.png（1280×800、RGB）。
- 小宣传图：store/promo-small-440x280.png。
- 横幅：store/promo-marquee-1400x560.png。
- GitHub Pages：main 分支 /docs，包含 .nojekyll、主页、隐私政策与演示页。
- 商店公开分发，提交审核后自动发布；最终状态以后台实际结果为准。
- 若后台出现新的法律协议或认证要求，应由账号持有人确认或完成。

## 变更记录

2026-11-04：准备 v1.4.0 首次公开发布，补齐 GitHub 项目链接与 Pages 资源，修正文案中的数据流及演示模式验证步骤。扩展运行代码未变更。

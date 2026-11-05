# Chrome 应用商店发布信息

最近提交审核：2026-11-05 · 版本：1.5.0

## 项目链接

- 源码：https://github.com/xuyang1996/bilingual-reader
- 网站：https://xuyang1996.github.io/bilingual-reader/
- 隐私政策：https://xuyang1996.github.io/bilingual-reader/privacy.html
- 演示页：https://xuyang1996.github.io/bilingual-reader/demo.html
- 支持：https://github.com/xuyang1996/bilingual-reader/issues

## 商店详情

名称：Bilingual Reader — 双语对照翻译

简短说明（由 manifest 提供）：网页段落双语对照翻译，支持英文句子解析、查词、音标、发音和本地收藏。可连接自备模型 API 或本地模型，支持术语库与敏感信息脱敏。

类别：生产力 / 工具（以后台可选类别为准）

语言：中文（简体）

详细说明：

把英文网页变成一页双语对照，读原文的同时看懂译文。

Bilingual Reader 识别网页正文并逐段翻译，把译文放在原文下方。标题、列表与表格都可对照阅读；代码块保持原文。可切换「双语对照」「仅译文」「仅原文」，随时还原页面。

【读网页时学英语】
划选已翻译段落中的英文原句，点击「学这句」，用简单中文读懂句子主干和关键短语。划选一个单词，点击「查单词」，查看语境释义、美式音标和词根或构词说明。可以用设备上的本地英语语音朗读单词或句子，也可以收藏到本机，在扩展面板的「学习收藏」中复习。

【首次使用】
真实翻译需要配置你自己的大模型 API 地址、模型和 API Key；本地部署的模型可按服务配置选择免 Key 鉴权。扩展不提供内置免费翻译额度。

想先体验？在设置页添加「演示模式（本地示例，无需 Key）」并保存，然后打开项目演示页启动翻译。演示模式使用本地词表和内置学习例句，可以离线体验翻译排版、划词、句子解析和收藏。

【模型与翻译风格】
支持 OpenAI 兼容接口、Anthropic、Gemini 和自定义接口，可接入 DeepSeek、Kimi、通义千问等服务，以及 Ollama、vLLM、LM Studio 本地模型。
可配置多个引擎；支持地址及鉴权候选回退、批量翻译、响应字段自定义。
内置通用、科技、新闻、学术、编程文档、GitHub、法律、医疗、金融、购物、客服、文学、社交媒体、通俗英语等场景，可编辑提示词或按网址匹配场景。

【网页浮签与翻译控制】
网页右侧的 32 像素浮签默认半透明，悬停后不透明并展开操作；可上下拖动并记住高度。
点击即可翻译；支持暂停/继续、从头重新翻译、失败段落补翻和还原。可快捷打开设置或关闭浮签，关闭后可从工具栏面板重新显示。
暂停会停止当前翻译请求，继续时从停止位置的上一个段落接着翻译；重译会从头重新翻译。

【阅读与效率】
正文识别默认排除导航、侧栏、页脚和目录；可用站点规则精确调整。
懒翻译按滚动位置发请求，动态新增内容可自动补翻。
本地缓存减少重复请求；术语库帮助统一专有名词。
也可使用工具栏按钮、页面右键菜单或 Alt+T 启动与还原。

【数据处理】
扩展作者不运营接收正文或密钥的服务器，没有广告与遥测。翻译或主动使用学习卡时，所需文本、提示词和鉴权信息直接发送到你配置的模型接口。可选 PII 脱敏会尝试替换邮箱、电话等信息。学习收藏保存在本机。完整说明请见隐私政策。

本项目以 MIT 协议开源，灵感来自「沉浸式翻译」。翻译风格使用了其公开的 immersive-translate/prompts 中的场景提示词，并按本项目的需要做了适配。感谢沉浸式翻译团队及提示词贡献者。
浏览器内置页和 Chrome 应用商店页面无法翻译；部分动态网页需刷新重译。

## 单一用途

帮助用户对照阅读外语网页。扩展将网页正文逐段翻译并与原文同时显示，还可解释用户主动选中的英文单词和句子。

## 权限理由

- storage：在浏览器本地保存引擎配置、API Key、翻译偏好、译文缓存和用户主动收藏的学习内容。
- contextMenus：提供翻译本页、还原本页、仅显示译文、仅显示原文四项页面右键操作。
- 主机权限 <all_urls>：在用户打开的网页中识别正文、插入及还原译文、显示原文学习卡，并访问用户配置的模型 API（含自建网关和本地服务）。
- 远程代码：不使用。扩展全部执行代码包含在上传包中；模型接口返回内容作为经过转义的文本显示，不执行远程代码。

## 数据处理披露

后台需按实际处理情况披露，不能因作者无服务器就填写「不处理任何数据」。

- 网站内容：按用户配置向模型接口传输待翻译正文或主动请求解析的英文原文。
- 身份验证信息：会在本地保存用户输入的模型 API Key，并向指定接口发送鉴权信息。
- 正文可能包含个人身份、财务、健康、个人通讯或位置信息；脱敏为可选的规则匹配，不保证完整移除。后台同时勾选这些正文数据类型，隐私政策说明其仅在待翻译正文中出现时处理。
- 后台数据类型：个人身份信息、健康信息、财务和付款信息、身份验证信息、个人通讯、位置、网站内容。未选择网络记录和用户活动（不保存浏览历史列表或行为日志）。
- 不读取密码管理器、浏览器 Cookie、浏览历史数据库，不建立广告档案。
- 数据用于用户可见的双语阅读与原文学习功能，不出售，不用于广告、信用或贷款判断。

## 审核备注

Bilingual Reader is an open-source, paragraph-level bilingual webpage translation extension.

No extension account or test credentials are required.

To verify without an API key:
1. Install the extension and open its Options page.
2. In 翻译引擎 (Translation engines), choose 演示模式（本地示例，无需 Key） from the engine picker, then click 保存这个引擎 (Save this engine). A fresh install has no engine selected; this step is required.
3. Open https://xuyang1996.github.io/bilingual-reader/demo.html (an ordinary public HTTPS page).
4. Click the right-edge floating button or the toolbar icon and 翻译此页 (Translate this page). Scroll to translate additional paragraphs. Demo translations have a pale yellow background. Navigation and code blocks are skipped.
5. Switch between dual / translation-only / original-only modes, then click 还原本页 (Restore).
6. Under “Try the English study card”, select the example sentence and click 学这句 (Learn this sentence). Select waiting and click 查单词 (Look up word) to see its meaning, IPA and word formation. Use 发音 (Pronunciation) and 收藏 (Save), then open 学习收藏 (Study collection) from the toolbar popup.

The Chinese dashboard instructions are in `reviewer-notes.txt`.

Demo mode uses a bundled dictionary and a fixed study example. Both work locally.
For real translation, users supply their own model API URL/model/key or use a local model server. The extension sends text and authentication directly to that configured endpoint; the developer receives none of it. Optional PII masking is heuristic and does not guarantee removal of all sensitive content.

Storage holds local settings, cached translations and saved study items. Context menus provide translation controls. Host access supports rendering translation and study cards on webpages, and requests to user-configured model endpoints.
No remote executable code is downloaded or run. Model responses are escaped before rendering.
Chrome internal pages and Chrome Web Store pages cannot be translated.

Privacy: https://xuyang1996.github.io/bilingual-reader/privacy.html
Source: https://github.com/xuyang1996/bilingual-reader

## 发布材料与操作

- 商店包：仓库外 ../releases/v1.5.0/bilingual-reader-store.zip（manifest.json 位于根目录）。
- 图标：icons/icon128.png。
- 截图：store/screenshot-01-bilingual.png 至 screenshot-05-scenario.png（1280×800、RGB）。
- 小宣传图：store/promo-small-440x280.png。
- 横幅：store/promo-marquee-1400x560.png。
- GitHub Pages：main 分支 /docs，包含 .nojekyll、主页、隐私政策与演示页。
- 商店公开分发，提交审核后自动发布；最终状态以后台实际结果为准。
- 若后台出现新的法律协议或认证要求，应由账号持有人确认或完成。

## 变更记录

2026-11-04：准备 v1.4.0 首次公开发布，补齐 GitHub 项目链接与 Pages 资源，修正文案中的数据流及演示模式验证步骤。扩展运行代码未变更。

2026-11-05：撤回待审核的 v1.4.0，上传 v1.4.4，更新浮签、暂停/继续、重译功能说明及提示词来源致谢，保存新版测试说明后重新提交审核。

2026-11-05：撤回待审核的 v1.4.4，上传 v1.5.0。同步英语学习说明、权限用途与免 Key 演示步骤后重新提交审核。

## 实际提交状态

v1.5.0 已提交 Chrome 应用商店，后台确认「待审核」，审核通过后自动发布。商店 ID 为 `hknjjifpobhffnapdepmclepeaholndk`。详细记录见 `PUBLISH-STATUS.md`。

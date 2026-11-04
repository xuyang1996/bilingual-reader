# Bilingual Reader

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

**Read webpages with the original text and its translation, paragraph by paragraph.**

Bilingual Reader is a Chrome extension that identifies webpage content and places a translation next to each original paragraph. Headings, lists and table cells can be translated while code blocks stay intact. It uses your own model API or a locally hosted model.

No build step, npm installation or third-party runtime is required. The extension interface is currently primarily in Simplified Chinese; these README translations describe the same extension.

[Website](https://xuyang1996.github.io/bilingual-reader/) · [Downloads](https://github.com/xuyang1996/bilingual-reader/releases) · [Privacy policy](https://xuyang1996.github.io/bilingual-reader/privacy.html) · [Report an issue](https://github.com/xuyang1996/bilingual-reader/issues)

## Preview

![Paragraph-by-paragraph bilingual reading](docs/screenshot-bilingual.png)

| Toolbar popup | Settings |
| --- | --- |
| ![Toolbar popup](docs/screenshot-popup.png) | ![Settings page](docs/screenshot-options.png) |

## Features

- **Bilingual reading:** switch between original + translation, translation only and original only; restore the page when finished.
- **Content recognition:** skip navigation, sidebars, footers and other page furniture by default; customize the scope with site rules.
- **Lazy translation:** request translations near the viewport instead of sending the entire page at once.
- **Dynamic content:** translate newly inserted content with incremental translation enabled.
- **Bring your own model:** configure multiple providers, custom gateways or local servers.
- **Translation styles:** 14 built-in scenarios, editable prompts and automatic scenario matching by URL.
- **Terminology and privacy:** glossary instructions, translation post-processing and optional sensitive-data masking.
- **Local settings and cache:** keep configuration and cached translations in the browser, with JSON import/export.

## Quick start

1. Download **`bilingual-reader.zip`** from [Releases](https://github.com/xuyang1996/bilingual-reader/releases) and extract it, or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the directory containing `manifest.json` (the extracted `bilingual-reader` directory or the repository root).
4. Open the extension's settings. Under **Translation engines (`翻译引擎`)**, select a provider and enter its API URL, model and API key. Click **Test connection (`测试连接`)**, then **Save this engine (`保存这个引擎`)**.
5. Open a regular webpage and click the extension icon → **Translate this page (`翻译此页`)**.
6. Choose your target language in the popup. The default target is Simplified Chinese; 17 target languages are listed.

Below the main button, **Pause (`暂停`)** keeps existing translations and cancels active and queued work. It becomes **Continue (`继续`)**, which resumes from the paragraph immediately before the pause point. **Retranslate (`重新翻译`)** clears this page's translations and starts again from the first paragraph, bypassing old cache. **Restore (`还原本页`)** removes translations and ends the session.

A fresh installation has **no configured engine**. Real translation requires a working model endpoint; the extension supplies no hosted translation service or API credits. Your provider may charge for requests.

You can also click the compact **floating `译` button** fixed to the right side of ordinary webpages. Drag it vertically; its height is remembered across pages. The 32 px button is half transparent when idle and fully opaque on hover. Hover or focus it for pause/continue, retranslation, restoration, settings and close controls. After closing it, select **显示网页浮签** (show webpage widget) in the extension popup, or enable it under **译文样式** (display settings).

### Try it without an API key

In settings, add **Demo mode (`演示模式（本地示例，无需 Key）`)** and save it. Open the [English demo page](https://xuyang1996.github.io/bilingual-reader/demo.html), then start translation.

Demo mode uses a bundled local dictionary and makes no network requests. Its translations have a pale yellow background. It demonstrates recognition, layout, mode switching and restoration; **it is not machine translation**.

### Shortcuts and context menu

| Action | Default shortcut |
| --- | --- |
| Translate / restore the current page | `Alt+T` |
| Start translation | `Alt+Shift+T` |
| Restore the page | `Alt+Shift+R` |

Customize shortcuts at `chrome://extensions/shortcuts`. The page context menu also provides translation, restoration, translation-only and original-only actions.

## Connect a model API

The engine picker contains provider presets, including OpenAI, Anthropic Claude, Google Gemini, DeepSeek, Kimi, Qwen, GLM, OpenRouter and others. Local presets include Ollama, vLLM and LM Studio.

| Interface | Configuration |
| --- | --- |
| OpenAI-compatible | Base URL, optional path, model and authentication |
| Anthropic Messages | Anthropic request format and authentication |
| Gemini generateContent | Gemini request format, model path and key settings |
| Custom / gateway | Custom path, headers, extra body parameters and response-field path |
| Local model | Local server URL and model; use no-key authentication only if the server allows it |

Provider suggestions appear as hints; fill in the actual values required by your service. Preset engine names follow the model name. Choose **Fully custom (`完全自定义`)** to use your own unique engine name, including separate gateways for the same model.

The engine layer handles URL candidates (including a missing `/v1`), authentication fallback, multiple response shapes and SSE responses. It remembers successful URL/authentication combinations. Numbered batches fall back to individual requests if the response cannot be aligned. Model-name heuristics adjust parameters for some reasoning models; compatibility still depends on the actual service.

Advanced fields include authentication mode, system/developer/user role, timeout, batch size, temperature, output-token limit, custom headers, extra JSON body, response-field path and a custom system prompt. The [local API test bench](test/engine.html) exposes request/response details; browser CORS restrictions may apply outside the extension.

If translation fails, the popup shows the API error. Correct the model, authentication or quota in settings, then click **重试失败段落** (retry failed paragraphs). Successful translations are preserved. Temporary network and API errors receive at most two retries; model, endpoint or persistent service failures pause further requests. See the [reliability notes](docs/RELIABILITY.zh-CN.md) (Chinese).

## Translation styles

| Scenario | Focus |
| --- | --- |
| General | Faithful, concise translation |
| Technology / software | Technical terminology and product names |
| News / media | Facts, quotations and attribution |
| Academic papers | Formulas, citations and the strength of claims |
| Programming documentation | APIs, commands and identifiers |
| GitHub | Issues, pull requests, Markdown and code |
| Legal | Defined terms and legal references |
| Medical / health | Medical terminology, quantities and units |
| Finance | Numbers, percentages and financial terms |
| E-commerce | Brands, specifications and purchase conditions |
| Customer service | Tone and responsibility without added commitments |
| Fiction | Voice, rhythm and narrative style |
| Social media | Informal language, mentions and hashtags |
| Plain English | Rewrite difficult English in simpler English |

Automatic URL matching is enabled by default; a matching scenario takes precedence over the manually selected scenario. You can edit built-in prompts or add custom scenarios. `{target}` is replaced with the target-language name.

An engine's custom system prompt overrides the scenario and general rules. Otherwise, scenario instructions are added to the general rules. The batch protocol, when used, and glossary instructions are appended afterward.

## Site rules and glossary

Use a JSON array in **Site rules (`站点规则`)** to choose a main-content selector, exclude elements, change languages or display modes, and override recognition thresholds. Rules support wildcard URLs, `||example.com` domain matching and `parentId` inheritance; more specific matching rules apply later.

```json
[
  {
    "id": "docs-site",
    "name": "Documentation",
    "urlPattern": ["*docs.example.com*"],
    "translationMode": "dual",
    "targetLang": "zh-Hans",
    "mainSelector": "main",
    "excludeSelectors": [".sidebar", "nav", ".advertisement"],
    "thresholds": { "paragraphMinTextCount": 2 }
  }
]
```

The default minimum paragraph length is 2 characters; the page-content threshold is 50 characters. **Whole-page translation (`整页翻译`)** includes page furniture that is normally skipped. Inline technical fragments are protected with placeholders; standalone code blocks are skipped.

The glossary accepts one source/target pair per line, separated by a tab or comma. For example:

```text
large language model,大语言模型
pull request,拉取请求
```

Glossary entries are added to the model prompt. Post-processing also replaces remaining source terms; it cannot guarantee correction of every translation that uses a different target term.

## Privacy and storage

- The developer does not operate a server that receives your page text, API keys or usage statistics. There are no advertising or telemetry SDKs.
- Real translation sends the processed text, prompts and authentication information **directly to the endpoint you configure**. Its operator's policies apply. Use an endpoint you trust and HTTPS for remote services.
- Optional masking covers email addresses, telephone numbers, card numbers, identification numbers, IP addresses, URLs and IBANs. It is based on patterns and **does not guarantee removal of all sensitive information**.
- Settings, API keys and translation cache are stored in `chrome.storage.local`. Cache entries use text/language/engine identifiers and expire on read after 30 days. You can disable or clear the cache.
- JSON configuration exports contain API keys. Keep backups private. Clear cache and reset settings through their respective settings controls, or uninstall the extension to remove its local storage.
- For local-only processing, use demo mode or a model service that is actually hosted on your computer. A “local” preset alone does not determine where a custom URL sends data.

See the [full privacy policy](https://xuyang1996.github.io/bilingual-reader/privacy.html) for details.

## Architecture and development

The extension uses Manifest V3, classic JavaScript scripts and a shared `IMT` namespace. Core modules do not depend on `chrome.*`; the translation transport is injected for the extension or tests.

| Path | Responsibility |
| --- | --- |
| `src/shared/` | Defaults, providers, utilities, configuration migration and prompts |
| `src/core/` | Rules, segmentation, scheduling, masking, glossary and rendering |
| `src/content/` | Page commands and the connection to the background worker |
| `src/background/` | API adapters, cache, messages, shortcuts and context menus |
| `src/popup/`, `src/options/` | Toolbar controls and settings |
| `test/` | DOM harness, mock model server and browser verification scripts |
| `docs/` | Documentation, screenshots and GitHub Pages resources |

The flow is: **resolve rules → collect paragraphs → schedule → mask → cache/API → restore placeholders → apply glossary → render**. Restoration unwraps original nodes and removes injected translations. Display modes are controlled with CSS classes.

After editing, reload the unpacked extension and refresh the target webpage. Read the [development guide](docs/DEVELOPMENT.md), [product requirements](docs/PRD.md) and [original detailed technical notes](docs/README-technical.zh-CN.md) before larger changes. These detailed documents are currently in Chinese.

### Local verification

From a checkout named `bilingual-reader`, start a static server, open the DOM harness, and run browser scripts in a second terminal from the repository root:

```bash
git clone https://github.com/xuyang1996/bilingual-reader.git
cd bilingual-reader
python3 -m http.server 8766 --bind 127.0.0.1 --directory ..
```

`http://127.0.0.1:8766/bilingual-reader/test/harness.html?autotest=1`

```bash
python3 test/e2e.py --ext . \
  --url http://127.0.0.1:8766/bilingual-reader/demo/demo.html \
  --out /tmp/bilingual-reader-e2e.png
python3 test/verify_ai.py --ext .
python3 test/verify_reliability.py --ext .
python3 test/verify_floating.py --ext .
python3 test/verify_options.py --ext .
python3 test/verify_popup.py --ext . \
  --url http://127.0.0.1:8766/bilingual-reader/demo/demo.html
```

Run browser tests **sequentially**. The scripts use Python's standard library and default to Chrome's macOS installation path; pass `--chrome /path/to/chrome` on other setups. API-shape tests use a local mock HTTP service, not a paid provider.

Recorded validation on 2026-11-04: **67 DOM tests, 35 API-shape assertions and 53 settings assertions passed; popup checks passed; the packaged extension translated 52 demo paragraphs with 0 errors.** These are recorded results, not a guarantee of every provider's live availability.

Build the Chrome Web Store archive with:

```bash
python3 test/build_store_zip.py --ext . --out ../bilingual-reader-store.zip
```

The store ZIP places `manifest.json` at its root and excludes tests, documentation and store artwork. The source archive includes the full project under `bilingual-reader/`.

## Limitations and contributions

- This release targets Chrome / Chromium using Manifest V3 (manifest minimum: Chrome 96). Firefox and Safari are not supported in this release.
- Chrome internal pages and Chrome Web Store pages cannot be translated. Closed shadow roots cannot be accessed.
- Frequent React/Vue rerendering may replace injected translations. Content recognition is heuristic; unusual sites may need custom rules.
- Provider rate limits, quotas, authentication and service availability remain the provider's responsibility. Not every API is compatible with every advanced setting.
- Changes to the model, endpoint, prompts or glossary automatically use a separate translation cache.

Bug reports and contributions are welcome through [Issues](https://github.com/xuyang1996/bilingual-reader/issues) and pull requests. Include the Chrome version, reproduction steps and a public example URL where possible. Remove API keys and private page content from reports.

## Inspiration and credits

This project's inspiration comes from **[Immersive Translate](https://immersivetranslate.com/)**. Its translation styles use scenario prompts from the public **[immersive-translate/prompts](https://github.com/immersive-translate/prompts)** repository, adapted to this project's needs. Thanks to the Immersive Translate team and prompt contributors.

## License

See [LICENSE](LICENSE) for the project's MIT license and attribution notes.

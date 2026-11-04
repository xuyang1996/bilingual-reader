# Publication status

Updated: 2026-11-05 (Asia/Shanghai)

## Chrome Web Store

- Item ID: `hknjjifpobhffnapdepmclepeaholndk`
- Dashboard: https://chrome.google.com/webstore/devconsole/fb83a780-0058-4709-be61-cea17a9209ea/hknjjifpobhffnapdepmclepeaholndk/edit
- Version: **1.4.4**.
- Status: **Submitted; pending Google compliance review.** The submission confirmation and the package page both confirmed the pending-review state; the package page showed version 1.4.4.
- Automatically publish after approval: enabled.
- Public listing is not live yet; review and approval remain with Google.
- Replaced the pending v1.4.0 submission with the v1.4.4 store ZIP on 2026-11-05. The previous review was cancelled first. Existing icon, 5 screenshots and promotional tiles were retained.
- Updated and saved the Chinese description with the compact, translucent, right-docked floating button, pause/resume, restart translation and prompt-source attribution. Saved the updated 428-character reviewer instructions.
- Package permissions remained storage, contextMenus and host permission; no new permissions were introduced.
- Saved: Chinese description, Tools category, Chinese (China) language, homepage/support URLs, single purpose, permissions justifications, no-remote-code declaration, data disclosures, privacy URL and reviewer instructions.
- Distribution observed: free, public, all regions. Existing non-trader account classification was not changed.
- Public contact email was explicitly approved by the account holder and verified successfully.
- Homepage, privacy policy and demo URLs returned HTTP 200; their public bytes matched committed source.
- The all-websites host permission caused an additional-review warning, which was acknowledged before submission.

## GitHub

- Public repository created: https://github.com/xuyang1996/bilingual-reader
- Source and history were pushed to main; public visibility and remote commit were verified.
- GitHub login and second-factor authentication completed successfully.
- GitHub Pages source: main /docs; HTTPS enforced; deployment verified as built.
- Published files: docs/index.html, docs/privacy.html, docs/demo.html, docs/.nojekyll.
- Live Pages URL: https://xuyang1996.github.io/bilingual-reader/
- Live privacy URL: https://xuyang1996.github.io/bilingual-reader/privacy.html
- Release downloads: https://github.com/xuyang1996/bilingual-reader/releases/tag/v1.4.4
- Future source pushes to main automatically rebuild the Pages site.

## Validation for v1.4.4

- The uploaded ZIP's 27 files were verified byte-for-byte against release source commit `e791a12f781673a8e852988cc6185c8a69fa9622`; its root manifest declared version 1.4.4.
- Floating-button browser checks: 29 passed, including compact size, opacity, hover, vertical dragging, right-edge docking, saved height and restoring a hidden button.
- Store ZIP SHA-256: `5bd40bf042f60b418d65a65f2cc5a13bb0872437d32420ff447c91ff141d3592`.
- Chrome Web Store accepted the package and confirmed version 1.4.4 after submission.

## Initial v1.4.0 publication validation (2026-11-04)

- Browser DOM unit harness: 67 passed, 0 failed.
- API-shape tests against a local mock HTTP service: 35 passed, 0 failed.
- Settings round-trip/browser checks: 53 passed, 0 failed.
- Popup behavioral checks: all passed, including engine/language changes and restore.
- End-to-end: 52 translated paragraphs, 0 errors.
- Repeated E2E from extracted final store ZIP: 52 translated paragraphs, 0 errors.
- Store images: required dimensions and RGB PNG verified.
- Tracked-source credential scan: only explicitly marked demo keys matched.
- Extension runtime code was unchanged during initial publication preparation.
- Initial store ZIP SHA-256: b27be556bd12a99abf6b72d158c88e9d7f59e86f2e53e716534542e33beec2dc

## Local artifacts

- Store ZIP: ../releases/v1.4.4/bilingual-reader-store.zip (manifest at ZIP root).
- Source ZIP: ../releases/v1.4.4/bilingual-reader.zip (bilingual-reader/ prefix).
- Exact 428-character dashboard review instructions: reviewer-notes.txt (excluding the final newline).
- Versioned release archives remain unchanged; these publication records are maintained separately on main.

# Publication status

Updated: 2026-11-04 (Asia/Shanghai)

## Chrome Web Store

- Item ID: `hknjjifpobhffnapdepmclepeaholndk`
- Dashboard: https://chrome.google.com/webstore/devconsole/fb83a780-0058-4709-be61-cea17a9209ea/hknjjifpobhffnapdepmclepeaholndk/edit
- Status: **Draft; not submitted for review.**
- Uploaded: v1.4.0 ZIP, icon, 5 screenshots, small promotional tile, marquee tile.
- Saved: Chinese description, Tools category, Chinese (China) language, homepage/support URLs, single purpose, permissions justifications, no-remote-code declaration, data disclosures, privacy URL and reviewer instructions.
- Distribution observed: free, public, all regions. Existing non-trader account classification was not changed.
- Dashboard blockers: missing verified public contact email; homepage and privacy URLs unavailable until GitHub Pages deployment.
- Public contact email awaits account-holder confirmation; browser is at the email-entry dialog. Do not publish a personal contact email without the requested confirmation.

## GitHub

- Public repository created: https://github.com/xuyang1996/bilingual-reader
- Local origin is configured; repository is still empty remotely.
- GitHub CLI device login is waiting for the account holder to complete GitHub second-factor authentication in the Chrome tab titled Confirm access.
- Do not claim source was pushed or Pages deployed until verified.
- Ready locally: docs/index.html, docs/privacy.html, docs/demo.html, docs/.nojekyll.
- Intended Pages URL: https://xuyang1996.github.io/bilingual-reader/
- Intended privacy URL: https://xuyang1996.github.io/bilingual-reader/privacy.html
- After authentication: push main, enable Pages from main /docs, verify public HTTPS URLs, publish v1.4.0 release assets, then finish Chrome submission.

## Validation performed

- Browser DOM unit harness: 67 passed, 0 failed.
- API-shape tests against a local mock HTTP service: 35 passed, 0 failed.
- Settings round-trip/browser checks: 53 passed, 0 failed.
- Popup behavioral checks: all passed, including engine/language changes and restore.
- End-to-end: 52 translated paragraphs, 0 errors.
- Repeated E2E from extracted final store ZIP: 52 translated paragraphs, 0 errors.
- Store images: required dimensions and RGB PNG verified.
- Tracked-source credential scan: only explicitly marked demo keys matched.
- Extension runtime code unchanged during publication preparation.
- Store ZIP SHA-256: b27be556bd12a99abf6b72d158c88e9d7f59e86f2e53e716534542e33beec2dc

## Local artifacts

- Store ZIP: ../bilingual-reader-store.zip (manifest at ZIP root).
- Source ZIP: ../bilingual-reader.zip (bilingual-reader/ prefix).
- Exact 383-character dashboard review instructions: reviewer-notes.txt.

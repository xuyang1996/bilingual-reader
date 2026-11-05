# Publication status

Updated: 2026-11-05 (Asia/Shanghai)

## Chrome Web Store

- Item ID: `hknjjifpobhffnapdepmclepeaholndk`
- Dashboard: https://chrome.google.com/webstore/devconsole/fb83a780-0058-4709-be61-cea17a9209ea/hknjjifpobhffnapdepmclepeaholndk/edit
- Version: **1.5.0**.
- Status: **Submitted and pending Google compliance review.** The package page showed version 1.5.0 before submission, and the confirmation dialog reported that the item was under compliance review.
- Automatically publish after approval: enabled.
- Public listing is not live yet; review and approval remain with Google.
- Replaced the pending v1.4.4 submission with the v1.5.0 store ZIP on 2026-11-05. The previous review was cancelled before upload. The existing icon, screenshots and promotional tiles were retained.
- Saved the Chinese listing, updated single purpose and permission justifications, and saved the 364-character reviewer instructions for the offline study demo.
- The package uses the existing storage, contextMenus and all-sites host permissions.
- The five localized homepages, privacy policy and demo returned HTTP 200 and matched the release commit byte for byte before submission.
- The all-websites host permission caused an additional-review warning, which was acknowledged before submission.

## GitHub

- Public repository: https://github.com/xuyang1996/bilingual-reader
- Release source commit: `86abd37df6e73f2182d533c0e5b6af990626d333`.
- GitHub Pages builds from main /docs. The release deployment was verified as built.
- Live Pages URL: https://xuyang1996.github.io/bilingual-reader/
- Live privacy URL: https://xuyang1996.github.io/bilingual-reader/privacy.html
- Release downloads: https://github.com/xuyang1996/bilingual-reader/releases/tag/v1.5.0
- Both release asset digests matched the local archives.

## Validation for v1.5.0

- The uploaded ZIP contains 33 files and a root manifest declaring version 1.5.0.
- The extracted store package passed the study and offline demo checks, 42 translation reliability checks, 53 settings checks, popup checks and 35 model API compatibility checks.
- Store ZIP SHA-256: `687dbeff70d019bc27ef8d94b5ed2bab640341a37d0f5d8197ded34aa88c5f3e`.
- Source ZIP SHA-256: `9e1140da4c6d3051cbbae88e4d3a7e74f9d1ff412dc717485e16931dd8da3bc7`.

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

- Store ZIP: ../releases/v1.5.0/bilingual-reader-store.zip (manifest at ZIP root).
- Source ZIP: ../releases/v1.5.0/bilingual-reader.zip (bilingual-reader/ prefix).
- Exact 364-character dashboard review instructions: reviewer-notes.txt (excluding the final newline).
- Versioned release archives remain unchanged; these publication records are maintained separately on main.

# Preview favicons

These local copies are used only by the HTTP design preview's `/_favicon/` route.
The packaged extension uses Chrome's favicon cache. The preview serves an exact
hostname allowlist and makes no external requests when displaying these icons.
Unknown hosts return 404 so the UI can show its default icon.

Downloaded from official site endpoints on 2026-09-20. Each response was HTTP 200
and its file signature was verified as PNG or ICO. The `.png` extension for X is
intentional: its endpoint advertises an ICO content type but returns PNG bytes.

| File | Official source |
| --- | --- |
| youtube.png | https://www.youtube.com/s/desktop/b0f1b2cc/img/favicon_32x32.png |
| youtube-music.png | https://music.youtube.com/img/favicon_32.png |
| github.ico | https://github.com/favicon.ico |
| instagram.png | https://www.instagram.com/favicon.ico |
| x.png | https://x.com/favicon.ico |
| notion.ico | https://www.notion.com/front-static/favicon.ico |

# Reload Log — notes for Claude

- Plain HTML/JS PWA hosted on GitHub Pages (jaro-ad.github.io/reloading-log). Data lives on the device (IndexedDB).
- Bump APP_VERSION in app.js and CACHE in sw.js with every release.
- **After every change to the app, update the user guide** (Claude Doc "Reload Log — User Guide":
  https://claude.ai/artifact/3Z8cbxtjBZeKSRpugzz8tg) so it matches the app.
- Lots: when no lot is Open, use the oldest lot first (FIFO) — confirmed by Jaro.

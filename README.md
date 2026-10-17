# FOMO Alerts: Chrome extension source code (version 0.9.4)

This is version **0.9.4**, the version in the Chrome Web Store until version 0.9.6 has passed Google's review.

To check that the Chrome Web Store version is exactly this code, run this here (needs [Node.js](https://nodejs.org) 18 or newer):

```
node verify.js
```

0.9.6 removes two things that 0.9.4 still has:

- **The `cookies` permission.** 0.9.4 uses it only to read fomoalerts.family's own two cookies: the website's Telegram link and an invite code.
- **Selectors and texts from our server.** These were data only, never code, but nothing can be changed from the server any more.

The full README and the current code are on the [main branch](https://github.com/nannodes/fomo-alerts-extension).

© 2026 FOMO Alerts. All rights reserved. See [LICENSE](LICENSE).

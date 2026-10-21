# FOMO Alerts: Chrome extension source code

Take-profit, stop-loss, trailing-stop and buy-the-dip alerts for [fomo.family](https://fomo.family), sent to your Telegram.

This repository holds the exact code of the FOMO Alerts Chrome extension, so anyone can check what it does before installing it.

- **Chrome Web Store:** [FOMO Alerts](https://chromewebstore.google.com/detail/ioakhcjlledhimdgkppifpffapgjlkmm), ID `ioakhcjlledhimdgkppifpffapgjlkmm`
- **Website:** [fomoalerts.family](https://fomoalerts.family)
- **Official links and addresses:** [fomoalerts.family/dont-get-scammed.html](https://fomoalerts.family/dont-get-scammed.html)

## Check it yourself

1. **Read the code** in [`extension/`](extension). It's plain JavaScript: there's no build step and nothing is minified. The extension also can't download and run code from the internet, because Chrome doesn't allow that for Manifest V3 extensions.
2. **Check that the store version is this code.** With [Node.js](https://nodejs.org) 18 or newer, run:

   ```
   node verify.js
   ```

   It downloads FOMO Alerts from Google's own servers (the same file Chrome installs) and compares every file with `extension/`. When everything matches, it ends with:

   ```
   ✓ Every file is exactly the same: the Chrome Web Store version is this code.
   ```

3. **Every version has a tag**, for example `v0.9.6`. A new version can take a few days to pass Google's review. If the store still has an older version, check out that version's tag: `git checkout v0.9.5`.

## What it can see and do

**Permissions** (see [`extension/manifest.json`](extension/manifest.json)): `storage`, plus your data on two sites only, fomo.family and fomoalerts.family. Nothing else.

| | |
|---|---|
| **Reads on fomo.family** | Only responses that Fomo's own page already gets from Fomo's API (`prod-api.fomo.family`): your Fomo user id and username, your public wallet addresses, and your positions with their entry prices. See [`page-hook.js`](extension/page-hook.js) and [`rules.js`](extension/rules.js). |
| **Sends to our server** (fomoalerts.family) | Your alerts, which coins you hold, your Fomo user id, username and public wallet addresses, and error reports. [`background.js`](extension/background.js) is the only file that talks to our server. |
| **Never** | Never sees your password, login token, private key or seed phrase. Has no code that trades, withdraws or signs anything. Never makes requests of its own to Fomo. |

Your private key stays with Privy, Fomo's wallet provider, in its own isolated part of the page on another domain. Neither fomo.family nor any extension running on it can read it.

## Also built in

- **Nothing can be changed from our server.** There are no remote rules, texts or code. Any change is a new version that Google reviews.
- **Only our two receiving addresses.** The payment screen shows only the two addresses built into [`content.js`](extension/content.js) (`PAY_TO`), whatever the server sends.
- **Copies can't use our server.** It only answers the official extension (by its ID) and our website.

## What security scanners report, and why

Automatic extension scanners look for code patterns that malware also uses. Each one that appears in FOMO Alerts:

| A scanner may report | What it is here |
|---|---|
| Runs inside the page ("MAIN world"), wraps `fetch` | [`page-hook.js`](extension/page-hook.js) reads answers that Fomo's own page already gets from Fomo's API (`prod-api.fomo.family` only). That's how the extension knows your positions. It never reads request headers or login tokens, and never sends requests of its own. |
| `MutationObserver` that adds UI | Fomo redraws its pages without reloading them. The observer puts the alerts card back under the Buy/Sell box. |
| Network requests | Only [`background.js`](extension/background.js) talks to a server, and only to fomoalerts.family. Nothing runs on a timer. The extension asks when you open a coin, when you come back to the tab, when you use the card, or when the chart's price reaches one of your levels. It checks every few seconds only while you wait for something you started: linking Telegram or Discord, or a payment. |
| Timers | One timer re-sends your alert lines to the chart script on the same page every 4 seconds. Nothing leaves the page. |
| Error reports | When something breaks, a short report goes to fomoalerts.family: what went wrong and where, with no account data. |

The extension never loads or builds code while it runs: no `importScripts`, `eval` or `new Function`. Everything it runs is listed in [`manifest.json`](extension/manifest.json).

## Files

| File | What it does |
|---|---|
| `extension/manifest.json` | Permissions and which scripts run where |
| `extension/page-hook.js` | Reads Fomo's API responses inside the page (exact host only) |
| `extension/chart-bridge.js` | Draws your alert levels on Fomo's charts |
| `extension/content.js` | The alerts card, the settings window, the payment screen |
| `extension/background.js` | The only part that talks to the FOMO Alerts server (its address is at the top) |
| `extension/rules.js` | How it finds Fomo's boxes and data (built in and frozen) |
| `extension/vendor/qrcode.js` | QR code library (MIT license, Kazuhiko Arase) |
| `verify.js` | Compares the Chrome Web Store version with this code |

## Report a problem

- **Security issue:** see [SECURITY.md](SECURITY.md). Please tell us privately first.
- **Anything else:** [Discord](https://discord.gg/RxWRnQNYMx) or support@fomoalerts.family.

## License

© 2026 FOMO Alerts. All rights reserved. You may read this code and run `verify.js`. You may not copy, change, publish or reuse it without written permission. See [LICENSE](LICENSE).

GitHub lets anyone press "Fork" on a public repository, but that gives no permission to use the code anywhere else.

FOMO Alerts is not affiliated with, endorsed by or sponsored by Fomo (fomo.family).

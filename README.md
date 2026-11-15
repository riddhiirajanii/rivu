# RiVu — full-stack couple app

A private two-person app with SQLite persistence, separate accounts, Socket.IO real-time chat,
presence, read receipts, profile pictures, date-based schedules, and an installable PWA shell.
No third-party API keys or paid services are required.

## Requirements
- Node.js 18 or newer
- npm
- Internet for the first `npm install` only (to download open-source packages)

## Run locally
1. Extract the ZIP.
2. Open a terminal in `rivu-fullstack`.
3. Copy `.env.example` to `.env`.
4. Set `RIVU_INVITE_CODE` in `.env` to a long private phrase shared only with Kavya.
5. Run:

   ```bash
   npm install
   npm start
   ```

6. Open http://localhost:3000
7. Create your account. Kavya opens the same address and creates a separate account
   using the same invite code.

The database is created automatically at `data/rivu.sqlite`. Back up the `data/` folder.

## What's included
- **Today schedule:** plans have a date and time. Home shows only today's plans.
  The Daily Plans page has Today, Upcoming, and All Plans views.
- Shared bucket list, travel list, games, question jar, heart dump, scrapbook and doodles.
- Real-time chat and message history.
- Online/offline presence when the other member has an active connection.
- Read receipts: sent messages show Sent until the other member opens the chat, then Read.
- Individual display names and profile photos.
- Installable PWA manifest, app icon, and basic static-shell service worker.
- Responsive layout with a bottom navigation bar on narrow screens.

## Accounts and invite code
Both members register independently with the same invite code. The first account creates
the private RiVu room; subsequent registrations with the same invite code join that room.
Do not share the invite code publicly.

## Phone testing on your Wi-Fi
Find your computer's LAN IP (for example `192.168.1.20`) and open
`http://192.168.1.20:3000` on the phone. Both devices must be on the same Wi-Fi and
your firewall must allow the Node process.

For PWA installation, browsers generally require HTTPS or localhost. On a phone visiting
the computer's plain HTTP LAN address, install prompts may not appear. For local install
testing, use localhost on the same device or wait until HTTPS deployment. On iPhone,
use Safari → Share → Add to Home Screen when served securely.

## Notifications
The app can request browser notification permission from the chat page. This prototype
shows notifications for new messages while the app page is open but not visible.
True background push while the browser is fully closed requires Web Push subscriptions
and VAPID keys (free to generate, but not implemented yet). We can add that after local
testing; no paid messaging provider is needed.

## Deploy later
For remote access, deploy to a Node-compatible host with:
- persistent disk/volume for SQLite
- WebSocket support
- HTTPS

Set `NODE_ENV=production`, `RIVU_INVITE_CODE` to a strong private value, and `DB_PATH`
to a file on persistent storage if needed. Free hosting plans often sleep or have
ephemeral disks; verify their current terms. A small VPS is more predictable but may
cost money. Do not expose the app publicly without HTTPS, backups, rate limiting, and
a security review.

## Privacy and limitations
- Passwords are hashed using Node's built-in scrypt.
- Session tokens are random, stored hashed in SQLite, and sent in HTTP-only cookies.
- Heart-dump entries are shared with both members; the “sensitive” flag is a label,
  not a privacy boundary.
- No password reset/account recovery yet.
- Profile pictures and scrapbook images are stored as data URLs in SQLite; keep files small.
- This is a personal starter app, not a security-audited production service.

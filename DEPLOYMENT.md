# Deployment checklist — intentionally postponed

Before public deployment:
- Test two accounts on two devices and verify live chat, presence and read receipts.
- Confirm the database survives app restart and host redeploy.
- Choose a Node host with persistent disk and Socket.IO/WebSocket support.
- Set HTTPS, `NODE_ENV=production`, a strong private `RIVU_INVITE_CODE`, and persistent `DB_PATH`.
- Add rate limiting, backups/restore testing, logging and monitoring.
- Review privacy and security before adding intimate personal content.

Free hosting tiers can sleep or discard local files. Check current provider limits rather
than assuming SQLite persistence is available.

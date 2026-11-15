# RiVu — Vercel edition

This package adapts the existing RiVu couples app for Vercel's serverless model.

## Architecture

- Static app: `public/`
- API: `api/[[...route]].js`
- Database: Neon PostgreSQL
- Chat and presence: authenticated HTTP polling (about every 3 seconds), rather than a persistent Socket.IO server. This is compatible with serverless functions and provides near-real-time updates.
- Authentication: scrypt password hashes and HTTP-only, Secure/SameSite cookies.

## Deploy to Vercel

1. Create a free/paid PostgreSQL project at https://neon.tech and copy its pooled or direct connection string. It must include SSL.
2. Create a **private** GitHub repository. Upload the contents of this folder (not the outer folder).
3. Import that repository at https://vercel.com/new.
4. In Vercel → Project → Settings → Environment Variables, add:
   - `DATABASE_URL` = your Neon connection string
   - `RIVU_INVITE_CODE` = a long, private invite code known only to the two of you
   - `NODE_ENV` = `production`
5. Deploy. Vercel will serve the `public` directory and route `/api/*` to the serverless API.
6. Open the generated HTTPS URL and create/sign into your RiVu accounts.

Do not put `.env`, database files, passwords, or private invite codes in GitHub. The `.env.example` is only a placeholder.

## Migrate your existing local RiVu data

The migration tool imports your existing SQLite room, users, sessions, bucket-list items, schedule, scrapbook, and messages into Neon.

1. Keep a backup of your original `rivu-fullstack/data` folder.
2. Copy the entire original `data` folder (including any `-wal` / `-shm` files if present) into this project folder.
3. In this project folder, create a local `.env` file containing:
   ```
   DATABASE_URL=your_neon_connection_string
   RIVU_INVITE_CODE=your_new_private_invite_code
   NODE_ENV=production
   ```
4. Run `npm install` locally (this installs the migration-only SQLite dependency too).
5. Run `npm run migrate:sqlite`.
6. After the migration reports completion, delete the local `.env` before committing or uploading anything. Do not delete your original SQLite backup until you have checked the deployed app.

The migration is safe to re-run for the same records (it skips existing IDs). Existing passwords are imported as password hashes; you can sign in using your previous usernames and passwords. Old browser sessions may not carry over, so sign in again.

## Notes and limitations

- Chat messages and presence update by polling, usually within a few seconds; this is not a persistent WebSocket connection.
- The app uses one private RiVu room. Both people register with the same invite code.
- The “sensitive” label in Heart Dump is not a separate privacy boundary; entries remain shared with the room.
- Profile and scrapbook images are stored in PostgreSQL as data URLs. Keep images small.
- Keep your Neon database credentials and invite code private. Back up Neon data before making schema changes.

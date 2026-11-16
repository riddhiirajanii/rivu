const crypto = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const webpush = require("web-push");

const sql = neon(process.env.DATABASE_URL);
const DAY = 86400000;
const now = () => new Date().toISOString();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clean = (s, n = 2000) =>
  typeof s === "string" ? s.trim().slice(0, n) : "";

const validType = t => [
  "bucket",
  "schedule",
  "travel",
  "games",
  "questions",
  "feelings",
  "scrapbook",
  "draw"
].includes(t);

async function init() {
  await sql`
    CREATE TABLE IF NOT EXISTS rooms (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id),
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      avatar TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS items_room_type
    ON items(room_id, type, id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS messages_room_id
    ON messages(room_id, id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS presence (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      last_seen BIGINT NOT NULL
    )
  `;

  // Web Push subscriptions.
  await sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS push_subscriptions_room_user
    ON push_subscriptions(room_id, user_id)
  `;
}

let initPromise;

const ensureDb = () => initPromise ||= init();

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => {
        const i = v.indexOf("=");
        return [
          v.slice(0, i),
          decodeURIComponent(v.slice(i + 1))
        ];
      })
  );
}

function setCookie(res, token, clear = false) {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    clear
      ? `rivu_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
      : `rivu_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`
  );
}

async function getUser(req) {
  const token = cookies(req).rivu_session;

  if (!token) return null;

  const rows = await sql`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash(token)}
      AND s.expires_at > ${Date.now()}
    LIMIT 1
  `;

  return rows[0] || null;
}

const safeUser = u => ({
  id: Number(u.id),
  name: u.name,
  username: u.username
});

async function issueSession(user, res) {
  const token = crypto.randomBytes(32).toString("hex");

  await sql`
    INSERT INTO sessions(token_hash, user_id, expires_at)
    VALUES(
      ${hash(token)},
      ${user.id},
      ${Date.now() + 30 * DAY}
    )
  `;

  setCookie(res, token);
}

function body(req) {
  return req.body && typeof req.body === "object"
    ? req.body
    : {};
}


// Send a push notification to the other users in the same room.
async function sendPushToRoom(
  roomId,
  senderId,
  senderName,
  messageText
) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) return;

  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:admin@rivu.app",
      publicKey,
      privateKey
    );

    const subscriptions = await sql`
      SELECT endpoint, subscription
      FROM push_subscriptions
      WHERE room_id = ${roomId}
        AND user_id <> ${senderId}
    `;

    await Promise.all(
      subscriptions.map(async row => {
        try {
          const subscription =
            typeof row.subscription === "string"
              ? JSON.parse(row.subscription)
              : row.subscription;

          await webpush.sendNotification(
            subscription,
            JSON.stringify({
              title: `A message from ${senderName} ♡`,
              body: String(messageText).slice(0, 180),
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              tag: "rivu-message",
              url: "/?open=chat"
            })
          );
        } catch (error) {
          const status = error.statusCode || error.status;

          // Remove expired subscriptions.
          if (status === 404 || status === 410) {
            await sql`
              DELETE FROM push_subscriptions
              WHERE endpoint = ${row.endpoint}
            `;
          } else {
            console.error("RiVu push delivery error:", error);
          }
        }
      })
    );
  } catch (error) {
    // Push failure must not stop a message from being saved.
    console.error("RiVu push setup/delivery error:", error);
  }
}


module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  try {
    await ensureDb();

    const pathname = new URL(
      req.url,
      "https://rivu.invalid"
    ).pathname
      .replace(/^\/api\/?/, "")
      .replace(/\/$/, "");

    const b = body(req);

    // REGISTER
    if (req.method === "POST" && pathname === "register") {
      const name = clean(b.name, 50);
      const username = clean(b.username, 30).toLowerCase();
      const password = String(b.password || "");
      const invite = String(b.inviteCode || "");

      if (!process.env.RIVU_INVITE_CODE) {
        return res.status(500).json({
          error: "The RiVu invite code is not configured on the host."
        });
      }

      if (invite !== process.env.RIVU_INVITE_CODE) {
        return res.status(403).json({
          error: "That invite code is not correct."
        });
      }

      if (
        !name ||
        !/^[a-z0-9_.-]{3,30}$/.test(username) ||
        password.length < 10
      ) {
        return res.status(400).json({
          error: "Use a name, a username (3–30 letters/numbers), and a password of at least 10 characters."
        });
      }

      let rooms = await sql`
        SELECT * FROM rooms ORDER BY id LIMIT 1
      `;

      let room = rooms[0];

      if (!room) {
        [room] = await sql`
          INSERT INTO rooms(name, created_at)
          VALUES('RiVu ♡', ${now()})
          RETURNING *
        `;
      }

      const salt = crypto.randomBytes(16).toString("hex");

      const passwordHash =
        crypto.scryptSync(password, salt, 64).toString("hex") +
        ":" +
        salt;

      let user;

      try {
        [user] = await sql`
          INSERT INTO users(
            room_id,
            name,
            username,
            password_hash,
            created_at
          )
          VALUES(
            ${room.id},
            ${name},
            ${username},
            ${passwordHash},
            ${now()}
          )
          RETURNING *
        `;
      } catch (e) {
        if (String(e.message).toLowerCase().includes("unique")) {
          return res.status(409).json({
            error: "That username is already taken."
          });
        }

        throw e;
      }

      await issueSession(user, res);

      return res.json({
        user: safeUser(user)
      });
    }


    // LOGIN
    if (req.method === "POST" && pathname === "login") {
      const username = clean(b.username, 30).toLowerCase();
      const password = String(b.password || "");

      const rows = await sql`
        SELECT *
        FROM users
        WHERE username = ${username}
        LIMIT 1
      `;

      const user = rows[0];

      if (!user) {
        return res.status(401).json({
          error: "Username or password is incorrect."
        });
      }

      const [stored, salt] = user.password_hash.split(":");

      const candidate = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

      if (
        !crypto.timingSafeEqual(
          Buffer.from(stored, "hex"),
          Buffer.from(candidate, "hex")
        )
      ) {
        return res.status(401).json({
          error: "Username or password is incorrect."
        });
      }

      await issueSession(user, res);

      return res.json({
        user: safeUser(user)
      });
    }


    // LOGOUT
    if (req.method === "POST" && pathname === "logout") {
      const token = cookies(req).rivu_session;

      if (token) {
        await sql`
          DELETE FROM sessions
          WHERE token_hash = ${hash(token)}
        `;
      }

      setCookie(res, "", true);

      return res.json({ ok: true });
    }


    // All routes below this point require login.
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Please sign in again."
      });
    }


    // GET VAPID PUBLIC KEY
    if (
      req.method === "GET" &&
      pathname === "push/public-key"
    ) {
      const enabled = Boolean(
        process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY
      );

      return res.json({
        enabled,
        publicKey: enabled
          ? process.env.VAPID_PUBLIC_KEY
          : null
      });
    }


    // SAVE PUSH SUBSCRIPTION
    if (
      req.method === "POST" &&
      pathname === "push/subscribe"
    ) {
      const subscription = b.subscription;

      if (
        !subscription ||
        typeof subscription !== "object" ||
        typeof subscription.endpoint !== "string" ||
        !subscription.endpoint.startsWith("https://") ||
        !subscription.keys?.p256dh ||
        !subscription.keys?.auth
      ) {
        return res.status(400).json({
          error: "Invalid push subscription."
        });
      }

      const encoded = JSON.stringify(subscription);

      await sql`
        INSERT INTO push_subscriptions(
          user_id,
          room_id,
          endpoint,
          subscription,
          created_at,
          updated_at
        )
        VALUES(
          ${user.id},
          ${user.room_id},
          ${subscription.endpoint},
          ${encoded}::jsonb,
          ${now()},
          ${now()}
        )
        ON CONFLICT(endpoint)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          room_id = EXCLUDED.room_id,
          subscription = EXCLUDED.subscription,
          updated_at = EXCLUDED.updated_at
      `;

      return res.json({ ok: true });
    }


    // REMOVE PUSH SUBSCRIPTION
    if (
      req.method === "POST" &&
      pathname === "push/unsubscribe"
    ) {
      const endpoint = clean(b.endpoint, 3000);

      if (endpoint) {
        await sql`
          DELETE FROM push_subscriptions
          WHERE user_id = ${user.id}
            AND endpoint = ${endpoint}
        `;
      }

      return res.json({ ok: true });
    }


    // CURRENT USER
    if (req.method === "GET" && pathname === "me") {
      return res.json({
        user: safeUser(user)
      });
    }


    // PROFILE
    if (req.method === "GET" && pathname === "profile") {
      const members = await sql`
        SELECT id, name, username, avatar
        FROM users
        WHERE room_id = ${user.room_id}
        ORDER BY id
      `;

      return res.json({
        user: {
          ...safeUser(user),
          avatar: user.avatar || null
        },
        members: members.map(m => ({
          ...m,
          id: Number(m.id)
        }))
      });
    }


    // UPDATE PROFILE
    if (
      req.method === "PATCH" &&
      pathname === "profile"
    ) {
      const name = clean(b.name, 50);

      const avatar = b.avatar === null
        ? null
        : clean(b.avatar, 500000);

      if (!name) {
        return res.status(400).json({
          error: "Please enter a display name."
        });
      }

      if (
        avatar &&
        !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)
      ) {
        return res.status(400).json({
          error: "Please use a PNG, JPG, WEBP, or GIF image."
        });
      }

      if (avatar && avatar.length > 450000) {
        return res.status(413).json({
          error: "Please use a smaller profile picture (about 300 KB or less)."
        });
      }

      const [updated] = await sql`
        UPDATE users
        SET name = ${name}, avatar = ${avatar}
        WHERE id = ${user.id}
        RETURNING *
      `;

      return res.json({
        user: {
          ...safeUser(updated),
          avatar: updated.avatar || null
        }
      });
    }


    // GET ITEMS
    if (
      req.method === "GET" &&
      pathname === "items"
    ) {
      const type = String(
        new URL(req.url, "https://rivu.invalid")
          .searchParams.get("type") || ""
      );

      if (!validType(type)) {
        return res.status(400).json({
          error: "Unknown section."
        });
      }

      const rows = await sql`
        SELECT
          i.id,
          i.type,
          i.payload,
          i.created_at,
          i.updated_at,
          u.name AS author
        FROM items i
        JOIN users u ON u.id = i.user_id
        WHERE i.room_id = ${user.room_id}
          AND i.type = ${type}
        ORDER BY i.id DESC
      `;

      return res.json({
        items: rows.map(r => ({
          id: Number(r.id),
          type: r.type,
          ...(typeof r.payload === "string"
            ? JSON.parse(r.payload)
            : r.payload),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          author: r.author
        }))
      });
    }


    // CREATE ITEM
    if (
      req.method === "POST" &&
      pathname === "items"
    ) {
      const type = String(b.type || "");
      const payload = b.payload;

      if (
        !validType(type) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        return res.status(400).json({
          error: "Invalid item."
        });
      }

      const encoded = JSON.stringify(payload);


      const t = now();

      const [row] = await sql`
        INSERT INTO items(
          room_id,
          user_id,
          type,
          payload,
          created_at,
          updated_at
        )
        VALUES(
          ${user.room_id},
          ${user.id},
          ${type},
          ${encoded}::jsonb,
          ${t},
          ${t}
        )
        RETURNING id
      `;

      return res.status(201).json({
        item: {
          id: Number(row.id),
          type,
          ...payload,
          createdAt: t,
          updatedAt: t,
          author: user.name
        }
      });
    }


    // UPDATE OR DELETE ITEM
    const itemMatch = pathname.match(/^items\/(\d+)$/);

    if (
      itemMatch &&
      req.method === "PATCH"
    ) {
      const id = Number(itemMatch[1]);

      const rows = await sql`
        SELECT *
        FROM items
        WHERE id = ${id}
          AND room_id = ${user.room_id}
        LIMIT 1
      `;

      const row = rows[0];

      if (!row) {
        return res.status(404).json({
          error: "Entry not found."
        });
      }

      const payload = b.payload;

      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        return res.status(400).json({
          error: "Invalid update."
        });
      }

      const old = typeof row.payload === "string"
        ? JSON.parse(row.payload)
        : row.payload;

      const merged = {
        ...old,
        ...payload
      };

      const encoded = JSON.stringify(merged);


      const t = now();

      await sql`
        UPDATE items
        SET payload = ${encoded}::jsonb,
            updated_at = ${t}
        WHERE id = ${id}
      `;

      return res.json({
        item: {
          id,
          type: row.type,
          ...merged,
          updatedAt: t
        }
      });
    }

    if (
      itemMatch &&
      req.method === "DELETE"
    ) {
      const id = Number(itemMatch[1]);

      const result = await sql`
        DELETE FROM items
        WHERE id = ${id}
          AND room_id = ${user.room_id}
        RETURNING id
      `;

      if (!result.length) {
        return res.status(404).json({
          error: "Entry not found."
        });
      }

      return res.json({ ok: true });
    }


    // GET MESSAGES
    if (
      req.method === "GET" &&
      pathname === "messages"
    ) {
      const rows = await sql`
        SELECT
          m.id,
          m.text,
          m.created_at,
          m.read_at,
          u.id AS user_id,
          u.name
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ${user.room_id}
        ORDER BY m.id DESC
        LIMIT 100
      `;

      return res.json({
        messages: rows.reverse().map(m => ({
          id: Number(m.id),
          text: m.text,
          userId: Number(m.user_id),
          name: m.name,
          createdAt: m.created_at,
          readAt: m.read_at
        }))
      });
    }


    // REALTIME POLLING
    if (
      pathname === "realtime" &&
      req.method === "GET"
    ) {
      await sql`
        INSERT INTO presence(user_id, room_id, last_seen)
        VALUES(
          ${user.id},
          ${user.room_id},
          ${Date.now()}
        )
        ON CONFLICT(user_id)
        DO UPDATE SET
          last_seen = EXCLUDED.last_seen,
          room_id = EXCLUDED.room_id
      `;

      const url = new URL(req.url, "https://rivu.invalid");

      const after = Number(
        url.searchParams.get("after") || 0
      );

      const initial =
        url.searchParams.get("initial") === "1";

      const members = await sql`
        SELECT
          u.id,
          u.name,
          u.username,
          u.avatar,
          p.last_seen
        FROM users u
        LEFT JOIN presence p ON p.user_id = u.id
        WHERE u.room_id = ${user.room_id}
        ORDER BY u.id
      `;

      let rows = [];

      if (!initial) {
        rows = await sql`
          SELECT
            m.id,
            m.text,
            m.created_at,
            m.read_at,
            u.id AS user_id,
            u.name
          FROM messages m
          JOIN users u ON u.id = m.user_id
          WHERE m.room_id = ${user.room_id}
            AND m.id > ${after}
          ORDER BY m.id ASC
          LIMIT 100
        `;
      }

      const unread = await sql`
        SELECT id, read_at
        FROM messages
        WHERE room_id = ${user.room_id}
          AND user_id = ${user.id}
          AND read_at IS NOT NULL
          AND id > ${Math.max(0, after - 100)}
      `;

      const maxRows = await sql`
        SELECT COALESCE(MAX(id), 0) AS max_id
        FROM messages
        WHERE room_id = ${user.room_id}
      `;

      return res.json({
        messages: rows.map(m => ({
          id: Number(m.id),
          text: m.text,
          userId: Number(m.user_id),
          name: m.name,
          createdAt: m.created_at,
          readAt: m.read_at
        })),

        members: members.map(m => ({
          id: Number(m.id),
          name: m.name,
          username: m.username,
          avatar: m.avatar || null,
          online: Date.now() - Number(m.last_seen || 0) < 15000
        })),

        readReceipts: unread.map(m => ({
          id: Number(m.id),
          readAt: m.read_at
        })),

        maxId: Number(maxRows[0].max_id)
      });
    }


    // MARK MESSAGES AS READ
    if (
      pathname === "realtime/read" &&
      req.method === "POST"
    ) {
      const t = now();

      const changed = await sql`
        UPDATE messages
        SET read_at = ${t}
        WHERE room_id = ${user.room_id}
          AND user_id <> ${user.id}
          AND read_at IS NULL
        RETURNING id
      `;

      return res.json({
        ids: changed.map(x => Number(x.id)),
        readAt: t
      });
    }


    // SEND MESSAGE + WEB PUSH
    if (
      pathname === "realtime/send" &&
      req.method === "POST"
    ) {
      const text = clean(b.text, 2000);

      if (!text) {
        return res.status(400).json({
          error: "Message is empty."
        });
      }

      const t = now();

      const [row] = await sql`
        INSERT INTO messages(
          room_id,
          user_id,
          text,
          created_at
        )
        VALUES(
          ${user.room_id},
          ${user.id},
          ${text},
          ${t}
        )
        RETURNING id
      `;

      await sendPushToRoom(
        user.room_id,
        user.id,
        user.name,
        text
      );

      return res.json({
        id: Number(row.id),
        text,
        userId: Number(user.id),
        name: user.name,
        createdAt: t,
        readAt: null
      });
    }


    return res.status(404).json({
      error: "Not found."
    });

  } catch (e) {
    console.error("RiVu API error:", e);

    return res.status(500).json({
      error: "RiVu server error. Check the Vercel function logs and database configuration."
    });
  }
};
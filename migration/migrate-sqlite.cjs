
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { neon } = require("@neondatabase/serverless");

const sqlitePath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "rivu.sqlite");
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in .env before migrating.");
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);

const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const sql = neon(process.env.DATABASE_URL);

async function main() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS rooms (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, avatar TEXT)`,
    `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS items (id BIGSERIAL PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id), type TEXT NOT NULL, payload JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS items_room_type ON items(room_id,type,id)`,
    `CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room_id,id)`,
    `CREATE TABLE IF NOT EXISTS presence (user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, last_seen BIGINT NOT NULL)`
  ];
  for (const q of ddl) await sql.query(q);

  const tables = ["rooms","users","sessions","items","messages"];
  for (const table of tables) {
    const rows = source.prepare(`SELECT * FROM ${table}`).all();
    let count=0;
    for (const row of rows) {
      if (table==="rooms") await sql`INSERT INTO rooms(id,name,created_at) VALUES(${row.id},${row.name},${row.created_at}) ON CONFLICT(id) DO NOTHING`;
      if (table==="users") await sql`INSERT INTO users(id,room_id,name,username,password_hash,created_at,avatar) VALUES(${row.id},${row.room_id},${row.name},${row.username},${row.password_hash},${row.created_at},${row.avatar||null}) ON CONFLICT(id) DO NOTHING`;
      if (table==="sessions") await sql`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${row.token_hash},${row.user_id},${row.expires_at}) ON CONFLICT(token_hash) DO NOTHING`;
      if (table==="items") {
        const payload = typeof row.payload==="string" ? row.payload : JSON.stringify(row.payload);
        await sql`INSERT INTO items(id,room_id,user_id,type,payload,created_at,updated_at) VALUES(${row.id},${row.room_id},${row.user_id},${row.type},${payload}::jsonb,${row.created_at},${row.updated_at}) ON CONFLICT(id) DO NOTHING`;
      }
      if (table==="messages") await sql`INSERT INTO messages(id,room_id,user_id,text,created_at,read_at) VALUES(${row.id},${row.room_id},${row.user_id},${row.text},${row.created_at},${row.read_at||null}) ON CONFLICT(id) DO NOTHING`;
      count++;
    }
    console.log(`Imported ${count} ${table}.`);
  }
  for (const table of ["rooms","users","items","messages"]) {
    await sql.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),1),1), true)`);
  }
  console.log("RiVu database migration complete. Keep your original SQLite folder as a backup.");
}
main().catch(err=>{console.error(err);process.exitCode=1}).finally(()=>source.close());

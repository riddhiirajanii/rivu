require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const INVITE_CODE = process.env.RIVU_INVITE_CODE || "change-this-invite-code";
const SESSION_DAYS = 30;
const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "rivu.sqlite");
require("fs").mkdirSync(path.dirname(dbPath), {recursive:true});


const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS items_room_type ON items(room_id,type,id);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room_id,id);
CREATE TABLE IF NOT EXISTS message_reads(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, read_at TEXT NOT NULL, PRIMARY KEY(message_id,user_id));
`);
// Lightweight migration for databases created by earlier RiVu versions.
try { db.exec("ALTER TABLE messages ADD COLUMN read_at TEXT"); } catch (e) { if (!String(e.message).includes("duplicate column")) throw e; }
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT"); } catch (e) { if (!String(e.message).includes("duplicate column")) throw e; }
const now = () => new Date().toISOString();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const safeUser = u => ({id:u.id,name:u.name,username:u.username});
const cookieOptions = {httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:SESSION_DAYS*86400000};
app.disable("x-powered-by");
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:false}));
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","same-origin");next();});
app.use(express.static(path.join(__dirname,"public")));

function getUserFromToken(token) {
  if(!token) return null;
  const row=db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token),Date.now());
  return row || null;
}
function auth(req,res,next) {
  const token=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("rivu_session="))?.slice("rivu_session=".length);
  const user=getUserFromToken(token);
  if(!user) return res.status(401).json({error:"Please sign in again."});
  req.user=user; next();
}
function issueSession(user,res) {
  const token=crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash(token),user.id,Date.now()+SESSION_DAYS*86400000);
  res.cookie("rivu_session",token,cookieOptions);
}
function cleanText(s,max=2000) {
  if(typeof s!=="string") return "";
  return s.trim().slice(0,max);
}
function validType(t) {
  return ["bucket","schedule","travel","games","questions","feelings","scrapbook","draw"].includes(t);
}

app.post("/api/register",(req,res)=>{
  const name=cleanText(req.body.name,50), username=cleanText(req.body.username,30).toLowerCase();
  const password=String(req.body.password||""), invite=String(req.body.inviteCode||"");
  if(invite!==INVITE_CODE) return res.status(403).json({error:"That invite code is not correct."});
  if(name.length<1 || !/^[a-z0-9_.-]{3,30}$/.test(username) || password.length<10)
    return res.status(400).json({error:"Use a name, a username (3–30 letters/numbers), and a password of at least 10 characters."});
  try {
    let room=db.prepare("SELECT * FROM rooms ORDER BY id LIMIT 1").get();
    if(!room){const result=db.prepare("INSERT INTO rooms(name,created_at) VALUES(?,?)").run("RiVu ♡",now());room=db.prepare("SELECT * FROM rooms WHERE id=?").get(result.lastInsertRowid);}
    const salt=crypto.randomBytes(16).toString("hex");
    const passwordHash=crypto.scryptSync(password,salt,64).toString("hex")+":"+salt;
    const result=db.prepare("INSERT INTO users(room_id,name,username,password_hash,created_at) VALUES(?,?,?,?,?)").run(room.id,name,username,passwordHash,now());
    const user=db.prepare("SELECT * FROM users WHERE id=?").get(result.lastInsertRowid);
    issueSession(user,res);res.json({user:safeUser(user)});
  } catch(e) {
    if(String(e.message).includes("UNIQUE")) return res.status(409).json({error:"That username is already taken."});
    console.error(e);res.status(500).json({error:"Could not create account."});
  }
});
app.post("/api/login",(req,res)=>{
  const username=cleanText(req.body.username,30).toLowerCase(), password=String(req.body.password||"");
  const user=db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if(!user) return res.status(401).json({error:"Username or password is incorrect."});
  const [stored,salt]=user.password_hash.split(":");
  const candidate=crypto.scryptSync(password,salt,64).toString("hex");
  if(!crypto.timingSafeEqual(Buffer.from(stored,"hex"),Buffer.from(candidate,"hex"))) return res.status(401).json({error:"Username or password is incorrect."});
  issueSession(user,res);res.json({user:safeUser(user)});
});
app.post("/api/logout",auth,(req,res)=>{
  const token=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("rivu_session="))?.slice("rivu_session=".length);
  if(token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
  res.clearCookie("rivu_session",{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/"});
  res.json({ok:true});
});
app.get("/api/me",auth,(req,res)=>res.json({user:safeUser(req.user)}));
app.get("/api/profile",auth,(req,res)=>{
  const members=db.prepare("SELECT id,name,username,avatar FROM users WHERE room_id=? ORDER BY id").all(req.user.room_id);
  res.json({user:{...safeUser(req.user),avatar:req.user.avatar||null},members});
});
app.patch("/api/profile",auth,(req,res)=>{
  const name=cleanText(req.body.name,50);
  const avatar=req.body.avatar===null?null:cleanText(req.body.avatar,500000);
  if(!name) return res.status(400).json({error:"Please enter a display name."});
  if(avatar && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) return res.status(400).json({error:"Please use a PNG, JPG, WEBP, or GIF image."});
  
  db.prepare("UPDATE users SET name=?,avatar=? WHERE id=?").run(name,avatar,req.user.id);
  const updated=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  io.to("room:"+req.user.room_id).emit("profile:updated",{id:updated.id,name:updated.name,avatar:updated.avatar});
  res.json({user:{...safeUser(updated),avatar:updated.avatar||null}});
});
app.get("/api/items",auth,(req,res)=>{
  const type=String(req.query.type||"");
  if(!validType(type)) return res.status(400).json({error:"Unknown section."});
  const rows=db.prepare("SELECT i.id,i.type,i.payload,i.created_at,i.updated_at,u.name AS author FROM items i JOIN users u ON u.id=i.user_id WHERE i.room_id=? AND i.type=? ORDER BY i.id DESC").all(req.user.room_id,type);
  res.json({items:rows.map(r=>({id:r.id,type:r.type,...JSON.parse(r.payload),createdAt:r.created_at,updatedAt:r.updated_at,author:r.author}))});
});
app.post("/api/items",auth,(req,res)=>{
  const type=String(req.body.type||"");const payload=req.body.payload;
  if(!validType(type)||!payload||typeof payload!=="object"||Array.isArray(payload)) return res.status(400).json({error:"Invalid item."});
  const encoded=JSON.stringify(payload);
  
  const t=now();const result=db.prepare("INSERT INTO items(room_id,user_id,type,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(req.user.room_id,req.user.id,type,encoded,t,t);
  const item={id:result.lastInsertRowid,type,...payload,createdAt:t,updatedAt:t,author:req.user.name};
  io.to("room:"+req.user.room_id).emit("item:created",item);
  res.status(201).json({item});
});
app.patch("/api/items/:id",auth,(req,res)=>{
  const id=Number(req.params.id), row=db.prepare("SELECT * FROM items WHERE id=? AND room_id=?").get(id,req.user.room_id);
  if(!row) return res.status(404).json({error:"Entry not found."});
  const payload=req.body.payload;
  if(!payload||typeof payload!=="object"||Array.isArray(payload)) return res.status(400).json({error:"Invalid update."});
  const merged={...JSON.parse(row.payload),...payload};const encoded=JSON.stringify(merged);
  db.prepare("UPDATE items SET payload=?,updated_at=? WHERE id=?").run(encoded,now(),id);
  const item={id,type:row.type,...merged,updatedAt:now()};
  io.to("room:"+req.user.room_id).emit("item:updated",item);res.json({item});
});
app.delete("/api/items/:id",auth,(req,res)=>{
  const id=Number(req.params.id);const result=db.prepare("DELETE FROM items WHERE id=? AND room_id=?").run(id,req.user.room_id);
  if(!result.changes) return res.status(404).json({error:"Entry not found."});
  io.to("room:"+req.user.room_id).emit("item:deleted",{id});res.json({ok:true});
});
app.get("/api/messages",auth,(req,res)=>{
  const rows=db.prepare("SELECT m.id,m.text,m.created_at,m.read_at,u.id AS user_id,u.name FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 100").all(req.user.room_id);
  res.json({messages:rows.reverse().map(m=>({id:m.id,text:m.text,userId:m.user_id,name:m.name,createdAt:m.created_at,readAt:m.read_at}))});
});

io.use((socket,next)=>{
  const cookie=socket.handshake.headers.cookie||"";
  const token=cookie.split(";").map(x=>x.trim()).find(x=>x.startsWith("rivu_session="))?.slice("rivu_session=".length);
  const user=getUserFromToken(token);
  if(!user) return next(new Error("Unauthorized"));
  socket.user=user;next();
});
const onlineByRoom = new Map();
io.on("connection",socket=>{
  const room="room:"+socket.user.room_id;socket.join(room);
  if(!onlineByRoom.has(room)) onlineByRoom.set(room,new Set());
  const online=onlineByRoom.get(room);online.add(socket.user.id);
  io.to(room).emit("presence:update",{userId:socket.user.id,online:true});
  socket.emit("presence:snapshot",{userIds:[...online]});
  socket.emit("chat:ready",{user:safeUser(socket.user)});
  socket.on("chat:read",()=>{
    const unread=db.prepare("SELECT id FROM messages WHERE room_id=? AND user_id<>? AND read_at IS NULL").all(socket.user.room_id,socket.user.id);
    if(unread.length){
      const t=now();
      const mark=db.prepare("UPDATE messages SET read_at=? WHERE room_id=? AND user_id<>? AND read_at IS NULL");
      mark.run(t,socket.user.room_id,socket.user.id);
      io.to(room).emit("chat:read-receipt",{readerId:socket.user.id,readAt:t,ids:unread.map(x=>x.id)});
    }
  });
  socket.on("chat:send",(raw,ack)=>{
    const text=cleanText(raw,2000);
    if(!text){if(typeof ack==="function")ack({error:"Message is empty."});return;}
    const created=now();const result=db.prepare("INSERT INTO messages(room_id,user_id,text,created_at) VALUES(?,?,?,?)").run(socket.user.room_id,socket.user.id,text,created);
    const message={id:result.lastInsertRowid,text,userId:socket.user.id,name:socket.user.name,createdAt:created,readAt:null};
    io.to(room).emit("chat:message",message);
    if(typeof ack==="function")ack({ok:true,id:message.id});
  });
  socket.on("disconnect",()=>{
    const stillHere=[...io.sockets.sockets.values()].some(s=>s.user?.id===socket.user.id);
    if(!stillHere){online.delete(socket.user.id);io.to(room).emit("presence:update",{userId:socket.user.id,online:false});}
  });
});
setInterval(()=>db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now()),60*60*1000).unref();
server.listen(PORT,()=>console.log(`RiVu is running at http://localhost:${PORT}`));

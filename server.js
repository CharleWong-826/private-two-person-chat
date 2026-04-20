const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8088);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "chat.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const CONFIG = {
  trustProxy: process.env.TRUST_PROXY === "1",
  initialRoomCode: process.env.CHAT_ROOM_CODE || "my-private-room",
  users: [
    {
      username: process.env.CHAT_USER1_NAME || "me",
      passcode: process.env.CHAT_USER1_PASS || "111111"
    },
    {
      username: process.env.CHAT_USER2_NAME || "friend",
      passcode: process.env.CHAT_USER2_PASS || "222222"
    }
  ]
};

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initialUsers = CONFIG.users.map(user => ({
      username: user.username,
      passcode: user.passcode
    }));
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({
        settings: {
          roomCode: CONFIG.initialRoomCode,
          ownerUsername: initialUsers[0].username,
          users: initialUsers
        },
        messages: [],
        sessions: {}
      }, null, 2),
      "utf8"
    );
  }
}

function loadDb() {
  ensureDataFile();
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (!db.settings) {
    db.settings = {
      roomCode: CONFIG.initialRoomCode,
      ownerUsername: CONFIG.users[0].username,
      users: CONFIG.users.map(user => ({
        username: user.username,
        passcode: user.passcode
      }))
    };
    saveDb(db);
  }
  if (!db.messages) {
    db.messages = [];
  }
  if (!db.sessions) {
    db.sessions = {};
  }
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function generateSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function authenticate(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.chat_session;
  if (!sessionId) {
    return null;
  }

  const db = loadDb();
  const session = db.sessions[sessionId];
  if (!session) {
    return null;
  }

  const allowedUser = db.settings.users.find(user => user.username === session.username);
  if (!allowedUser) {
    return null;
  }

  return {
    sessionId,
    username: session.username,
    isOwner: db.settings.ownerUsername === session.username
  };
}

function isSecureRequest(req) {
  if (req.socket.encrypted) {
    return true;
  }
  if (CONFIG.trustProxy) {
    return (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  }
  return false;
}

function applyDefaultHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

function broadcast(clients, payload) {
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(serialized);
  }
}

const sseClients = new Set();

function sanitizeMessage(text) {
  return String(text || "").replace(/\r/g, "").trim().slice(0, 2000);
}

function getSettingsView(db) {
  return {
    roomCode: db.settings.roomCode,
    ownerUsername: db.settings.ownerUsername,
    users: db.settings.users.map(user => ({
      username: user.username
    }))
  };
}

function listMessagesForUser(db, username) {
  return db.messages
    .filter(message => !message.destroyedFor || !message.destroyedFor.includes(username))
    .slice(-200);
}

function removeMessageFromUser(db, messageId, username) {
  const message = db.messages.find(item => item.id === messageId);
  if (!message) {
    return null;
  }
  const hiddenFor = new Set(message.destroyedFor || []);
  hiddenFor.add(username);
  message.destroyedFor = Array.from(hiddenFor);
  const userCount = db.settings.users.length;
  if (message.destroyedFor.length >= userCount) {
    db.messages = db.messages.filter(item => item.id !== messageId);
  }
  return message;
}

function requireOwner(auth, res) {
  if (!auth || !auth.isOwner) {
    sendJson(res, 403, { error: "Only the owner can do this" });
    return false;
  }
  return true;
}

function handleLogin(req, res, bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const roomCode = String(payload.roomCode || "").trim();
  const username = String(payload.username || "").trim();
  const passcode = String(payload.passcode || "").trim();

  const db = loadDb();

  if (roomCode !== db.settings.roomCode) {
    return sendJson(res, 403, { error: "Wrong room code" });
  }

  const user = db.settings.users.find(item => item.username === username && item.passcode === passcode);
  if (!user) {
    return sendJson(res, 403, { error: "Wrong username or passcode" });
  }

  const sessionId = generateSessionId();
  db.sessions[sessionId] = {
    username,
    createdAt: new Date().toISOString()
  };
  saveDb(db);

  const cookieParts = [
    `chat_session=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax"
  ];
  if (isSecureRequest(req)) {
    cookieParts.push("Secure");
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": cookieParts.join("; "),
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({ ok: true, username }));
}

function handleMe(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { authenticated: false });
  }
  const db = loadDb();
  return sendJson(res, 200, {
    authenticated: true,
    username: auth.username,
    isOwner: auth.isOwner,
    settings: getSettingsView(db)
  });
}

function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const db = loadDb();
  if (cookies.chat_session && db.sessions[cookies.chat_session]) {
    delete db.sessions[cookies.chat_session];
    saveDb(db);
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "chat_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleMessages(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }
  const db = loadDb();
  return sendJson(res, 200, {
    messages: listMessagesForUser(db, auth.username),
    username: auth.username,
    isOwner: auth.isOwner,
    settings: getSettingsView(db)
  });
}

async function handleSend(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(await collectRequestBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const text = sanitizeMessage(payload.text);
  if (!text) {
    return sendJson(res, 400, { error: "Message cannot be empty" });
  }
  const selfDestruct = Boolean(payload.selfDestruct);

  const db = loadDb();
  const message = {
    id: crypto.randomUUID(),
    sender: auth.username,
    text,
    sentAt: new Date().toISOString(),
    selfDestruct,
    destroyedFor: []
  };
  db.messages.push(message);
  db.messages = db.messages.slice(-500);
  saveDb(db);

  broadcast(sseClients, { type: "message", message });
  return sendJson(res, 200, { ok: true, message });
}

async function handleEphemeralRead(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(await collectRequestBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const messageId = String(payload.messageId || "").trim();
  if (!messageId) {
    return sendJson(res, 400, { error: "Missing message id" });
  }

  const db = loadDb();
  const message = db.messages.find(item => item.id === messageId);
  if (!message) {
    return sendJson(res, 200, { ok: true, alreadyGone: true });
  }
  if (!message.selfDestruct) {
    return sendJson(res, 200, { ok: true, ignored: true });
  }
  if (message.sender === auth.username) {
    return sendJson(res, 200, { ok: true, ignored: true });
  }

  removeMessageFromUser(db, messageId, auth.username);
  removeMessageFromUser(db, messageId, message.sender);
  saveDb(db);

  broadcast(sseClients, {
    type: "message_deleted",
    messageId
  });
  return sendJson(res, 200, { ok: true });
}

function handleAdminState(req, res) {
  const auth = authenticate(req);
  if (!requireOwner(auth, res)) {
    return;
  }
  const db = loadDb();
  return sendJson(res, 200, {
    ok: true,
    settings: getSettingsView(db)
  });
}

async function handleAdminUpdate(req, res) {
  const auth = authenticate(req);
  if (!requireOwner(auth, res)) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await collectRequestBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const roomCode = String(payload.roomCode || "").trim();
  const user1Pass = String(payload.user1Pass || "").trim();
  const user2Pass = String(payload.user2Pass || "").trim();

  if (roomCode.length < 6) {
    return sendJson(res, 400, { error: "Room code must be at least 6 characters" });
  }
  if (user1Pass.length < 6 || user2Pass.length < 6) {
    return sendJson(res, 400, { error: "Passwords must be at least 6 characters" });
  }

  const db = loadDb();
  db.settings.roomCode = roomCode;
  if (db.settings.users[0]) {
    db.settings.users[0].passcode = user1Pass;
  }
  if (db.settings.users[1]) {
    db.settings.users[1].passcode = user2Pass;
  }
  db.sessions = {};
  saveDb(db);

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "chat_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({
    ok: true,
    message: "Settings updated. Please log in again.",
    settings: getSettingsView(db)
  }));
}

function handleStream(req, res) {
  const auth = authenticate(req);
  if (!auth) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ type: "hello", username: auth.username })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "heartbeat", time: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(normalized).toLowerCase();
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json"
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  applyDefaultHeaders(res);

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      const db = loadDb();
      return sendJson(res, 200, {
        ok: true,
        messageCount: db.messages.length,
        userCount: db.settings.users.length
      });
    }
    if (req.method === "POST" && pathname === "/api/login") {
      return handleLogin(req, res, await collectRequestBody(req));
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      return handleLogout(req, res);
    }
    if (req.method === "GET" && pathname === "/api/me") {
      return handleMe(req, res);
    }
    if (req.method === "GET" && pathname === "/api/messages") {
      return handleMessages(req, res);
    }
    if (req.method === "POST" && pathname === "/api/send") {
      return handleSend(req, res);
    }
    if (req.method === "POST" && pathname === "/api/messages/read") {
      return handleEphemeralRead(req, res);
    }
    if (req.method === "GET" && pathname === "/api/admin/state") {
      return handleAdminState(req, res);
    }
    if (req.method === "POST" && pathname === "/api/admin/update") {
      return handleAdminUpdate(req, res);
    }
    if (req.method === "GET" && pathname === "/api/stream") {
      return handleStream(req, res);
    }
    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  ensureDataFile();
  console.log(`Private two-person chat is running on http://${HOST}:${PORT}`);
  console.log(`Room code: ${CONFIG.initialRoomCode}`);
  console.log(`User 1: ${CONFIG.users[0].username}`);
  console.log(`User 2: ${CONFIG.users[1].username}`);
});

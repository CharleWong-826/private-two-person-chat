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
  roomCode: process.env.CHAT_ROOM_CODE || "my-private-room",
  trustProxy: process.env.TRUST_PROXY === "1",
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
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ messages: [], sessions: {} }, null, 2),
      "utf8"
    );
  }
}

function loadDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
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

  const allowedUser = CONFIG.users.find(user => user.username === session.username);
  if (!allowedUser) {
    return null;
  }

  return {
    sessionId,
    username: session.username
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

function listMessages() {
  const db = loadDb();
  return db.messages.slice(-200);
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

  if (roomCode !== CONFIG.roomCode) {
    return sendJson(res, 403, { error: "Wrong room code" });
  }

  const user = CONFIG.users.find(item => item.username === username && item.passcode === passcode);
  if (!user) {
    return sendJson(res, 403, { error: "Wrong username or passcode" });
  }

  const db = loadDb();
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
  return sendJson(res, 200, { authenticated: true, username: auth.username });
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
  return sendJson(res, 200, { messages: listMessages(), username: auth.username });
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

  const db = loadDb();
  const message = {
    id: crypto.randomUUID(),
    sender: auth.username,
    text,
    sentAt: new Date().toISOString()
  };
  db.messages.push(message);
  db.messages = db.messages.slice(-500);
  saveDb(db);

  broadcast(sseClients, { type: "message", message });
  return sendJson(res, 200, { ok: true, message });
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
      return sendJson(res, 200, {
        ok: true,
        messageCount: listMessages().length,
        userCount: CONFIG.users.length
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
  console.log(`Room code: ${CONFIG.roomCode}`);
  console.log(`User 1: ${CONFIG.users[0].username}`);
  console.log(`User 2: ${CONFIG.users[1].username}`);
});

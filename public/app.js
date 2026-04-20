const loginCard = document.querySelector("#login-card");
const chatCard = document.querySelector("#chat-card");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const chatTitle = document.querySelector("#chat-title");
const logoutButton = document.querySelector("#logout-button");
const connectionStatus = document.querySelector("#connection-status");
const installBanner = document.querySelector("#install-banner");
const installButton = document.querySelector("#install-button");
const adminButton = document.querySelector("#admin-button");
const adminCard = document.querySelector("#admin-card");
const adminForm = document.querySelector("#admin-form");
const adminRoomCode = document.querySelector("#admin-room-code");
const adminUser1Pass = document.querySelector("#admin-user1-pass");
const adminUser2Pass = document.querySelector("#admin-user2-pass");
const adminMessage = document.querySelector("#admin-message");
const adminCancelButton = document.querySelector("#admin-cancel-button");
const selfDestructToggle = document.querySelector("#self-destruct-toggle");

let currentUser = null;
let eventSource = null;
let knownMessageIds = new Set();
let deferredInstallPrompt = null;
let reconnectTimer = null;
let unseenCount = 0;
let currentSettings = null;
let isOwner = false;
const pendingEphemeralReads = new Set();

function updateTitle() {
  document.title = unseenCount > 0 ? `(${unseenCount}) Catalog Chat` : "Catalog Chat";
}

function updateConnectionStatus(label, stateClass) {
  connectionStatus.textContent = label;
  connectionStatus.className = `status-dot ${stateClass}`;
}

function resetUnseenIfFocused() {
  if (document.visibilityState === "visible") {
    unseenCount = 0;
    updateTitle();
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderMessage(message, options = {}) {
  if (knownMessageIds.has(message.id)) {
    return;
  }
  knownMessageIds.add(message.id);

  const mine = message.sender === currentUser;
  const article = document.createElement("article");
  article.className = `bubble ${mine ? "mine" : "theirs"}`;
  article.innerHTML = `
    <div class="meta">
      <span>${escapeHtml(message.sender)}</span>
      <span>${formatTime(message.sentAt)}${message.selfDestruct ? " · 阅后即焚" : ""}</span>
    </div>
    <div class="text">${escapeHtml(message.text).replaceAll("\n", "<br>")}</div>
  `;
  article.dataset.messageId = message.id;
  messagesEl.appendChild(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (!options.silent && document.visibilityState !== "visible" && message.sender !== currentUser) {
    unseenCount += 1;
    updateTitle();
  }

  if (message.selfDestruct && !mine) {
    acknowledgeEphemeral(message.id);
  }
}

function removeMessageBubble(messageId) {
  knownMessageIds.delete(messageId);
  const el = messagesEl.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (el) {
    el.remove();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function connectStream() {
  if (eventSource) {
    eventSource.close();
  }
  clearTimeout(reconnectTimer);
  updateConnectionStatus("连接中", "status-connecting");
  eventSource = new EventSource("/api/stream");
  eventSource.onmessage = event => {
    const payload = JSON.parse(event.data);
    if (payload.type === "hello") {
      updateConnectionStatus("已连接", "status-online");
      return;
    }
    if (payload.type === "message" && payload.message) {
      renderMessage(payload.message);
      return;
    }
    if (payload.type === "message_deleted" && payload.messageId) {
      removeMessageBubble(payload.messageId);
    }
  };
  eventSource.onerror = () => {
    updateConnectionStatus("连接断开，正在重连", "status-offline");
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (currentUser) {
        connectStream();
      }
    }, 2500);
  };
}

async function loadMessages() {
  const data = await api("/api/messages");
  currentUser = data.username;
  isOwner = Boolean(data.isOwner);
  currentSettings = data.settings || null;
  chatTitle.textContent = `你好，${currentUser}`;
  adminButton.classList.toggle("hidden", !isOwner);
  messagesEl.innerHTML = "";
  knownMessageIds = new Set();
  data.messages.forEach(message => renderMessage(message, { silent: true }));
  resetUnseenIfFocused();
}

function showChat() {
  loginCard.classList.add("hidden");
  chatCard.classList.remove("hidden");
  adminCard.classList.add("hidden");
  messageInput.focus();
}

function showLogin() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  currentUser = null;
  currentSettings = null;
  isOwner = false;
  updateConnectionStatus("未连接", "status-offline");
  knownMessageIds = new Set();
  messagesEl.innerHTML = "";
  adminButton.classList.add("hidden");
  adminCard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  chatCard.classList.add("hidden");
}

function showAdmin() {
  if (!isOwner) {
    return;
  }
  adminMessage.textContent = "";
  adminRoomCode.value = currentSettings?.roomCode || "";
  adminUser1Pass.value = "";
  adminUser2Pass.value = "";
  chatCard.classList.add("hidden");
  adminCard.classList.remove("hidden");
}

async function acknowledgeEphemeral(messageId) {
  if (pendingEphemeralReads.has(messageId)) {
    return;
  }
  pendingEphemeralReads.add(messageId);
  try {
    await api("/api/messages/read", {
      method: "POST",
      body: JSON.stringify({ messageId })
    });
  } catch {
    pendingEphemeralReads.delete(messageId);
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginError.textContent = "";

  const form = new FormData(loginForm);
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        roomCode: form.get("roomCode"),
        username: form.get("username"),
        passcode: form.get("passcode")
      })
    });
    await loadMessages();
    connectStream();
    showChat();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

composer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) {
    return;
  }
  messageInput.value = "";
  messageInput.style.height = "auto";
  try {
    const data = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        text,
        selfDestruct: selfDestructToggle.checked
      })
    });
    renderMessage(data.message);
  } catch (error) {
    alert(error.message);
  }
});

messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  showLogin();
});

adminButton.addEventListener("click", showAdmin);
adminCancelButton.addEventListener("click", showChat);

adminForm.addEventListener("submit", async event => {
  event.preventDefault();
  adminMessage.textContent = "";
  try {
    const data = await api("/api/admin/update", {
      method: "POST",
      body: JSON.stringify({
        roomCode: adminRoomCode.value.trim(),
        user1Pass: adminUser1Pass.value,
        user2Pass: adminUser2Pass.value
      })
    });
    currentSettings = data.settings;
    alert("设置已保存。现在需要重新登录。");
    showLogin();
  } catch (error) {
    adminMessage.textContent = error.message;
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBanner.classList.remove("hidden");
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  installBanner.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installBanner.classList.add("hidden");
});

document.addEventListener("visibilitychange", resetUnseenIfFocused);

async function bootstrap() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    const me = await api("/api/me");
    if (!me.authenticated) {
      showLogin();
      return;
    }
    currentUser = me.username;
    currentSettings = me.settings || null;
    isOwner = Boolean(me.isOwner);
    await loadMessages();
    connectStream();
    showChat();
  } catch {
    showLogin();
  }
}

bootstrap();

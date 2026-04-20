# Private Two-Person Chat

一个只给两个人使用的手机友好型即时聊天工具。

特点：

- 手机浏览器可用
- 只允许两个预设账号登录
- 共享一个房间口令
- 实时收消息，发送消息后另一边几乎立刻看到
- 支持安装到手机主屏幕
- 有连接状态提示和断线自动重连
- 不依赖第三方 npm 包，直接用 Node.js 就能跑

## 目录

- `server.js` 服务端
- `public/` 手机网页
- `data/chat.json` 本地消息与会话数据

## 启动

```bash
cd /Users/wangzheng/Documents/Codex/2026-04-19-new-chat/private-two-person-chat
npm start
```

默认会启动在：

`http://0.0.0.0:8088`

如果你要让手机访问，需要让手机和电脑在同一个局域网，然后用电脑局域网 IP 打开，例如：

`http://192.168.1.20:8088`

如果只是先在电脑上试：

`http://127.0.0.1:8088`

## 手机像 App 一样安装

打开网页后：

- Android Chrome：点浏览器菜单，选择“安装应用”或“添加到主屏幕”
- iPhone Safari：点“分享”，再点“添加到主屏幕”

装完后会以 PWA 方式打开，更像一个独立聊天 App。

## 默认登录信息

房间口令：

`my-private-room`

用户 1：

- 用户名 `me`
- 口令 `111111`

用户 2：

- 用户名 `friend`
- 口令 `222222`

## 自定义账号

可以在启动前设置环境变量：

```bash
CHAT_ROOM_CODE=room-2026 \
CHAT_USER1_NAME=alice \
CHAT_USER1_PASS=apple123 \
CHAT_USER2_NAME=bob \
CHAT_USER2_PASS=orange456 \
npm start
```

如果你放在 Nginx、Caddy、Cloudflare Tunnel 这类 HTTPS 反向代理后面，建议加：

```bash
TRUST_PROXY=1 npm start
```

这样服务端会在 HTTPS 请求下自动加更合适的 `Secure` Cookie。

## Docker 启动

```bash
cd /Users/wangzheng/Documents/Codex/2026-04-19-new-chat/private-two-person-chat
docker build -t private-two-person-chat .
docker run --rm -p 8088:8088 \
  -e CHAT_ROOM_CODE=my-private-room \
  -e CHAT_USER1_NAME=me \
  -e CHAT_USER1_PASS=111111 \
  -e CHAT_USER2_NAME=friend \
  -e CHAT_USER2_PASS=222222 \
  private-two-person-chat
```

健康检查接口：

`GET /api/health`

## 公网可访问版本

这个项目现在已经带了 [render.yaml](/Users/wangzheng/Documents/Codex/2026-04-19-new-chat/private-two-person-chat/render.yaml)，适合直接部署到 Render。

### 最省事的上线方式

1. 把这个项目放到一个 GitHub 仓库里
2. 登录 Render
3. 选择 `New +` -> `Blueprint`
4. 连接你的 GitHub 仓库
5. Render 会自动识别 `render.yaml`
6. 在环境变量里填下面几个值

必填环境变量：

- `CHAT_ROOM_CODE`
- `CHAT_USER1_NAME`
- `CHAT_USER1_PASS`
- `CHAT_USER2_NAME`
- `CHAT_USER2_PASS`

变量示例见：

[.env.example](/Users/wangzheng/Documents/Codex/2026-04-19-new-chat/private-two-person-chat/.env.example)

部署成功后，Render 会给你一个类似下面的公网地址：

`https://your-app-name.onrender.com`

你和对方都直接用手机浏览器打开这个网址就能登录聊天。

### 手机上安装

公网地址打开后：

- `iPhone Safari`：分享 -> 添加到主屏幕
- `Android Chrome`：菜单 -> 安装应用 / 添加到主屏幕

这样以后点桌面图标就能直接进聊天。

### 上线前建议

不要继续用默认口令。至少把下面这些都改成你自己的：

- 房间口令改成长一点
- 两个人的登录口令都改成高强度
- 用户名不要太明显

## 注意

这个版本适合私人小范围使用，但它不是完整商用级聊天系统：

- 数据默认明文存本地 JSON
- 没有端到端加密
- 没有推送通知
- 没有图片、语音、已读状态

如果你后面要，我可以继续把它升级成：

- 安装到手机桌面的 PWA
- 消息持久化到 SQLite
- 图片发送
- 语音消息
- 局域网部署助手
- 真正的账号邀请机制

# 超级嗅探 (Super Sniffer)

基于 **PHP + Node.js (Puppeteer)** 的视频 m3u8 地址解析服务。输入视频页面链接，自动嗅探并返回页面中的 `.m3u8` 播放地址。

## 功能特性

- 支持任意视频页面链接，自动提取 `.m3u8` 播放地址
- 通过 Puppeteer 无头浏览器加载页面，支持动态加载的视频地址
- 四种提取方式：网络请求拦截、响应体扫描、页面内容扫描、iframe 扫描
- 返回标准 JSON 格式，便于前端播放器直接对接
- 支持带查询参数的 m3u8 地址（如 `index.m3u8?token=xxx`）

## 系统要求

- Node.js >= 18.0.0
- PHP >= 7.0（仅前端接口需要）
- Chrome / Chromium（项目内已打包 `chrome-linux64`，或使用系统浏览器）

## 项目结构

```
超级嗅探/
├── api.php          # PHP 前端接口（转发请求、提取 m3u8）
├── node.js          # Node.js 解析服务（Express + Puppeteer）
├── package.json     # Node.js 依赖配置
├── .user.ini        # PHP 运行配置
├── chrome-linux64/  # 打包的 Chrome 浏览器（可选）
└── node_modules/    # Node.js 依赖
```

## 快速开始

### 1. 准备 Chrome 浏览器

项目使用 Puppeteer 驱动 Chrome 解析页面。将 `chrome-linux64.tar.xz` 解压到项目根目录：

```bash
tar -xf chrome-linux64.tar.xz
```

也可以使用系统已安装的 Chrome，通过环境变量指定：

```bash
export CHROME_PATH="/usr/bin/google-chrome"
```

### 2. 安装依赖

```bash
npm install
```

### 3. 启动 Node.js 解析服务

```bash
npm start
# 或
node node.js
```

默认监听 `1314` 端口，可通过环境变量修改：

```bash
PORT=8080 node node.js
```

### 4. 配置 PHP 前端接口

将 `api.php` 部署到 PHP 环境（如 Nginx + PHP-FPM），通过环境变量指定解析服务地址：

```bash
# 默认地址为 http://122.51.166.115:1314
# 如需修改，设置环境变量 PLAYER_HOST
export PLAYER_HOST="http://127.0.0.1:1314"
```

## API 接口

### 解析视频地址

```
GET /node.js?url=<视频页面地址>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url  | string | 是 | 视频页面链接（需 URL 编码） |

### 返回格式

```json
// 解析成功
{"code":200,"url":"https://example.com/video/index.m3u8"}

// 缺少参数
{"code":400,"msg":"请提供需要解析的链接"}

// 未找到播放链接
{"code":404,"msg":"未找到播放链接"}

// 服务异常
{"code":500,"msg":"解析失败: ..."}
```

### PHP 前端接口

```
GET /api.php?url=<视频页面地址>
```

返回格式与 Node.js 服务一致。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 1314 | Node.js 服务监听端口 |
| CHROME_PATH | `./chrome-linux64/chrome` | Chrome 可执行文件路径 |
| PARSE_TIMEOUT | 30000 | 页面加载超时（毫秒） |
| EXTRA_WAIT | 3000 | 加载完成后额外等待时间（毫秒） |
| PLAYER_HOST | `http://122.51.166.115:1314` | PHP 前端指向的解析服务地址 |

## 常见问题

**Q: 提示 `无法获取解析页面`？**
A: 请确认 Node.js 解析服务已启动，且 `api.php` 中的 `PLAYER_HOST` 指向正确的服务地址。

**Q: 提示 `未找到播放链接`？**
A: 部分视频网站需要登录或存在反爬机制，可尝试更换视频源，或调整 `EXTRA_WAIT` 等待时间。

**Q: 提示 `解析失败: ...`？**
A: 请检查 Chrome 是否可用。项目内已打包 `chrome-linux64`，也可通过 `CHROME_PATH` 指定系统 Chrome。

## 许可证

MIT License

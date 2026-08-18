# 超级嗅探 (Super Sniffer)

基于 **PHP + Node.js (Puppeteer)** 的视频 m3u8 地址解析服务。输入视频页面链接，自动嗅探并返回页面中的 `.m3u8` 播放地址。

## 功能特性

- 支持任意视频页面链接，自动提取 `.m3u8` 播放地址
- 通过 Puppeteer 无头浏览器加载页面，支持动态加载的视频地址
- 四种提取方式：网络请求拦截、响应体扫描、页面内容扫描、iframe 扫描
- 返回标准 JSON 格式，便于前端播放器直接对接
- 支持带查询参数的 m3u8 地址（如 `index.m3u8?token=xxx`）
- 内置管理后台，支持在线更新（浏览器更新 / 源码更新独立进行，一键升级）

## 系统要求

- Node.js >= 18.0.0
- PHP >= 7.0（仅前端接口需要）
- Chrome / Chromium（项目内已打包 `chrome-linux64`，或使用系统浏览器）

## 项目结构

```
超级嗅探/
├── 1.sh             # 一键解压浏览器脚本
├── api.php          # PHP 前端接口（转发请求、提取 m3u8）
├── node.js          # Node.js 解析服务（Express + Puppeteer）
├── update.js        # 在线更新模块（浏览器/源码独立更新）
├── admin.html       # 管理后台页面
├── package.json     # Node.js 依赖配置
├── .user.ini        # PHP 运行配置
├── chrome-linux64/  # 解压后的 Chrome 浏览器（由 1.sh 生成）
└── node_modules/    # Node.js 依赖
```

## 快速开始

### 1. 一键解压浏览器

项目使用 Puppeteer 驱动 Chrome 解析页面。浏览器已内置在分发压缩包中，运行 `1.sh` 会自动解压到正确位置：

```bash
bash 1.sh
# 或
chmod +x 1.sh && ./1.sh
```

脚本会自动完成以下操作：

- 自动查找当前目录（或 `upload/`、`uploads/` 目录）下的浏览器压缩包
- 支持 `chrome-linux64.tar.xz`、`chrome-linux64.tar.gz`、`chrome-linux64.zip` 等格式
- 解压到项目根目录的 `chrome-linux64/` 并设置可执行权限
- 验证 Chrome 可运行，缺失系统依赖时自动尝试安装

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

## 管理后台 & 在线更新

启动服务后，浏览器访问 **`http://<服务器IP>:1314/admin`** 进入管理后台。

### 后台功能

- **服务状态**：实时显示服务运行状态、监听端口、Chrome 版本、当前版本
- **更新源切换**：稳定版（`main` 分支）/ 先行版（`cs1` 分支）自由切换
- **浏览器更新**：仅更新 Chrome 浏览器，不影响源码与服务逻辑
- **源码更新**：仅更新项目源码（`node.js`、`api.php`、`admin.html` 等），不影响浏览器
- **一键升级**：先更新浏览器，再更新源码，全自动完成

### 更新源（稳定版 / 先行版）

后台支持两种更新源，用户可自由选择，更新到对应分支版本：

| 更新源 | 分支 | 说明 |
|--------|------|------|
| 稳定版 | `main` | 稳定发布，旧包，适合生产环境 |
| 先行版 | `cs1` | 先行体验，新包，含最新功能 |

- 切换更新源后，检查更新与执行更新均基于所选分支
- 更新源配置持久化到 `update-config.json`，重启后仍生效
- 更新包按分支独立命名与发布：先行版资产带 `-cs1` 后缀（如 `super-sniffer-source_1.3.0-cs1.zip`）

### 更新机制

- 更新源为 GitHub Releases（`ssmhdssmhd/MXTX`），源码包与浏览器包独立发布
- 浏览器更新与源码更新**互不干扰**，各自下载、解压、替换、验证
- 更新前自动备份，更新后自动验证；验证失败自动回滚到旧版本
- 源码更新完成后服务自动重启，无需手动操作

### 更新接口

```
GET  /admin                        # 管理后台页面
GET  /admin/api/status             # 服务状态
GET  /admin/api/update-source      # 获取当前更新源
POST /admin/api/update-source      # 切换更新源（body: {"source":"stable"|"beta"}）
GET  /admin/api/check-update       # 检查更新（对比所选分支最新版本）
POST /admin/api/update             # 执行更新（body: {"type":"browser"|"source"|"all"}）
```

### 更新源配置

默认更新源为 `ssmhdssmhd/MXTX`，可通过环境变量修改：

```bash
export GITHUB_OWNER="你的用户名"
export GITHUB_REPO="你的仓库名"
# 私有仓库需要 Token
export GITHUB_TOKEN="ghp_xxx"
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
| GITHUB_OWNER | `ssmhdssmhd` | 在线更新的 GitHub 用户名 |
| GITHUB_REPO | `MXTX` | 在线更新的 GitHub 仓库名 |
| GITHUB_TOKEN | 空 | GitHub Token（私有仓库更新需要） |

## 常见问题

**Q: 提示 `无法获取解析页面`？**
A: 请确认 Node.js 解析服务已启动，且 `api.php` 中的 `PLAYER_HOST` 指向正确的服务地址。

**Q: 提示 `未找到播放链接`？**
A: 部分视频网站需要登录或存在反爬机制，可尝试更换视频源，或调整 `EXTRA_WAIT` 等待时间。

**Q: 提示 `解析失败: ...`？**
A: 请检查 Chrome 是否可用。项目内已打包 `chrome-linux64`，也可通过 `CHROME_PATH` 指定系统 Chrome。

## 许可证

MIT License

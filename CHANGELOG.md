# 更新日志 (Changelog)

本项目所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [2.0.0] - 2026-08-18

> 💥 **大版本升级**：性能大幅优化 + 配置全面环境变量化。功能完全向后兼容（现有接口不变、旧环境变量名仍可用），代码内部几乎全部重写，版本号升至 2.0。

### 新增

#### 🔧 统一的 MX_ 前缀环境变量系统
- 所有配置统一通过 `MX_` 前缀环境变量注入，包含 **7 大类 30+ 变量**：
  - **服务类**：`MX_PORT`、`MX_HOST`
  - **后台类**：`MX_ADMIN_USER`、`MX_ADMIN_PASS`（管理后台 Basic Auth）
  - **浏览器类**：`MX_CHROME_PATH`、`MX_CHROME_HEADLESS`、`MX_BROWSER_POOL_SIZE`、`MX_PAGE_POOL_SIZE`、`MX_CHROME_ARGS`
  - **嗅探类**：`MX_PARSE_TIMEOUT`、`MX_EXTRA_WAIT`、`MX_EARLY_RETURN`、`MX_USER_AGENT`、`MX_VIEWPORT_WIDTH/HEIGHT`、`MX_SNIFF_RESPONSE_BODY`、`MX_SNIFF_IFRAME`
  - **缓存类**：`MX_CACHE_ENABLE`、`MX_CACHE_TTL`、`MX_CACHE_MAX`
  - **并发类**：`MX_MAX_CONCURRENT`、`MX_REQUEST_QUEUE_TIMEOUT`
  - **更新类**：`MX_GITHUB_OWNER`、`MX_GITHUB_REPO`、`MX_GITHUB_TOKEN`、`MX_PROXY`
  - **PHP 专属**：`MX_PLAYER_HOST`、`MX_PHP_TIMEOUT`、`MX_PHP_CONNECT_TIMEOUT`、`MX_PHP_CACHE_ENABLE`、`MX_PHP_CACHE_TTL`、`MX_PHP_CACHE_DIR`、`MX_PHP_SSL_VERIFY`
- 所有变量**兼容旧名 fallback**（如 `PORT` / `CHROME_PATH` / `PLAYER_HOST` 等老部署无需修改即可升级）
- 新增 `.env.example` 文件，完整列出所有变量与注释，方便一键复制配置
- `package.json` 新增 `npm run check` 脚本（执行 `node --check` 语法检查）

#### ⚡ 性能：浏览器单例池 + 页面池
- `node.js` 启动时**一次性初始化 Chrome 浏览器池**（可配置 1~N 实例），每次解析**不再 launch/close**
- 单浏览器内**页面池（Page Pool）**：Page 用完回到空闲池（回到 `about:blank` 释放内存），下次优先复用，免去 `newPage()` 开销
- 浏览器**崩溃自动重启**：监听 `disconnected` 事件，自动拉起新实例
- 支持 **MX_CHROME_ARGS**（JSON 数组字符串）注入任意额外启动参数

#### ⚡ 性能：找到即返回（Early Return）
- 新增 `MX_EARLY_RETURN` 开关（默认开启）：请求拦截/响应拦截**一旦捕获到 m3u8 地址**，立即 resolve 提前结束等待
- 不用再死等 `EXTRA_WAIT`，快的站点 1 秒内就能返回
- 响应头 `X-Cache: DIRECT-M3U8`：如果传入的本身就是 m3u8，0 开销直接返回

#### ⚡ 性能：LRU 结果缓存
- 进程内 LRU 缓存实现（TTL + 容量上限）：相同 URL 在 `MX_CACHE_TTL` 内直接返回，不开浏览器
- 响应头 `X-Cache: HIT / MISS` 明确标识缓存命中情况
- `MX_CACHE_MAX` 限制最大条目（默认 500），超出淘汰最久未用
- 每 5 分钟自动清理过期项，防内存泄漏

#### ⚡ 性能：信号量并发控制
- 信号量（Semaphore）限制同时解析数量（默认 `MX_MAX_CONCURRENT=5`）
- 超出并发的请求进入**有界等待队列**，超过 `MX_REQUEST_QUEUE_TIMEOUT`（默认 90 秒）直接返回 `请求排队超时`，避免无限积压 OOM
- 健康检查接口 `/` 返回当前并发数、队列长度、缓存大小

#### ⚡ 性能：资源自动屏蔽 + PHP 层缓存
- 请求拦截自动 `abort` image / font / media 三类资源，省带宽 + 加速加载
- `api.php` 新增**本地文件缓存**（`MX_PHP_CACHE_ENABLE/TLL/DIR`），命中直接返回 JSON，不调 Node.js
- `api.php` cURL 多参数调优：`CURLOPT_ENCODING`（接收压缩）、`CURLOPT_TCP_NODELAY`、`CURLOPT_FORBID_REUSE=false`（连接复用）、`CURLOPT_MAXREDIRS=5`

#### 🔒 后台 Basic Auth 账号密码
- 新增 `MX_ADMIN_USER` / `MX_ADMIN_PASS`，同时设置后所有 `/admin` 路由启用 HTTP Basic Auth 登录
- 未设置时放行，但启动日志会**醒目提示**生产环境务必设置
- `/admin/api/status` 新增 `adminAuth` 字段标识当前是否开启认证

#### 🛡️ 优雅退出 & 安全重启
- 监听 `SIGINT` / `SIGTERM`，退出前优雅 `browser.close()` 关闭浏览器池，避免孤儿进程
- 源码更新执行 `restartServer` 前先关闭浏览器池，确保干净重启

#### 🆕 在线更新下载流式写入 + 代理支持
- `downloadFile()` 从「一次性读入内存 Buffer」改为**流式 ReadableStream 写入磁盘**，大文件更新不占爆内存
- 新增 `MX_PROXY` 环境变量，更新下载 / GitHub API 可走 HTTP 代理（国内网络福音）

### 优化

- `node.js` 代码结构**模块化分章节**：环境变量加载 → 工具函数 → LRU 缓存 → 信号量 → 浏览器池 → 核心解析 → 路由 → 后台 → 启动，每块都有详细注释
- `api.php` 增加协议校验（只允许 http/https）、JSON 响应统一 `JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES`（中文和斜杠不转义）
- `update.js` 统一使用 `envS()` 读取环境变量，Chrome 路径检查使用 `MX_CHROME_PATH`
- 启动时控制台**彩色启动面板**：打印端口、后台、认证、Chrome 路径、浏览器池、缓存、并发、找到即返回等所有关键配置，一眼看清运行状态
- `/admin/api/status` 新增缓存、并发、浏览器池详细信息字段

### 修复

- 修复 `browser.newPage()` / `page.close()` 抛错不处理可能导致的资源泄漏
- 修复 `page.on('response')` 读取二进制响应体可能卡死的问题（增强 `isTextResponse` 识别 javascript/ecmascript）
- 修复 `MX_PARSE_TIMEOUT` 之前仅对 `goto` 生效，现在整体逻辑有信号量超时 + 排队超时双重保护
- 修复后台任何人可访问的安全隐患（新增 Basic Auth）
- 修复源码更新重启可能残留 Chrome 孤儿进程（先 close 再 restart）

### 文档

- `README.md` 重写：新增 v2 性能对比表、完整环境变量表、Response Header 说明、Nginx FastCGI 注入示例、常见问题 Q&A
- 新增 `.env.example`：带中文注释的完整环境变量示例
- `package.json` 版本升级至 2.0.0，description/keywords 同步更新

---

## [1.3.0] - 2026-08-18

### 新增

- 在线更新支持「稳定版 / 先行版」两种更新源
  - 稳定版：从 `main` 分支获取（旧包，稳定发布）
  - 先行版：从 `cs1` 分支获取（新包，先行体验）
  - 后台可自由切换更新源，切换后自动获取对应分支的最新版本
  - 更新源配置持久化到 `update-config.json`，重启后仍生效
- 管理后台新增更新源切换界面
  - 显示当前更新源与对应分支
  - 一键切换稳定版 / 先行版
- 新增更新源接口
  - `GET /admin/api/update-source` 获取当前更新源
  - `POST /admin/api/update-source` 切换更新源（stable / beta）
- 更新包按分支独立命名与发布（`-cs1` 后缀区分先行版）

### 优化

- `update.js` 重构：按分支过滤获取最新 Release，资产按分支匹配
- 更新 `README.md`，补充稳定版 / 先行版使用说明
- 版本升级至 1.3.0

---

## [1.2.0] - 2026-08-18

### 新增

- 新增管理后台页面 `admin.html`
  - 实时显示服务状态、监听端口、Chrome 版本、当前版本
  - 浏览器更新与源码更新独立展示，互不干扰
  - 支持一键升级（浏览器 + 源码）
- 新增在线更新模块 `update.js`
  - 浏览器更新：仅更新 Chrome 浏览器，不影响源码
  - 源码更新：仅更新项目源码，不影响浏览器
  - 更新前自动备份，更新后自动验证，验证失败自动回滚
  - 源码更新完成后服务自动重启
- `node.js` 新增后台管理接口
  - `GET /admin` 管理后台页面
  - `GET /admin/api/status` 服务状态
  - `GET /admin/api/check-update` 检查更新
  - `POST /admin/api/update` 执行更新（browser / source / all）
- 更新源支持环境变量配置（`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_TOKEN`）

### 优化

- 更新 `README.md`，补充管理后台与在线更新使用说明
- 版本升级至 1.2.0

---

## [1.1.0] - 2026-08-18

### 新增

- 新增 `1.sh` 一键解压浏览器脚本
  - 自动查找当前目录及 `upload/`、`uploads/` 目录下的浏览器压缩包
  - 支持 `chrome-linux64.tar.xz`、`chrome-linux64.tar.gz`、`chrome-linux64.zip` 等格式
  - 自动解压到项目根目录 `chrome-linux64/` 并设置可执行权限
  - 验证 Chrome 可运行，缺失系统依赖时自动尝试安装
  - Chrome 已就绪时自动跳过解压
- 浏览器已内置进分发压缩包（`chrome-linux64.tar.xz`）

### 优化

- 更新 `README.md`，补充一键解压浏览器的使用说明

---

## [1.0.0] - 2026-08-18

### 新增

- 新增 `node.js` Node.js 解析服务（Express + Puppeteer）
  - 支持网络请求拦截捕获 m3u8 地址
  - 支持响应体扫描、页面内容扫描、iframe 扫描
  - 支持带查询参数的 m3u8 地址
- 新增 `package.json` 依赖配置（express、puppeteer）
- 新增 `README.md` 项目说明文档
- 新增 `.gitignore` 忽略规则

### 优化

- 优化 `api.php` 前端接口
  - 增加 URL 格式校验
  - 改进 m3u8 正则，支持带查询参数的完整地址
  - 增加 cURL 连接超时与 SSL 校验配置
  - 支持通过环境变量 `PLAYER_HOST` 配置解析服务地址
  - 解析失败时返回解析服务的具体错误信息

# 超级嗅探 (Super Sniffer) v2

基于 **PHP + Node.js (Puppeteer)** 的视频 m3u8 地址解析服务。输入视频页面链接，自动嗅探并返回页面中的 `.m3u8` 播放地址。

v2 版本在保持原有功能的基础上，重点做了 **性能大幅优化** 和 **统一的 MX_ 前缀环境变量配置**。

---

## 功能特性

- 支持任意视频页面链接，自动提取 `.m3u8` 播放地址
- 通过 Puppeteer 无头浏览器加载页面，支持动态加载的视频地址
- 四种提取方式：网络请求拦截、响应体扫描、页面内容扫描、iframe 扫描
- 返回标准 JSON 格式，便于前端播放器直接对接
- 支持带查询参数的 m3u8 地址（如 `index.m3u8?token=xxx`）
- 内置管理后台（支持 Basic Auth 账号密码保护），支持在线更新（浏览器更新 / 源码更新独立进行，一键升级）
- 所有配置通过 **MX_ 前缀的环境变量** 集中管理（向下兼容旧变量名）

### 🚀 v2 性能优化（相比 v1）

| 优化项 | 说明 | 预计性能提升 |
|--------|------|-------------|
| **浏览器单例池** | 服务启动时一次性启动 1~N 个 Chrome 实例，每次解析不再 `launch/close` | ⭐⭐⭐⭐⭐ 首解节省 1~3s |
| **Page 池复用** | Page 用完放回空闲池（about:blank 释放内存），下次优先复用 | ⭐⭐⭐ 单次解析快 200~800ms |
| **找到即返回** | 请求/响应拦截一旦捕获到 m3u8 立即结束等待，不再傻等 `EXTRA_WAIT` | ⭐⭐⭐⭐⭐ 快的站 <1s 返回 |
| **LRU 结果缓存** | 相同 URL 在 TTL 内直接返回缓存，不消耗浏览器资源 | ⭐⭐⭐⭐⭐ 重复请求 = 1ms 级 |
| **信号量并发控制** | 限制同时解析数（默认 5），队列超时报错，防 OOM | ⭐⭐⭐ 稳定性极大提升 |
| **资源屏蔽** | 请求拦截自动 abort image / font / media，省带宽加速加载 | ⭐⭐⭐ 单次省几百毫秒 |
| **PHP 层缓存** | `api.php` 本地文件缓存，相同请求连 Node.js 都不调用 | ⭐⭐⭐⭐ PHP 层直接毫秒级返回 |
| **后台 Basic Auth** | 管理后台支持账号密码，之前任何人可访问更新 | ⭐⭐⭐ 安全性 |

---

## 系统要求

- Node.js >= 18.0.0
- PHP >= 7.0（仅前端接口需要）
- Chrome / Chromium（项目内已打包 `chrome-linux64`，或使用系统浏览器，通过 `MX_CHROME_PATH` 指定）

---

## 项目结构

```
超级嗅探/
├── .env.example      # MX_ 环境变量配置示例（复制为 .env 使用）
├── 1.sh              # 一键解压浏览器脚本
├── api.php           # PHP 前端接口（转发请求、提取 m3u8，带本地缓存）
├── node.js           # Node.js 解析服务（Express + Puppeteer + 浏览器池 + 缓存）
├── update.js         # 在线更新模块（浏览器/源码独立更新，MX_ 变量支持）
├── admin.html        # 管理后台页面
├── package.json      # Node.js 依赖配置（v2.0.0）
├── .user.ini         # PHP 运行配置
├── README.md         # 本文档
├── CHANGELOG.md      # 更新日志
├── chrome-linux64/   # 解压后的 Chrome 浏览器（由 1.sh 生成）
└── node_modules/     # Node.js 依赖
```

---

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
export MX_CHROME_PATH="/usr/bin/google-chrome-stable"
```

### 2. 安装依赖

```bash
npm install
```

### 3. （可选）配置环境变量

复制 `.env.example` 为 `.env` 并修改，或直接在启动时注入：

```bash
cp .env.example .env
# 编辑 .env 设置端口、后台账号密码等
```

**至少强烈建议设置后台账号密码：**

```
MX_ADMIN_USER=your_name
MX_ADMIN_PASS=your_strong_password
```

### 4. 启动 Node.js 解析服务

```bash
# 最简启动（使用默认配置）
npm start

# 或带自定义配置（推荐）
MX_PORT=8080 \
MX_ADMIN_USER=admin \
MX_ADMIN_PASS=change_me \
MX_CACHE_TTL=3600 \
MX_MAX_CONCURRENT=8 \
  node node.js
```

默认监听 `1314` 端口，所有可配置项见下文 **环境变量** 章节。

### 5. 配置 PHP 前端接口

将 `api.php` 部署到 PHP 环境（如 Nginx + PHP-FPM），通过环境变量指定解析服务地址：

```bash
# 默认地址为 http://122.51.166.115:1314
# 如需修改，设置环境变量 MX_PLAYER_HOST（或兼容旧的 PLAYER_HOST）
export MX_PLAYER_HOST="http://127.0.0.1:1314"
```

**Nginx FastCGI 注入示例：**

```nginx
location ~ \.php$ {
    fastcgi_pass unix:/run/php/php8.1-fpm.sock;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    # 注入 MX 环境变量
    fastcgi_param MX_PLAYER_HOST "http://127.0.0.1:1314";
    fastcgi_param MX_PHP_CACHE_ENABLE "1";
    fastcgi_param MX_PHP_CACHE_TTL "1800";
    include fastcgi_params;
}
```

---

## 环境变量（全部以 MX_ 开头）

### Node.js 服务专属

| 分类 | 变量名 | 默认值 | 兼容旧名 | 说明 |
|------|--------|--------|---------|------|
| **服务** | `MX_PORT` | `1314` | `PORT` | 监听端口 |
| **服务** | `MX_HOST` | `0.0.0.0` | - | 监听网卡（`127.0.0.1` 仅本地） |
| **后台** | `MX_ADMIN_USER` | 空 | - | 后台 Basic Auth 用户名 |
| **后台** | `MX_ADMIN_PASS` | 空 | - | 后台 Basic Auth 密码 |
| **浏览器** | `MX_CHROME_PATH` | `./chrome-linux64/chrome` | `CHROME_PATH` | Chrome 可执行路径 |
| **浏览器** | `MX_CHROME_HEADLESS` | `true` | - | 是否无头 |
| **浏览器** | `MX_BROWSER_POOL_SIZE` | `1` | - | 浏览器实例数（1~3） |
| **浏览器** | `MX_PAGE_POOL_SIZE` | `8` | - | 单浏览器 Page 池大小 |
| **浏览器** | `MX_CHROME_ARGS` | 空 | - | 额外启动参数（JSON 数组字符串） |
| **嗅探** | `MX_PARSE_TIMEOUT` | `30000` | `PARSE_TIMEOUT` | 解析总超时（毫秒） |
| **嗅探** | `MX_EXTRA_WAIT` | `2000` | `EXTRA_WAIT` | 加载后额外等待（毫秒，找到即返回时可被跳过） |
| **嗅探** | `MX_EARLY_RETURN` | `true` | - | 找到 m3u8 即返回（性能核心） |
| **嗅探** | `MX_USER_AGENT` | Chrome 122 UA | - | 自定义 UA |
| **嗅探** | `MX_VIEWPORT_WIDTH` | `1280` | - | 视口宽 |
| **嗅探** | `MX_VIEWPORT_HEIGHT` | `720` | - | 视口高 |
| **嗅探** | `MX_SNIFF_RESPONSE_BODY` | `true` | - | 是否扫描响应体 |
| **嗅探** | `MX_SNIFF_IFRAME` | `true` | - | 是否扫描 iframe |
| **缓存** | `MX_CACHE_ENABLE` | `true` | - | 是否启用 LRU 结果缓存 |
| **缓存** | `MX_CACHE_TTL` | `1800` | - | 缓存 TTL（秒） |
| **缓存** | `MX_CACHE_MAX` | `500` | - | 最大缓存条目（超量淘汰最久未用） |
| **并发** | `MX_MAX_CONCURRENT` | `5` | - | 最大同时解析数 |
| **并发** | `MX_REQUEST_QUEUE_TIMEOUT` | `90000` | - | 请求排队超时（毫秒） |
| **更新** | `MX_GITHUB_OWNER` | `ssmhdssmhd` | `GITHUB_OWNER` | GitHub 用户名 |
| **更新** | `MX_GITHUB_REPO` | `MXTX` | `GITHUB_REPO` | GitHub 仓库名 |
| **更新** | `MX_GITHUB_TOKEN` | 空 | `GITHUB_TOKEN` | GitHub Token（私有仓库/限流） |
| **更新** | `MX_PROXY` | 空 | - | 下载更新代理（如 `http://127.0.0.1:7890`） |

### PHP（api.php）专属

| 变量名 | 默认值 | 兼容旧名 | 说明 |
|--------|--------|---------|------|
| `MX_PLAYER_HOST` | `http://122.51.166.115:1314` | `PLAYER_HOST` | Node.js 解析服务地址 |
| `MX_PHP_TIMEOUT` | `30` | - | cURL 总执行超时（秒） |
| `MX_PHP_CONNECT_TIMEOUT` | `3` | - | cURL 连接超时（秒） |
| `MX_PHP_CACHE_ENABLE` | `1` | - | 本地文件缓存开关 |
| `MX_PHP_CACHE_TTL` | `1800` | - | 缓存 TTL（秒） |
| `MX_PHP_CACHE_DIR` | `./.mx_cache` | - | 缓存目录 |
| `MX_PHP_SSL_VERIFY` | `0` | - | 是否校验 SSL 证书 |

---

## 管理后台 & 在线更新

启动服务后，浏览器访问 **`http://<服务器IP>:<端口>/admin`** 进入管理后台。

如果设置了 `MX_ADMIN_USER` / `MX_ADMIN_PASS`，浏览器会弹出登录框要求输入账号密码。

### 后台功能

- **服务状态**：实时显示服务运行状态、监听端口、Chrome 版本、当前版本、**缓存命中率、并发数、浏览器池大小**
- **更新源切换**：稳定版（`main` 分支）/ 先行版（`cs1` 分支）自由切换
- **浏览器更新**：仅更新 Chrome 浏览器，不影响源码与服务逻辑
- **源码更新**：仅更新项目源码（`node.js`、`api.php`、`admin.html` 等），不影响浏览器
- **一键升级**：先更新浏览器，再更新源码，全自动完成

### 更新源（稳定版 / 先行版）

| 更新源 | 分支 | 说明 |
|--------|------|------|
| 稳定版 | `main` | 稳定发布，旧包，适合生产环境 |
| 先行版 | `cs1` | 先行体验，新包，含最新功能 |

### 更新机制

- 更新源为 GitHub Releases（默认 `ssmhdssmhd/MXTX`），源码包与浏览器包独立发布
- 浏览器更新与源码更新**互不干扰**，各自下载、解压、替换、验证
- 更新前自动备份，更新后自动验证；验证失败自动回滚到旧版本
- 源码更新完成后服务自动重启（v2 会先优雅关闭浏览器池再重启，避免孤儿进程）
- 支持 `MX_PROXY` 环境变量为更新下载设置代理

---

## API 接口

### 解析视频地址

```
GET /node.js?url=<视频页面地址>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url  | string | 是 | 视频页面链接（需 URL 编码） |

**Response Headers：**
- `X-Cache: HIT`        = 命中 Node.js LRU 缓存，直接返回
- `X-Cache: MISS`       = 未命中，实际执行浏览器解析
- `X-Cache: DIRECT-M3U8`= 传入本身就是 m3u8，直接返回

### 返回格式

```jsonc
// 解析成功
{ "code": 200, "url": "https://example.com/video/index.m3u8?token=xxx" }

// 缺少参数 / 格式错
{ "code": 400, "msg": "请提供需要解析的链接" }

// 未找到播放链接
{ "code": 404, "msg": "未找到播放链接" }

// 并发排队超时
{ "code": 500, "msg": "解析失败: 请求排队超时（队列积压，当前并发上限 5）" }

// 服务异常
{ "code": 500, "msg": "解析失败: ..." }
```

### PHP 前端接口

```
GET /api.php?url=<视频页面地址>
```

返回格式与 Node.js 服务一致；额外 Response Header：
- `X-Cache: HIT` = 命中 PHP 本地文件缓存

---

## 常见问题

**Q: 对比 v1，性能提升到底有多大？**
A: 保守估计：
- 第一次解析一个新站：v1 大概 5~10 秒（启动 Chrome 2s + 加载 3s + 等待 3s），v2 大概 2~5 秒（Chrome 已启动 + 资源屏蔽 + 找到即返回 可快到 1s 内）
- 第二次请求同一个 URL：v1 还是 5~10 秒，v2 毫秒级（缓存命中）

**Q: 后台一直弹登录框？**
A: 你开启了 `MX_ADMIN_USER/PASS`，请输入正确的账号密码。如果忘记，去掉这两个环境变量重启即可关闭认证。

**Q: 内存占用会不会越来越大？**
A: v2 做了多重保护：LRU 缓存上限 500 条、Page 池上限 8/浏览器、并发信号量 5。正常使用内存 500MB~1.5GB 足够。

**Q: 并发满了请求会怎样？**
A: 进入队列排队；排队超过 `MX_REQUEST_QUEUE_TIMEOUT`（默认 90 秒）会直接返回 `请求排队超时`，避免无限积压。

**Q: 提示 `解析失败: ...`？**
A: 请检查 Chrome 是否可用。项目内已打包 `chrome-linux64`，也可通过 `MX_CHROME_PATH` 指定系统 Chrome。

---

## 许可证

MIT License

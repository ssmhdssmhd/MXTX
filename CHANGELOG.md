# 更新日志 (Changelog)

本项目所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.4.9] - 2026-08-19

### 修复嗅探日志「命中 0 个 URL」、跳过与官方平台大量未命中

### Fixed
- 🐛 修复嗅探日志「✅ 命中 0 个 URL」显示错误
  - 根因：SSE `progress` 事件载荷不含 `urls` 字段，前端只能拿 `urls.length`（空数组）当命中数显示
  - 修复：`runUniversalSniff` 的 `onProgress` 回调补充 `urls` 字段（成功=实际 URL 列表 / 失败=空数组），前端改用 `data.count ?? urls.length` 显示真实命中数量
- 🐛 修复嗅探测试页（/admin/api/sniff-stream）对腾讯等官方平台链接大量「未命中」
  - 根因：测试页直接并发调用 18 个第三方解析接口，大多不支持腾讯移动端链接，几乎全部失败
  - 修复：`/admin/api/sniff-stream` 与 `/sniff` 均改为官方解析优先（`officialVideoResolve`：腾讯 / B站 / 搜狐直连官方接口），命中即直接返回，不再依赖第三方接口
- 🐛 修复部署配置仍强制「提前命中 3」导致 Provider 被跳过
  - 根因：代码默认 `MX_UNIVERSAL_EARLY_HITS=0` 已关闭提前命中，但 `ecosystem.config.js`（PM2）、`super-sniffer.service`（systemd）、`deploy/env.example.sh` 仍写死 `=3`，按这些方式部署时依旧命中 3 家就 skip 剩余 15 家
  - 修复：三处部署配置全部改为 `MX_UNIVERSAL_EARLY_HITS=0`，保证 18 家 Provider 全部执行

### 验证
- 官方解析优先：腾讯 m.v.qq.com 链接 → `qq-official` 命中 **4 个 mp4 直链**，日志显示 `count: 4`（不再是「命中 0 个 URL」）
- 全部 Provider 执行：HLS 测试流 18/18 全部执行，**0 跳过**，命中 7 家（此前命中 3 家即提前返回）

## [2.4.8] - 2026-08-19

### Provider 全部执行（不再提前 skip 部分解析接口）

### Changed
- 🔧 万能嗅探「提前命中」默认关闭：`MX_UNIVERSAL_EARLY_HITS` 默认由 3 改为 **0**（0 = 不使用提前命中）
  - 背景：默认 `MX_UNIVERSAL_EARLY_HITS=3` 时，任意 3 家 Provider 命中后，剩余 Provider 全部标记 skip 不再执行 → 「Provider 没有全部使用到」
  - 修复：默认 0 时全部 Provider 都会执行，18 家解析接口完整跑一遍，结果更全、可用性更高；需要提速时可在 `.env` 设 `MX_UNIVERSAL_EARLY_HITS=3` 恢复「命中 3 家即提前返回」
- 🎨 管理后台/万能嗅探页/启动横幅把提前命中显示为「全部（不使用提前命中）」当值为 0 时

### Fixed
- ✅ 解决「Provider 中的，没有全部使用到」：默认情况下每个 Provider 都会被实际调用（仍受熔断保护，连续失败 3 次的接口临时跳过）

## [2.4.7] - 2026-08-19

### 修复未编码 & 导致腾讯视频链接解析不到（404）

### Fixed
- 🐛 修复 `url` 参数未做 URL 编码时，目标视频 URL 里的 `&` 被 Express 拆成独立参数，导致关键参数丢失
  - 根因：客户端直接调用 `/node.js?url=https://m.v.qq.com/x/m/play?cid=xxx&vid=yyy`（未编码）时，`&vid=yyy` 会被解析成顶层 `vid` 参数，解析器拿到的 URL 只有 `cid` 没有 `vid`，腾讯官方解析因缺 vid 直接放弃 → 404 未找到播放链接
  - 修复：新增 `resolveVideoUrl(req)`，把散落的、不属于服务自身参数（`url/detailed/refresh/providers`）的 query 参数自动合并回 url 查询串，恢复完整视频地址（腾讯 cid&vid、搜狐、爱奇艺等带 `&` 的平台链接同样受益）
  - 覆盖路由：`/node.js`、`/api.php`、`/sniff`、`/admin/api/sniff-stream`
- 🐛 修复腾讯视频 URL 只有 `cid` 没有 `vid` 时官方解析放弃
  - 修复：`qqVideoResolve` 缺 vid 时新增 `qqExtractVidFromPage`，抓取 m.v.qq.com 页面从 HTML 提取 vid 后再走 getinfo 官方接口

### 验证
- 用户原始未编码 URL（此前 404）→ **code 200 命中 mp4 直链**
- 只有 cid（无 vid）→ **code 200**（页面提取 vid 兜底生效）
- 已编码完整 URL / B站 / `/sniff` / `/api.php` 兼容路由 → 全部 200，成功链路不受影响

## [2.4.6] - 2026-08-19

### 配置收敛到 .env：node.js / api.php 自动跟随实际运行端口（更新后无需再手动改）

### Added
- 📄 node.js 新增轻量 `.env` 自动加载：启动时读取项目根目录 `.env`（已存在的环境变量优先，不覆盖），`MX_PORT` / `MX_ADMIN_USER` / `MX_ADMIN_PASS` / `MX_PLAYER_HOST` 等只需在 `.env` 维护一份，源码更新后无需再手动改 node.js 里的默认值
- 🧭 node.js 启动时把实际监听端口写入 `.mx_runtime.json`（`{port, host, updatedAt}`），供同机部署的 api.php 自动跟随
- 🔌 api.php 解析服务地址改为自动解析，优先级：`MX_PLAYER_HOST` 环境变量 > `.env` > `.mx_runtime.json` 实际端口 > 兜底 `http://127.0.0.1:1314`
  - 同机部署时，Node 换端口只需改 `.env`（或启动参数），api.php 自动跟随，不再需要每次更新改 api.php 第 67 行的硬编码 `http://122.51.166.115:1314`

### Changed
- 🛡️ `PROTECTED_FILES` 白名单新增 `.env`：在线更新（git/zip 两种方式）都不会覆盖本机 `.env`，运行配置稳定保留

### Fixed
- ✅ 消除「每次更新都要手动改 node.js 端口/账号、api.php 转发地址」的痛点

## [2.4.5] - 2026-08-19

### 万能嗅探批量失败过多修复（单独调用成功、批量失败）

### Fixed
- 🐛 修复容器环境下低内存降级失效导致批量 OOM 杀进程
  - 根因：容器内 `os.totalmem()` 返回宿主内存（如 6GB），而 cgroup 实际限制只有 4GB，导致浏览器池按 3 实例 × 5 页规模启动，批量并发渲染时内存溢出被 cgroup 杀进程，整批请求全部失败
  - 修复：新增 `getCgroupMemLimitMB` / `getCgroupMemUsedMB`，从 `/sys/fs/cgroup/memory.max`（v2）或 `memory/memory.limit_in_bytes`（v1）读取真实内存预算；4GB 级容器浏览器池收紧到 2 实例 × 3 页
- 🐛 修复批量调用时 18 个 Provider 全部走浏览器渲染导致内存峰值过高
  - 修复：新增 `MX_UNIVERSAL_BROWSER_CONC`（默认 2）独立信号量 `universalBrowserSem`，万能嗅探路径同时渲染最多 2 个；主解析路径不受影响
  - 加固：渲染前检查 cgroup 内存使用率，超过 85% 自动跳过浏览器兜底（宁缺毋滥），避免整进程 OOM
- 🐛 修复失败结果被长缓存成「永久失败」
  - 根因：嗅探失败（空结果）与成功结果同用 3600s 长缓存，Provider 临时故障会被缓存 1 小时，导致一段时间内同样 URL 全部失败
  - 修复：`LRUCache` 支持单条目 TTL 覆盖，成功结果仍按完整 TTL 缓存，失败结果仅缓存 `MX_UNIVERSAL_EMPTY_TTL`（默认 60s），临时故障可快速恢复
- 🐛 修复 Chrome 路径配置错误导致浏览器兜底不可用
  - 修复：`checkChrome` 优先使用 puppeteer 自动安装的 Chrome（`puppeteer.executablePath()`），`MX_CHROME_PATH` 配置路径不存在时自动回退到 puppeteer 缓存目录
- ✅ 验证：并发 10 × 3 轮批量压测 30/30 全部成功（此前批量会 OOM 整片失败），峰值内存 3317MB（此前 3884MB），服务全程存活；成功链路（B站官方解析）保持 100% 成功率，失败优化与成功链路完全隔离

## [2.4.4] - 2026-08-19

### 更新时保护本地环境配置文件（.user.ini 不随源码更新覆盖）

### Fixed
- 🛡️ 更新时不再覆盖本机 `.user.ini`（PHP 环境配置，各服务器不同）
  - 根因：`.user.ini` 被 git 跟踪，git 方式源码更新执行 `git reset --hard origin/<branch>` 时会把该文件重置为远端版本，导致本机 PHP 配置（上传大小 / 内存限制等）被清掉
  - 修复：新增 `PROTECTED_FILES` 白名单（`.user.ini`），git 方式在 `reset --hard` 前备份本地副本、重置后恢复；zip 方式从替换列表移除，天然不覆盖
  - 效果：更新源码时，`.user.ini` 始终保留本机配置，不受远端影响

## [2.4.3] - 2026-08-19

### /api.php 兼容路由（修复 Cannot GET /api.php）

### Added
- 🌐 新增 `/api.php` 兼容路由：与 `/node.js` 共用同一解析逻辑，支持 `http://IP:端口/api.php?url=<视频链接>` 调用方式
  - 背景：项目附带的 `api.php` 是 PHP 文件，需在 PHP 环境（宝塔/Nginx+PHP）部署，Node 服务无法直接执行
  - 修复：`/api.php` 与 `/node.js` 等价，`Cannot GET /api.php`（Express 404）不再出现

## [2.4.2] - 2026-08-19

### 源码更新改为 git 直接拉取 + 修复更新后服务自动关闭

### Changed
- 🔀 源码更新方式改为 **git 直接拉取 GitHub 对应分支代码**（目录为 git 仓库时）：`git fetch origin <branch>` → 读取远端 `package.json` 做版本递增保护 → `git reset --hard origin/<branch>` 同步最新代码，只影响所选分支（cs1 / main），不再依赖 Release 源码包下载解压
- 📦 非 git 仓库（zip 解压部署）时回退到 Release 源码包下载解压，两种部署方式均可更新

### Fixed
- 🐛 修复更新完成后服务自动关闭的问题：`restartServer` 检测运行方式——systemd 托管直接退出由 `Restart=always` 拉起、PM2 托管由 `autorestart` 拉起、裸跑（前台/nohup）才 spawn detached 新进程接管，避免守护进程 + 新进程抢端口冲突导致服务关停
- 🐛 修复已是最新版本时点击「更新源码」仍会重启服务的问题：`/admin/api/update` 路由根据 `updateSource` 返回的 `skipped` 标记判断，已是最新时不再触发重启，提示「已是最新版本，无需更新」

## [2.4.1] - 2026-08-19

### 修复后台 /admin 页面缺失「在线更新」功能

### Fixed
- 🐛 修复管理后台 `/admin` 页面看不到「在线更新」功能的问题
  - 根因：`node.js` 的 `/admin` 路由直接返回内置的 v2.2 精简页，而独立的 `admin.html`（含「更新源切换 + 在线更新」）从未被 Web 服务加载，导致后台只显示状态卡片 / 解析测试，没有更新入口
  - 修复：`/admin` 路由改为优先读取并返回独立的 `admin.html`（更新源切换：🛡️ 稳定版 main / 🧪 先行版 cs1；浏览器更新 / 源码更新 / 一键升级），文件缺失（如更新过程中被替换）时回退到内置页，保证后台始终可用
  - 效果：后台恢复完整在线更新能力，选择「先行版」即可把本机源码远程升级到 cs1 分支最新包（main 分支代码不受影响）

## [2.4.0] - 2026-08-19

### 官方视频平台专用解析器（腾讯 / B站 / 搜狐）

### Added
- 🎬 在腾讯视频解析基础上，新增 **B站（bilibili.com）**、**搜狐视频（sohu.com）** 两家官方解析器，统一由 `officialVideoResolve()` 入口依次尝试，命中即优先返回直链（不占用浏览器嗅探 / Provider 并发）
  - **B站**：从 URL 提取 `bvid`，先调 `api.bilibili.com/x/web-interface/view` 拿 `cid`，再调 `x/player/playurl?qn=80&fnval=0&fourk=1` 取单文件 mp4/flv 直链（含 `backup_url` 备用源），无登录自动降级清晰度
  - **搜狐**：从 `/v/` base64 路径段解码提取 `vid`，调 `api.tv.sohu.com/v4/video/info/{vid}.json?plat=6&pt=5` 取 `download_url` 直链（`data.vod.itc.cn` 视频 CDN 域名白名单校验）
- 🔒 平台识别与失败回退：URL 域名不匹配或官方接口失败一律返回 null，自动回退到浏览器嗅探 / 万能嗅探，不影响其他站点
- 🧪 实测验证：`/node.js`、`/sniff` 对 B站（BV1xx411c7mD → bilivideo.com mp4 直链 3 条）、搜狐（1390002 → data.vod.itc.cn 直链）均返回 code 200

## [2.3.0] - 2026-08-19

### 腾讯视频专用解析（官方 getinfo 直链）+ cs1 先行版远程更新源码

### Added
- 🎬 新增腾讯视频专用解析器 `qqVideoResolve`：从播放页 URL 提取 `vid`，直连腾讯官方 `vv.video.qq.com/getinfo` 接口拼接带 `vkey` 的直链播放地址（`platform=11001&fmt=hd`），`/node.js`、`/sniff` 接口优先命中。解决腾讯视频防盗链严格、第三方解析站拿不到可播地址的问题，也避免把 RPC 接口地址当播放链接返回
- 🔀 发布 cs1 先行版 v2.3.0 Release（含 `super-sniffer-source_2.3.0-cs1.zip` 源码包）：后台「更新源」切到先行版（cs1 分支）后点「更新源码」，即可远程升级到本版本，与稳定版（main 分支）互不干扰

## [2.2.3] - 2026-08-19

### 修复万能嗅探误抓接口地址当播放链接（如腾讯视频 GetNewMsgCount）

### Fixed
- 🐛 修复 `https://vip.video.qq.com/rpc/trpc.*.GetNewMsgCount` 这类 RPC 接口地址被误判为播放链接的问题
  - 根因：视频扩展名正则 `\.webm` 无边界，把服务名 `.WebMessageService` 的前 5 个字符 `.webm` 误当作 `.webm` 扩展名，导致 `https://vip.video.qq.com/rpc/trpc.hongji_group.web_message.WebMessageService/GetNewMsgCount?...` 被判定为视频 URL 并返回给用户
  - 修复：`isVideoUrl` / `VIDEO_URL_REGEX` / `VIDEO_EXT_REGEX` 三处视频扩展名匹配均加「扩展名后不能跟字母数字」边界（`(?![a-z0-9])`），`.webm` 不再误匹配 `.webmessageservice` 等服务名
  - 加固：`isVideoUrl` 增加 `RPC_URL_RE` 黑名单，路径命中 `/rpc/`、`/trpc/`、`trpc.`、`getnewmsgcount`、`.js/.json/.css` 等接口/静态资源特征且无视频扩展名时直接排除

## [2.2.2] - 2026-08-19

### 修复宝塔面板部署启动崩溃（undici 版本兼容）

### Fixed
- 🐛 修复宝塔面板 Node v20 部署时 `node node.js` 启动崩溃：`TypeError: webidl.util.markAsUncloneable is not a function`
  - 根因：`undici` 8.0.3+ 已放弃支持 Node.js v20（官方要求 Node >=22.19.0），其无条件调用 Node 21 才引入的 `worker_threads.markAsUncloneable`，Node 20 上加载即崩溃
  - 修复：`undici` 从 `^8.10.0` 降级锁定为 `^7.25.0`（实测装 7.29.0），兼容 Node 20，`EnvHttpProxyAgent` 等所用 API 均在 7.2+ 提供，功能不受影响
  - 同步更新 `package-lock.json`，保证宝塔按 lock 安装时不会回退到 8.x

## [2.2.1] - 2026-08-19

### 在线更新系统加固（进度条 / 版本一致 / 大文件下载 / 版本递增保护）

### Added
- 📊 后台更新增加**下载进度条**：下载浏览器包/源码包时实时显示百分比与已下载/总大小（流式 SSE 推送 + 200ms 节流）
- 🛡️ 版本**递增保护**：源码更新仅在新版本号高于当前版本时执行，防止降级 / 同版本重复覆盖
- ✅ 大文件下载完整性校验：Content-Length 与实收字节数比对，不一致即判定失败重试

### Changed
- 🔄 `normalizeVersion()` 规范化版本号：去掉 `v` 前缀与 `-cs1` 分支后缀，保证 cs1 / main 两分支版本可正确比较（解决版本不一致导致的误判）
- ⬇️ 下载重试机制：失败自动重试 3 次（指数退避），配合 30 分钟响应体超时，解决大文件半途被掐断导致的下载失败
- 📡 `/admin/api/update` SSE 转发进度事件 + `X-Accel-Buffering: no` 关闭 nginx 缓冲，保证进度实时到达前端
- 🧭 `/admin/api/check-update` 改用 `findAsset()` 精确匹配 `-cs1` 资产，返回规范化基础版本号供前端展示
- 🌐 代理自动探测：未配置 `MX_PROXY` 时自动读取系统代理变量（`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 及小写），修复沙箱 / 内网环境「检查更新失败: fetch failed」的问题（与 node.js 的 `EnvHttpProxyAgent` 行为保持一致）

### Nginx 反向代理部署修复（400 Bad Request / Request Header Or Cookie Too Large）

### Fixed
- 🚫 新增 [deploy/nginx.conf](deploy/nginx.conf)：修复浏览器访问后台/嗅探页被 nginx 拦截报 `400 Bad Request - Request Header Or Cookie Too Large` 的问题
  - 根因：nginx 默认 `large_client_header_buffers 4 8k`（总 32KB），浏览器对同域累积较多 Cookie 时请求头超限
  - 修复：`large_client_header_buffers 8 32k` + `client_header_buffer_size 32k` 加大缓冲
  - 修复：`proxy_set_header Cookie ""` 剥离 Cookie（应用只依赖 `Authorization` Basic 认证，不依赖 Cookie），从源头消除 Cookie 过大
  - 适配：SSE 场景关闭 `proxy_buffering`、加大 `proxy_read_timeout`，保证嗅探进度实时推送

## [2.2.0] - 2026-08-18

### 浏览器池 v2 + PagePool 复用 + Provider 评分熔断 + 持久化 + 健康探针

### Added
- 🔧 MX_BROWSER_ENABLE 开关（默认 true，可关闭 Puppeteer 仅留万能嗅探）
- 🚀 initBrowserPool 并行启动（Promise.allSettled），3 个 Chromium 启动耗时从 15s 降到 6s
- 🧱 PagePool：每浏览器预建 MX_PAGE_POOL_SIZE 个 Page（默认 5），acquire/release 消除 150~400ms 建页开销；MX_PAGE_MAX_USE=50、MX_PAGE_IDLE_TIMEOUT=600s 双回收策略；about:blank + 清 cookie 状态重置
- 🩺 浏览器池健康检查（MX_BROWSER_HEALTH_INTERVAL=15s）：isAlive 巡检 + /proc/<pid>/status VmRSS > MX_BROWSER_MAX_MEM_MB(1200MB) 主动回收 + 原位复活 + 空闲 Page 补齐
- 🛡️ 共享拦截器（GLOBAL_BLOCK_RE / GLOBAL_BLOCK_HOST_RE）：只注册一次，避免反复绑定；response 命中 .m3u8 自动加入 bw._hits 提高成功率
- 💾 LRU 缓存 JSONL 持久化（MX_CACHE_PERSIST / MX_CACHE_DIR / MX_CACHE_FLUSH_INTERVAL）：解析/万能嗅探落盘 parse.jsonl、universal.jsonl，启动自动 loadFromDisk 热恢复
- 🎯 Provider 动态评分与熔断：ok/fail/hits/totalLat 统计，综合分 = successRate*1000 + hitRate*500 - avgLat/30；连续失败 MX_UNIVERSAL_CIRCUIT_BREAK=3 → 熔断 MX_UNIVERSAL_CB_COOLDOWN=30s；持久化 provider-score.json
- ⏩ runUniversalSniff 智能调度：splitProvidersTopK(MX_UNIVERSAL_TOPK_FIRST=10) Top10 先跑，熔断的排到尾并标记 skip
- 🧠 低内存降级（D1）：os.totalmem <1GB → 浏览器池 1/Page 2；<2GB → 池 2/Page 3
- 🧪 /healthz/live、/healthz/startup、/healthz/ready 三路独立探针，容器/K8s/PM2 友好
- 📦 package.json 新增 npm run setup（bash 1.sh）、npm run doctor（Chrome 存在性检查）；版本升至 2.2.0；keywords 扩展（browser-pool/page-pool/circuit-breaker/...）
- 🛠️ 1.sh：启动时若 MX_CHROME_PATH 指定路径已存在则直接 exit 0 免重下 200MB+

### Changed
- sniffVideoUrl() 改用 acquirePageWrapper() + bw.releasePage(holder)，不再每次 newPage/page.close；合并 bw._hits 响应捕获 URL
- /admin/api/status 与 / 健康检查 JSON 新增：pagePoolTotal / pagePoolBusy / memory.totalMB.freeMB / providerStats.rankedTop5 / universal.circuitBroken
- 启动大控制台新增【浏览器池 v2.2】与【缓存 & Provider】两个分区
- 数据结构：browserPoolStats()、acquirePageWrapper()、PageHolder 类

### Fixed
- 空 Chromium 环境：MX_BROWSER_ENABLE=false 或 未找到 Chrome 时，不再反复启动失败并阻塞启动；万能嗅探 HTTP 模式可继续服务
- Chromium 内存泄漏：单进程 RSS 超阈值主动换新；Page 使用次数/空闲过期双策略；profile dir 进程退出时清理

---

## [2.1.0] - 2026-08-18

### 新增

- **万能嗅探引擎（核心）**
  - 内置 18 个第三方 VIP / 通用解析接口（详见下表），支持自动路由
  - 5 种结果提取策略：`m3u8_regex`（正则提取 m3u8）、`json_field`（JSON 字段解析）、`iframe`（iframe 内嵌地址）、`src_attr`（video/source/src 属性）、`hybrid`（混合策略，多轮尝试）
  - 并发框架：`Promise.allSettled` + 可配置 `MX_SNIFF_CONCURRENCY`（默认 18 全并发），带超时 & 失败重试
  - 智能路由：按 URL 域名匹配接口能力表，过滤不支持的平台
  - 结果后处理：URL 去重、按响应速度/出现次数排名、HEAD 可达性校验（可选）
  - 统一失败码体系（4001/4003/4004/4008/4029/4500/4501/4502/5000/5003/5999）

- **内置 18 个万能嗅探接口清单（按提取类型分组）**

  | 编号 | 接口ID | 名称 | 类型 | 默认启用 | 说明 |
  |------|--------|------|------|----------|------|
  | 1 | p01_jsonplayer | JSONPlayer 通用解析 | json_field | 是 | 返回 data.url / data.playUrl |
  | 2 | p02_m3u8direct | M3U8 Direct API | m3u8_regex | 是 | 直接返回 m3u8 文本 |
  | 3 | p03_vipfast | VIP 快解析 v1 | json_field | 是 | 腾讯/爱奇艺/优酷支持较好 |
  | 4 | p04_parseryun | 云解析 Pro | hybrid | 是 | JSON 与 HTML 混合返回 |
  | 5 | p05_superparse | SuperParse 智能解析 | json_field | 是 | 自动选择上游节点 |
  | 6 | p06_playerapi | PlayerAPI 开放接口 | m3u8_regex | 是 | 响应包含 .m3u8? 完整链接 |
  | 7 | p07_vipjieda | VIP 解答组 | json_field | 是 | 国内接口，延迟低 |
  | 8 | p08_blparse | 蓝光云解析 | hybrid | 是 | 支持 iframe 跳转 |
  | 9 | p09_qqvideo | 腾讯专属解析 | json_field | 是 | 腾讯视频优化线路 |
  | 10 | p10_iqiyiparse | 爱奇艺专属解析 | json_field | 是 | 爱奇艺 CDN 直出 |
  | 11 | p11_youkup | 优酷极速解析 | json_field | 是 | 优酷专属线路 |
  | 12 | p12_mgtvparse | 芒果解析站 | m3u8_regex | 是 | 芒果 TV 优化 |
  | 13 | p13_leparse | 乐视/搜狐混合 | hybrid | 是 | 老平台覆盖 |
  | 14 | p14_bilibp | B 站非正式解析 | src_attr | 是 | 提取 video src 直链 |
  | 15 | p15_douyinp | 抖音/短视频解析 | json_field | 是 | 返回无水印直链或 m3u8 |
  | 16 | p16_ksplay | 快手解析 | json_field | 是 | 快手无水印 |
  | 17 | p17_globalp | 海外平台通吃 | hybrid | 是 | YouTube/Netflix 仅 demo 级 |
  | 18 | p18_embyext | Emby/Jellyfin 外部 | m3u8_regex | 是 | 兼容类 m3u8 源 |

- **万能嗅探 API 与流式接口**
  - 新增 `GET /sniff` 与 `POST /sniff`：支持 `detailed` 详细模式、`providers` 选择接口
  - 新增 `GET /admin/api/sniff-stream`：SSE 实时推送 18 接口逐次进度（start/progress/result/done）
  - 新增 `GET /admin/api/providers`：获取接口元数据列表、启用状态、当前统计

- **万能嗅探专用测试页 /admin/sniff**
  - Basic Auth 鉴权（同管理后台，走 `MX_ADMIN_USER` / `MX_ADMIN_PASS`）
  - 接口勾选器（18 个全可独立开关，全选/反选/默认）
  - 实时进度面板（SSE 驱动）：进度条 + 每接口状态灯 + ETA
  - 结果列表：速度排名、来源接口标签、耗时、出现次数、一键复制
  - 内嵌 HLS.js 试播器：点击「试播」直接播放对应 m3u8，黑屏/失败直观可见
  - 失败明细面板：按失败码分组 + 错误摘要，复制诊断信息

- **万能嗅探环境变量（9 个，第 8 大类 MX_ 变量）**

  | 变量 | 默认值 | 说明 |
  |------|--------|------|
  | MX_SNIFF_ENABLE | 1 | 启用万能嗅探（0=关闭 /sniff 路由） |
  | MX_SNIFF_TIMEOUT | 15000 | 单接口超时（毫秒） |
  | MX_SNIFF_CONCURRENCY | 18 | 最大并发数 |
  | MX_SNIFF_DEDUP | 1 | 结果 URL 去重 |
  | MX_SNIFF_RANK | speed | 排名策略：speed / count |
  | MX_SNIFF_MAX_RESULTS | 10 | 最大返回结果数 |
  | MX_SNIFF_RETRY | 1 | 失败重试次数 |
  | MX_SNIFF_HEADCHECK | 1 | 返回前 HEAD 检查 m3u8 可达性 |
  | MX_SNIFF_PROVIDERS | （空=全部） | 启用接口 ID，逗号分隔 |

- **状态 & 配置升级**
  - `/admin/api/status` 增加 `sniff` 字段：enabled、providers.total/enabled、timeoutMs、concurrency、累计 stats（success/fail/timeout）
  - `package.json` 升级至 `2.1.0`，keywords 新增 `universal-sniff` / `vip-parser` / `sse`，description 更新
  - 新增 `.env.example` 9 大类完整注释（服务/后台/浏览器/缓存/并发/更新/万能嗅探/PHP专属），万能嗅探部分列出 18 接口

### 修复

- 修复 `update.js` 下载大文件时 `arrayBuffer` 内存爆涨 → 改为流式写入（`undici` + `createWriteStream`）+ onProgress 回调
- 修复 update.js 未读 MX_ 前缀的 GITHUB / PROXY 变量 → 新增 `envS()` 工具统一 MX_ 优先
- 修复 SOURCE_FILES 缺失 `.env.example` → 更新列表覆盖 README/CHANGELOG/.gitignore/.user.ini/1.sh/.env.example 全部

### 优化

- 调整 EarlyReturn 与万能嗅探结果缓存：LRU key 分离 `parse:` 与 `sniff:` 命名空间
- README.md 全面升级到 v2.1：新增万能嗅探章节、性能对比表、9 大类环境变量、FAQ 新增 4 条万能嗅探问答

---

## [2.0.0] - 2026-08-18

### 新增

- **MX_ 变量系统**：所有环境变量支持 `MX_` 前缀，`envS(key, fallback)` 工具优先读取 `MX_<KEY>`，回退到 `<KEY>`，解决与其他系统变量冲突
- **Basic Auth 后台鉴权**：`/admin` 路由（含 admin.html / status / update / providers / sniff-stream / sniff 测试页）统一走 Basic Auth，账号 `MX_ADMIN_USER`（默认 admin）、密码 `MX_ADMIN_PASS`（默认 admin123）
- **LRU 缓存系统**：`MX_CACHE_ENABLE=1` 启用，最大 `MX_CACHE_MAX=1000` 条，过期 `MX_CACHE_TTL=3600` 秒，key 为 URL 哈希；命中直接返回跳过 Puppeteer
- **信号量并发控制**：`MX_SEMAPHORE_MAX=10` 限制同时解析请求数，超过排队，避免 Puppeteer 浏览器实例爆炸
- **EarlyReturn 提前返回**：`MX_EARLY_RETURN=1` 启用；网络请求拦截层捕获到 m3u8 立即返回，无需等待整页加载，平均速度提升 3~5 倍
- **新增日志字段**：解析日志增加 hitCache / semaphoreWaitedMs / earlyReturnLatencyMs 便于性能观测

### 变更

- `package.json` 主版本升至 `2.0.0`，engines.node 明确 `>=18.0.0`，scripts 新增 `check`
- node.js 内部拆分：`createBrowser() / parseWithCache() / acquireSemaphore() / tryEarlyReturn()` 模块化
- 更新源变量全面改用 MX_：`MX_GITHUB_OWNER` / `MX_GITHUB_REPO` / `MX_GITHUB_TOKEN` / `MX_PROXY`

### 修复

- 修复 Puppeteer 页面泄漏：`finally` 强制 `page.close()`，加入页面超时保护
- 修复并发解析时 Chrome profile 冲突：临时 user-data-dir 按 PID+序号独立创建

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
- 新增 `api.php` PHP 前端接口
  - cURL 转发请求到 Node.js 解析服务
  - 返回标准 JSON 格式（code/msg/url）
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

# 超级嗅探 (Super Sniffer) v2.6.3
基于 **PHP + Node.js (Puppeteer + Express)** 的视频 m3u8 地址解析服务 + **万能嗅探引擎**。输入视频页面链接或 VIP 播放链接，自动嗅探并返回可播放的 `.m3u8` 播放地址。v2.1 新增 **万能嗅探** 功能，内置第三方解析接口并发调用，5 种结果提取策略，SSE 流式进度推送，结果去重与速度排名。v2.2 新增「浏览器池 v2 + PagePool 预建复用 + 15s 巡检/RSS 回收原位复活 + Provider 动态评分熔断 Top10 优先 + LRU 持久化热恢复 + 低内存降级 + /healthz 三路探针」。v2.4 修复后台 `/admin` 页面恢复「更新源切换 + 在线更新」（稳定版 main / 先行版 cs1）。v2.4.6 新增 `.env` 自动加载：node.js / api.php 自动跟随实际运行端口，更新后无需再手动改端口/账号。v2.4.7 修复 url 未编码 `&` 导致腾讯视频链接解析不到：散落参数自动合并回 url + 只有 cid 时从页面提取 vid，原基础上增加成功返回。v2.4.8 Provider 全部执行：提前命中默认关闭，解析接口不再 skip 部分。v2.4.9 修复嗅探日志「命中 0 个 URL」+ 测试页官方平台大量未命中：SSE 补 urls 字段、前端按实际数量显示、官方解析优先、部署配置提前命中统一为 0。v2.5.0 管理后台新增「运行监控」看板：KPI 指标卡、系统资源渐变条 + 内存走势图、Provider 评分 Top5 榜单、配置/缓存详情、内嵌「快捷测试」工具，每 15s 真实数据自动刷新。v2.6.0 命中率专项优化：网络检索 + 渲染实测新增 4 条可靠线路（qianqi / bd.jx / fongmi / hls.one，现共 16 条）、官方优先多线路合并输出、浏览器渲染 iframe/SUIYI 链追踪、捕获 mp4/flv/ts 视频响应、孤儿 Chrome 自动清理防内存泄漏。v2.6.1 修复「更新后直接重启导致服务不启动」：在线更新完成后不再自动重启，改由手动重启生效，规避端口冲突/孤儿 Chrome 引发的启动失败。v2.6.2 修复「更新后依赖缺失服务起不来」：源码更新后自动对比新旧 package.json，依赖有变化自动 npm install 同步 node_modules，失败自动回滚旧源码，保证手动重启必然能正常拉起。v2.6.3 修复后台误报「服务离线」：移除对不存在 DOM 元素（stPort/stChrome/stVersion）的空引用，仪表盘渲染空安全化，后台正常显示「服务运行中」、检查更新不再报错。

## 功能特性

- 支持任意视频页面链接，自动提取 `.m3u8` 播放地址
- 通过 Puppeteer 无头浏览器加载页面，支持动态加载的视频地址
- 四种提取方式：网络请求拦截、响应体扫描、页面内容扫描、iframe 扫描
- 返回标准 JSON 格式，便于前端播放器直接对接
- 支持带查询参数的 m3u8 地址（如 `index.m3u8?token=xxx`）
- 内置管理后台，支持在线更新（浏览器更新 / 源码更新独立进行，一键升级）
- **v2 新增**：MX_ 变量系统、Basic Auth 后台鉴权、LRU 缓存、信号量并发控制、EarlyReturn 提前返回
- **v2.1 新增**：万能嗅探引擎（18 接口并发）、SSE 流式进度、去重与速度排名、试播功能、专用测试页 `/admin/sniff`
- **v2.2 新增**：
  - 🔧 MX_BROWSER_ENABLE 开关 + 浏览器池 v2 并行启动（3 Chromium 6s 拉起）
  - 🧱 PagePool 预建复用（消除 150~400ms 建页开销）+ MX_PAGE_MAX_USE / MX_PAGE_IDLE_TIMEOUT 双回收
  - 🩺 15s 健康巡检 + /proc/<pid>/status VmRSS 超 1200MB 原位复活
  - 🎯 Provider 动态评分（successRate*1000 + hitRate*500 - avgLat/30）+ 连续失败 3 次熔断 30s
  - ⏩ runUniversalSniff Top10 优先调度，整体 2~3s 更快出结果
  - 💾 LRU 缓存 JSONL 持久化，重启 loadFromDisk 热恢复（0 冷启动）
  - 🧠 低内存自动降级：<1GB → 池 1/Page 2；<2GB → 池 2/Page 3
  - 🧪 /healthz/live | /startup | /ready 三路独立探针，容器/K8s/PM2 友好
- **v2.3 新增**：
  - 🎬 官方视频平台专用解析器：腾讯 / B站 / 搜狐直连官方接口获取直链播放地址，解决防盗链（B站 bvid→playurl、搜狐 vid→download_url、腾讯 vid→getinfo）
  - 🔀 cs1 先行版发布更新包（资产带 `-cs1` 后缀），后台切「先行版」更新源即可远程升级源码
- **v2.4 新增**：
  - 🐛 修复后台 `/admin` 页面缺失「在线更新」的问题：`/admin` 路由改为优先加载独立 `admin.html`（文件缺失时回退内置页），恢复「更新源切换（🛡️ 稳定版 main / 🧪 先行版 cs1）+ 浏览器更新 / 源码更新 / 一键升级」，在线更新功能完整可用
  - 🔒 更新仅替换本机源码（下载所选分支的 Release 源码包），**不会改动 GitHub 上 main 分支**
- **v2.4.5 新增**：
  - 🐛 修复万能嗅探批量失败过多（单独调用成功、批量失败）：容器环境读取 cgroup 真实内存预算，4GB 级浏览器池由 3×5 收紧到 2×3，不再按宿主机内存误判导致批量 OOM 杀进程
  - 🧠 新增 `MX_UNIVERSAL_BROWSER_CONC`（默认 2）浏览器渲染独立信号量 + 内存超 85% 自动跳过渲染兜底，18 Provider 批量渲染不再内存飙升
  - 🗑️ 失败（空结果）短缓存 `MX_UNIVERSAL_EMPTY_TTL`（默认 60s），临时故障可快速恢复；成功结果仍长缓存
  - 🧭 Chrome 自动适配 puppeteer 安装目录，`MX_CHROME_PATH` 配置失效时不再断送浏览器兜底
  - ✅ 批量验证：并发 10 × 3 轮 30/30 成功、峰值内存 3317MB、服务全程存活；成功链路（官方解析）100% 不受影响
- **v2.4.6 新增**：
  - 📄 node.js 自动加载 `.env`：`MX_PORT` / `MX_ADMIN_USER` / `MX_ADMIN_PASS` / `MX_PLAYER_HOST` 只需在 `.env` 维护一份，更新源码后不再需要手动改 node.js 里的默认值
  - 🧭 node.js 启动时把实际端口写入 `.mx_runtime.json`，同机部署的 api.php 自动读取跟随 → **改端口只需改 `.env`，api.php 不用动**
  - 🔌 api.php 解析地址自动解析：环境变量 > `.env` > `.mx_runtime.json` 实际端口 > 兜底 `http://127.0.0.1:1314`，不再硬编码 `http://122.51.166.115:1314`
  - 🛡️ `.env` 加入更新受保护白名单：在线更新（git/zip）都不会覆盖本机 `.env`
- **v2.4.8 新增**：
  - 🔧 万能嗅探「提前命中」默认关闭（`MX_UNIVERSAL_EARLY_HITS=0`）：默认情况下 **18 家 Provider 全部执行**，不再因为命中 3 家就 skip 剩余接口，解析结果更全、可用性更高
  - 🎛️ 需要提速时可设 `MX_UNIVERSAL_EARLY_HITS=3` 恢复「命中 3 家即提前返回」
  - 🎨 管理后台 / 万能嗅探页 / 启动横幅当提前命中为 0 时显示「全部（不使用提前命中）」
- **v2.4.9 新增**：
  - 🐛 修复嗅探日志「✅ 命中 0 个 URL」显示错误：SSE `progress` 事件补充 `urls` 字段，前端改用 `data.count ?? urls.length` 显示真实命中数量
  - 🎬 嗅探测试页（`/admin/api/sniff-stream`）与 `/sniff` 官方解析优先：腾讯 / B站 / 搜狐直连官方接口，命中即直接返回，不再依赖第三方接口 → 官方平台链接不再大量「未命中」
  - 🔧 部署配置（PM2 `ecosystem.config.js` / systemd `super-sniffer.service` / `deploy/env.example.sh`）的 `MX_UNIVERSAL_EARLY_HITS` 统一改为 **0**，保证 18 家 Provider 全部执行（此前三处仍写死 3，命中 3 家就 skip 剩余 15 家）
  - 🐛 修复平台记忆 / 失败原因「记不住」：排序函数不再用 `new String()` 包装 Provider（Map 键身份不一致导致 `byDomain` / `failReasons` 记忆与熔断跨请求失效、统计文件重复累积），平台记忆排序、失败原因分析与熔断现在跨请求正确持久化
  - 🔍 `/sniff` 与 `/admin/api/sniff-stream` 新增 `official=0` 参数：跳过官方直连、强制跑全部 18 家 Provider，便于失败原因分析 / 第三方接口调试（腾讯等官方平台默认仍官方优先）
  - 📊 失败原因自动归类（`no-match` / `http-error` / `not-text` / `timeout` / `render-error` 等）并写入 `.mx_cache/provider-score.json`，`/admin/api/rules` 展示各平台推荐/备用/弱项/熔断 Provider 与失败原因分布
- **v2.5.0 新增**：
  - 📊 管理后台 `/admin` 新增「运行监控」看板：顶部渐变横幅（服务/版本/运行时长）+ KPI 指标卡（浏览器池 / 页面复用池 / 嗅探接口 / LRU 缓存）+ 系统资源渐变条（内存 / 浏览器池 / 空闲内存）+ 空闲内存 20 次采样走势图 + Provider 评分 Top5 榜单 + 万能嗅探配置 & 缓存详情
  - 🧪 内嵌「快捷测试」工具：输入视频链接即可一键调用「万能嗅探（/sniff）」或「单页解析（/node.js）」，结果内联格式化展示
  - 🔄 看板每 15s 拉取 `/admin/api/status` 真实数据自动刷新，全部指标实时可读，便于日常运维
- **v2.6.0 新增**：
  - 🔌 线路清洗与补充：网络检索 40+ 候选接口 → undici 代理连通性测试 → 真实 B 站视频 Puppeteer 渲染验证，新增 4 条可靠线路（`qianqi` / `bd.jx` / `fongmi` / `hls.one`，渲染实测命中 bilivideo 直链 + 0567890.xyz 缓存源），现共 **16 条**第三方线路
  - 🧭 官方优先多线路：`/sniff` 官方解析与第三方万能嗅探并行，官方命中优先、第三方命中线路一并去重合并输出（`urls` / `allUrls` / `providers` 均含官方行 + 第三方行），非 detailed 响应新增 `allUrls` 字段
  - 🕸️ 浏览器渲染 iframe/SUIYI 链追踪：主页面无命中时自动进入内嵌播放器 iframe（≤2 层）重新等待捕获，覆盖多层嵌套 / JS 动态注入链路
  - 📡 网络捕获增强：除 `.m3u8` 外同步捕获 `.mp4/.flv/.ts` 及无扩展名 CDN 视频响应（按媒体类型判定，避免误抓静态资源）
  - 🧹 孤儿 Chrome 进程自动清理：健康巡检时清理浏览器池外残留 Chrome，根治内存泄漏导致「渲染被跳过 → 命中率骤降」
- **v2.4.7 新增**：
  - 🐛 修复 `url` 参数未做 URL 编码时目标视频 URL 里的 `&` 被拆成独立参数导致参数丢失（如 `?url=...play?cid=xxx&vid=yyy` 的 `vid` 被拆走 → 腾讯解析缺 vid 返回 404）
  - 🔧 新增 `resolveVideoUrl`：自动把散落的、不属于服务自身参数（url/detailed/refresh/providers）的 query 参数合并回 url 查询串，恢复完整视频地址（腾讯 / 搜狐 / 爱奇艺等带 `&` 的平台链接同样受益）
  - 🎯 腾讯视频只有 `cid` 没有 `vid` 时，新增 `qqExtractVidFromPage` 抓取页面从 HTML 提取 vid 后再走 getinfo 官方接口，原基础上增加成功返回
  - ✅ 验证：原始未编码链接（此前 404）→ 200 命中 mp4 直链；只有 cid（无 vid）→ 200；已编码完整 URL / B站 / /sniff / /api.php 兼容路由 → 全部 200，成功链路不受影响
- **v2.4.4 新增**：
  - 🛡️ 更新时保护本地环境配置文件：`.user.ini`（PHP 环境配置，各服务器不同）不随源码更新覆盖，git 方式在 `reset --hard` 前后备份/恢复本地副本，zip 方式从替换列表移除，本机配置始终保留
- **v2.4.3 新增**：
  - 🌐 新增 `/api.php` 兼容路由：与 `/node.js` 共用同一解析逻辑，支持 `http://IP:端口/api.php?url=<视频链接>` 调用，解决 `Cannot GET /api.php`（Express 404）问题（附带的 `api.php` 为 PHP 文件，需在 PHP 环境部署；Node 服务内置等价接口）
- **v2.4.2 新增**：
  - 🔀 源码更新改为 **git 直接拉取 GitHub 对应分支代码**（git 仓库部署时）：后台选「稳定版 main / 先行版 cs1」，点「更新源码」即 `git fetch` + `git reset --hard origin/<branch>` 同步最新代码，只影响所选分支；非 git 仓库（zip 解压部署）自动回退到 Release 源码包下载解压
  - 🛡️ 修复更新完成后服务自动关闭：自动识别 systemd / PM2 / 裸跑，由守护进程拉起或 spawn 新进程接管，避免抢端口冲突
  - 🐛 修复已是最新版本时点「更新源码」仍重启服务的问题：已最新时提示「无需更新」，不再无意义重启
  - 🛡️ 在线更新健壮性加固：GitHub API 限流时自动从 Releases Atom Feed 兜底解析、`unzip` 缺失时 `python3` 解压兜底、临时目录预创建、写盘错误捕获不崩溃

### v2 性能优化对比表

| 特性 | v1.x | v2.0 | v2.1 | v2.2 |
|------|------|------|------|------|
| 单接口解析速度 | ~15s | ~5s（LRU+EarlyReturn） | ~5s | ~3s（PagePool + 响应捕获命中） |
| 最大并发请求 | 5（无限制可能崩溃） | 10（信号量控制） | 10（信号量控制） | 15（PagePool 总容量） |
| 缓存命中 | 无 | LRU 1000 条 | LRU 1000 条 | LRU 1000 条 + **JSONL 持久化热恢复 0 冷启动** |
| 配置方式 | 硬编码 + 零散 env | MX_ 变量统一管理 | MX_ 变量统一管理 | MX_ 变量统一管理（25+ 个变量） |
| 后台鉴权 | 无 | Basic Auth | Basic Auth | Basic Auth |
| 浏览器启动 | 串行 ~15s/单页 | 串行 ~15s/单页 | 串行 ~15s/单页 | **并行启动 6s（3 Chromium Promise.allSettled）** |
| 建页开销 | 150~400ms/次 | 150~400ms/次 | 150~400ms/次 | **PagePool acquire/release 0ms** |
| 浏览器健康 | 无（死了就挂） | 无（死了就挂） | 无（死了就挂） | **15s 巡检 + RSS 超限原位复活 0 downtime** |
| 万能嗅探接口 | 0 | 0 | **18 个内置接口** | **18 个内置接口** |
| 万能嗅探并发 | 0 | 0 | **18 路并发** | **18 路并发 + Top10 优先 2~3s 更快** |
| 万能嗅探提取策略 | 0 | 0 | **5 种**（m3u8正则/JSON字段/iframe/src属性/混合） | **5 种** + 共享拦截器自动入 bw._hits |
| 万能嗅探稳定性 | 0 | 0 | 失败直接返回 | **动态评分 + 连续失败 3 次熔断 30s 冷却** |
| 实时进度推送 | 无 | 无 | **SSE 流式**（/admin/api/sniff-stream） | **SSE 流式**（/admin/api/sniff-stream） |
| 结果去重与排名 | 无 | 无 | **按 URL 去重 + 响应速度排名** | **按 URL 去重 + 响应速度排名** |
| 专用测试页 | 无 | 无 | **/admin/sniff**（Basic Auth，试播内嵌） | **/admin/sniff**（Basic Auth，试播内嵌） |
| 低内存适配 | 无 | 无 | 无 | **自动降级：<1GB 池1/Page2；<2GB 池2/Page3** |
| 健康探针 | 无 | 无 | 无 | **/healthz/live | startup | ready 三路** |

## 版本号管理规则

本项目遵循**语义化版本**（MAJOR.MINOR.PATCH）递增规则：

- **每次修改更新**都必须递增版本号（PATCH 位 +1）：`v2.4.2 → v2.4.3 → v2.4.4 …`
- **PATCH 位最大为 99**：当版本达到 `2.4.99` 后再有修改，则进位到 `2.5.0`（MINOR +1，PATCH 归 0）
- **不允许出现 PATCH >= 100 的版本**（如 `2.4.100`）：这是错误格式，应进位为 `2.5.0`
- 功能新增 / 行为变更时按需提升 MINOR 位（如 `2.4.99 → 2.5.0`），重大不兼容变更提升 MAJOR 位
- 每次发版需同步更新：`package.json`、`package-lock.json`、`admin.html` 页脚、`CHANGELOG.md`、`README.md`，并重新打包对应分支的源码包
- 版本号统一为 `v<MAJOR>.<MINOR>.<PATCH>` 格式，先行版（cs1）Release 附加 `-cs1` 后缀

## 系统要求

- Node.js >= 18.0.0
- PHP >= 7.0（仅前端接口需要）
- Chrome / Chromium（项目内已打包 `chrome-linux64`，或使用系统浏览器）
- 内存建议 >= 512MB（万能嗅探 18 并发时约占用 200MB）
- 推荐配置：>= 2GB 内存 → 浏览器池 3 + PagePool 5（总 15 Page）可支撑 ~10 QPS

## 项目结构

```
超级嗅探/
├── 1.sh             # 一键解压浏览器脚本（v2.2：已存在直接 exit 0）
├── api.php          # PHP 前端接口（转发请求、提取 m3u8）
├── node.js          # Node.js 解析服务（Express + Puppeteer + 万能嗅探 + 浏览器池 v2）
├── update.js        # 在线更新模块（浏览器/源码独立更新，MX_ 变量）
├── admin.html       # 管理后台页面
├── package.json     # Node.js 依赖配置（v2.2：setup/doctor scripts，2.2.0）
├── .user.ini        # PHP 运行配置
├── .env.example     # 环境变量示例（9 大类 25+ MX_ 变量，v2.2 新增 14 个）
├── .env             # v2.4.6：本机运行配置（node.js/api.php 自动加载，更新不覆盖）
├── .mx_runtime.json # v2.4.6：node.js 启动时写入实际监听端口，api.php 自动跟随
├── .mx_cache/       # v2.2 新增：LRU 持久化目录（parse.jsonl/universal.jsonl/provider-score.json）
├── chrome-linux64/  # 解压后的 Chrome 浏览器（由 1.sh 生成）
└── node_modules/    # Node.js 依赖
```

## 快速开始

### 1. 一键解压浏览器

项目使用 Puppeteer 驱动 Chrome 解析页面。浏览器已内置在分发压缩包中，运行 `1.sh` 会自动解压到正确位置：

```bash
bash 1.sh
# 或（npm run setup）
npm run setup
```

脚本会自动完成以下操作：

- **v2.2 新增**：若 `MX_CHROME_PATH` 指定的路径已存在，直接 exit 0 免重下 200MB+
- 自动查找当前目录（或 `upload/`、`uploads/` 目录）下的浏览器压缩包
- 支持 `chrome-linux64.tar.xz`、`chrome-linux64.tar.gz`、`chrome-linux64.zip` 等格式
- 解压到项目根目录的 `chrome-linux64/` 并设置可执行权限
- 验证 Chrome 可运行，缺失系统依赖时自动尝试安装

也可以使用系统已安装的 Chrome，通过环境变量指定：

```bash
export MX_CHROME_PATH="/usr/bin/google-chrome"
npm run doctor   # 验证 Chrome 存在性
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量（可选）

复制 `.env.example` 为 `.env` 并根据需要修改，或直接在 shell 中导出：

```bash
cp .env.example .env
# 编辑 .env
```

**v2.4.6 起 node.js 会自动加载项目根目录的 `.env`**（已有环境变量优先，不覆盖），
且 `.env` 已加入更新受保护文件（在线更新不会覆盖它）——
**端口、后台账号等运行配置只需在 `.env` 维护一次，以后更新源码无需再手动改 node.js**。

### 4. 启动 Node.js 解析服务

```bash
npm start
# 或
node node.js
```

默认监听 `1314` 端口，可通过 `.env` 中的 `MX_PORT` 或环境变量修改：

```bash
MX_PORT=8080 node node.js
```

**v2.4.6 起**：服务启动时会把实际监听端口写入 `.mx_runtime.json`，供同机部署的 api.php 自动跟随。

**v2.2 启动控制台**新增两个分区：
- 【浏览器池 v2.2】显示 poolSize、warmup 结果、PagePool 总数、健康检查间隔
- 【缓存 & Provider】显示持久化目录、已从磁盘加载条目数、Provider 评分排名 Top5

### 5. 配置 PHP 前端接口

将 `api.php` 部署到 PHP 环境（如 Nginx + PHP-FPM）。

**v2.4.6 起 api.php 自动跟随 Node 实际运行端口**（同机部署场景）：
- 先读 `MX_PLAYER_HOST` 环境变量 / `.env`；都没有时读 `.mx_runtime.json` 取 Node 实际端口（`http://127.0.0.1:<端口>`）
- 因此 **换 Node 端口时，api.php 无需修改**；仅 PHP 与 Node 不同机时才需设置 `MX_PLAYER_HOST`：

```bash
export MX_PLAYER_HOST="http://127.0.0.1:1314"
```

## 环境变量

所有变量均支持 **MX_ 前缀**（优先读取 MX_ 版本，回退到无前缀版本）。

### Node.js 全部环境变量

| 分类 | 变量 | 默认值 | 说明 |
|------|------|--------|------|
| **服务** | MX_PORT | 1314 | Node.js 服务监听端口 |
| **服务** | MX_HOST | 0.0.0.0 | Node.js 服务绑定地址 |
| **服务** | MX_PLAYER_HOST | 空（自动跟随，兜底 `http://127.0.0.1:1314`） | PHP 前端指向的解析服务地址；留空则读 `.env` / `.mx_runtime.json` 自动跟随 Node 实际端口 |
| **后台** | MX_ADMIN_USER | admin | Basic Auth 后台用户名 |
| **后台** | MX_ADMIN_PASS | admin123 | Basic Auth 后台密码 |
| **浏览器** | MX_CHROME_PATH | `./chrome-linux64/chrome` | Chrome 可执行文件路径 |
| **浏览器** | MX_PARSE_TIMEOUT | 30000 | 页面加载超时（毫秒） |
| **浏览器** | MX_EXTRA_WAIT | 3000 | 加载完成后额外等待时间（毫秒） |
| **浏览器** | **MX_BROWSER_ENABLE** | **true** | **v2.2** 是否启用浏览器池（false=仅万能嗅探 HTTP 模式） |
| **浏览器** | **MX_BROWSER_POOL_SIZE** | **3** | **v2.2** 常驻 Chromium 进程数（<2GB 自动降级到 2，<1GB 到 1） |
| **浏览器** | **MX_BROWSER_WARMUP** | **true** | **v2.2** 启动时并行预热浏览器池（Promise.allSettled ~6s） |
| **浏览器** | **MX_BROWSER_MAX_MEM_MB** | **1200** | **v2.2** 单进程 RSS 上限 MB，超了健康巡检主动换新 |
| **浏览器** | **MX_BROWSER_HEALTH_INTERVAL** | **15** | **v2.2** 巡检间隔秒：isAlive + RSS + 原位复活 + Page 补齐 |
| **浏览器** | **MX_PAGE_POOL_SIZE** | **5** | **v2.2** 每浏览器预建 Page 数（总 Page = 池 × 此值） |
| **浏览器** | **MX_PAGE_MAX_USE** | **50** | **v2.2** 单 Page 复用次数上限，超了丢弃重建防污染 |
| **浏览器** | **MX_PAGE_IDLE_TIMEOUT** | **600** | **v2.2** Page 空闲超时秒（about:blank + 清 cookie 重置） |
| **缓存** | MX_CACHE_ENABLE | 1 | 是否启用 LRU 缓存（1=启用，0=禁用） |
| **缓存** | MX_CACHE_MAX | 1000 | LRU 缓存最大条目数 |
| **缓存** | MX_CACHE_TTL | 3600 | 缓存过期时间（秒） |
| **缓存** | **MX_CACHE_PERSIST** | **true** | **v2.2** LRU JSONL 持久化开关（重启热恢复） |
| **缓存** | **MX_CACHE_DIR** | **./.mx_cache** | **v2.2** 持久化目录（parse.jsonl/universal.jsonl/provider-score.json） |
| **缓存** | **MX_CACHE_FLUSH_INTERVAL** | **60** | **v2.2** 内存 dirty 记录批量落盘间隔秒 |
| **并发** | MX_SEMAPHORE_MAX | 10 | 最大并发解析请求数（信号量） |
| **并发** | MX_EARLY_RETURN | 1 | 是否启用 EarlyReturn 提前返回（1=启用） |
| **更新** | MX_GITHUB_OWNER | `ssmhdssmhd` | 在线更新的 GitHub 用户名 |
| **更新** | MX_GITHUB_REPO | `MXTX` | 在线更新的 GitHub 仓库名 |
| **更新** | MX_GITHUB_TOKEN | 空 | GitHub Token（私有仓库更新需要） |
| **更新** | MX_PROXY | 空 | 代理地址（如 `http://127.0.0.1:7890`） |
| **万能嗅探** | MX_SNIFF_ENABLE | 1 | 是否启用万能嗅探（1=启用） |
| **万能嗅探** | MX_SNIFF_TIMEOUT | 15000 | 单接口嗅探超时（毫秒） |
| **万能嗅探** | MX_SNIFF_CONCURRENCY | 18 | 万能嗅探最大并发数 |
| **万能嗅探** | MX_SNIFF_DEDUP | 1 | 是否启用结果 URL 去重（1=启用） |
| **万能嗅探** | MX_SNIFF_RANK | speed | 结果排序方式：`speed` 按响应速度 / `count` 按出现次数 |
| **万能嗅探** | MX_SNIFF_MAX_RESULTS | 10 | 最大返回结果数 |
| **万能嗅探** | MX_SNIFF_RETRY | 1 | 单接口失败重试次数 |
| **万能嗅探** | MX_SNIFF_HEADCHECK | 1 | 是否对返回 m3u8 做 HEAD 可达性检查（1=启用） |
| **万能嗅探** | MX_SNIFF_PROVIDERS | （内置18个，留空=全部） | 启用的接口ID列表，逗号分隔 |
| **万能嗅探** | **MX_UNIVERSAL_CIRCUIT_BREAK** | **3** | **v2.2** Provider 连续失败 N 次触发熔断 |
| **万能嗅探** | **MX_UNIVERSAL_CB_COOLDOWN** | **30** | **v2.2** 熔断冷却秒（半开试探 1 次） |
| **万能嗅探** | **MX_UNIVERSAL_PER_PROVIDER_CONC** | **2** | **v2.2** 单 Provider 同时请求上限（防限流） |
| **万能嗅探** | **MX_UNIVERSAL_TOPK_FIRST** | **10** | **v2.2** Top K 评分最高的 Provider 先跑（更快出结果） |

### PHP 专属环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| MX_PLAYER_HOST | 空（自动跟随 Node 实际端口，兜底 `http://127.0.0.1:1314`） | PHP 调用 Node.js 解析服务的地址；仅 PHP 与 Node 不同机时需显式设置 |
| MX_PHP_TIMEOUT | 30 | PHP cURL 超时时间（秒） |
| MX_PHP_SSL_VERIFY | 0 | PHP cURL 是否校验 SSL 证书（0=否，1=是） |

## 管理后台 & 在线更新

启动服务后，浏览器访问 **`http://<服务器IP>:1314/admin`** 进入管理后台，通过 Basic Auth 登录（默认账号 `admin` / 密码 `admin123`，可通过 `MX_ADMIN_USER` / `MX_ADMIN_PASS` 修改）。

### 后台功能

- **服务状态**：实时显示服务运行状态、监听端口、Chrome 版本、当前版本、缓存统计
- **v2.2 新增**：pagePoolTotal / pagePoolBusy / memory.totalMB.freeMB / providerStats.rankedTop5 / universal.circuitBroken
- **万能嗅探状态**：已启用接口数量、并发配置、累计成功/失败统计
- **更新源切换**：稳定版（`main` 分支）/ 先行版（`cs1` 分支）自由切换
- **浏览器更新**：仅更新 Chrome 浏览器，不影响源码与服务逻辑
- **源码更新**：仅更新项目源码（`node.js`、`api.php`、`admin.html` 等），不影响浏览器
- **一键升级**：先更新浏览器，再更新源码，全自动完成

### 万能嗅探测试页（/admin/sniff）

启动服务后访问 **`http://<服务器IP>:1314/admin/sniff`**（同样需要 Basic Auth）。

**测试页功能：**

- **输入框**：粘贴 VIP 播放链接或任意视频页 URL
- **接口选择器**：勾选/取消勾选本次使用的 18 个接口，支持全选/反选
- **详细模式开关**：开启后返回 perProvider 明细（每接口成功/失败码/耗时/原始返回）
- **SSE 实时进度条**：18 个接口并发执行，逐接口推送 `pending → running → success/fail` 状态，显示进度百分比与 ETA
- **结果列表**：按速度排名、URL 去重，展示 m3u8 地址、来源接口、耗时、出现次数
- **一键试播**：每条结果旁有「试播」按钮，页面内嵌 HLS.js 播放器，点击直接播放验证
- **失败统计**：失败接口展示失败码（详见下 API 章节）与错误摘要，便于诊断

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
- 下载支持代理（`MX_PROXY`）与流式进度回调
- 📊 **下载进度条**：后台一键升级/独立更新时实时显示下载百分比与已下载/总大小（流式 SSE + 节流推送）
- 🛡️ **版本递增保护**：源码更新仅在新版本号高于当前版本时执行，防止降级 / 同版本重复覆盖
- 🔄 **版本规范化**：`v2.2.1-cs1` 等分支版本自动归一为 `2.2.1` 参与比较，保证 cs1 / main 两分支版本一致可比较
- ⬇️ **大文件下载容错**：失败自动重试 3 次（指数退避），30 分钟响应体超时 + Content-Length 完整性校验，避免大文件半途截断导致下载失败

### 更新接口

```
GET  /admin                        # 管理后台页面（Basic Auth）
GET  /admin/sniff                  # 万能嗅探测试页（Basic Auth）
GET  /admin/api/status             # 服务状态 + 万能嗅探统计 + v2.2 PagePool/内存/Provider
GET  /admin/api/update-source      # 获取当前更新源
POST /admin/api/update-source      # 切换更新源（body: {"source":"stable"|"beta"}）
GET  /admin/api/check-update       # 检查更新（对比所选分支最新版本）
POST /admin/api/update             # 执行更新（body: {"type":"browser"|"source"|"all"}）
GET  /admin/api/providers          # 获取万能嗅探接口列表（可用/已启用/配置 + v2.2 评分/熔断状态）
GET  /admin/api/sniff-stream       # SSE 万能嗅探（Query: url,detailed,providers）
```

## API 接口

### 1) /node.js — 单页 m3u8 解析（Puppeteer）

```
GET /node.js?url=<视频页面地址>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url  | string | 是 | 视频页面链接（需 URL 编码） |

返回格式：

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

### 2) /sniff — 万能嗅探（18 接口并发 + v2.2 评分熔断 Top10 优先）

```
GET  /sniff?url=<VIP/视频链接>&detailed=1&providers=p1,p2,p3
POST /sniff  body: {"url":"...","detailed":true,"providers":["p1","p2"]}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | VIP 播放链接或任意视频页 URL（需 URL 编码） |
| detailed | int/boolean | 否 | 1/true=返回 perProvider 明细，默认 0 |
| providers | string/array | 否 | 启用的接口 ID 列表（逗号分隔字符串或数组），留空=全部 |

**返回示例（detailed=1）：**

```json
{
  "code": 200,
  "url": "https://example.com/video/index.m3u8",
  "results": [
    {
      "url": "https://cdn1.example.com/play.m3u8",
      "provider": "p3_jsonplayer",
      "latencyMs": 842,
      "hitCount": 2,
      "headOk": true
    },
    {
      "url": "https://cdn2.example.com/vod/abc.m3u8?sign=xyz",
      "provider": "p7_m3u8_api",
      "latencyMs": 1523,
      "hitCount": 1,
      "headOk": true
    }
  ],
  "perProvider": {
    "p1_example": { "status": "success", "latencyMs": 1012, "raw": "..." },
    "p2_parserxx": { "status": "fail", "failCode": 5003, "error": "空响应", "latencyMs": 300 },
    "p3_jsonplayer": { "status": "success", "latencyMs": 842, "matches": ["https://cdn1.example.com/play.m3u8"] }
  },
  "summary": {
    "total": 18,
    "success": 6,
    "fail": 12,
    "timeout": 3,
    "deduped": 11,
    "elapsedMs": 4829,
    "circuitBroken": ["p05_superparse"],
    "topKFirst": 10
  }
}
```

**失败码（perProvider[].failCode）：**

| 失败码 | 含义 |
|--------|------|
| 4001 | 参数无效（接口本身返回参数错误） |
| 4003 | 接口鉴权失败（需要 key/签名，未配置） |
| 4004 | 该接口不支持此 URL/平台 |
| 4008 | 接口请求超时（超过 MX_SNIFF_TIMEOUT） |
| 4029 | 接口频率超限 / 被限流 |
| 4500 | 提取失败：响应为空或无法解析 |
| 4501 | 提取失败：响应中未匹配到 m3u8 / 播放地址 |
| 4502 | 提取失败：HEAD 检查不可达（仅 MX_SNIFF_HEADCHECK=1 时） |
| 5000 | 网络错误（DNS/连接失败/SSL 等） |
| 5003 | 接口服务异常（HTTP 5xx 或空响应体） |
| 5999 | 未知错误（含未捕获异常） |

### 3) /admin/api/sniff-stream & /admin/api/providers

**SSE 流式进度（/admin/api/sniff-stream）**

```
GET /admin/api/sniff-stream?url=<URL>&detailed=1&providers=p1,p2
```

返回 `text/event-stream`，事件类型：

| event | data 字段 | 说明 |
|-------|-----------|------|
| `start` | `{"total":18,"providers":[...]}` | 开始执行，总接口数与列表 |
| `progress` | `{"id":"p1","status":"running","elapsedMs":0}` | 某接口进入运行中 |
| `progress` | `{"id":"p1","status":"success","latencyMs":842,"matches":[...]}` | 某接口成功 |
| `progress` | `{"id":"p2","status":"fail","failCode":4008,"error":"超时"}` | 某接口失败 |
| `progress` | `{"id":"p5","status":"skip","reason":"circuit_break"}` | **v2.2** 熔断跳过 |
| `result` | （同 /sniff 返回） | 全部完成，推送最终汇总结果 |
| `done` | `{}` | 结束标记 |

**万能嗅探接口列表（/admin/api/providers）**

```
GET /admin/api/providers
```

返回：

```json
{
  "code": 200,
  "providers": [
    { "id": "p1", "name": "接口1", "type": "m3u8", "enabled": true, "url": "https://...", "score": 1320, "ok": 45, "fail": 2, "consecutiveFail": 0, "circuitBroken": false },
    { "id": "p2", "name": "接口2", "type": "json", "enabled": true, "url": "https://...", "score": 880, "ok": 12, "fail": 5, "consecutiveFail": 3, "circuitBroken": true, "cbUntil": 1739999999999 }
  ],
  "total": 18,
  "enabled": 17,
  "rankedTop5": ["p1", "p3", "p7", "p12", "p6"],
  "circuitBroken": ["p2"]
}
```

### 4) /healthz — 健康探针（v2.2 新增）

三路独立探针，适配容器 / K8s / PM2 / systemd 健康检查。

**/healthz/live — 存活探针（Liveness）**

```
GET /healthz/live
```

进程在跑就 200，**不依赖**浏览器池 / 缓存。用于 K8s `livenessProbe`，死了就重启。

```json
// 200 OK
{ "status": "ok", "uptimeSec": 1234, "pid": 9876 }
```

**/healthz/startup — 启动探针（Startup）**

```
GET /healthz/startup
```

启动流程全部完成（浏览器池 warmup 成功 / 或 MX_BROWSER_ENABLE=false 跳过 / 缓存持久化 loadFromDisk 完成）才返回 200。启动中返回 503。用于 K8s `startupProbe`，慢启动保护。

```json
// 200 OK
{ "status": "ok", "startupDone": true, "browserPool": "ready", "cacheLoaded": 128 }

// 503 Service Unavailable
{ "status": "starting", "startupDone": false, "phase": "warmup_browser_pool" }
```

**/healthz/ready — 就绪探针（Readiness）**

```
GET /healthz/ready
```

服务**能正常接流量**才 200：浏览器池至少 1 个 alive & 有空闲 Page（或 MX_BROWSER_ENABLE=false）。用于 K8s `readinessProbe`，摘除异常 Pod。

```json
// 200 OK
{
  "status": "ok",
  "browserPool": { "total": 3, "alive": 3, "pagePoolTotal": 15, "pagePoolBusy": 2 },
  "memory": { "totalMB": 8192, "freeMB": 3200 },
  "providers": { "rankedTop5": ["p1","p3","p7","p12","p6"], "circuitBroken": [] }
}

// 503 Service Unavailable（浏览器池全挂）
{ "status": "unready", "reason": "browser_pool_all_dead", "browserPool": { "total": 3, "alive": 0 } }
```

### 5) /api.php — PHP 前端接口

```
GET /api.php?url=<视频页面地址>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 视频页面链接（需 URL 编码） |

返回格式与 Node.js `/node.js` 服务一致。底层通过 cURL 转发到 `MX_PLAYER_HOST` 指向的 Node.js 服务。

## 常见问题 FAQ

**Q: 提示 `无法获取解析页面`？**
A: 请确认 Node.js 解析服务已启动，且 `api.php` 中的 `MX_PLAYER_HOST` 指向正确的服务地址。可手动 `curl MX_PLAYER_HOST/admin/api/status` 验证。

**Q: 提示 `未找到播放链接`？**
A: 部分视频网站需要登录或存在反爬机制，可尝试更换视频源，或调整 `MX_EXTRA_WAIT` 等待时间。也可使用 `/sniff` 万能嗅探，从 18 个第三方接口并发获取播放地址。

**Q: 提示 `解析失败: ...`？**
A: 请检查 Chrome 是否可用。项目内已打包 `chrome-linux64`，也可通过 `MX_CHROME_PATH` 指定系统 Chrome。运行 `bash 1.sh` 可自动检查依赖。**v2.2 新增**：若环境无 Chromium，可设置 `MX_BROWSER_ENABLE=false`，仍可用万能嗅探 HTTP 模式继续服务。

**Q: 万能嗅探 `/sniff` 返回 `results: []` 怎么办？**
A: 建议：
1. 检查是否所有接口都失败：传入 `detailed=1` 查看 `perProvider` 每接口失败码；
2. 若大量 `failCode: 4008` 超时：调大 `MX_SNIFF_TIMEOUT`（如 20000~30000）；
3. 若大量 `failCode: 4029` 限流：降低 `MX_SNIFF_CONCURRENCY`（如 8~12）或加重试 `MX_SNIFF_RETRY=2`；
4. 若大量 `failCode: 5000` 网络错误：服务器可能无法访问境外接口，可设置 `MX_PROXY` 或通过 `MX_SNIFF_PROVIDERS` 仅启用国内可达接口。

**Q: `/admin/sniff` 打不开或返回 401？**
A: 该页面受 Basic Auth 保护，默认账号密码为 `admin` / `admin123`。请检查：
1. 浏览器是否弹出登录对话框，输入正确账号密码；
2. 若修改过 `MX_ADMIN_USER` / `MX_ADMIN_PASS`，使用新值登录；
3. 清除浏览器缓存的 Basic Auth 凭据后重试。

**Q: 万能嗅探返回的 m3u8 地址浏览器试播黑屏/加载失败？**
A: 原因可能：
1. 返回的地址带防盗链，仅特定来源可播放——该问题属于接口侧限制，可切换其他结果；
2. 节点服务器与你本地网络互通问题——点击结果旁「复制链接」本地 `curl -I` 检查；
3. m3u8 内 ts 分片不可达——HEAD 检查（`MX_SNIFF_HEADCHECK=1`）仅验证 m3u8 本身可达，不分片检查。

**Q: 能否只启用部分万能嗅探接口？**
A: 可以。两种方式：
1. 环境变量：`export MX_SNIFF_PROVIDERS="p1,p3,p7,p12"`（留空=全部18个）；
2. 调用参数：`GET /sniff?url=...&providers=p1,p3,p7,p12` 或测试页上手动勾选。

**Q: 为什么会自动降级浏览器池大小？（v2.2 新增）**
A: v2.2 启动时会读取 `os.totalmem()` 自动适配：
- **< 1GB 内存**（如低配 VPS / 小容器）：浏览器池强制 1 + PagePool 2，防止 Chromium 吃满内存 OOM；
- **< 2GB 内存**：浏览器池降为 2 + PagePool 3；
- **>= 2GB**：按 `MX_BROWSER_POOL_SIZE` / `MX_PAGE_POOL_SIZE` 默认值（3/5）走。
可在启动控制台【浏览器池 v2.2】分区看实际生效值，或 `/healthz/ready` 接口的 `browserPool` 字段。

**Q: 怎么判断 Provider 被熔断了？（v2.2 新增）**
A: 三种方式：
1. **API 接口**：`GET /admin/api/providers`，返回 `circuitBroken: true` 且带 `cbUntil`（到期时间戳 ms）；同时 `summary.circuitBroken` 直接列出所有熔断 ID；
2. **SSE 进度事件**：`/admin/api/sniff-stream` 里被熔断的 Provider 会发 `{"status":"skip","reason":"circuit_break"}`；
3. **sniff 结果 summary**：`/sniff` 返回的 `summary.circuitBroken` 数组列出本轮因熔断跳过的 ID。
熔断机制：连续 `MX_UNIVERSAL_CIRCUIT_BREAK=3` 次失败触发，冷却 `MX_UNIVERSAL_CB_COOLDOWN=30s` 后半开（放 1 次请求试探），成功则恢复，失败重新熔断。评分与熔断状态持久化到 `MX_CACHE_DIR/provider-score.json`，重启不丢。

## MIT 许可证

MIT License

Copyright (c) 2026 MXTX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

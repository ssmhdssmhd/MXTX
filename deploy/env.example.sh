#!/usr/bin/env bash
# 超级嗅探 v2.2 环境变量样例
# 用法：
#   cp deploy/env.example.sh .env
#   source .env
#   node node.js
# 或配合 ecosystem.config.js / super-sniffer.service 使用
# ------------------------------------------------------------

# ===== 服务 =====
export MX_PORT=1314
export MX_HOST=0.0.0.0
export MX_PLAYER_HOST="http://127.0.0.1:${MX_PORT}"

# ===== 后台（务必改掉默认账号密码）=====
export MX_ADMIN_USER=admin
export MX_ADMIN_PASS='请改成你的强密码'
export MX_ADMIN_AUTH=true

# ===== 浏览器池 v2.2 =====
export MX_BROWSER_ENABLE=true
export MX_CHROME_PATH=/workspace/chrome-linux64/chrome
export MX_BROWSER_POOL_SIZE=2          # 1GB VPS 建议 1；2GB 建议 2；4GB+ 建议 3
export MX_BROWSER_WARMUP=true
export MX_BROWSER_MAX_MEM_MB=1200      # 单 Chromium RSS 超阈值就换新
export MX_BROWSER_HEALTH_INTERVAL=15
export MX_PAGE_POOL_SIZE=5             # 每浏览器预建 Page 数
export MX_PAGE_MAX_USE=50              # 单页使用上限换新
export MX_PAGE_IDLE_TIMEOUT=600        # 秒，空闲过期

# ===== 嗅探 =====
export MX_PARSE_TIMEOUT=30000
export MX_EXTRA_WAIT=3000
export MX_USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

# ===== 缓存持久化 =====
export MX_CACHE_MAX=500
export MX_CACHE_TTL=1800
export MX_UNIVERSAL_CACHE_MAX=200
export MX_UNIVERSAL_CACHE_TTL=3600
export MX_CACHE_PERSIST=true
export MX_CACHE_DIR=/workspace/.mx_cache
export MX_CACHE_FLUSH_INTERVAL=60

# ===== 并发 =====
export MX_PARSE_CONCURRENCY=5
export MX_UNIVERSAL_CONCURRENCY=6
export MX_SNIFF_ONE_TIMEOUT=15000
export MX_UNIVERSAL_EARLY_HITS=3

# ===== 万能嗅探智能调度 =====
export MX_UNIVERSAL_ENABLE=true
export MX_UNIVERSAL_CIRCUIT_BREAK=3       # 连续失败次数熔断
export MX_UNIVERSAL_CB_COOLDOWN=30        # 熔断冷却秒数
export MX_UNIVERSAL_PER_PROVIDER_CONC=2   # 同一 Provider 同时请求上限
export MX_UNIVERSAL_TOPK_FIRST=10         # TopK 先跑，剩下的补跑

# ===== 更新 =====
export MX_AUTO_UPDATE=false
export MX_UPDATE_SOURCE=stable            # stable=main  beta=cs1（先行版）

# ===== PHP 专属 =====
export MX_PHP_TIMEOUT=25
export MX_PHP_SSL_VERIFY=0

/**
 * 超级嗅探 v2.2 PM2 配置
 * 使用：
 *   # 开发/快速
 *   pm2 start ecosystem.config.js
 *   # 指定配置
 *   cp deploy/env.example.sh .env && source .env && pm2 start ecosystem.config.js
 *   # 查看日志
 *   pm2 logs super-sniffer
 *   # 开机自启
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'super-sniffer',
      script: './node.js',
      cwd: __dirname,
      instances: 1,              // Puppeteer + 浏览器池在单进程管理，多实例会重复起 Chromium
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',  // 2~3 个 Chromium + Node 安全线
      env: {
        NODE_ENV: 'production',
        // ====== 服务 ======
        MX_PORT: 1314,
        MX_HOST: '0.0.0.0',
        MX_PLAYER_HOST: 'http://127.0.0.1:1314',
        // ====== 后台（强烈建议修改默认密码）======
        MX_ADMIN_USER: 'admin',
        MX_ADMIN_PASS: 'admin888',
        MX_ADMIN_AUTH: true,
        // ====== 浏览器池 v2.2 ======
        MX_BROWSER_ENABLE: true,
        MX_CHROME_PATH: '/workspace/chrome-linux64/chrome',
        MX_BROWSER_POOL_SIZE: 2,
        MX_BROWSER_WARMUP: true,
        MX_BROWSER_MAX_MEM_MB: 1200,
        MX_BROWSER_HEALTH_INTERVAL: 15,
        MX_PAGE_POOL_SIZE: 5,
        MX_PAGE_MAX_USE: 50,
        MX_PAGE_IDLE_TIMEOUT: 600,
        // ====== 万能嗅探 ======
        MX_UNIVERSAL_ENABLE: true,
        MX_UNIVERSAL_TIMEOUT: 10000,
        MX_UNIVERSAL_CONCURRENCY: 6,
        MX_UNIVERSAL_EARLY_HITS: 3,
        MX_UNIVERSAL_CIRCUIT_BREAK: 3,
        MX_UNIVERSAL_CB_COOLDOWN: 30,
        MX_UNIVERSAL_PER_PROVIDER_CONC: 2,
        MX_UNIVERSAL_TOPK_FIRST: 10,
        // ====== 缓存持久化 ======
        MX_CACHE_MAX: 500,
        MX_CACHE_TTL: 1800,
        MX_UNIVERSAL_CACHE_MAX: 200,
        MX_UNIVERSAL_CACHE_TTL: 3600,
        MX_CACHE_PERSIST: true,
        MX_CACHE_DIR: './.mx_cache',
        MX_CACHE_FLUSH_INTERVAL: 60,
        // ====== 更新 ======
        MX_UPDATE_SOURCE: 'stable' // stable=main, beta=cs1
      },
      // 健康探针：/healthz/ready 每 10s，失败 3 次自动重启
      healthcheck: {
        test: ['CMD-SHELL', 'curl -f http://127.0.0.1:1314/healthz/ready || exit 1'],
        interval: 10000,
        timeout: 5000,
        retries: 3
      }
    }
  ]
};

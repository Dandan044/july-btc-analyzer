// 代理地址：优先读 PROXY_URL 环境变量，未设则用默认值
const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const socksProxy = proxyUrl.replace(/^http/, 'socks5');

module.exports = {
  apps: [{
    name: 'btc-alert',
    script: './skills/btc-alert/engine.js',
    cwd: __dirname,
    
    // 自动重启配置
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    
    // Node.js 堆内存配置（2026-05-09: 默认堆仅8.85MB/93%使用率，扩至256MB）
    node_args: ['--max-old-space-size=256'],

    // 内存限制
    max_memory_restart: '500M',
    
    // 日志配置 - 统一合并到一个文件
    error_file: './logs/btc-alert.log',
    out_file: './logs/btc-alert.log',
    merge_logs: true,
    time: true,
    
    // 环境
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      LOG_LEVEL: 'INFO',
      PROXY_URL: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: socksProxy
    }
  }, {
    name: 'cron-name-cache',
    script: './scripts/cron-name-cache.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 5,
    restart_delay: 3000,
    error_file: './logs/cron-name-cache.log',
    out_file: './logs/cron-name-cache.log',
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai'
    }
  }, {
    name: 'cron-dispatcher',
    script: './scripts/cron-dispatcher.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 5,
    restart_delay: 3000,
    max_memory_restart: '200M',
    error_file: './logs/cron-dispatcher.log',
    out_file: '/dev/null',
    time: false,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      DISPATCHER_FALLBACK: '0',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: '*',
      PATH: [process.env.HOME, '.npm-global', 'bin'].join('/') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  }, {
    name: 'july-dashboard',
    script: './dashboard/server.js',
    args: '--port 3100',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 5,
    restart_delay: 3000,
    max_memory_restart: '200M',
    error_file: './logs/dashboard.log',
    out_file: './logs/dashboard.log',
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      PROXY_URL: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: socksProxy
    }
  }]
};
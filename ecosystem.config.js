module.exports = {
  apps: [{
    name: 'btc-alert',
    script: './skills/btc-alert/engine.js',
    cwd: '/root/.openclaw/workspace-july',
    
    // 自动重启配置
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    
    // 内存限制
    max_memory_restart: '500M',
    
    // 日志
    error_file: './logs/btc-alert-error.log',
    out_file: './logs/btc-alert-out.log',
    merge_logs: true,
    time: true,
    
    // 环境
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai'
    }
  }]
};
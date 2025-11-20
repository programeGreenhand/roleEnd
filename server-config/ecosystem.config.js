// PM2进程管理配置文件
module.exports = {
  apps: [{
    name: 'roleEnd',
    script: './testjs.js',
    instances: 'max', // 使用所有CPU核心
    exec_mode: 'cluster', // 集群模式
    
    // 环境变量
    env: {
      NODE_ENV: 'production',
      PORT: 8082
    },
    
    // 日志配置
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true, // 日志中显示时间戳
    
    // 性能配置
    max_memory_restart: '500M', // 内存超过500M自动重启
    
    // 文件监控（生产环境建议关闭）
    watch: false,
    ignore_watch: ['node_modules', 'logs', 'temp', 'server-config'],
    
    // 重启策略
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // 环境变量
    instance_var: 'INSTANCE_ID',
    
    // 启动参数
    node_args: '--max-old-space-size=512',
    
    // 健康检查
    health_check_url: 'http://localhost:8082/api/health',
    health_check_interval: 30000,
    
    // 优雅关闭
    kill_timeout: 5000,
    
    // 启动延迟（避免多个实例同时启动）
    listen_timeout: 3000
  }]
};
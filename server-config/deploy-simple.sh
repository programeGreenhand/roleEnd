#!/bin/bash

echo "🚀 RoleEnd 简化部署脚本"
echo "================================"

# 检查是否在项目目录
if [ ! -f "testjs.js" ]; then
    echo "❌ 错误：请在项目根目录运行此脚本（testjs.js所在目录）"
    exit 1
fi

PROJECT_DIR=$(pwd)
echo "📁 项目目录: $PROJECT_DIR"

# 1. 检查并安装Node.js
echo ""
echo "📦 步骤1: 检查Node.js..."
if ! command -v node &> /dev/null; then
    echo "⚠️  Node.js未安装，正在安装..."
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install nodejs -y
else
    echo "✅ Node.js已安装: $(node -v)"
fi

# 2. 检查并安装PM2
echo ""
echo "📦 步骤2: 检查PM2..."
if ! command -v pm2 &> /dev/null; then
    echo "⚠️  PM2未安装，正在安装..."
    sudo npm install -g pm2
else
    echo "✅ PM2已安装"
fi

# 3. 安装项目依赖
echo ""
echo "📦 步骤3: 安装项目依赖..."
npm install

# 4. 检查环境变量文件
echo ""
echo "📝 步骤4: 检查环境变量..."
if [ ! -f ".env" ]; then
    echo "❌ 错误：未找到.env文件"
    echo "请确保.env文件存在并包含所有必要配置"
    exit 1
else
    echo "✅ 找到.env文件"
fi

# 5. 创建日志目录
echo ""
echo "📁 步骤5: 创建日志目录..."
mkdir -p logs
chmod 755 logs
echo "✅ 日志目录已创建"

# 6. 创建PM2配置文件
echo ""
echo "📝 步骤6: 创建PM2配置..."
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'roleEnd',
    script: './testjs.js',
    instances: 1,
    exec_mode: 'fork',
    
    env: {
      NODE_ENV: 'production'
    },
    
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    
    max_memory_restart: '500M',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    kill_timeout: 5000
  }]
};
EOF
echo "✅ PM2配置已创建"

# 7. 停止旧进程并启动新进程
echo ""
echo "🚀 步骤7: 启动应用..."
pm2 delete roleEnd 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# 8. 设置PM2开机自启
echo ""
echo "🔧 步骤8: 设置开机自启..."
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $(whoami) --hp $(eval echo ~$(whoami))
pm2 save

echo ""
echo "================================"
echo "✅ 应用启动完成！"
echo ""
echo "📊 检查状态："
pm2 status
echo ""
echo "🔧 常用命令："
echo "  查看日志: pm2 logs roleEnd"
echo "  重启应用: pm2 restart roleEnd"
echo "  停止应用: pm2 stop roleEnd"
echo "  查看状态: pm2 status"
echo ""
echo "🌐 测试访问："
echo "  本地测试: curl http://localhost:8082/api/health"
echo "  如果本地能访问但公网不能，请检查："
echo "  1. 安全组是否开放8082端口"
echo "  2. 防火墙配置"
echo ""
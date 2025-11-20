#!/bin/bash

# RoleEnd 腾讯云服务器部署脚本
# 使用方法: chmod +x deploy.sh && ./deploy.sh

echo "🚀 开始部署 RoleEnd 到腾讯云服务器..."

# 检查是否以root用户运行
if [ "$EUID" -ne 0 ]; then 
    echo "⚠️  请使用 sudo 运行此脚本"
    exit 1
fi

# 设置变量
PROJECT_NAME="roleEnd"
PROJECT_DIR="/var/www/$PROJECT_NAME"
BACKUP_DIR="/var/backups/$PROJECT_NAME"
LOG_DIR="$PROJECT_DIR/logs"

# 创建项目目录
mkdir -p $PROJECT_DIR
mkdir -p $BACKUP_DIR
mkdir -p $LOG_DIR

# 备份现有项目（如果存在）
if [ -d "$PROJECT_DIR" ] && [ "$(ls -A $PROJECT_DIR)" ]; then
    echo "📦 备份现有项目..."
    BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"
    tar -czf $BACKUP_FILE -C /var/www $PROJECT_NAME
    echo "✅ 备份完成: $BACKUP_FILE"
fi

# 复制项目文件
echo "📁 复制项目文件..."
cp -r ./* $PROJECT_DIR/

# 设置文件权限
chown -R www-data:www-data $PROJECT_DIR
chmod -R 755 $PROJECT_DIR

# 复制Nginx配置
echo "🌐 配置Nginx..."
cp server-config/nginx.conf /etc/nginx/sites-available/$PROJECT_NAME

# 启用站点
if [ ! -f "/etc/nginx/sites-enabled/$PROJECT_NAME" ]; then
    ln -s /etc/nginx/sites-available/$PROJECT_NAME /etc/nginx/sites-enabled/
fi

# 测试Nginx配置
nginx -t
if [ $? -eq 0 ]; then
    echo "✅ Nginx配置测试通过"
    systemctl restart nginx
    systemctl enable nginx
else
    echo "❌ Nginx配置测试失败，请检查配置"
    exit 1
fi

# 安装PM2（如果未安装）
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装PM2..."
    npm install -g pm2
fi

# 复制PM2配置
cp server-config/ecosystem.config.js $PROJECT_DIR/

# 安装项目依赖
echo "📦 安装项目依赖..."
cd $PROJECT_DIR
npm install --production

# 检查环境变量文件
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "⚠️  未找到.env文件，请复制server.env.example并配置环境变量"
    cp server-config/server.env.example $PROJECT_DIR/.env
    echo "📝 请编辑 $PROJECT_DIR/.env 文件并设置正确的配置"
    exit 1
fi

# 启动应用
echo "🚀 启动应用..."
pm2 start $PROJECT_DIR/ecosystem.config.js

# 设置PM2开机自启
pm2 startup
pm2 save

# 显示部署状态
echo ""
echo "🎉 部署完成！"
echo ""
echo "📊 部署状态检查:"
echo "  PM2状态: $(pm2 list | grep $PROJECT_NAME | wc -l) 个实例运行"
echo "  Nginx状态: $(systemctl is-active nginx)"
echo "  项目目录: $PROJECT_DIR"
echo "  日志目录: $LOG_DIR"
echo ""
echo "🔧 常用命令:"
echo "  查看PM2日志: pm2 logs $PROJECT_NAME"
echo "  重启应用: pm2 restart $PROJECT_NAME"
echo "  停止应用: pm2 stop $PROJECT_NAME"
echo "  查看Nginx日志: tail -f /var/log/nginx/error.log"
echo ""
echo "🌐 访问地址:"
echo "  HTTP API: http://你的域名或IP/api"
echo "  WebSocket: ws://你的域名或IP/ws/chat"
echo "  临时文件: http://你的域名或IP/temp/"
echo ""
echo "✅ 部署完成！请确保防火墙已开放80和443端口"
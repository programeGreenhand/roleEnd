#!/bin/bash

# RoleEnd 腾讯云服务器部署脚本 - 适配 server-config 目录结构
# 使用方法: chmod +x deploy.sh && sudo ./deploy.sh

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
SERVER_CONFIG_DIR="./server-config"

# 检查 server-config 目录是否存在
if [ ! -d "$SERVER_CONFIG_DIR" ]; then
    echo "❌ server-config 目录不存在，请在项目根目录运行此脚本"
    exit 1
fi

# 1. 安装必要的软件
echo "📦 安装必要的软件包..."

# 安装 EPEL 仓库（如果还没安装）
if ! dnf repolist | grep -q epel; then
    echo "🔧 安装 EPEL 仓库..."
    dnf install epel-release -y
fi

# 安装 Nginx（如果还没安装）
if ! command -v nginx &> /dev/null; then
    echo "🔧 安装 Nginx..."
    dnf install nginx -y
fi

# 安装 Node.js（如果还没安装）
if ! command -v node &> /dev/null; then
    echo "🔧 安装 Node.js..."
    # 使用 NodeSource 仓库安装 Node.js 18
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
    dnf install nodejs -y
fi

# 2. 创建项目目录
echo "📁 创建项目目录..."
mkdir -p $PROJECT_DIR
mkdir -p $BACKUP_DIR
mkdir -p $LOG_DIR

# 3. 备份现有项目（如果存在）
if [ -d "$PROJECT_DIR" ] && [ "$(ls -A $PROJECT_DIR)" ]; then
    echo "📦 备份现有项目..."
    BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"
    tar -czf $BACKUP_FILE -C /var/www $PROJECT_NAME
    echo "✅ 备份完成: $BACKUP_FILE"
fi

# 4. 复制项目文件（排除 server-config 目录本身）
echo "📁 复制项目文件..."
# 复制除 server-config 外的所有文件
find . -maxdepth 1 -not -name "server-config" -not -name "." -exec cp -r {} $PROJECT_DIR/ \;

# 5. 复制 server-config 中的配置文件到项目目录
echo "📄 复制配置文件..."
cp $SERVER_CONFIG_DIR/ecosystem.config.js $PROJECT_DIR/
cp $SERVER_CONFIG_DIR/server.env.example $PROJECT_DIR/

# 6. 设置文件权限（OpenCloudOS 使用 nginx 用户）
echo "🔒 设置文件权限..."
chown -R nginx:nginx $PROJECT_DIR
chmod -R 755 $PROJECT_DIR
chmod 644 $PROJECT_DIR/.env 2>/dev/null || true

# 7. 配置 Nginx（针对 OpenCloudOS）
echo "🌐 配置 Nginx..."

# OpenCloudOS 使用 /etc/nginx/conf.d/ 目录
NGINX_CONF_DIR="/etc/nginx/conf.d"
NGINX_CONF_FILE="$NGINX_CONF_DIR/${PROJECT_NAME}.conf"

# 检查 Nginx 配置目录是否存在
if [ ! -d "$NGINX_CONF_DIR" ]; then
    echo "❌ Nginx 配置目录不存在: $NGINX_CONF_DIR"
    echo "🔧 创建目录..."
    mkdir -p $NGINX_CONF_DIR
fi

# 复制 Nginx 配置
if [ -f "$SERVER_CONFIG_DIR/nginx.conf" ]; then
    echo "📄 复制 Nginx 配置..."
    cp $SERVER_CONFIG_DIR/nginx.conf $NGINX_CONF_FILE
    echo "✅ Nginx 配置已复制到: $NGINX_CONF_FILE"
else
    echo "❌ 未找到 nginx.conf 文件"
    exit 1
fi

# 8. 配置防火墙
echo "🔥 配置防火墙..."
if systemctl is-active firewalld &> /dev/null; then
    firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --add-service=https
    firewall-cmd --reload
    echo "✅ 防火墙已配置"
else
    echo "ℹ️  firewalld 未运行，跳过防火墙配置"
fi

# 9. 测试并启动 Nginx
echo "🔧 测试 Nginx 配置..."
if nginx -t; then
    echo "✅ Nginx 配置测试通过"
    
    # 启动或重启 Nginx
    if systemctl is-active nginx &> /dev/null; then
        systemctl reload nginx
        echo "🔄 Nginx 服务已重载"
    else
        systemctl start nginx
        systemctl enable nginx
        echo "🚀 Nginx 服务已启动并设置为开机自启"
    fi
else
    echo "❌ Nginx 配置测试失败"
    exit 1
fi

# 10. 安装 PM2
echo "📦 安装 PM2..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
    echo "✅ PM2 已安装"
else
    echo "✅ PM2 已存在"
fi

# 11. 安装项目依赖
echo "📦 安装项目依赖..."
cd $PROJECT_DIR
npm install --production

# 12. 检查环境变量文件
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "⚠️  未找到 .env 文件"
    if [ -f "server.env.example" ]; then
        cp server.env.example $PROJECT_DIR/.env
        echo "📝 已创建 .env 文件，请编辑: $PROJECT_DIR/.env"
        echo "💡 请务必配置以下重要项："
        echo "   - JWT_SECRET"
        echo "   - 数据库连接信息"
        echo "   - OSS配置"
        echo "   - API密钥"
        echo "然后重新运行: pm2 restart roleEnd"
    else
        echo "❌ 未找到环境变量示例文件"
        exit 1
    fi
else
    echo "✅ 找到 .env 文件"
fi

# 13. 启动应用
echo "🚀 启动应用..."
cd $PROJECT_DIR

# 停止已存在的应用
pm2 delete $PROJECT_NAME 2>/dev/null || true

# 启动应用
pm2 start ecosystem.config.js

# 14. 设置 PM2 开机自启
echo "🔧 设置 PM2 开机自启..."
pm2 startup
pm2 save

# 15. 显示部署状态
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
echo "  查看Nginx日志: tail -f /var/log/nginx/error.log"
echo "  查看应用日志: tail -f $LOG_DIR/combined.log"
echo ""
echo "🌐 访问测试:"
echo "  应用状态: curl http://localhost/health"
echo "  API测试: curl http://localhost/api/"
echo "  根路径: curl http://localhost/"
echo ""
echo "⚠️  重要提醒:"
echo "  1. 请编辑 $PROJECT_DIR/.env 文件并配置所有必要的环境变量"
echo "  2. 确保防火墙和安全组已开放80端口"
echo "  3. 检查 PM2 和 Nginx 服务状态"
echo ""
echo "✅ 部署流程完成！"
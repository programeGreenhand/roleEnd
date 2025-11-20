# 🚀 RoleEnd 服务器部署指南

本目录包含将RoleEnd智能角色对话系统部署到腾讯云服务器所需的所有配置文件。

## 📁 文件说明

### 核心配置文件
- **`nginx.conf`** - Nginx反向代理配置，处理HTTP/HTTPS、WebSocket代理
- **`ecosystem.config.js`** - PM2进程管理配置，支持集群模式
- **`server.env.example`** - 服务器环境变量模板（复制为.env使用）
- **`deploy.sh`** - 自动化部署脚本

## 🔧 部署前准备

### 1. 服务器要求
- **操作系统**: Ubuntu 20.04 LTS / CentOS 8.x
- **配置**: 2核4GB内存，50GB硬盘
- **网络**: 公网IP，开放80/443端口

### 2. 环境准备
```bash
# 安装基础软件
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx nodejs npm mysql-server

# 安装PM2
sudo npm install -g pm2
```

## 🚀 快速部署

### 方法1: 使用自动化脚本
```bash
# 上传项目到服务器后
chmod +x server-config/deploy.sh
sudo ./server-config/deploy.sh
```

### 方法2: 手动部署
```bash
# 1. 复制项目文件
sudo cp -r . /var/www/roleEnd/

# 2. 设置权限
sudo chown -R www-data:www-data /var/www/roleEnd
sudo chmod -R 755 /var/www/roleEnd

# 3. 配置Nginx
sudo cp server-config/nginx.conf /etc/nginx/sites-available/roleEnd
sudo ln -s /etc/nginx/sites-available/roleEnd /etc/nginx/sites-enabled/

# 4. 配置环境变量
sudo cp server-config/server.env.example /var/www/roleEnd/.env
# 编辑.env文件，设置实际配置

# 5. 安装依赖
cd /var/www/roleEnd
sudo npm install --production

# 6. 启动服务
sudo pm2 start server-config/ecosystem.config.js
sudo pm2 startup
sudo pm2 save

# 7. 重启Nginx
sudo nginx -t && sudo systemctl restart nginx
```

## ⚙️ 环境变量配置

### 必须修改的配置
编辑 `/var/www/roleEnd/.env` 文件：

```env
# 服务器公网地址（重要！替换为你的域名或IP）
SERVER_PUBLIC_URL=https://your-domain.com

# CORS允许的域名（多个用逗号分隔）
ALLOWED_ORIGINS=https://your-frontend.com,https://your-domain.com

# 生产环境数据库（建议使用云数据库）
DB_HOST=your-production-db.com
DB_USER=roleend_user
DB_PASSWORD=your-secure-password

# 生产环境OSS配置
OSS_ACCESS_KEY_ID=your-production-key
OSS_ACCESS_KEY_SECRET=your-production-secret
OSS_BUCKET=roleend-production

# 强JWT密钥（至少32位随机字符串）
JWT_SECRET=your-very-long-and-secure-jwt-secret-key
```

## 🌐 网络配置

### Nginx反向代理
- **HTTP API**: `http://your-domain.com/api/*` → `http://localhost:8082/api/*`
- **WebSocket**: `ws://your-domain.com/ws/*` → `ws://localhost:8082/ws/*`
- **静态文件**: `http://your-domain.com/temp/*` → `/var/www/roleEnd/temp/*`

### 防火墙配置
```bash
# 开放必要端口
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

## 🔒 安全配置

### 1. 禁用root SSH登录
```bash
sudo adduser deployer
sudo usermod -aG sudo deployer

# 配置SSH密钥
sudo mkdir -p /home/deployer/.ssh
sudo vim /home/deployer/.ssh/authorized_keys

# 修改SSH配置
sudo vim /etc/ssh/sshd_config
```

修改以下配置：
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

### 2. 文件权限安全
```bash
# 确保敏感文件权限正确
sudo chmod 600 /var/www/roleEnd/.env
sudo chown www-data:www-data /var/www/roleEnd/.env
```

## 📊 监控和维护

### 查看服务状态
```bash
# PM2状态
pm2 status
pm2 logs roleEnd

# Nginx状态
systemctl status nginx
tail -f /var/log/nginx/error.log

# 系统资源
htop
df -h
```

### 备份策略
```bash
# 创建备份脚本
sudo vim /var/backups/backup_roleEnd.sh
```

添加以下内容：
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/roleEnd"

# 备份数据库
mysqldump -u $DB_USER -p$DB_PASSWORD $DB_DATABASE > $BACKUP_DIR/db_$DATE.sql

# 备份代码（排除node_modules）
tar -czf $BACKUP_DIR/code_$DATE.tar.gz --exclude=node_modules /var/www/roleEnd

# 删除7天前的备份
find $BACKUP_DIR -name "*.sql" -mtime +7 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete
```

设置定时任务：
```bash
# 每天凌晨2点执行备份
echo "0 2 * * * root /var/backups/backup_roleEnd.sh" | sudo tee -a /etc/crontab
```

## 🚨 故障排除

### 常见问题

#### 1. 端口被占用
```bash
# 检查端口占用
netstat -tulpn | grep :8082

# 重启PM2
pm2 restart roleEnd
```

#### 2. 数据库连接失败
```bash
# 检查MySQL服务
systemctl status mysql

# 测试数据库连接
mysql -u $DB_USER -p$DB_PASSWORD -h $DB_HOST -e "SHOW DATABASES;"
```

#### 3. 文件权限问题
```bash
# 修复权限
sudo chown -R www-data:www-data /var/www/roleEnd
sudo chmod -R 755 /var/www/roleEnd
```

#### 4. Nginx配置错误
```bash
# 测试配置
sudo nginx -t

# 查看错误日志
sudo tail -f /var/log/nginx/error.log
```

## 📞 技术支持

如果部署过程中遇到问题：

1. **查看日志**: `pm2 logs roleEnd`
2. **检查配置**: 确认.env文件配置正确
3. **网络测试**: 使用curl测试API接口
4. **防火墙**: 确认端口已开放

## ✅ 部署完成检查清单

- [ ] 服务器环境配置完成
- [ ] 项目文件上传完成
- [ ] 环境变量配置正确
- [ ] Nginx反向代理配置
- [ ] PM2进程管理配置
- [ ] 防火墙和安全配置
- [ ] 域名解析配置（如使用域名）
- [ ] SSL证书配置（推荐）
- [ ] 备份策略设置
- [ ] 服务启动和验证

---

**💡 提示**: 部署完成后，建议定期更新系统和依赖包，保持系统安全稳定运行。

**🔒 安全提醒**: 确保.env文件中的敏感信息不被泄露，定期更换密钥和密码。
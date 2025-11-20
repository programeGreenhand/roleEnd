# 🚀 RoleEnd 后端部署指南 - 腾讯云服务器

本指南详细说明如何将RoleEnd智能角色对话系统后端部署到腾讯云服务器上。

## 📋 部署前准备

### 1. 腾讯云服务器要求
- **操作系统**: Ubuntu 20.04 LTS 或 CentOS 8.x
- **配置**: 至少 2核4GB内存，50GB硬盘空间
- **网络**: 公网IP，开放所需端口

### 2. 域名和SSL证书（可选但推荐）
- 已备案的域名
- SSL证书（腾讯云可免费申请）

### 3. 服务账号准备
- 七牛云账号（语音服务）
- DeepSeek API账号
- 阿里云OSS账号（文件存储）

## 🔧 服务器环境配置

### 1. 连接服务器
```bash
ssh root@your-server-ip
```

### 2. 更新系统并安装基础工具
```bash
# Ubuntu/Debian
apt update && apt upgrade -y
apt install -y curl wget git vim nginx

# CentOS/RHEL
yum update -y
yum install -y curl wget git vim nginx
```

### 3. 安装Node.js 18+
```bash
# 方法1: 使用NodeSource仓库
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 方法2: 使用NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18
```

### 4. 安装MySQL 8.0
```bash
# Ubuntu/Debian
wget https://dev.mysql.com/get/mysql-apt-config_0.8.22-1_all.deb
dpkg -i mysql-apt-config_0.8.22-1_all.deb
apt update
apt install -y mysql-server

# CentOS/RHEL
wget https://dev.mysql.com/get/mysql80-community-release-el7-5.noarch.rpm
rpm -ivh mysql80-community-release-el7-5.noarch.rpm
yum install -y mysql-server

# 启动MySQL
systemctl start mysql
systemctl enable mysql
```

### 5. 配置MySQL安全
```bash
mysql_secure_installation

# 创建数据库和用户
mysql -u root -p
```

在MySQL中执行：
```sql
CREATE DATABASE rolesystem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'roleuser'@'localhost' IDENTIFIED BY 'your_secure_password';
GRANT ALL PRIVILEGES ON rolesystem.* TO 'roleuser'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

## 📦 项目部署

### 1. 上传项目文件
```bash
# 创建项目目录
mkdir -p /var/www/roleEnd
cd /var/www/roleEnd

# 上传文件（选择一种方式）
# 方式1: 使用Git（推荐）
git clone https://github.com/programeGreenhand/roleEnd.git .

# 方式2: 使用SCP上传
# 在本地执行：scp -r d:\roleEnd\* root@your-server-ip:/var/www/roleEnd/
```

### 2. 安装项目依赖
```bash
cd /var/www/roleEnd
npm install --production
```

### 3. 配置环境变量
```bash
# 创建.env文件
vim .env
```

将以下内容填入（根据实际情况修改）：
```env
# 服务配置
PORT=8082

# 数据库配置
DB_HOST=localhost
DB_USER=roleuser
DB_PASSWORD=your_secure_password
DB_DATABASE=rolesystem
DB_CONNECTION_LIMIT=10

# 七牛云配置
QINIU_API_KEY=your_actual_qiniu_api_key
QINIU_BASE_URL=https://openai.qiniu.com/v1

# DeepSeek配置
DEEPSEEK_API_KEY=your_actual_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# JWT配置
JWT_SECRET=your_secure_jwt_secret_at_least_32_chars
JWT_EXPIRES_IN=7d

# 阿里云OSS配置
OSS_REGION=oss-cn-shenzhen
OSS_ACCESS_KEY_ID=your_actual_access_key_id
OSS_ACCESS_KEY_SECRET=your_actual_access_key_secret
OSS_BUCKET=your_bucket_name
OSS_ENDPOINT=oss-cn-shenzhen.aliyuncs.com
```

### 4. 设置文件权限
```bash
chown -R www-data:www-data /var/www/roleEnd
chmod -R 755 /var/www/roleEnd
```

## 🌐 Nginx反向代理配置

### 1. 创建Nginx配置文件
```bash
vim /etc/nginx/sites-available/roleEnd
```

添加以下配置：
```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名
    
    # 静态文件服务
    location /temp/ {
        alias /var/www/roleEnd/temp/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    
    # API代理
    location /api/ {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    # WebSocket代理
    location /ws/ {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    
    # 根路径重定向
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS配置（可选但推荐）
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    
    # SSL安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # 复用上面的location配置
    location /temp/ {
        alias /var/www/roleEnd/temp/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    
    location /api/ {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    location /ws/ {
        proxy_pass http://localhost:8082;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 2. 启用站点配置
```bash
# 创建符号链接
ln -s /etc/nginx/sites-available/roleEnd /etc/nginx/sites-enabled/

# 测试Nginx配置
nginx -t

# 重启Nginx
systemctl restart nginx
systemctl enable nginx
```

## 🔄 进程管理配置

### 1. 使用PM2管理Node.js进程
```bash
# 安装PM2
npm install -g pm2

# 创建PM2配置文件
vim ecosystem.config.js
```

添加以下内容：
```javascript
module.exports = {
  apps: [{
    name: 'roleEnd',
    script: './testjs.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 8082
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    max_memory_restart: '500M',
    watch: false,
    ignore_watch: ['node_modules', 'logs', 'temp'],
    instance_var: 'INSTANCE_ID'
  }]
};
```

### 2. 启动应用
```bash
# 创建日志目录
mkdir -p logs

# 启动应用
pm2 start ecosystem.config.js

# 设置开机自启
pm2 startup
pm2 save
```

## 🔒 安全配置

### 1. 防火墙配置
```bash
# Ubuntu/Debian (ufw)
ufw allow ssh
ufw allow 80
ufw allow 443
ufw enable

# CentOS/RHEL (firewalld)
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

### 2. 禁用root登录（可选但推荐）
```bash
# 创建新用户
adduser deployer
usermod -aG sudo deployer

# 配置SSH密钥登录
mkdir -p /home/deployer/.ssh
vim /home/deployer/.ssh/authorized_keys

# 禁用密码登录和root登录
vim /etc/ssh/sshd_config
```

修改SSH配置：
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

重启SSH服务：
```bash
systemctl restart sshd
```

### 3. 定期备份
```bash
# 创建备份脚本
vim /var/backups/backup_roleEnd.sh
```

添加备份脚本：
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/roleEnd"
DB_BACKUP="$BACKUP_DIR/roleEnd_db_$DATE.sql"
CODE_BACKUP="$BACKUP_DIR/roleEnd_code_$DATE.tar.gz"

# 创建备份目录
mkdir -p $BACKUP_DIR

# 备份数据库
mysqldump -u roleuser -p'your_password' rolesystem > $DB_BACKUP

# 备份代码
tar -czf $CODE_BACKUP /var/www/roleEnd --exclude=node_modules --exclude=temp

# 删除7天前的备份
find $BACKUP_DIR -name "*.sql" -mtime +7 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

# 设置定时任务（每天凌晨2点执行）
echo "0 2 * * * root /var/backups/backup_roleEnd.sh" >> /etc/crontab
```

## 🧪 部署验证

### 1. 检查服务状态
```bash
# 检查PM2状态
pm2 status

# 检查Nginx状态
systemctl status nginx

# 检查MySQL状态
systemctl status mysql
```

### 2. 测试API接口
```bash
# 测试健康检查接口
curl http://localhost:8082/api/health

# 测试数据库连接
curl http://localhost:8082/api/characters
```

### 3. 检查日志
```bash
# 查看应用日志
pm2 logs roleEnd

# 查看Nginx访问日志
tail -f /var/log/nginx/access.log

# 查看错误日志
tail -f /var/log/nginx/error.log
```

## 🚨 故障排除

### 常见问题及解决方案

#### 1. 端口被占用
```bash
# 检查端口占用
netstat -tulpn | grep :8082

# 杀死占用进程
kill -9 <PID>
```

#### 2. 数据库连接失败
```bash
# 检查MySQL服务状态
systemctl status mysql

# 检查数据库用户权限
mysql -u roleuser -p -e "SHOW GRANTS;"
```

#### 3. 文件权限问题
```bash
# 修复文件权限
chown -R www-data:www-data /var/www/roleEnd
chmod -R 755 /var/www/roleEnd
```

#### 4. PM2进程异常
```bash
# 重启PM2进程
pm2 restart roleEnd

# 重新加载PM2配置
pm2 reload roleEnd

# 删除并重新添加
pm2 delete roleEnd
pm2 start ecosystem.config.js
```

## 📊 监控和维护

### 1. 系统监控
```bash
# 安装监控工具
apt install -y htop iotop iftop

# 实时监控
htop  # CPU和内存
iotop # 磁盘IO
iftop # 网络流量
```

### 2. 日志轮转
```bash
# 配置日志轮转
vim /etc/logrotate.d/roleEnd
```

添加配置：
```
/var/www/roleEnd/logs/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    copytruncate
}
```

### 3. 性能优化
```bash
# 优化MySQL配置
vim /etc/mysql/mysql.conf.d/mysqld.cnf
```

添加优化参数：
```ini
[mysqld]
innodb_buffer_pool_size = 256M
query_cache_size = 64M
max_connections = 100
```

## 🎯 部署完成检查清单

- [ ] 服务器环境配置完成
- [ ] Node.js和MySQL安装成功
- [ ] 项目文件上传完成
- [ ] 环境变量配置正确
- [ ] Nginx反向代理配置
- [ ] PM2进程管理配置
- [ ] 防火墙和安全配置
- [ ] 备份策略设置
- [ ] 服务启动和验证
- [ ] 域名解析配置（如使用域名）

## 📞 技术支持

如果部署过程中遇到问题，请检查：
1. 查看PM2日志：`pm2 logs roleEnd`
2. 检查Nginx错误日志：`tail -f /var/log/nginx/error.log`
3. 验证数据库连接
4. 检查防火墙设置

---

**💡 提示**: 部署完成后，建议定期更新系统和依赖包，保持系统安全稳定运行。

**🔒 安全提醒**: 确保.env文件中的敏感信息不被泄露，定期更换密钥和密码。
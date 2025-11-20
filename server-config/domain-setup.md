# 🌐 域名配置指南

## 1. 域名购买和解析

### 购买域名（推荐）
- **腾讯云**: dnspod.cn
- **阿里云**: wanwang.aliyun.com
- **Godaddy**: godaddy.com

### 域名解析配置

在域名管理后台添加以下DNS记录：

```
# A记录 - 将域名指向服务器IP
类型: A
主机记录: @
记录值: 你的服务器公网IP
TTL: 600秒

# 可选的子域名配置
类型: A
主机记录: api
记录值: 你的服务器公网IP
TTL: 600秒

# CNAME记录（如使用CDN）
类型: CNAME
主机记录: cdn
记录值: 你的CDN域名
TTL: 600秒
```

## 2. SSL证书配置

### 免费SSL证书（推荐）

#### 使用Let's Encrypt
```bash
# 安装Certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# 自动续期测试
sudo certbot renew --dry-run
```

#### 使用acme.sh（更灵活）
```bash
# 安装acme.sh
curl https://get.acme.sh | sh

# 获取证书
acme.sh --issue -d your-domain.com --nginx

# 安装证书
acme.sh --install-cert -d your-domain.com \
    --key-file /etc/ssl/private/your-domain.com.key \
    --fullchain-file /etc/ssl/certs/your-domain.com.crt \
    --reloadcmd "systemctl reload nginx"
```

### 商业SSL证书
- **腾讯云**: 提供免费和付费SSL证书
- **阿里云**: 提供免费DV证书
- **其他**: DigiCert, GlobalSign等

## 3. Nginx HTTPS配置

### 基础HTTPS配置
编辑 `/etc/nginx/sites-available/roleEnd`，添加SSL配置：

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com www.your-domain.com;
    
    # SSL证书路径
    ssl_certificate /etc/ssl/certs/your-domain.com.crt;
    ssl_certificate_key /etc/ssl/private/your-domain.com.key;
    
    # SSL安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # 其他配置保持不变...
}
```

### 高级安全配置
```nginx
# HSTS头（强制HTTPS）
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# 安全头
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;

# 隐藏服务器信息
server_tokens off;
```

## 4. CDN配置（可选）

### 腾讯云CDN
1. 登录腾讯云CDN控制台
2. 添加域名：your-domain.com
3. 源站配置：你的服务器IP
4. 缓存配置：根据文件类型设置

### 阿里云CDN
1. 登录阿里云CDN控制台
2. 添加加速域名
3. 配置源站信息和缓存策略

## 5. 负载均衡配置（高可用）

### 多服务器配置
如果有多个服务器实例，配置负载均衡：

```nginx
upstream roleend_backend {
    server 192.168.1.10:8082 weight=3;
    server 192.168.1.11:8082 weight=2;
    server 192.168.1.12:8082 weight=1;
    
    # 健康检查
    check interval=3000 rise=2 fall=5 timeout=1000 type=http;
    check_http_send "GET /health HTTP/1.0\r\n\r\n";
    check_http_expect_alive http_2xx http_3xx;
}

server {
    # ... 其他配置
    
    location /api/ {
        proxy_pass http://roleend_backend;
        # ... 代理配置
    }
}
```

## 6. 性能优化

### 静态资源缓存
```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    access_log off;
}

location /temp/ {
    expires 1h;
    add_header Cache-Control "public";
}
```

### Gzip压缩
```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_proxied any;
gzip_comp_level 6;
gzip_types
    application/atom+xml
    application/javascript
    application/json
    application/ld+json
    application/manifest+json
    application/rss+xml
    application/vnd.geo+json
    application/vnd.ms-fontobject
    application/x-font-ttf
    application/x-web-app-manifest+json
    application/xhtml+xml
    application/xml
    font/opentype
    image/bmp
    image/svg+xml
    image/x-icon
    text/cache-manifest
    text/css
    text/plain
    text/vcard
    text/vnd.rim.location.xloc
    text/vtt
    text/x-component
    text/x-cross-domain-policy;
```

## 7. 监控和日志

### 访问日志配置
```nginx
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" '
                '"$http_user_agent" "$http_x_forwarded_for"';

access_log /var/log/nginx/roleend_access.log main;
error_log /var/log/nginx/roleend_error.log;
```

### 状态监控
```nginx
location /nginx_status {
    stub_status on;
    access_log off;
    allow 127.0.0.1;
    allow 你的管理IP;
    deny all;
}
```

## 8. 故障排除

### 常见域名问题

#### DNS解析失败
```bash
# 检查DNS解析
nslookup your-domain.com
dig your-domain.com

# 检查本地hosts文件
cat /etc/hosts
```

#### SSL证书问题
```bash
# 检查证书有效期
openssl x509 -in /etc/ssl/certs/your-domain.com.crt -noout -dates

# 测试SSL连接
openssl s_client -connect your-domain.com:443
```

#### Nginx配置错误
```bash
# 测试配置
sudo nginx -t

# 重新加载配置
sudo systemctl reload nginx

# 查看错误日志
sudo tail -f /var/log/nginx/error.log
```

## 9. 最佳实践

### 安全建议
1. **定期更新SSL证书**
2. **使用强密码和密钥**
3. **配置防火墙规则**
4. **启用日志监控**
5. **定期备份配置**

### 性能建议
1. **启用HTTP/2**
2. **配置合理的缓存策略**
3. **使用CDN加速静态资源**
4. **优化图片和资源大小**
5. **监控服务器性能**

### 维护建议
1. **定期更新系统和软件**
2. **监控域名和证书过期**
3. **定期检查日志文件**
4. **备份重要配置**
5. **测试故障恢复流程**

---

**💡 提示**: 域名配置完成后，建议使用在线工具（如SSL Labs, Pingdom）测试网站性能和安全性。

**🔒 安全提醒**: 确保SSL证书有效，定期更换密钥，监控异常访问。
#!/bin/bash

echo "🔥 配置防火墙..."

# 检查firewalld状态
if systemctl is-active --quiet firewalld; then
    echo "✅ firewalld正在运行"
    
    # 开放HTTP端口
    sudo firewall-cmd --permanent --add-service=http
    sudo firewall-cmd --permanent --add-service=https
    
    # 开放Node.js端口（用于直接访问测试）
    sudo firewall-cmd --permanent --add-port=8082/tcp
    
    # 重载防火墙
    sudo firewall-cmd --reload
    
    echo "✅ 防火墙配置完成"
    echo "已开放端口："
    sudo firewall-cmd --list-all
else
    echo "⚠️  firewalld未运行"
    echo "尝试启动firewalld..."
    sudo systemctl start firewalld
    sudo systemctl enable firewalld
    
    if systemctl is-active --quiet firewalld; then
        echo "✅ firewalld已启动"
        # 重复上面的配置
        sudo firewall-cmd --permanent --add-service=http
        sudo firewall-cmd --permanent --add-service=https
        sudo firewall-cmd --permanent --add-port=8082/tcp
        sudo firewall-cmd --reload
    else
        echo "❌ 无法启动firewalld，请手动检查"
    fi
fi

echo ""
echo "⚠️  重要提醒："
echo "1. 请在腾讯云控制台配置安全组，开放以下端口："
echo "   - 80 (HTTP)"
echo "   - 443 (HTTPS，如果需要)"
echo "   - 8082 (Node.js应用端口)"
echo ""
echo "2. 安全组配置位置："
echo "   腾讯云控制台 > 云服务器 > 实例详情 > 安全组 > 配置规则"
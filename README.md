# 🎭 RoleEnd - 智能角色对话系统

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0+-orange.svg)](https://mysql.com/)
[![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-brightgreen.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

一个功能丰富的智能角色对话系统，支持多场景、多角色、语音交互的实时对话体验。

## ✨ 核心特性

### 🎯 多角色对话
- **预设角色库**：包含魔法师、战士、学生等多种角色
- **个性化设置**：每个角色具有独特的性格、背景和语音风格
- **情感识别**：支持角色情感状态管理和情感倾向配置

### 🏞️ 多场景支持
- **沉浸式场景**：魔法城堡、现代咖啡厅、未来太空站等多样化场景
- **场景切换**：支持对话过程中实时切换场景
- **场景定制**：可自定义场景背景和氛围描述

### 🔊 语音交互
- **文本转语音**：集成七牛云语音合成服务
- **语音识别**：支持语音输入和语音回复
- **音频处理**：支持音频格式转换和优化

### 🔐 用户系统
- **完整认证**：基于JWT的用户注册、登录、令牌管理
- **会话管理**：支持多设备登录和会话状态管理
- **权限控制**：用户角色和权限分级管理

### 💾 数据持久化
- **MySQL数据库**：完整的关系型数据存储
- **实时同步**：WebSocket实现实时消息同步
- **历史记录**：完整的对话历史记录和检索

## 🚀 快速开始

### 环境要求

- Node.js 18+
- MySQL 8.0+
- 七牛云账号（语音服务）
- DeepSeek API密钥

### 安装步骤

1. **克隆项目**
```bash
git clone https://github.com/programeGreenhand/roleEnd.git
cd roleEnd
```

2. **安装依赖**
```bash
npm install
```

3. **配置环境变量**
创建 `.env` 文件：
```env
# 服务配置
PORT=8082

# 数据库配置
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=rolesystem
DB_CONNECTION_LIMIT=10

# 七牛云配置
QINIU_API_KEY=your_qiniu_api_key
QINIU_BASE_URL=https://openai.qiniu.com/v1

# DeepSeek配置
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# JWT配置
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d

# 阿里云OSS配置
OSS_REGION=oss-cn-shenzhen
OSS_ACCESS_KEY_ID=your_access_key_id
OSS_ACCESS_KEY_SECRET=your_access_key_secret
OSS_BUCKET=your_bucket_name
OSS_ENDPOINT=oss-cn-shenzhen.aliyuncs.com
```

4. **初始化数据库**
项目启动时会自动创建所需的数据表并插入默认数据。

5. **启动服务**
```bash
npm start
```

## 📚 API接口文档

### 用户认证

#### 🔐 用户注册
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "testuser",
  "password": "password123",
  "email": "test@example.com"
}
```

#### 🔑 用户登录
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "testuser",
  "password": "password123"
}
```

### 角色管理

#### 📋 获取角色列表
```http
GET /api/characters
Authorization: Bearer {token}
```

#### ❤️ 收藏角色
```http
POST /api/characters/{characterId}/favorite
Authorization: Bearer {token}
```

### 对话管理

#### 💬 创建新对话
```http
POST /api/chat/sessions
Authorization: Bearer {token}
Content-Type: application/json

{
  "characterId": "character-uuid",
  "sceneId": "scene-uuid"
}
```

#### 🔊 发送语音消息
```http
POST /api/chat/sessions/{sessionId}/voice
Authorization: Bearer {token}
Content-Type: multipart/form-data

{
  "audio": [音频文件]
}
```

#### 📝 发送文本消息
```http
POST /api/chat/sessions/{sessionId}/message
Authorization: Bearer {token}
Content-Type: application/json

{
  "content": "你好，今天天气怎么样？"
}
```

### 场景管理

#### 🏞️ 获取场景列表
```http
GET /api/scenes
Authorization: Bearer {token}
```

#### 🔄 切换场景
```http
PUT /api/chat/sessions/{sessionId}/scene
Authorization: Bearer {token}
Content-Type: application/json

{
  "sceneId": "new-scene-uuid"
}
```

## 🗃️ 数据库结构

### 核心数据表

| 表名 | 描述 | 主要字段 |
|------|------|----------|
| `users` | 用户表 | id, username, email, password_hash |
| `characters` | 角色表 | id, name, personality, voice_type |
| `scenes` | 场景表 | id, name, background_prompt, image_url |
| `chat_sessions` | 对话会话表 | id, user_id, character_id, scene_id |
| `chat_messages` | 消息表 | id, session_id, sender, content, audio_url |
| `user_favorites` | 用户收藏表 | user_id, character_id |
| `user_tokens` | 用户令牌表 | user_id, token, expires_at |

## 🔧 技术架构

### 后端技术栈
- **Node.js** - 运行时环境
- **Express.js** - Web框架
- **MySQL** - 关系型数据库
- **WebSocket** - 实时通信
- **JWT** - 身份认证
- **bcrypt** - 密码加密

### 第三方服务集成
- **七牛云** - 语音合成服务
- **DeepSeek** - AI对话引擎
- **阿里云OSS** - 文件存储

### 核心模块
```
├── 用户认证模块 (auth)
├── 角色管理模块 (characters)
├── 场景管理模块 (scenes)
├── 对话管理模块 (chat)
├── 语音处理模块 (voice)
└── 数据库管理模块 (database)
```

## 🎨 默认数据

### 预设角色
1. **艾米莉亚** - 温柔善良的魔法师
2. **雷克斯** - 勇敢的战士
3. **莉娜** - 活泼可爱的学生

### 预设场景
1. **魔法城堡** - 神秘的魔法世界
2. **现代咖啡厅** - 温馨的对话环境
3. **未来太空站** - 科幻的太空体验
4. **古代书院** - 古典的文化氛围
5. **海边小屋** - 宁静的自然环境

## 🔄 开发指南

### 项目结构
```
roleEnd/
├── testjs.js          # 主应用文件
├── package.json       # 项目配置
├── .env               # 环境变量
├── .gitignore         # Git忽略文件
└── temp/             # 临时文件目录
```

### 代码规范
- 使用ES6+语法
- 异步操作使用async/await
- 错误处理使用try/catch
- 数据库操作使用连接池

### 扩展开发
1. 添加新角色：在`insertDefaultCharacters`函数中添加
2. 创建新场景：在`insertDefaultScenes`函数中添加
3. 集成新语音服务：修改语音处理模块

## 🤝 贡献指南

欢迎提交Issue和Pull Request！

### 开发流程
1. Fork项目
2. 创建功能分支
3. 提交代码变更
4. 创建Pull Request

### 代码审查标准
- 代码符合项目规范
- 包含必要的测试用例
- 更新相关文档

## 📄 许可证

本项目采用MIT许可证。详见 [LICENSE](LICENSE) 文件。

## 📞 联系方式

- 项目主页：https://github.com/programeGreenhand/roleEnd
- 问题反馈：GitHub Issues
- 邮箱：programeGreenhand@example.com

---

**⭐ 如果这个项目对您有帮助，请给个Star支持一下！**
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const url = require('url');
const fs = require('fs');
const path = require('path');
const OSS = require('ali-oss');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt'); // 新增: 用于密码哈希
const jwt = require('jsonwebtoken'); // 新增: 用于生成JWT令牌
const ffmpeg = require('fluent-ffmpeg') 

// 配置
//如何不明文写在代码中，请使用环境变量或配置文件
// 使用环境变量或可选的 config.json，不在代码中明文写秘密
require('dotenv').config(); // 如果使用 .env 文件

// 尝试从项目根目录载入可选的 config.json（仅作为备选）
let fileConfig = {};
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch (err) {
  console.warn('读取 config.json 失败（可忽略）:', err.message);
}

// 简单工具：优先使用环境变量，其次使用 config.json，最后使用安全的默认值或抛错
const get = (envName, fileKey, defaultValue, required = false) => {
  const val = process.env[envName] ?? (fileConfig?.[fileKey] ?? defaultValue);
  if (required && (val === undefined || val === null || val === '')) {
    throw new Error(`缺少必要配置：${envName}（可通过环境变量或 config.json 提供）`);
  }
  return val;
};

// 基本服务配置
const PORT = parseInt(get('PORT', 'PORT', '8082'));
const QINIU_API_KEY = get('QINIU_API_KEY', 'QINIU_API_KEY', '', true);
const DEEPSEEK_API_KEY = get('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', '', true);
const QINIU_BASE_URL = get('QINIU_BASE_URL', 'QINIU_BASE_URL', 'https://openai.qiniu.com/v1');
const DEEPSEEK_BASE_URL = get('DEEPSEEK_BASE_URL', 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1');
const JWT_SECRET = get('JWT_SECRET', 'JWT_SECRET', '', true);
const JWT_EXPIRES_IN = get('JWT_EXPIRES_IN', 'JWT_EXPIRES_IN', '7d');

// 服务器网络配置（新增）
const SERVER_PUBLIC_URL = get('SERVER_PUBLIC_URL', 'SERVER_PUBLIC_URL', `http://localhost:${PORT}`);
const ALLOWED_ORIGINS = get('ALLOWED_ORIGINS', 'ALLOWED_ORIGINS', '*').split(',').map(origin => origin.trim());

// MySQL 配置
const dbConfig = {
  host: get('DB_HOST', 'DB_HOST', 'localhost'),
  user: get('DB_USER', 'DB_USER', 'root'),
  password: get('DB_PASSWORD', 'DB_PASSWORD', ''),
  database: get('DB_DATABASE', 'DB_DATABASE', 'rolesystem'),
  waitForConnections: true,
  connectionLimit: parseInt(get('DB_CONNECTION_LIMIT', 'DB_CONNECTION_LIMIT', '10')),
  queueLimit: 0
};

// 创建 MySQL 连接池
const pool = mysql.createPool(dbConfig);

// 阿里云 OSS 配置
const ossConfig = {
  region: get('OSS_REGION', 'OSS_REGION', 'oss-cn-shenzhen'),
  accessKeyId: get('OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID', '', true),
  accessKeySecret: get('OSS_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET', '', true),
  bucket: get('OSS_BUCKET', 'OSS_BUCKET', '', true),
  endpoint: get('OSS_ENDPOINT', 'OSS_ENDPOINT', 'oss-cn-shenzhen.aliyuncs.com')
};

// 小提示（启动时可打印非敏感配置以确认）
// console.log('配置加载完成: PORT=', PORT, 'OSS_BUCKET=', ossConfig.bucket, 'DB_HOST=', dbConfig.host);

// 创建OSS客户端
const ossClient = new OSS(ossConfig);

// 创建临时目录（作为备用）
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 创建Express应用
const app = express();

// 动态CORS配置
app.use(cors({
  origin: function (origin, callback) {
    // 允许所有来源（开发环境）或指定来源（生产环境）
    if (ALLOWED_ORIGINS.includes('*') || !origin) {
      callback(null, true);
    } else if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '50mb' }));

// 静态文件服务，用于提供音频文件访问（备用）
app.use('/temp', express.static(TEMP_DIR));

// 配置multer用于处理文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// 创建HTTP服务器
const server = http.createServer(app);

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// ==================== 数据库初始化 ====================

// 数据库表创建SQL
const createTables = async () => {
  const connection = await pool.getConnection();
  
  try {
    // 1. 用户表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        status ENUM('active', 'inactive', 'banned') DEFAULT 'active'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. 场景表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS scenes (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        background_prompt TEXT NOT NULL,
        image_url VARCHAR(500),
        category VARCHAR(50),
        is_public BOOLEAN DEFAULT TRUE,
        created_by VARCHAR(36),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_category (category),
        INDEX idx_public (is_public),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 3. 智能体/角色表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS characters (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        avatar_url VARCHAR(500),
        personality TEXT,
        background TEXT,
        voice_type VARCHAR(100),
        theme VARCHAR(50),
        skills JSON,
        emotional_tendency JSON,
        system_prompt TEXT,
        is_custom BOOLEAN DEFAULT FALSE,
        is_public BOOLEAN DEFAULT TRUE,
        author VARCHAR(100),
        created_by VARCHAR(36),
        usage_count INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_custom (is_custom),
        INDEX idx_public (is_public),
        INDEX idx_creator (created_by),
        INDEX idx_rating (rating),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 4. 用户收藏智能体表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        character_id VARCHAR(36) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_character (user_id, character_id),
        INDEX idx_user (user_id),
        INDEX idx_character (character_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 5. 对话实例表（会话表）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        character_id VARCHAR(36) NOT NULL,
        scene_id VARCHAR(36),
        title VARCHAR(200),
        context_summary TEXT,
        current_emotion VARCHAR(50) DEFAULT 'normal',
        message_count INT DEFAULT 0,
        last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        status ENUM('active', 'archived', 'deleted') DEFAULT 'active',
        INDEX idx_user (user_id),
        INDEX idx_character (character_id),
        INDEX idx_scene (scene_id),
        INDEX idx_last_message (last_message_at),
        INDEX idx_status (status),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
        FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 6. 对话消息表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id VARCHAR(36) PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        sender ENUM('user', 'character') NOT NULL,
        content TEXT NOT NULL,
        message_type ENUM('text', 'voice') DEFAULT 'text',
        emotion VARCHAR(50),
        voice_url VARCHAR(500),
        audio_url VARCHAR(500),
        original_text TEXT,
        voice_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_session (session_id),
        INDEX idx_sender (sender),
        INDEX idx_type (message_type),
        INDEX idx_created (created_at),
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 7. 用户令牌表 (新增)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        token VARCHAR(500) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_valid BOOLEAN DEFAULT TRUE,
        INDEX idx_user_id (user_id),
        INDEX idx_token (token(255)),
        INDEX idx_valid (is_valid),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✓ 数据库表创建/验证完成');

    // 插入默认场景数据
    await insertDefaultScenes(connection);
    
    // 插入默认角色数据
    await insertDefaultCharacters(connection);

  } catch (error) {
    console.error('× 数据库表创建失败:', error);
    throw error;
  } finally {
    connection.release();
  }
};

// 插入默认场景
const insertDefaultScenes = async (connection) => {
  const defaultScenes = [
    {
      id: uuidv4(),
      name: '魔法城堡',
      description: '一座神秘的魔法城堡，充满了古老的魔法气息',
      background_prompt: '你现在身处一座古老的魔法城堡中，城堡里弥漫着神秘的魔法气息，墙上挂着古老的画像，空气中闪烁着微弱的魔法光芒。',
      image_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/scenes/magic_castle.jpg',
      category: '奇幻',
      is_public: true
    },
    {
      id: uuidv4(),
      name: '现代咖啡厅',
      description: '温馨舒适的现代咖啡厅，适合轻松对话',
      background_prompt: '你现在坐在一家温馨的咖啡厅里，空气中弥漫着咖啡的香气，轻柔的音乐在耳边响起，周围的环境让人感到放松和舒适。',
      image_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/scenes/coffee_shop.jpg',
      category: '日常',
      is_public: true
    },
    {
      id: uuidv4(),
      name: '未来太空站',
      description: '高科技的太空站，充满科幻色彩',
      background_prompt: '你现在身处一个高科技的太空站中，透过舷窗可以看到璀璨的星空，周围都是先进的科技设备，空气中充满了未来感。',
      image_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/scenes/space_station.jpg',
      category: '科幻',
      is_public: true
    },
    {
      id: uuidv4(),
      name: '古代书院',
      description: '古色古香的书院，书香气息浓厚',
      background_prompt: '你现在坐在一座古代书院里，周围摆满了古籍，空气中弥漫着淡淡的墨香，环境安静祥和，适合深度交流。',
      image_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/scenes/ancient_academy.jpg',
      category: '古风',
      is_public: true
    },
    {
      id: uuidv4(),
      name: '海边小屋',
      description: '面朝大海的温馨小屋，海风徐徐',
      background_prompt: '你现在坐在一间面朝大海的小屋里，可以听到海浪声，海风轻抚，阳光透过窗户洒进来，环境宁静而美好。',
      image_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/scenes/seaside_cottage.jpg',
      category: '自然',
      is_public: true
    }
  ];

  for (const scene of defaultScenes) {
    try {
      await connection.execute(
        'INSERT IGNORE INTO scenes (id, name, description, background_prompt, image_url, category, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [scene.id, scene.name, scene.description, scene.background_prompt, scene.image_url, scene.category, scene.is_public]
      );
    } catch (error) {
      console.warn('插入默认场景失败:', scene.name, error.message);
    }
  }

  console.log('✓ 默认场景数据插入完成');
};

// 插入默认角色
const insertDefaultCharacters = async (connection) => {
  const defaultCharacters = [
    {
      id: uuidv4(),
      name: '艾米莉亚',
      description: '温柔善良的魔法师，总是乐于助人',
      personality: '温柔、善良、聪明、有耐心',
      background: '来自魔法学院的优秀学生，擅长治愈魔法',
      voice_type: 'qiniu_zh_female_wwxkjx',
      theme: 'magical',
      skills: JSON.stringify(['治愈魔法', '占卜', '魔法研究']),
      emotional_tendency: JSON.stringify({
        default: 'calm',
        happy: 0.7,
        sad: 0.2,
        angry: 0.1,
        excited: 0.6,
        calm: 0.8
      }),
      system_prompt: '你是艾米莉亚，一个温柔善良的魔法师。你总是耐心倾听，用温和的语气与人交流，乐于帮助他人解决问题。你对魔法有深入的了解，喜欢分享知识。',
      is_custom: false,
      is_public: true,
      author: '系统',
      avatar_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/characters/emilia.jpg'
    },
    {
      id: uuidv4(),
      name: '雷克斯',
      description: '勇敢的战士，富有正义感',
      personality: '勇敢、正直、坚强、有领导力',
      background: '来自北方的战士，曾参与多次重要战役',
      voice_type: 'qiniu_zh_male_wwxkjx',
      theme: 'warrior',
      skills: JSON.stringify(['剑术', '战术指挥', '防护技能']),
      emotional_tendency: JSON.stringify({
        default: 'confident',
        happy: 0.6,
        sad: 0.2,
        angry: 0.4,
        excited: 0.8,
        calm: 0.5
      }),
      system_prompt: '你是雷克斯，一个勇敢的战士。你说话直接有力，富有正义感，总是愿意保护弱者。你有丰富的战斗经验，对于困难从不退缩。',
      is_custom: false,
      is_public: true,
      author: '系统',
      avatar_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/characters/rex.jpg'
    },
    {
      id: uuidv4(),
      name: '莉娜',
      description: '活泼可爱的学生，充满好奇心',
      personality: '活泼、好奇、开朗、爱学习',
      background: '高中生，对世界充满好奇，喜欢探索新事物',
      voice_type: 'qiniu_zh_female_wwxkjx',
      theme: 'student',
      skills: JSON.stringify(['学习', '研究', '社交']),
      emotional_tendency: JSON.stringify({
        default: 'happy',
        happy: 0.9,
        sad: 0.1,
        angry: 0.2,
        excited: 0.9,
        calm: 0.4
      }),
      system_prompt: '你是莉娜，一个活泼可爱的高中生。你对一切都充满好奇心，说话活泼有趣，喜欢用年轻人的语言交流，总是充满活力和热情。',
      is_custom: false,
      is_public: true,
      author: '系统',
      avatar_url: 'https://onepiece-spiderman.oss-cn-shenzhen.aliyuncs.com/characters/lina.jpg'
    }
  ];

  for (const character of defaultCharacters) {
    try {
      await connection.execute(
        'INSERT IGNORE INTO characters (id, name, description, personality, background, voice_type, theme, skills, emotional_tendency, system_prompt, is_custom, is_public, author, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          character.id, character.name, character.description, character.personality,
          character.background, character.voice_type, character.theme, character.skills,
          character.emotional_tendency, character.system_prompt, character.is_custom,
          character.is_public, character.author, character.avatar_url
        ]
      );
    } catch (error) {
      console.warn('插入默认角色失败:', character.name, error.message);
    }
  }

  console.log('✓ 默认角色数据插入完成');
};

// ==================== 用户认证相关函数 ====================

// 注册用户
const registerUser = async (userData) => {
  const connection = await pool.getConnection();
  try {
    // 检查用户名是否已存在
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [userData.username]
    );

    if (existingUsers.length > 0) {
      throw new Error('用户名已存在');
    }

    // 检查邮箱是否已存在
    if (userData.email) {
      const [existingEmails] = await connection.execute(
        'SELECT id FROM users WHERE email = ?',
        [userData.email]
      );

      if (existingEmails.length > 0) {
        throw new Error('邮箱已被注册');
      }
    }

    // 哈希密码
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(userData.password, saltRounds);

    // 创建用户
    const userId = uuidv4();
    await connection.execute(
      'INSERT INTO users (id, username, email, password_hash, avatar_url) VALUES (?, ?, ?, ?, ?)',
      [userId, userData.username, userData.email || null, passwordHash, userData.avatar_url || null]
    );

    return userId;
  } finally {
    connection.release();
  }
};

// 验证用户登录
const verifyUser = async (username, password) => {
  const connection = await pool.getConnection();
  try {
    // 查找用户
    const [users] = await connection.execute(
      'SELECT id, username, password_hash, status FROM users WHERE username = ?',
      [username]
    );

    if (users.length === 0) {
      throw new Error('用户不存在');
    }

    const user = users[0];

    // 检查用户状态
    if (user.status !== 'active') {
      throw new Error('账户已被禁用');
    }

    // 验证密码
    console.log(password,user.password_hash)
    const isPasswordValid = password === user.password_hash?true:false
    if (!isPasswordValid) {
      throw new Error('密码错误');
    }
    console.log('user',user)
    return user;
  } finally {
    connection.release();
  }
};

// 生成JWT令牌
const generateToken = async (userId, remember = false) => {
  const expiresIn = remember ? '30d' : JWT_EXPIRES_IN;
  
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn });
  
  // 保存令牌到数据库
  const connection = await pool.getConnection();
  try {
    const tokenId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (remember ? 30 : 7)); // 30天或7天后过期
    
    await connection.execute(
      'INSERT INTO user_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
      [tokenId, userId, token, expiresAt]
    );
    
    return token;
  } finally {
    connection.release();
  }
};

// 验证JWT令牌
const verifyToken = async (token) => {
  try {
    // 验证令牌有效性
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // 检查令牌是否在数据库中存在且有效
    const connection = await pool.getConnection();
    try {
      const [tokens] = await connection.execute(
        'SELECT * FROM user_tokens WHERE user_id = ? AND token = ? AND is_valid = 1 AND expires_at > NOW()',
        [decoded.userId, token]
      );
      
      if (tokens.length === 0) {
        throw new Error('令牌已失效');
      }
      
      return decoded;
    } finally {
      connection.release();
    }
  } catch (error) {
    throw new Error('无效的令牌');
  }
};

// 使令牌失效（登出）
const invalidateToken = async (token) => {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'UPDATE user_tokens SET is_valid = 0 WHERE token = ?',
      [token]
    );
  } finally {
    connection.release();
  }
};

// JWT认证中间件
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: '未授权',
        message: '请提供有效的认证令牌'
      });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = await verifyToken(token);
    
    // 将用户ID附加到请求对象
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: '认证失败',
      message: error.message
    });
  }
};

// ==================== 用户相关 ====================

// 创建用户
const createUser = async (userData) => {
  const connection = await pool.getConnection();
  try {
    const userId = uuidv4();
    await connection.execute(
      'INSERT INTO users (id, username, email, password_hash, avatar_url) VALUES (?, ?, ?, ?, ?)',
      [userId, userData.username, userData.email, userData.password_hash, userData.avatar_url]
    );
    return userId;
  } finally {
    connection.release();
  }
};

// 获取用户信息
const getUserById = async (userId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT id, username, email, avatar_url, created_at, updated_at, status FROM users WHERE id = ?',
      [userId]
    );
    return rows[0];
  } finally {
    connection.release();
  }
};

// ==================== 角色相关 ====================

// 创建角色
const createCharacter = async (characterData, userId) => {
  const connection = await pool.getConnection();
  try {
    const characterId = uuidv4();
    await connection.execute(
      `INSERT INTO characters (
        id, name, description, avatar_url, personality, background, 
        voice_type, theme, skills, emotional_tendency, system_prompt, 
        is_custom, is_public, author, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        characterId, characterData.name, characterData.description, characterData.avatar_url || null,
        characterData.personality || null, characterData.background || null, characterData.voice_type || null,
        characterData.theme || null, JSON.stringify(characterData.skills || []),
        JSON.stringify(characterData.emotional_tendency || {}), characterData.system_prompt || characterData.background,
        true, characterData.is_public || false, characterData.author || 'Custom',
        userId || null
      ]
    );
    return characterId;
  } finally {
    connection.release();
  }
};

// 获取角色
const getCharacterById = async (characterId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM characters WHERE id = ?',
      [characterId]
    );
    
    if (rows.length === 0) {
      return null;
    }
    
    const character = rows[0];
    
    // 健壮的 JSON 字段解析
    try {
      if (character.skills && typeof character.skills === 'string') {
        if (character.skills.includes(',')) {
          character.skills = character.skills.split(',').map(skill => skill.trim());
        } else {
          character.skills = JSON.parse(character.skills || '[]');
        }
      } else {
        character.skills = [];
      }
    } catch (error) {
      console.warn(`解析角色技能失败: ${error.message}`);
      character.skills = [];
    }
    
    try {
      if (character.emotional_tendency && typeof character.emotional_tendency === 'string') {
        character.emotional_tendency = JSON.parse(character.emotional_tendency || '{}');
      } else {
        character.emotional_tendency = {};
      }
    } catch (error) {
      console.warn(`解析角色情感倾向失败: ${error.message}`);
      character.emotional_tendency = {};
    }
    
    return character;
  } finally {
    connection.release();
  }
};

// 获取公共角色
const getPublicCharacters = async (limit = 50, offset = 0) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM characters WHERE is_public = 1 ORDER BY usage_count DESC, rating DESC, created_at DESC LIMIT ? OFFSET ?',
      [String(limit), String(offset)]
    );
    
    return rows.map(row => {
      // 更健壮的 JSON 解析
      try {
        // 处理 skills 字段
        if (row.skills && typeof row.skills === 'string') {
          // 如果是逗号分隔的字符串，转换为数组
          if (row.skills.includes(',')) {
            row.skills = row.skills.split(',').map(skill => skill.trim());
          } else {
            // 尝试解析为 JSON
            row.skills = JSON.parse(row.skills || '[]');
          }
        } else {
          row.skills = [];
        }
      } catch (error) {
        console.warn(`解析 skills JSON 失败，使用默认值: ${error.message}`);
        row.skills = [];
      }
      
      // 处理 emotional_tendency 字段
      try {
        if (row.emotional_tendency && typeof row.emotional_tendency === 'string') {
          row.emotional_tendency = JSON.parse(row.emotional_tendency || '{}');
        } else {
          row.emotional_tendency = {};
        }
      } catch (error) {
        console.warn(`解析 emotional_tendency JSON 失败，使用默认值: ${error.message}`);
        row.emotional_tendency = {};
      }
      
      return row;
    });
  } finally {
    connection.release();
  }
};

// 获取自定义角色
const getCustomCharacters = async (limit = 50, offset = 0) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM characters WHERE is_custom = 1 AND is_public = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [parseInt(limit), parseInt(offset)]
    );
    return rows.map(row => {
      try {
        row.skills = JSON.parse(row.skills || '[]');
        row.emotional_tendency = JSON.parse(row.emotional_tendency || '{}');
      } catch (error) {
        row.skills = [];
        row.emotional_tendency = {};
      }
      return row;
    });
  } finally {
    connection.release();
  }
};

// 获取用户角色
const getUserCharacters = async (userId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM characters WHERE created_by = ? ORDER BY created_at DESC',
      [userId]
    );
    return rows.map(row => {
      try {
        row.skills = JSON.parse(row.skills || '[]');
        row.emotional_tendency = JSON.parse(row.emotional_tendency || '{}');
      } catch (error) {
        row.skills = [];
        row.emotional_tendency = {};
      }
      return row;
    });
  } finally {
    connection.release();
  }
};

// 获取用户收藏角色
const getUserFavoriteCharacters = async (userId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT c.*, uf.created_at as favorited_at 
       FROM characters c 
       JOIN user_favorites uf ON c.id = uf.character_id 
       WHERE uf.user_id = ? 
       ORDER BY uf.created_at DESC`,
      [userId]
    );
    return rows.map(row => {
      try {
        row.skills = JSON.parse(row.skills || '[]');
        row.emotional_tendency = JSON.parse(row.emotional_tendency || '{}');
      } catch (error) {
        row.skills = [];
        row.emotional_tendency = {};
      }
      return row;
    });
  } finally {
    connection.release();
  }
};

// ==================== 收藏相关 ====================

// 添加收藏
const addToFavorites = async (userId, characterId) => {
  const connection = await pool.getConnection();
  try {
    const favoriteId = uuidv4();
    await connection.execute(
      'INSERT INTO user_favorites (id, user_id, character_id) VALUES (?, ?, ?)',
      [favoriteId, userId, characterId]
    );
    
    // 更新角色的使用计数
    await connection.execute(
      'UPDATE characters SET usage_count = usage_count + 1 WHERE id = ?',
      [characterId]
    );
    
    return favoriteId;
  } finally {
    connection.release();
  }
};

// 移除收藏
const removeFromFavorites = async (userId, characterId) => {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'DELETE FROM user_favorites WHERE user_id = ? AND character_id = ?',
      [userId, characterId]
    );
  } finally {
    connection.release();
  }
};

// ==================== 场景相关 ====================

// 获取场景列表
const getScenes = async () => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM scenes WHERE is_public = 1 ORDER BY category, name'
    );
    return rows;
  } finally {
    connection.release();
  }
};

// 获取场景详情
const getSceneById = async (sceneId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM scenes WHERE id = ?',
      [sceneId]
    );
    return rows[0];
  } finally {
    connection.release();
  }
};

// 上传场景背景图到OSS
const uploadSceneImage = async (imageBuffer, filename) => {
  const timestamp = Date.now();
  const uuid = uuidv4().substring(0, 8);
  const fileExtension = path.extname(filename) || '.jpg';
  const objectKey = `scenes/${timestamp}_${uuid}${fileExtension}`;
  
  const result = await ossClient.put(objectKey, imageBuffer, {
    headers: {
      'Content-Type': `image/${fileExtension.substring(1)}`,
      'Cache-Control': 'public, max-age=31536000'
    }
  });
  
  return result.url;
};

// 创建自定义场景
const createScene = async (sceneData, userId) => {
  const connection = await pool.getConnection();
  try {
    const sceneId = uuidv4();
    await connection.execute(
      `INSERT INTO scenes (
        id, name, description, background_prompt, image_url, 
        category, is_public, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sceneId, sceneData.name, sceneData.description, sceneData.background_prompt,
        sceneData.image_url, sceneData.category, sceneData.is_public || false, userId
      ]
    );
    return sceneId;
  } finally {
    connection.release();
  }
};

// 更新场景背景图
const updateSceneImage = async (sceneId, imageUrl) => {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'UPDATE scenes SET image_url = ? WHERE id = ?',
      [imageUrl, sceneId]
    );
  } finally {
    connection.release();
  }
};

// ==================== 会话相关 ====================

// 创建会话
const createChatSession = async (userId, characterId, sceneId = null, title = null) => {
  const connection = await pool.getConnection();
  try {
    const sessionId = uuidv4();
    
    // 如果没有提供标题，使用角色名生成
    let sessionTitle = title;
    if (!sessionTitle) {
      const character = await getCharacterById(characterId);
      sessionTitle = character ? `与${character.name}的对话` : '新对话';
    }
    
    await connection.execute(
      'INSERT INTO chat_sessions (id, user_id, character_id, scene_id, title) VALUES (?, ?, ?, ?, ?)',
      [sessionId, userId, characterId, sceneId, sessionTitle]
    );
    
    // 更新角色的使用计数
    await connection.execute(
      'UPDATE characters SET usage_count = usage_count + 1 WHERE id = ?',
      [characterId]
    );
    
    return sessionId;
  } finally {
    connection.release();
  }
};

// 获取会话详情
const getChatSession = async (sessionId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT cs.*, c.name as character_name, c.avatar_url as character_avatar,
              c.voice_type as character_voice_type, c.system_prompt,
              s.name as scene_name, s.background_prompt as scene_background,
              s.image_url as scene_image_url
       FROM chat_sessions cs
       LEFT JOIN characters c ON cs.character_id = c.id
       LEFT JOIN scenes s ON cs.scene_id = s.id
       WHERE cs.id = ?`,
      [sessionId]
    );
    return rows[0];
  } finally {
    connection.release();
  }
};

// 获取用户会话列表
const getUserChatSessions = async (userId) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT cs.*, c.name as character_name, c.avatar_url as character_avatar,
              s.name as scene_name, s.image_url as scene_image_url
       FROM chat_sessions cs
       LEFT JOIN characters c ON cs.character_id = c.id
       LEFT JOIN scenes s ON cs.scene_id = s.id
       WHERE cs.user_id = ? AND cs.status = 'active'
       ORDER BY cs.last_message_at DESC`,
      [userId]
    );
    return rows;
  } catch (error) {
    console.error('获取用户会话失败:', error);
    throw error;
  } finally {
    connection.release();
  }
};

// 更新会话
const updateChatSession = async (sessionId, updates) => {
  const connection = await pool.getConnection();
  try {
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), sessionId];
    
    await connection.execute(
      `UPDATE chat_sessions SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      values
    );
  } finally {
    connection.release();
  }
};

// 更新会话的场景
const updateSessionScene = async (sessionId, sceneId) => {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'UPDATE chat_sessions SET scene_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [sceneId, sessionId]
    );
    
    // 获取更新后的会话信息，包括场景数据
    const session = await getChatSession(sessionId);
    return session;
  } finally {
    connection.release();
  }
};

// ==================== 消息相关 ====================

// 保存消息
// 修改 saveChatMessage 函数，添加ID生成
async function saveChatMessage(messageData) {
  console.log(`=== 保存聊天消息 ===`)
  console.log(`消息数据:`, {
    session_id: messageData.session_id,
    sender: messageData.sender,
    content: messageData.content?.substring(0, 50) + '...',
    message_type: messageData.message_type
  })
  
  try {
    // 验证必要字段
    if (!messageData.session_id) {
      throw new Error('缺少会话ID')
    }
    
    if (!messageData.sender || !['user', 'character'].includes(messageData.sender)) {
      throw new Error(`无效的发送者标识: ${messageData.sender}`)
    }
    
    if (!messageData.content) {
      throw new Error('消息内容为空')
    }
    
    // 生成消息ID
    const messageId = uuidv4()
    
    const query = `
      INSERT INTO chat_messages (
        id, session_id, sender, content, message_type, 
        audio_url, voice_type, original_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `
    
    const params = [
      messageId,
      messageData.session_id,
      messageData.sender,
      messageData.content,
      messageData.message_type || 'text',
      messageData.audio_url || null,
      messageData.voice_type || null,
      messageData.original_text || null
    ]
    
    const [result] = await pool.execute(query, params)
    console.log(`✓ 消息保存成功，ID: ${messageId}`)
    
    return messageId
    
  } catch (error) {
    console.error('× 保存聊天消息失败:', error)
    throw error
  }
}

// 获取消息列表
const getChatMessages = async (sessionId, limit = 50, offset = 0) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      [sessionId, parseInt(limit), parseInt(offset)]
    );
    return rows;
  } finally {
    connection.release();
  }
};

async function getRecentChatMessages(sessionId, limit = 5) {
  console.log(`=== 获取对话历史上下文 ===`)
  console.log(`会话ID: ${sessionId}, 限制条数: ${limit}`)
  console.log(`会话ID: ${typeof sessionId}, 限制条数: ${ typeof limit}`)
  try {
    const query = `
      SELECT sender, content, message_type, created_at 
      FROM chat_messages 
      WHERE session_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `
    
    // 方法1：使用 pool.execute（推荐）
    const [messages] = await pool.query(query, [sessionId,limit])
    
    // 或者方法2：使用 pool.query（需要正确格式化）
    // const [messages] = await pool.query(query, [sessionId, parseInt(limit)])
    
    console.log(`✓ 查询成功，获取到 ${messages.length} 条原始消息`)
    
    // 反转数组以获得正确的时间顺序
    const orderedMessages = messages.reverse()
    
    console.log(`✓ 处理后得到 ${orderedMessages.length} 条历史消息`)
    
    // 打印消息详情用于调试
    orderedMessages.forEach((msg, index) => {
      // 添加空值检查
      const contentPreview = msg.content ? 
        msg.content.substring(0, 50) + '...' : 
        '[空内容]'
      console.log(`消息 ${index + 1}: [${msg.sender}] ${contentPreview}`)
    })
    
    // 确保消息标识正确，并过滤掉无效消息
    const validMessages = orderedMessages.filter(msg => {
      return msg.sender && (msg.sender === 'user' || msg.sender === 'character') && msg.content
    })
    
    console.log(`✓ 过滤后有效消息: ${validMessages.length} 条`)
    return validMessages
    
  } catch (error) {
    console.error('× 获取对话历史失败:', error)
    console.error('错误详情:', {
      sessionId: sessionId,
      limit: limit,
      errorCode: error.code,
      errno: error.errno
    })
    return []
  }
}
// ==================== 工具函数 ====================

// 验证音频数据
function validateAudioData(buffer) {
  console.log(`=== 音频数据验证 ===`)
  console.log(`Buffer长度: ${buffer ? buffer.length : 0} bytes`)
  
  if (!buffer || buffer.length === 0) {
    throw new Error('音频数据为空')
  }
  
  // 调整最小文件大小检查，考虑短时间录音
  if (buffer.length < 44) { // WAV文件头最小44字节
    throw new Error('音频文件过小，可能不是有效的音频数据')
  }
  
  const header16 = buffer.slice(0, 16)
  console.log(`音频文件前16字节 (hex): ${header16.toString('hex')}`)
  console.log(`音频文件前4字节 (ascii): ${buffer.toString('ascii', 0, 4)}`)
  
  const header = buffer.toString('ascii', 0, 4)
  const header12 = buffer.slice(8, 12).toString('ascii')
  
  let detectedFormat = 'unknown'
  
  // 增强格式检测
  if (header === 'RIFF' && header12 === 'WAVE') {
    detectedFormat = 'wav'
    console.log('✓ 检测到WAV格式音频文件')
  } else if (header.substring(0, 3) === 'ID3' || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) {
    detectedFormat = 'mp3'
    console.log('✓ 检测到MP3格式音频文件')
  } else if (header === 'OggS') {
    detectedFormat = 'ogg'
    console.log('✓ 检测到OGG格式音频文件')
  } else if (header === 'fLaC') {
    detectedFormat = 'flac'
    console.log('✓ 检测到FLAC格式音频文件')
  } else if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    detectedFormat = 'webm'
    console.log('✓ 检测到WebM格式音频文件')
  } else {
    console.warn(`⚠ 未知音频格式，文件头: ${header} (${header.split('').map(c => c.charCodeAt(0).toString(16)).join(' ')})`)
    // 不抛出错误，继续处理
  }
  
  return { isValid: true, detectedFormat }
}

// 上传文件到阿里云OSS
async function uploadToAliOSS(buffer, filename, retries = 3) {
  console.log(`=== 开始上传音频文件到阿里云OSS ===`)
  console.log(`文件大小: ${buffer.length} bytes, 文件名: ${filename}`)
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timestamp = Date.now()
      const uuid = uuidv4().substring(0, 8)
      const fileExtension = path.extname(filename) || '.wav'
      const objectKey = `audio/${timestamp}_${uuid}${fileExtension}`
      
      // 验证buffer不为空
      if (!buffer || buffer.length === 0) {
        throw new Error('上传的音频数据为空')
      }
      
      const result = await ossClient.put(objectKey, buffer, {
        headers: {
          'Content-Type': getContentType(fileExtension),
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': buffer.length.toString()
        }
      })
      
      console.log(`✓ OSS上传成功: ${result.url}`)
      
      // 验证上传是否成功
      try {
        const headResult = await ossClient.head(objectKey)
        console.log(`✓ 文件验证成功，大小: ${headResult.res.headers['content-length']} bytes`)
      } catch (verifyError) {
        console.error('× 文件验证失败:', verifyError)
      }
      
      return result.url
      
    } catch (error) {
      console.error(`× 第${attempt}次OSS上传失败:`, error.message)
      
      if (attempt === retries) {
        console.log('OSS上传失败，使用本地备用方案')
        // 备用方案：保存到本地
        const localFilename = `${Date.now()}_${uuidv4().substring(0, 8)}${path.extname(filename) || '.wav'}`
        const localPath = path.join(TEMP_DIR, localFilename)
        fs.writeFileSync(localPath, buffer)
        const localUrl = `${SERVER_PUBLIC_URL}/temp/${localFilename}`
        console.log(`✓ 本地保存成功: ${localUrl}`)
        return localUrl
      }
      
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}


app.post('/api/debug/audio-test', upload.none(), async (req, res) => {
  try {
    const { base64Data, format = 'webm' } = req.body;
    
    console.log('🔍 测试音频数据:');
    console.log('  - 长度:', base64Data.length);
    console.log('  - 格式:', format);
    
    // 处理 Base64
    let pureBase64 = base64Data;
    if (base64Data.includes(',')) {
      pureBase64 = base64Data.split(',')[1];
    }
    
    const buffer = Buffer.from(pureBase64, 'base64');
    
    // 保存文件
    const filename = `test_${Date.now()}.${format}`;
    const filepath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    
    res.json({
      success: true,
      message: '文件已保存',
      filepath: filepath,
      fileSize: buffer.length,
      downloadUrl: `${SERVER_PUBLIC_URL}/temp/${path.basename(filepath)}`
    });
    
  } catch (error) {
    console.error('测试失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取内容类型
function getContentType(fileExtension) {
  const contentTypes = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif'
  };
  
  return contentTypes[fileExtension.toLowerCase()] || 'application/octet-stream';
}

// 更新后的音频格式转换函数
async function convertAudioFormat(inputBuffer, fromFormat, toFormat = 'wav') {
  console.log(`=== 音频格式转换: ${fromFormat} -> ${toFormat} ===`)
  
  if (fromFormat === toFormat) {
    console.log('格式相同，无需转换')
    return inputBuffer
  }
  
  return new Promise((resolve, reject) => {
    const tempInputFile = path.join(TEMP_DIR, `temp_input_${Date.now()}.${fromFormat}`)
    const tempOutputFile = path.join(TEMP_DIR, `temp_output_${Date.now()}.${toFormat}`)
    
    try {
      // 写入临时文件
      fs.writeFileSync(tempInputFile, inputBuffer)
      
      // 检查 FFmpeg 是否可用
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          console.error('× FFmpeg 不可用:', err.message)
          reject(new Error('FFmpeg 未安装或不可用'))
          return
        }
        
        // 使用ffmpeg转换
        ffmpeg(tempInputFile)
          .toFormat(toFormat)
          .audioCodec('pcm_s16le') // 16位PCM编码
          .audioChannels(1)        // 单声道
          .audioFrequency(16000)   // 16kHz采样率
          .on('end', () => {
            try {
              const convertedBuffer = fs.readFileSync(tempOutputFile)
              console.log(`✓ 格式转换成功，输出大小: ${convertedBuffer.length} bytes`)
              
              // 清理临时文件
              fs.unlinkSync(tempInputFile)
              fs.unlinkSync(tempOutputFile)
              
              resolve(convertedBuffer)
            } catch (error) {
              console.error('× 读取转换后文件失败:', error)
              reject(error)
            }
          })
          .on('error', (error) => {
            console.error('× FFmpeg转换失败:', error)
            // 清理临时文件
            try {
              fs.unlinkSync(tempInputFile)
              if (fs.existsSync(tempOutputFile)) {
                fs.unlinkSync(tempOutputFile)
              }
            } catch (cleanupError) {
              console.error('清理临时文件失败:', cleanupError)
            }
            reject(error)
          })
          .save(tempOutputFile)
      })
        
    } catch (error) {
      console.error('× 创建临时文件失败:', error)
      reject(error)
    }
  })
}

// Base64 转 Buffer
// Base64转Buffer函数 - 增强版
// 工具函数：Base64转Buffer，增强验证和调试
function base64ToBuffer(base64String) {
  console.log(`=== Base64解码处理 ===`);
  console.log(`原始Base64长度: ${base64String ? base64String.length : 0}`);
  console.log(`Base64前100字符: ${base64String ? base64String.substring(0, 100) : 'undefined'}`);
  
  try {
    // 检查是否包含data URL前缀
    let base64Data = base64String;
    if (base64String.includes(',')) {
      const parts = base64String.split(',');
      console.log(`检测到data URL前缀: ${parts[0]}`);
      base64Data = parts[1];
    }
    
    if (!base64Data || base64Data.length === 0) {
      throw new Error('Base64数据为空');
    }
    
    // 检查Base64格式
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(base64Data)) {
      throw new Error('Base64格式不正确');
    }
    
    console.log(`处理后Base64长度: ${base64Data.length}`);
    console.log(`Base64数据前50字符: ${base64Data.substring(0, 50)}`);
    
    const buffer = Buffer.from(base64Data, 'base64');
    console.log(`✓ Base64解码成功，Buffer大小: ${buffer.length} bytes`);
    
    return buffer;
  } catch (error) {
    console.error('× Base64解码失败:', error.message);
    throw new Error(`音频数据格式错误: ${error.message}`);
  }
}

// 语音识别 - 根据七牛云ASR接口文档修改
async function speechToText(audioUrl, originalFormat = 'wav', retries = 3) {
  console.log(`=== 语音识别处理 ===`)
  console.log(`音频URL: ${audioUrl}`)
  console.log(`原始格式: ${originalFormat}`)
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // 根据七牛云ASR接口文档，支持的格式为：raw/wav/mp3/ogg
      let qiniuFormat = originalFormat.toLowerCase()
      
      // 格式映射 - 将不支持的格式映射到支持的格式
      switch (qiniuFormat) {
        case 'webm':
        case 'flac':
        case 'm4a':
          qiniuFormat = 'wav' // 不支持的格式统一使用wav
          break
        case 'wav':
        case 'mp3':
        case 'ogg':
        case 'raw':
          // 这些格式直接支持
          break
        default:
          qiniuFormat = 'wav' // 默认使用wav
      }
      
      console.log(`使用格式进行识别: ${qiniuFormat}`)
      
      // 根据七牛云ASR接口文档构建请求参数
      const requestData = {
        model: 'asr',
        audio: {
          format: qiniuFormat,
          url: audioUrl
        }
      }
      
      console.log('发送识别请求:', JSON.stringify(requestData, null, 2))
      
      const response = await axios.post(`${QINIU_BASE_URL}/voice/asr`, requestData, {
        headers: {
          'Authorization': `Bearer ${QINIU_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      })
      
      console.log('识别响应:', JSON.stringify(response.data, null, 2))
      
      // 根据接口文档解析响应
      if (response.data && response.data.data && response.data.data.result) {
        const result = response.data.data.result
        let text = ''
        
        // 根据接口文档，text字段包含识别出的文本
        if (result.text) {
          text = result.text.trim()
        }
        
        if (text) {
          console.log(`✓ 语音识别成功: "${text}"`)
          return text
        } else {
          console.warn('× 语音识别返回空结果')
          if (attempt === retries) {
            throw new Error('语音识别返回空结果')
          }
        }
      } else {
        console.warn('× 语音识别返回无效响应')
        console.warn('响应结构:', response.data)
        throw new Error('语音识别返回无效响应')
      }
      
    } catch (error) {
      console.error(`× 第${attempt}次语音识别失败:`, error.message)
      
      if (error.response) {
        console.error('错误响应状态:', error.response.status)
        console.error('错误响应数据:', error.response.data)
        
        // 如果是客户端错误（4xx），不需要重试
        if (error.response.status >= 400 && error.response.status < 500) {
          const errorMsg = error.response.data?.message || error.response.data?.error || '语音识别参数错误'
          throw new Error(`语音识别失败: ${errorMsg}`)
        }
      }
      
      if (attempt === retries) {
        console.error(`语音识别失败，已重试${retries}次`)
        throw new Error(`语音识别服务暂时不可用: ${error.message}`)
      }
      
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
    }
  }
}

// 聊天
async function chatWithDeepSeek(text, characterId = 'default', sessionId = null, sceneId = null) {
  console.log(`=== DeepSeek聊天处理 ===`)
  console.log(`输入文本: "${text}"`)
  console.log(`角色ID: ${characterId}, 会话ID: ${sessionId}, 场景ID: ${sceneId}`)
  
  try {
    // 获取角色信息
    const character = await getCharacterById(characterId)
    console.log(`角色信息:`, character ? character.name : '默认角色')
    
    // 获取场景信息
    let scenePrompt = ''
    if (sceneId) {
      const scene = await getSceneById(sceneId)
      if (scene) {
        scenePrompt = `\n\n场景设定：${scene.background_prompt}`
        console.log(`场景设定: ${scene.name}`)
      }
    }
    
    // 构建系统提示词
    let systemPrompt = character ? character.system_prompt : '你是一个友善的AI助手，请用中文回答用户的问题。'
    systemPrompt += scenePrompt
    
    // 构建消息数组
    const messages = [
      { role: 'system', content: systemPrompt }
    ]
    
    // 添加对话历史上下文 - 修复标识问题
    if (sessionId) {
      const recentMessages = await getRecentChatMessages(sessionId, 4) // 减少到4条避免过长
      
      console.log(`=== 构建对话上下文 ===`)
      for (const msg of recentMessages) {
        if (msg.sender === 'user') {
          messages.push({ role: 'user', content: msg.content })
          console.log(`添加用户消息: ${msg.content.substring(0, 30)}...`)
        } else if (msg.sender === 'character') {
          messages.push({ role: 'assistant', content: msg.content })
          console.log(`添加助手消息: ${msg.content.substring(0, 30)}...`)
        }
      }
    }
    
    // 添加当前用户消息
    messages.push({ role: 'user', content: text })
    console.log(`添加当前用户消息: ${text}`)
    
    console.log(`总消息数量: ${messages.length}`)
    
    // 调用DeepSeek API
    const requestData = {
      model: 'deepseek-chat',
      messages: messages,
      max_tokens: 800,
      temperature: 0.7,
      stream: false
    }
    
    console.log('发送DeepSeek请求...')
    
    const response = await axios.post(`${DEEPSEEK_BASE_URL}/chat/completions`, requestData, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    })
    
    if (response.data && response.data.choices && response.data.choices[0]) {
      const aiResponse = response.data.choices[0].message.content
      console.log(`✓ DeepSeek回复: "${aiResponse}"`)
      return aiResponse
    } else {
      console.error('× DeepSeek返回无效响应:', response.data)
      return '抱歉，我现在有点忙，请稍后再试。'
    }
    
  } catch (error) {
    console.error('× DeepSeek聊天失败:', error.message)
    if (error.response) {
      console.error('错误详情:', error.response.data)
    }
    return '抱歉，我现在无法回答您的问题，请稍后再试。'
  }
}

// 文字转语音 voice_type
async function textToSpeech(text, voiceType = 'qiniu_zh_female_wwxkjx') {
  console.log(`=== 文字转语音处理 ===`);
  console.log(`输入文本: "${text}"`);
  console.log(`音色类型: ${voiceType}`);
  
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容为空');
    }
    
    // 限制文本长度
    const maxLength = 500;
    let processedText = text;
    if (text.length > maxLength) {
      processedText = text.substring(0, maxLength) + '...';
      console.log(`文本过长，已截取前${maxLength}字符`);
    }
    
    const requestData = {
      audio: {
        voice_type: voiceType,
        encoding: 'mp3',
        speed_ratio: 1.0
      },
      request: {
        text: processedText
      }
    };
    
    console.log('发送TTS请求:', JSON.stringify(requestData, null, 2));
    
    //这个是文字转语音接口
    const response = await axios.post(`${QINIU_BASE_URL}/voice/tts`, requestData, {
      headers: {
        'Authorization': `Bearer ${QINIU_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    console.log(`✓ 收到TTS响应:`, {
      status: response.status,
      hasData: !!response.data?.data,
      dataLength: response.data?.data?.length || 0
    });
    
    if (response.data && response.data.data) {
      console.log(`✓ TTS成功，音频数据长度: ${response.data.data.length}`);
      return response.data.data; // 返回base64编码的音频数据
    }
    
    console.log('× TTS响应格式不正确');
    return null;
  } catch (error) {
    console.error('× 文字转语音失败:', error.response?.data || error.message);
    return null;
  }
}

// 清理过期OSS文件
async function cleanupExpiredOSSFiles() {
  try {
    console.log('开始清理OSS中的过期文件...');
    
    const result = await ossClient.list({
      prefix: 'audio/',
      'max-keys': 1000
    });
    
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const obj of result.objects || []) {
      try {
        const filename = path.basename(obj.name);
        const timestampMatch = filename.match(/^(\d+)_/);
        
        if (timestampMatch) {
          const fileTimestamp = parseInt(timestampMatch[1]);
          const fileAge = now - fileTimestamp;
          
          if (fileAge > 24 * 60 * 60 * 1000) {
            await ossClient.delete(obj.name);
            console.log(`✓ 清理OSS过期文件: ${obj.name}`);
            cleanedCount++;
          }
        }
      } catch (error) {
        console.warn(`× 清理文件失败 ${obj.name}:`, error.message);
      }
    }
    
    console.log(`OSS文件清理完成，共清理${cleanedCount}个文件`);
    
  } catch (error) {
    console.warn('× OSS文件清理失败:', error.message);
  }
}

// ==================== 用户认证 API 路由 ====================

// 注册新用户
app.post('/api/user/register', async (req, res) => {
  try {
    console.log(`=== 注册用户请求 ===`);
    console.log(`用户名: ${req.body.username}`);
    console.log(`邮箱: ${req.body.email || '未提供'}`);
    
    // 检查必要参数
    if (!req.body.username || !req.body.password) {
      return res.status(400).json({
        success: false,
        error: '参数错误',
        message: '用户名和密码不能为空'
      });
    }
    
    // 注册用户
    const userId = await registerUser(req.body);
    
    // 生成令牌
    const token = await generateToken(userId);
    
    res.json({
      success: true,
      data: {
        userId,
        username: req.body.username,
        token
      }
    });
  } catch (error) {
    console.error('× 注册用户失败:', error.message);
    
    // 处理特定错误
    if (error.message.includes('用户名已存在') || error.message.includes('邮箱已被注册')) {
      return res.status(409).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: '注册失败',
      message: error.message
    });
  }
});

// 用户登录
app.post('/api/user/login', async (req, res) => {
  try {
    console.log(`=== 用户登录请求 ===`);
    console.log(`用户名: ${req.body.username}`);
    console.log(`记住登录: ${req.body.remember || false}`);
    
    // 检查必要参数
    if (!req.body.username || !req.body.password) {
      return res.status(400).json({
        success: false,
        error: '参数错误',
        message: '用户名和密码不能为空'
      });
    }
    
    // 验证用户
    const user = await verifyUser(req.body.username, req.body.password);
    
    // 生成令牌，如果选择记住登录，则使用更长的过期时间
    const token = await generateToken(user.id, req.body.remember);
    
    // 获取用户详情
    const userDetails = await getUserById(user.id);
    console.log('用户详情：',userDetails)
    res.json({
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        token,
        user: userDetails
      }
    });
  } catch (error) {
    console.error('× 用户登录失败:', error.message);
    
    // 处理特定错误
    if (error.message === '用户不存在' || error.message === '密码错误') {
      return res.status(401).json({
        success: false,
        error: '用户名或密码不正确'
      });
    } else if (error.message === '账户已被禁用') {
      return res.status(403).json({
        success: false,
        error: '账户已被禁用'
      });
    }
    
    res.status(500).json({
      success: false,
      error: '登录失败',
      message: error.message
    });
  }
});

// 获取用户ID（通过令牌）
app.get('/api/user/Id', authMiddleware, async (req, res) => {
  try {
    console.log(`=== 获取用户ID请求 ===`);
    console.log(`用户ID: ${req.userId}`);
    
    // 获取用户详情
    const user = await getUserById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: '用户不存在'
      });
    }
    
    res.json({
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        status: user.status
      }
    });
  } catch (error) {
    console.error('× 获取用户ID失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取用户信息失败',
      message: error.message
    });
  }
});

// 用户登出
app.post('/api/user/logout', authMiddleware, async (req, res) => {
  try {
    console.log(`=== 用户登出请求 ===`);
    console.log(`用户ID: ${req.userId}`);
    
    // 获取认证令牌
    const authHeader = req.headers.authorization;
    const token = authHeader.split(' ')[1];
    
    // 使令牌失效
    await invalidateToken(token);
    
    res.json({
      success: true,
      message: '登出成功'
    });
  } catch (error) {
    console.error('× 用户登出失败:', error.message);
    res.status(500).json({
      success: false,
      error: '登出失败',
      message: error.message
    });
  }
});

// ==================== HTTP API 路由 ====================

// 获取音色列表
app.get('/api/voice/list', async (req, res) => {
  console.log(`=== 获取音色列表请求 ===`);
  try {
    const response = await axios.get(`${QINIU_BASE_URL}/voice/list`, {
      headers: {
        'Authorization': `Bearer ${QINIU_API_KEY}`
      },
      timeout: 10000
    });
    
    const voiceList = response.data || [];
    
    res.json({
      success: true,
      data: voiceList
    });
  } catch (error) {
    console.error('× 获取音色列表失败:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: '获取音色列表失败',
      message: error.message
    });
  }
});

// 1. 获取用户收藏的智能体
app.get('/api/user/:userId/favorites', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权访问',
        message: '只能访问自己的收藏'
      });
    }
    
    console.log(`=== 获取用户收藏智能体 ===`);
    console.log(`用户ID: ${userId}`);
    
    const favorites = await getUserFavoriteCharacters(userId);
    
    res.json({
      success: true,
      data: favorites
    });
  } catch (error) {
    console.error('× 获取用户收藏智能体失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取收藏失败',
      message: error.message
    });
  }
});

// 2. 获取用户自建的智能体
app.get('/api/user/:userId/characters', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权访问',
        message: '只能访问自己创建的智能体'
      });
    }
    
    console.log(`=== 获取用户自建智能体 ===`);
    console.log(`用户ID: ${userId}`);
    
    const characters = await getUserCharacters(userId);
    
    res.json({
      success: true,
      data: characters
    });
  } catch (error) {
    console.error('× 获取用户自建智能体失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取自建智能体失败',
      message: error.message
    });
  }
});

// 3. 创建自建智能体
app.post('/api/user/:userId/characters', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能为自己创建智能体'
      });
    }
    
    const characterData = req.body;
    
    console.log(`=== 创建自建智能体 ===`);
    console.log(`用户ID: ${userId}`);
    console.log(`智能体数据:`, characterData);
    
    // 验证必要字段
    if (!characterData.name || !characterData.description) {
      return res.status(400).json({
        success: false,
        error: '缺少必要字段',
        message: '智能体名称和描述不能为空'
      });
    }
    
    const characterId = await createCharacter(characterData, userId);
    
    res.json({
      success: true,
      data: {
        characterId: characterId
      }
    });
  } catch (error) {
    console.error('× 创建自建智能体失败:', error.message);
    res.status(500).json({
      success: false,
      error: '创建智能体失败',
      message: error.message
    });
  }
});

// 4. 智能体广场 - 获取所有公共智能体
app.get('/api/characters/public', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    console.log(`=== 获取公共智能体广场 ===`);
    console.log(`页码: ${page}, 限制: ${limit}`);
    
    const characters = await getPublicCharacters(parseInt(limit), offset);
    
    res.json({
      success: true,
      data: characters,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: characters.length
      }
    });
  } catch (error) {
    console.error('× 获取公共智能体失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取智能体广场失败',
      message: error.message
    });
  }
});

// 5. 智能体广场 - 获取所有自建智能体
app.get('/api/characters/custom', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    console.log(`=== 获取自建智能体广场 ===`);
    console.log(`页码: ${page}, 限制: ${limit}`);
    
    const characters = await getCustomCharacters(parseInt(limit), offset);
    
    res.json({
      success: true,
      data: characters,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: characters.length
      }
    });
  } catch (error) {
    console.error('× 获取自建智能体广场失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取自建智能体广场失败',
      message: error.message
    });
  }
});

// 6. 收藏智能体
app.post('/api/user/:userId/favorites/:characterId', authMiddleware, async (req, res) => {
  try {
    const { userId, characterId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能为自己收藏智能体'
      });
    }
    
    console.log(`=== 收藏智能体 ===`);
    console.log(`用户ID: ${userId}, 智能体ID: ${characterId}`);
    
    // 检查智能体是否存在
    const character = await getCharacterById(characterId);
    if (!character) {
      return res.status(404).json({
        success: false,
        error: '智能体不存在'
      });
    }
    
    const favoriteId = await addToFavorites(userId, characterId);
    
    res.json({
      success: true,
      data: {
        favoriteId: favoriteId
      }
    });
  } catch (error) {
    console.error('× 收藏智能体失败:', error.message);
    
    // 处理重复收藏的情况
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        error: '已经收藏过此智能体'
      });
    }
    
    res.status(500).json({
      success: false,
      error: '收藏失败',
      message: error.message
    });
  }
});

// 取消收藏智能体
app.delete('/api/user/:userId/favorites/:characterId', authMiddleware, async (req, res) => {
  try {
    const { userId, characterId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能取消自己的收藏'
      });
    }
    
    console.log(`=== 取消收藏智能体 ===`);
    console.log(`用户ID: ${userId}, 智能体ID: ${characterId}`);
    
    await removeFromFavorites(userId, characterId);
    
    res.json({
      success: true,
      message: '取消收藏成功'
    });
  } catch (error) {
    console.error('× 取消收藏智能体失败:', error.message);
    res.status(500).json({
      success: false,
      error: '取消收藏失败',
      message: error.message
    });
  }
});

// 7. 获取对话场景列表
app.get('/api/scenes', async (req, res) => {
  try {
    console.log(`=== 获取对话场景列表 ===`);
    
    const scenes = await getScenes();
    
    res.json({
      success: true,
      data: scenes
    });
  } catch (error) {
    console.error('× 获取对话场景失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取场景失败',
      message: error.message
    });
  }
});

// 8. 获取用户的对话历史（会话列表）
app.get('/api/user/:userId/sessions', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权访问',
        message: '只能访问自己的对话历史'
      });
    }
    
    console.log(`=== 获取用户对话历史 ===`);
    console.log(`用户ID: ${userId}`);
    
    const sessions = await getUserChatSessions(userId);
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    console.error('× 获取用户对话历史失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取对话历史失败',
      message: error.message
    });
  }
});

// 9. 获取具体会话的消息列表
app.get('/api/sessions/:sessionId/messages', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    
    console.log(`=== 获取会话消息 ===`);
    console.log(`会话ID: ${sessionId}`);
    
    // 先获取会话信息
    const session = await getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }
    
    // 验证用户是否有权限访问此会话
    if (session.user_id !== req.userId) {
      return res.status(403).json({
        success: false,
        error: '无权访问',
        message: '只能访问自己的会话消息'
      });
    }
    
    // 获取消息列表
    const messages = await getChatMessages(sessionId, parseInt(limit), parseInt(offset));
    
    res.json({
      success: true,
      data: {
        session: session,
        messages: messages
      }
    });
  } catch (error) {
    console.error('× 获取会话消息失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取消息失败',
      message: error.message
    });
  }
});

// 10. 创建新的对话会话
app.post('/api/user/:userId/sessions', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { characterId, sceneId, title } = req.body;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能为自己创建会话'
      });
    }
    
    console.log(`=== 创建新对话会话 ===`);
    console.log(`用户ID: ${userId}, 智能体ID: ${characterId}, 场景ID: ${sceneId}`);
    
    // 验证智能体是否存在
    const character = await getCharacterById(characterId);
    if (!character) {
      return res.status(404).json({
        success: false,
        error: '智能体不存在'
      });
    }
    
    // 验证场景是否存在（如果提供了场景ID）
    if (sceneId) {
      const scene = await getSceneById(sceneId);
      if (!scene) {
        return res.status(404).json({
          success: false,
          error: '场景不存在'
        });
      }
    }
    
    const sessionId = await createChatSession(userId, characterId, sceneId, title);
    
    // 获取完整的会话信息
    const session = await getChatSession(sessionId);
    
    res.json({
      success: true,
      data: {
        sessionId: sessionId,
        session: session
      }
    });
  } catch (error) {
    console.error('× 创建对话会话失败:', error.message);
    res.status(500).json({
      success: false,
      error: '创建会话失败',
      message: error.message
    });
  }
});

// 11. 更新会话场景
app.put('/api/sessions/:sessionId/scene', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { sceneId } = req.body;
    
    console.log(`=== 更新会话场景 ===`);
    console.log(`会话ID: ${sessionId}, 新场景ID: ${sceneId}`);
    
    // 验证会话是否存在
    const session = await getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }
    
    // 验证用户是否有权限修改此会话
    if (session.user_id !== req.userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能修改自己的会话'
      });
    }
    
    // 验证场景是否存在
    const scene = await getSceneById(sceneId);
    if (!scene) {
      return res.status(404).json({
        success: false,
        error: '场景不存在'
      });
    }
    
    // 更新会话场景
    const updatedSession = await updateSessionScene(sessionId, sceneId);
    
    res.json({
      success: true,
      data: {
        session: updatedSession
      }
    });
  } catch (error) {
    console.error('× 更新会话场景失败:', error.message);
    res.status(500).json({
      success: false,
      error: '更新场景失败',
      message: error.message
    });
  }
});

// 12. 上传场景背景图片
app.post('/api/scenes/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    console.log(`=== 上传场景背景图片 ===`);
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '没有接收到图片文件'
      });
    }
    
    console.log(`接收到的文件信息:`);
    console.log(`  - 原始文件名: ${req.file.originalname}`);
    console.log(`  - MIME类型: ${req.file.mimetype}`);
    console.log(`  - 文件大小: ${req.file.size} bytes`);
    
    // 验证文件类型
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        success: false,
        error: '上传的文件不是图片'
      });
    }
    
    // 上传到OSS
    const imageUrl = await uploadSceneImage(req.file.buffer, req.file.originalname);
    
    res.json({
      success: true,
      data: {
        imageUrl: imageUrl
      }
    });
  } catch (error) {
    console.error('× 上传场景背景图片失败:', error.message);
    res.status(500).json({
      success: false,
      error: '上传图片失败',
      message: error.message
    });
  }
});

// 13. 创建自定义场景
app.post('/api/user/:userId/scenes', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 验证令牌用户ID和路径参数用户ID是否匹配
    if (req.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能为自己创建场景'
      });
    }
    
    const sceneData = req.body;
    
    console.log(`=== 创建自定义场景 ===`);
    console.log(`用户ID: ${userId}`);
    console.log(`场景数据:`, sceneData);
    
    // 验证必要字段
    if (!sceneData.name || !sceneData.background_prompt) {
      return res.status(400).json({
        success: false,
        error: '缺少必要字段',
        message: '场景名称和背景描述不能为空'
      });
    }
    
    const sceneId = await createScene(sceneData, userId);
    
    res.json({
      success: true,
      data: {
        sceneId: sceneId
      }
    });
  } catch (error) {
    console.error('× 创建自定义场景失败:', error.message);
    res.status(500).json({
      success: false,
      error: '创建场景失败',
      message: error.message
    });
  }
});

// 14. 更新场景背景图
app.put('/api/scenes/:sceneId/image', authMiddleware, async (req, res) => {
  try {
    const { sceneId } = req.params;
    const { imageUrl } = req.body;
    
    console.log(`=== 更新场景背景图 ===`);
    console.log(`场景ID: ${sceneId}`);
    console.log(`图片URL: ${imageUrl}`);
    
    // 验证场景是否存在
    const scene = await getSceneById(sceneId);
    if (!scene) {
      return res.status(404).json({
        success: false,
        error: '场景不存在'
      });
    }
    
    // 验证用户是否有权限修改此场景
    if (scene.created_by && scene.created_by !== req.userId) {
      return res.status(403).json({
        success: false,
        error: '无权操作',
        message: '只能修改自己创建的场景'
      });
    }
    
    // 更新场景背景图
    await updateSceneImage(sceneId, imageUrl);
    
    res.json({
      success: true,
      message: '场景背景图更新成功'
    });
  } catch (error) {
    console.error('× 更新场景背景图失败:', error.message);
    res.status(500).json({
      success: false,
      error: '更新背景图失败',
      message: error.message
    });
  }
});

// 15. 获取角色详情
app.get('/api/characters/:characterId', async (req, res) => {
  try {
    const { characterId } = req.params;
    
    console.log(`=== 获取角色详情 ===`);
    console.log(`角色ID: ${characterId}`);
    
    const character = await getCharacterById(characterId);
    if (!character) {
      return res.status(404).json({
        success: false,
        error: '角色不存在'
      });
    }
    
    res.json({
      success: true,
      data: character
    });
  } catch (error) {
    console.error('× 获取角色详情失败:', error.message);
    res.status(500).json({
      success: false,
      error: '获取角色详情失败',
      message: error.message
    });
  }
});

// ==================== WebSocket 连接处理 ====================

wss.on('connection', function connection(ws, request) {
  
  console.log('✓ 新的客户端已连接');
  
  // 发送连接成功消息
  ws.send(JSON.stringify({
    type: 'connection',
    data: { status: 'connected' },
    timestamp: Date.now(),
    messageId: generateMessageId()
  }));
  
  ws.on('message', async function incoming(message) {
    try {
      const messageData = JSON.parse(message);
      
      console.log(`=== 收到消息 ===`);
      console.log(`消息类型: ${messageData.type}`);
      console.log(`消息ID: ${messageData.messageId}`);
      console.log(`时间戳: ${messageData.timestamp}`);
      
      if (!messageData.type || !messageData.timestamp || !messageData.messageId) {
        console.log('× 无效的消息格式:', messageData);
        return;
      }
      
      switch (messageData.type) {
        case 'audio':
          await handleAudioMessage(ws, messageData);
          break;
          
        case 'text':
          await handleTextMessage(ws, messageData);
          break;
          
        case 'connection_ack':
          // 处理连接确认消息，简单回应即可
          console.log('✓ 收到连接确认消息');
          ws.send(JSON.stringify({
            type: 'connection_ack_response',
            data: { status: 'acknowledged' },
            timestamp: Date.now(),
            messageId: generateMessageId()
          }));
          break;
          
        default:
          console.log('× 未知的消息类型:', messageData.type);
      }
    } catch (error) {
      console.error('× 消息处理错误:', error);
      
      ws.send(JSON.stringify({
        type: 'error',
        data: { 
          error: '服务器处理错误',
          message: error.message 
        },
        timestamp: Date.now(),
        messageId: generateMessageId()
      }));
    }
  });
  
  ws.on('close', function close() {
    console.log('- 客户端已断开连接');
  });
  
  ws.on('error', function error(err) {
    console.error('× WebSocket连接错误:', err.message);
  });
});

// 修复后的音频消息处理函数，避免重复处理
async function handleAudioMessage(ws, messageData) {
  console.log(`=== 开始处理音频消息 ===`);
  
  try {
    // 1. 验证必要参数
    if (!messageData.data?.sessionId) {
      throw new Error('缺少会话ID');
    }
    
    if (!messageData.data?.audioData) {
      throw new Error('缺少音频数据');
    }
    
    // 2. 数据验证和转换
    const audioBuffer = base64ToBuffer(messageData.data.audioData);
    const validation = validateAudioData(audioBuffer);
    
    let processedBuffer = audioBuffer;
    let finalFormat = messageData.data.format || 'wav';
    
    // 3. 格式处理
    if (validation.detectedFormat === 'webm' || messageData.data.format === 'webm') {
      console.log('检测到WebM格式，直接使用');
      finalFormat = 'webm';
    }
    
    // 4. 上传到OSS
    const filename = `audio_${Date.now()}.${finalFormat}`;
    const audioUrl = await uploadToAliOSS(processedBuffer, filename);
    
    // 5. 发送处理进度
    ws.send(JSON.stringify({
      type: 'processing',
      data: {
        step: 'speech_recognition',
        message: '正在识别语音...'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
    
    // 6. 语音识别（STT）
    const recognizedText = await speechToText(audioUrl, finalFormat);
    
    if (!recognizedText || recognizedText.trim() === '') {
      throw new Error('语音识别失败，未识别到文字');
    }
    
    // 7. 发送识别结果
    ws.send(JSON.stringify({
      type: 'processing',
      data: {
        recognizedText: recognizedText,
        audioUrl: audioUrl,
        step: 'text_recognized'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
    
    console.log("保存用户的语音输入内容");
    // 8. 保存用户消息到数据库
    await saveChatMessage({
      session_id: messageData.data.sessionId,
      sender: 'user',
      content: recognizedText,
      message_type: 'voice',
      audio_url: audioUrl,
      original_text: recognizedText
    });
    
    // 9. 发送AI处理状态
    ws.send(JSON.stringify({
      type: 'processing',
      data: {
        step: 'ai_thinking',
        message: '正在思考回复...'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
    
    // 10. 获取会话信息并调用AI
    const session = await getChatSession(messageData.data.sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }
    
    // 直接使用识别的文本调用AI，不再触发text消息处理
    const aiResponse = await chatWithDeepSeek(
      recognizedText, 
      session.character_id, 
      session.id, 
      session.scene_id
    );
    
    // 11. 保存AI回复到数据库
    await saveChatMessage({
      session_id: session.id,
      sender: 'character',
      content: aiResponse,
      message_type: 'text',
      voice_type: messageData.data.voiceType
    });
    
    // 12. 文字转语音（TTS）
    let ttsAudioData = null;
    if (messageData.data.voiceType) {
      ws.send(JSON.stringify({
        type: 'processing',
        data: {
          step: 'generating_voice',
          message: '正在生成语音...'
        },
        timestamp: Date.now(),
        messageId: messageData.messageId
      }));
      
      const character = await getCharacterById(session.character_id);
      const voiceType = messageData.data.voiceType || character?.voice_type || 'qiniu_zh_female_wwxkjx';
      ttsAudioData = await textToSpeech(aiResponse, voiceType);
    }
    
    // 13. 返回完整结果
    const responseData = {
      type: 'response',
      data: {
        originalText: recognizedText,
        text: aiResponse,
        audioData: ttsAudioData,
        audioUrl: audioUrl,
        emotion: 'neutral'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    };
    
    console.log(`✓ 音频消息处理完成`);
    ws.send(JSON.stringify(responseData));
    
  } catch (error) {
    console.error('× 处理音频消息失败:', error);
    
    // 发送详细的错误信息
    ws.send(JSON.stringify({
      type: 'error',
      data: {
        error: error.message,
        step: 'audio_processing_failed',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
  }
}

// 文本消息处理函数
async function handleTextMessage(ws, messageData) {
  console.log(`=== 开始处理文本消息 ===`);
  console.log(`消息数据:`, {
    sessionId: messageData.data.sessionId,
    characterId: messageData.data.characterId,
    text: messageData.data.text,
    voiceType: messageData.data.voiceType
  });
  
  try {
    // 1. 验证必要参数
    if (!messageData.data.sessionId) {
      throw new Error('缺少会话ID');
    }
    
    if (!messageData.data.text || !messageData.data.text.trim()) {
      throw new Error('消息内容为空');
    }
    
    const userText = messageData.data.text.trim();
    
    console.log("保存用户文本对话");
    // 2. 保存用户消息 - 确保正确的sender标识
    await saveChatMessage({
      session_id: messageData.data.sessionId,
      sender: 'user', // 明确标识为用户消息
      content: userText,
      message_type: 'text'
    });
    
    // 3. 发送处理状态
    ws.send(JSON.stringify({
      type: 'processing',
      data: {
        step: 'ai_thinking',
        message: '正在思考回复...'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
    
    // 4. 获取会话信息
    const session = await getChatSession(messageData.data.sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }
    
    // 5. AI聊天处理
    const aiResponse = await chatWithDeepSeek(
      userText,
      messageData.data.characterId || session.character_id,
      session.id,
      session.scene_id
    );
    
    // 6. 保存AI回复 - 确保正确的sender标识
    await saveChatMessage({
      session_id: session.id,
      sender: 'character', // 明确标识为角色消息
      content: aiResponse,
      message_type: 'text',
      voice_type: messageData.data.voiceType
    });
    
    // 7. 文字转语音（如果需要）
    let ttsAudioData = null;
    if (messageData.data.voiceType) {
      ws.send(JSON.stringify({
        type: 'processing',
        data: {
          step: 'generating_voice',
          message: '正在生成语音...'
        },
        timestamp: Date.now(),
        messageId: messageData.messageId
      }));
      
      const character = await getCharacterById(session.character_id);
      const voiceType = messageData.data.voiceType || character?.voice_type || 'qiniu_zh_female_wwxkjx';
      ttsAudioData = await textToSpeech(aiResponse, voiceType);
    }
    
    // 8. 返回结果
    const responseData = {
      type: 'response',
      data: {
        text: aiResponse,
        audioData: ttsAudioData,
        emotion: 'neutral'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    };
    
    console.log(`✓ 文本消息处理完成`);
    ws.send(JSON.stringify(responseData));
    
  } catch (error) {
    console.error('× 处理文本消息失败:', error);
    
    ws.send(JSON.stringify({
      type: 'error',
      data: {
        error: error.message,
        step: 'text_processing_failed'
      },
      timestamp: Date.now(),
      messageId: messageData.messageId
    }));
  }
}

function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function cleanupExpiredFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtime.getTime();
      
      if (fileAge > 3600000) {
        fs.unlinkSync(filePath);
        console.log('✓ 清理过期本地文件:', file);
      }
    });
  } catch (error) {
    console.warn('× 清理过期本地文件失败:', error.message);
  }
}

setInterval(cleanupExpiredFiles, 30 * 60 * 1000);
setInterval(cleanupExpiredOSSFiles, 24 * 60 * 60 * 1000);

// ==================== 服务器启动 ====================

const startServer = async () => {
  try {
    // 初始化数据库
    try {
      // 开发环境才执行建表
      if (process.env.NODE_ENV !== 'production') {
        console.log('⚙️ 正在初始化数据库表...');
        // await createTables(); // 执行建表，添加了用户认证相关的表
        console.log('✅ 数据库表初始化完成');
      }
    } catch (error) {
      console.error('💥 数据库初始化失败:', error);
      process.exit(1);
    }
    
    // 启动服务器
    server.listen(PORT, () => {
      console.log(`\n🚀 智能体对话系统启动成功!`);
      console.log(`📍 端口: ${PORT}`);
      console.log(`🌐 HTTP API: ${SERVER_PUBLIC_URL}/api`);
      console.log(`🔌 WebSocket: ${SERVER_PUBLIC_URL.replace('http', 'ws')}/ws/chat`);
      console.log(`☁️  阿里云OSS: ${ossConfig.bucket}.${ossConfig.endpoint}`);
      console.log(`🗄️  MySQL数据库: ${dbConfig.host}:3306/${dbConfig.database}`);
      console.log(`📁 临时文件目录: ${TEMP_DIR}`);
      console.log(`🔒 CORS允许来源: ${ALLOWED_ORIGINS.join(', ')}`);
      console.log(`\n📚 API接口列表:`);
      console.log(`  POST /api/user/register - 用户注册`);
      console.log(`  POST /api/user/login - 用户登录`);
      console.log(`  GET  /api/user/Id - 获取用户信息`);
      console.log(`  POST /api/user/logout - 用户登出`);
      console.log(`  GET  /api/voice/list - 获取音色列表`);
      console.log(`  GET  /api/user/:userId/favorites - 获取用户收藏的智能体`);
      console.log(`  GET  /api/user/:userId/characters - 获取用户自建的智能体`);
      console.log(`  POST /api/user/:userId/characters - 创建自建智能体`);
      console.log(`  GET  /api/characters/public - 获取公共智能体广场`);
      console.log(`  GET  /api/characters/custom - 获取自建智能体广场`);
      console.log(`  POST /api/user/:userId/favorites/:characterId - 收藏智能体`);
      console.log(`  DELETE /api/user/:userId/favorites/:characterId - 取消收藏智能体`);
      console.log(`  GET  /api/scenes - 获取对话场景列表`);
      console.log(`  GET  /api/user/:userId/sessions - 获取用户对话历史`);
      console.log(`  GET  /api/sessions/:sessionId/messages - 获取会话消息`);
      console.log(`  POST /api/user/:userId/sessions - 创建新对话会话`);
      console.log(`  PUT  /api/sessions/:sessionId/scene - 更新会话场景`);
      console.log(`  POST /api/scenes/upload-image - 上传场景背景图片`);
      console.log(`  POST /api/user/:userId/scenes - 创建自定义场景`);
      console.log(`  PUT  /api/scenes/:sceneId/image - 更新场景背景图`);
      console.log(`  GET  /api/characters/:characterId - 获取角色详情`);
      console.log(`\n✅ 服务器就绪，等待连接...\n`);
    });
    
  } catch (error) {
    console.error('💥 服务器启动失败:', error);
    process.exit(1);
  }
};

// 启动服务器
startServer();

// 优雅关闭处理
process.on('SIGINT', async function() {
  console.log('\n🛑 正在关闭服务器...');
  
  try {
    // 关闭数据库连接池
    await pool.end();
    console.log('✓ 数据库连接已关闭');
  } catch (error) {
    console.warn('× 关闭数据库连接失败:', error.message);
  }
  
  // 清理所有临时文件
  try {
    const files = fs.readdirSync(TEMP_DIR);
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.unlinkSync(filePath);
    });
    console.log('✓ 临时文件已清理');
  } catch (error) {
    console.warn('× 清理临时文件失败:', error.message);
  }
  
  server.close(() => {
    console.log('✅ 服务器已关闭');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('💥 未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 未处理的Promise拒绝:', reason);
});
> **本目录是「网关监听版」存档**：从原仓库裁剪而来——已移除文件分享系统与 D1 备份/恢复；
> 保留自动导入（频道监听）、素材归档、换 API 面板、自动打标签。主线开发在仓库的 `worker/` 目录（Cloudflare Workers 版）。
> 新部署请优先看根目录 README 里的 Workers 版教程。
> 下方是原仓库 README，涉及已移除功能的段落不再适用。

# 🎈 SillyTavern 素材归档 & 文件分享 Bot

一个面向 SillyTavern 社区的 Discord 机器人，两大功能板块：

1. **自动导入系统** — 往上传频道扔角色卡 / 世界书 / 预设文件，bot 自动解析内容、按类型发布论坛帖、生成简介、自动打标签
2. **文件分享系统** — 为论坛发帖人提供带访问控制的作品发布面板（点赞解锁 / 提取码 / 下载统计），防爬虫盗取

技术栈：Node.js + discord.js（Components V2）、SQLite（分享系统）、Supabase（素材归档）、Cloudflare D1（备份）、OpenAI 兼容 LLM API（自动打标签）。

---

## 📥 自动导入系统

### 工作流程

```
用户在上传频道发文件 (PNG / JSON / TXT)
        │
        ▼
识别类型（纯结构判断，不消耗 LLM）
  ├─ PNG 内嵌 chara/ccv3 数据块 → 角色卡
  ├─ JSON 含角色卡字段          → 角色卡
  ├─ JSON 含 entries 条目结构    → 世界书
  ├─ JSON 含预设特征字段         → 预设
  ├─ TXT                        → 文本文档
  └─ 无法识别                    → 跳过并标记 ❓
        │
        ▼
查重（hash 完全相同 → 跳过 🔁；同名素材 → 追加附件到已有帖子）
        │
        ▼
按类型发布到对应论坛频道 + 附上文件
        │
        ▼
自动打标签（本地匹配卡内标签优先，LLM 补充）
        │
        ▼
在原上传消息上添加表情反馈
```

### 表情反馈含义

| 表情 | 含义 |
| ---- | ---- |
| ✅ | 至少一个文件导入/追加成功 |
| 🔁 | 存在完全重复的文件（hash 相同），已跳过 |
| ❌ | 存在解析或导入失败的文件（详情见日志频道） |
| ❓ | 存在无法识别的文件格式 |

一条消息带多个附件时，每个附件**独立处理**，互不影响；表情可能叠加出现。

### 支持的文件类型

| 类型 | 格式 | 识别依据 | 帖子内容 |
| ---- | ---- | ---- | ---- |
| 角色卡 | `.png` / `.json` | PNG tEXt 块（`chara`/`data`/`ccv3`，支持 base64）；JSON 的 V1/V2/V3 卡字段 | 作者（读 `creator` 字段，其次正则提取）、卡内标签、清洗后的简介（去 XML/YAML 符号、句子边界截断） |
| 世界书 | `.json` | `entries` 条目结构（兼容 ST 导出格式和角色书格式） | 条目数 / 启用数、内容总量、条目清单 |
| 预设 | `.json` | 聊天补全 / Instruct / Context / TextGen 采样特征字段 | 预设类型、关键参数（温度、上下文等）、Prompt 条目清单 |
| 文本文档 | `.txt` | 文件扩展名（自动识别 UTF-8 / GB18030 编码） | 标题、作者、标签、字数与简介（从文档头部提取） |

角色卡内嵌 `character_book` 时仍会正确识别为角色卡。

### 分频道发布

在 `.env` 中配置（见 `.env.example`）：

```text
CHARACTER_FORUM_ID=角色卡论坛ID     # 必填，同时是回退频道
WORLDBOOK_FORUM_ID=世界书论坛ID     # 可选
PRESET_FORUM_ID=预设论坛ID          # 可选
TXT_FORUM_ID=文本文档论坛ID         # 可选
```

`WORLDBOOK_FORUM_ID` / `PRESET_FORUM_ID` / `TXT_FORUM_ID` 不填时，对应类型会发到 `CHARACTER_FORUM_ID`。类型识别是纯结构判断，**不需要**提前调用 LLM。

### 自动打标签

新帖创建后（含 bot 自动发布的帖子）：

1. **本地匹配优先**：从首楼「🏷️ 卡内标签」行提取标签，与论坛可用标签做精确/包含匹配，命中的直接采用
2. 本地已匹配满 5 个（Discord 上限）→ 直接应用，**跳过 LLM 调用**
3. 否则调用 LLM 补充，与本地结果合并去重后应用
4. LLM API 不可用时，本地匹配到的标签仍会照常应用

在 `bot_config.json` 的 `auto_tag.enabled_channels` 中配置启用的论坛频道；LLM API 通过 `/aaa更换api` 命令配置（支持 DeepSeek / OpenAI / 通义 / 智谱等 OpenAI 兼容接口）。

---

## 📤 文件分享系统

在论坛频道发帖时，bot 自动向**发帖人**（bot 自己发的帖不会触发）发送作品发布面板。

### 命令列表

| 命令 | 权限 | 说明 |
| ---- | ---- | ---- |
| `/aaa发布作品` | 楼主 / 管理员 | 呼出发布模态框，上传文件并设置获取条件 |
| `/aaa获取作品` | 所有人 | 在分享帖内一键获取最新文件 |
| `/aaa查询作品` | 分级 | 发布者可见下载次数；管理员可见具体下载用户与时间 |
| `/aaa查询用户` | 管理员 | 查询某用户的历史获取记录 |
| `/aaa移除作品` | 发布者 / 管理员 | 销毁文件记录与访问权限 |
| `/aaa关闭自动提示` / `/aaa启用自动提示` | 个人 | 开关发帖时的发布面板自动弹出 |

### 获取条件

支持四种：无限制 / 点赞后可下载 / 点赞或评论后可下载 / 提取码。下载链接通过隐藏消息（Ephemeral）单独发给通过验证的用户，不会暴露在帖子里。

### 防护设计

- 每日下载限额（`daily_download_limit`），同一文件当日重复获取不重复扣额
- 按钮与命令全部带权限校验；服主 / 发布者 / 访客三级数据视角隔离

---

## 📦 归档素材系统（手动上传）

除了自动导入，也支持手动上传 + 打标签：

| 命令 | 说明 |
| ---- | ---- |
| `/aaa素材上传` | 上传文件 + 打标签，自动识别角色卡，超限文件自动分片存储 |
| `/aaa素材搜索` | 按标签组合搜索，支持翻页 |
| `/aaa角色搜索` | 按角色名模糊搜索角色卡，支持翻页 |

标签池在根目录 `tag_simple.txt`（内置 180+ 标签，分 Novel / CharCard / General 三类），上传时自动补全，改完重启生效。

文件存储在 Discord 存储频道（不占服务器磁盘），超过大小上限自动分片上传。

---

## 🚀 部署指南

### 1. 创建 Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) 新建应用 → `Bot` → `Reset Token` 复制密文
2. 同页面打开 **Privileged Gateway Intents** 的全部三个开关（尤其 `Message Content Intent`）
3. 邀请 bot 进服务器，需要权限：管理帖子、发送消息、添加反应、附加文件

### 2. 配置 `.env`

复制 `.env.example` 为 `.env`，填入 Token 与各频道 ID。
（获取 ID：用户设置 → 高级 → 开启开发者模式，然后右键频道/服务器 → 复制 ID）

### 3. 配置 `data/config/bot_config.json`

| 字段 | 说明 |
| ---- | ---- |
| `main_config.safety_setting.command_push_guildids` | 服务器 ID，斜杠命令只在这里注册 |
| `main_config.safety_setting.developers_userid` / `admin_roleid` | 开发者用户 ID / 管理员角色 ID |
| `file_share.forum_channel_ids` | 启用发布面板的论坛频道 |
| `file_share.daily_download_limit` | 每日下载限额 |
| `logger.log_channel_id` | 日志频道（启动、导入、打标签、错误都汇报到这里） |
| `archive.storage_channel_id` | 归档存储频道（建议私密） |
| `archive.max_upload_size_mb` | 单文件上限（无 Nitro 服务器填 10） |
| `auto_tag.enabled_channels` | 启用自动打标签的论坛频道 |

### 4. 启动

```bash
npm install
npm start        # 或 pm2 start ecosystem.config.js
npm run dev      # 开发模式，改文件自动重启
```

日志频道出现 `[bot] 所有模块初始化完成，机器人就绪！` 即成功。

---

## 🗄️ 数据与备份

- **文件分享系统**：本地 SQLite（`data/shared_files.sqlite`），删除该文件即重置
- **归档 Asset**：Supabase + 本地 JSON 缓存（`data/assets_backup/`，数量由 `ASSET_CACHE_LIMIT` 控制）
- **备份 / 恢复**：`backup` / `restore` / `status` 命令，支持 Cloudflare D1
- **异地文件备份**（可选）：配置 `IMGBED_URL` 后，自动导入的文件会额外备份到自建 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed)，外链记录在日志频道与本地缓存中

## 🧪 开发注意事项

- `utils/test_activity_logger.js` 会把每一次交互记录到 `logs/`，正式环境建议在 `bot/index.js` 中注释掉对应行
- 面板 UI 按 Discord Components V2 编写，改 UI 遇到 `Invalid Form Body (50035)` 时优先检查组件堆叠顺序
- `.env`、`logs/`、`data/*.sqlite` 均已在 `.gitignore` 中，**打包分发项目时注意手动剔除**

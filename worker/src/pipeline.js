/**
 * 导入流水线（Workers 版的核心）
 *
 * 逻辑与网关版 importer/index.js 的 processAttachment 一一对应：
 *   解析（角色卡/世界书/预设/文本）→ hash 查重 → 同名追加 / 新帖发布
 *   → 保存 Asset（Supabase）→ 图床备份 → 自动打标签 → 日志
 *
 * 差别只在外壳：discord.js 的 channel/thread/message 对象换成 REST 调用；
 * 触发方式有三个入口共用本流水线——/导入 命令、文件上传频道定时轮询、
 * （网关版在 gateway/ 目录里，仍用它自己的 importer）。
 */

import { parseAsset, TYPE_LABELS } from './core/asset_parser.js';
import { generateHash } from './core/hash.js';
import { findByHash, findByIdentity, saveAsset, deleteAsset } from './core/asset_storage.js';
import { formatForumMessage } from './core/forum_formatter.js';
import { isImgBedEnabled, backupToImgBed } from './core/imgbed.js';
import { computeAutoTags, isAutoTagEnabled } from './core/auto_tagger.js';
import { sendLog } from './core/logger.js';
import * as api from './discord_api.js';

/** 生成 identity：角色卡沿用旧格式（兼容已有数据），其他类型加前缀防止跨类型撞名 */
export function buildIdentity(asset) {
    const slug = (asset.name || '').toLowerCase().replace(/\s+/g, '_');
    if (!slug) return null;
    return asset.type === 'character' ? slug : `${asset.type}_${slug}`;
}

/** 按素材类型选择目标论坛频道（未单独配置时回退到角色卡论坛） */
export function resolveForumId(env, assetType) {
    const fallback = env.CHARACTER_FORUM_ID;
    if (assetType === 'worldbook') return env.WORLDBOOK_FORUM_ID || fallback;
    if (assetType === 'preset') return env.PRESET_FORUM_ID || fallback;
    if (assetType === 'text') return env.TXT_FORUM_ID || fallback;
    return fallback;
}

/**
 * 处理单个文件（已下载到内存）
 * @param {object} ctx - { env, supabase, apiConfig }
 * @param {{name:string, url:string, buffer:Buffer}} file
 * @returns {Promise<'success'|'appended'|'duplicate'|'failed'|'unsupported'>}
 */
export async function processImportedFile(ctx, file) {
    const { env } = ctx;
    try {
        file.hash = generateHash(file.buffer);

        // ---- 解析 ----
        const { asset, type, debug } = await parseAsset(file);
        if (!asset || type === 'unknown' || type === 'unsupported') {
            await sendLog(env, 'warning', {
                module: 'Importer',
                operation: '跳过文件',
                message: `文件: ${file.name}\n原因: ${type === 'unsupported' ? '不支持的格式' : '无法识别为角色卡/世界书/预设'}${debug ? `\n数据块: ${JSON.stringify(debug.chunks)}` : ''}`,
            });
            return 'unsupported';
        }

        asset.hash = file.hash;
        asset.identity = buildIdentity(asset);

        // ---- 完全重复（同 hash）：跳过 ----
        const exists = await findByHash(ctx.supabase, file.hash);
        if (exists) return 'duplicate';

        // ---- 同名素材（更新版文件）：追加附件到已有帖子 ----
        const sameAsset = asset.identity ? await findByIdentity(ctx.supabase, asset.identity) : null;
        if (sameAsset) {
            // 原版这里 sameAsset 缺 type 字段、发帖只能回退到角色卡论坛；
            // Workers 版先用本次解析的类型补上，再决定论坛（行为修正，已注明）
            sameAsset.type = asset.type;

            if (!sameAsset.forum || !sameAsset.forum.threadId) {
                const thread = await publishAsset(ctx, sameAsset);
                sameAsset.forum = { threadId: thread.id };
            }

            await api.postFileMessage(env, sameAsset.forum.threadId, `📦 新增文件：${file.name}`, file.name, file.buffer);

            // 用新版文件的解析结果刷新素材内容（简介/标签可能更新了）
            sameAsset.description = asset.description || sameAsset.description;
            if (Array.isArray(asset.tags) && asset.tags.length > 0) {
                sameAsset.tags = asset.tags;
            }
            if (asset.creator) sameAsset.creator = asset.creator;

            // 把新附件记录进数据库，重复上传同一更新版时能被 findByHash 拦截
            sameAsset.attachments = sameAsset.attachments || [];
            const alreadyRecorded = sameAsset.attachments.some(a => a.hash === file.hash);
            if (!alreadyRecorded) {
                const newAttachment = { filename: file.name, url: file.url, hash: file.hash };
                const backupUrl = await backupFile(ctx, file);
                if (backupUrl) newAttachment.backup_url = backupUrl;
                sameAsset.attachments.push(newAttachment);
            }
            await saveAsset(ctx.supabase, sameAsset);

            await refreshStarterMessage(ctx, sameAsset);
            return 'appended';
        }

        // ---- 全新素材：发帖 + 保存 ----
        try {
            asset.status = 'pending';
            await saveAsset(ctx.supabase, asset);

            const thread = await publishAsset(ctx, asset);
            asset.forum = { threadId: thread.id };
            await api.postFileMessage(env, thread.id, `📦 新增文件：${file.name}`, file.name, file.buffer);

            const backupUrl = await backupFile(ctx, file);
            if (backupUrl && asset.attachments?.[0]) {
                asset.attachments[0].backup_url = backupUrl;
            }

            asset.status = 'published';
            await saveAsset(ctx.supabase, asset);

            await autoTagPublishedThread(ctx, asset, thread);

            await sendLog(env, 'success', {
                module: 'Importer',
                operation: 'Asset导入',
                message:
`文件: ${asset.source?.filename || '未知'}
名称: ${asset.identity || asset.name}
类型: ${TYPE_LABELS[asset.type] || asset.type}
状态: ${asset.status}`,
            });

            return 'success';
        } catch (error) {
            // 发布失败：回滚刚保存的 pending 记录（失败不留痕，重试不会被误判为「重复文件」）
            await deleteAsset(ctx.supabase, asset.id).catch(() => {});
            throw error;
        }

    } catch (error) {
        console.error('[Importer] 导入失败:', file.name, error);
        await sendLog(env, 'error', {
            module: 'Importer',
            operation: '导入失败',
            message: `文件: ${file.name}\n错误: ${error.message}`,
        }).catch(() => {});
        return 'failed';
    }
}

/** 发帖：按类型选论坛、生成首楼、截断标题（与原 forum_publisher 一致） */
async function publishAsset(ctx, asset) {
    const { env } = ctx;
    const forumId = resolveForumId(env, asset.type);
    if (!forumId) throw new Error('未配置目标论坛频道（CHARACTER_FORUM_ID）');

    const content = formatForumMessage(asset);

    let threadName = (asset.name || '未命名').trim();
    if (threadName.length > 100) threadName = threadName.slice(0, 99) + '…';

    const thread = await api.createForumThread(env, forumId, threadName, content);
    thread.__forumId = forumId;
    thread.__content = content;
    thread.__name = threadName;

    await sendLog(env, 'success', {
        module: 'Forum Publisher',
        operation: '创建帖子',
        message:
`类型: ${TYPE_LABELS[asset.type] || asset.type}
名称: ${asset.identity || asset.name}
Thread ID: ${thread.id}`,
    });

    return thread;
}

/** 发帖后自动打标签（原版靠 threadCreate 事件；Workers 版在流水线内联完成） */
async function autoTagPublishedThread(ctx, asset, thread) {
    const { env } = ctx;
    const forumId = thread.__forumId;
    if (!isAutoTagEnabled(env, forumId)) return;

    try {
        const forum = await api.getChannel(env, forumId);
        const availableTags = (forum?.available_tags || []).map(t => ({ id: t.id, name: t.name }));
        if (availableTags.length === 0) return;

        const { tagIds, llmExhausted } = await computeAutoTags(ctx.apiConfig, {
            title: thread.__name,
            content: thread.__content,
            availableTags,
        });

        if (llmExhausted) {
            await sendLog(env, 'error', {
                module: '自动打标签',
                operation: 'API 耗尽',
                message: llmExhausted,
            });
        }

        if (tagIds.length === 0) return;
        await api.patchThread(env, thread.id, { applied_tags: tagIds });

        await sendLog(env, 'success', {
            module: '自动打标签',
            operation: '标签已应用',
            message: '帖子「' + thread.__name + '」已自动打上 '
                + tagIds.map(id => {
                    const tag = availableTags.find(t => t.id === id);
                    return tag ? '`' + tag.name + '`' : '';
                }).filter(Boolean).join(' '),
        });
    } catch (e) {
        console.error('[auto_tagger] 自动打标签出错:', e.message);
    }
}

/** 备份文件到 ImgBed（未配置则跳过；失败只记日志，不影响主流程） */
async function backupFile(ctx, file) {
    const { env } = ctx;
    if (!isImgBedEnabled(env)) return null;
    const backupUrl = await backupToImgBed(env, file);
    if (backupUrl) {
        await sendLog(env, 'info', {
            module: 'ImgBed',
            operation: '异地备份',
            message: `文件: ${file.name}\n外链: ${backupUrl}`,
        }).catch(() => {});
    } else {
        await sendLog(env, 'warning', {
            module: 'ImgBed',
            operation: '备份失败',
            message: `文件: ${file.name}（详情见控制台日志）`,
        }).catch(() => {});
    }
    return backupUrl;
}

/** 用最新素材内容刷新帖子首楼（仅当首楼是 bot 自己发的；尽力而为） */
async function refreshStarterMessage(ctx, asset) {
    const { env } = ctx;
    try {
        const threadId = asset.forum?.threadId;
        if (!threadId) return;
        const starter = await api.getMessage(env, threadId, threadId);
        if (!starter) return;
        if (starter.author?.id !== env.DISCORD_APPLICATION_ID) return;

        const newContent = formatForumMessage(asset);
        if (starter.content !== newContent) {
            await api.editMessage(env, threadId, threadId, { content: newContent });
        }
    } catch (e) {
        console.error('[Importer] 刷新首楼失败（不影响导入）:', e.message);
    }
}

/**
 * 处理一条频道消息的全部附件（轮询入口用；含表情反馈，与原版一致）
 * @param {object} message - Discord REST 的 message 对象
 * @returns {Promise<string[]>} 每个附件的状态
 */
export async function processChannelMessage(ctx, message) {
    const results = [];
    for (const attachment of message.attachments || []) {
        try {
            const response = await fetch(attachment.url);
            if (!response.ok) throw new Error('附件下载失败 HTTP ' + response.status);
            const buffer = Buffer.from(await response.arrayBuffer());
            const status = await processImportedFile(ctx, {
                name: attachment.filename,
                url: attachment.url,
                buffer,
            });
            results.push(status);
        } catch (e) {
            console.error('[Importer] 附件处理失败:', attachment.filename, e.message);
            results.push('failed');
        }
    }

    // 表情反馈（与原版 reactWithSummary 一致）
    const emojis = [];
    if (results.includes('success') || results.includes('appended')) emojis.push('✅');
    if (results.includes('duplicate')) emojis.push('🔁');
    if (results.includes('failed')) emojis.push('❌');
    if (results.includes('unsupported')) emojis.push('❓');
    for (const emoji of emojis) {
        try {
            await api.addReaction(ctx.env, message.channel_id, message.id, emoji);
        } catch (e) {
            console.error('[Importer] 添加反馈表情失败:', e.message);
        }
    }

    return results;
}

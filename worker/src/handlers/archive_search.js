/**
 * /标签搜索 与 /角色搜索（Workers 版）
 *
 * 2026-11-23 修正：原版查的是 archive_store（archive_files /
 * character_cards），而导入流水线写的是 assets——两本账，搜索永远
 * 查空。现统一改查 assets 表：
 * 角色搜索按名字/作者，标签搜索按关键词（名字/作者/简介），
 * 结果带帖子直达链接。Embed/按钮为原生 JSON，翻页走 UPDATE_MESSAGE。
 */

import { editOriginal } from '../discord_api.js';

const PAGE_SIZE = 8;

function parseTags(tagsStr) {
    return String(tagsStr || '').split(/\s+/).filter(t => t.trim().length > 0);
}

/** assets 类型标签（identity 前缀区分；无前缀 = 角色卡） */
function typeLabel(identity) {
    if (/^worldbook_/.test(identity || '')) return '📚 世界书';
    if (/^preset_/.test(identity || '')) return '⚙️ 预设';
    if (/^text_/.test(identity || '')) return '📄 文本';
    return '🎭 角色卡';
}

function cleanForOr(v) {
    return String(v).replace(/[%_(),]/g, '').trim();
}

/**
 * 在 assets 里按关键词搜索：每个关键词都要在 名字/作者/简介 任一处命中。
 * nameOnly=true 时只查名字/作者（角色搜索用）。
 */
async function searchAssets(ctx, keywords, page, nameOnly = false) {
    let query = ctx.supabase
        .from('assets')
        .select('id, identity, name, creator, thread_id, created_at', { count: 'exact' });
    for (const kw of keywords) {
        const k = cleanForOr(kw);
        if (!k) continue;
        query = nameOnly
            ? query.or(`name.ilike.%${k}%,creator.ilike.%${k}%`)
            : query.or(`name.ilike.%${k}%,creator.ilike.%${k}%,description.ilike.%${k}%`);
    }
    const from = (page - 1) * PAGE_SIZE;
    const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const assets = data || [];
    const filesByAsset = {};
    if (assets.length > 0) {
        const { data: atts } = await ctx.supabase
            .from('attachments')
            .select('asset_id, filename')
            .in('asset_id', assets.map(a => a.id));
        for (const att of atts || []) {
            (filesByAsset[att.asset_id] ||= []).push(att.filename);
        }
    }
    const total = count || 0;
    return { assets, filesByAsset, total, page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** 一条 assets 搜索结果的 embed field */
function assetField(ctx, asset, filesByAsset) {
    const files = filesByAsset[asset.id] || [];
    const ts = Math.floor(new Date(asset.created_at).getTime() / 1000);
    return {
        name: `${typeLabel(asset.identity)} ${asset.name}`,
        value: [
            asset.creator ? `👤 作者：${asset.creator}` : null,
            files.length ? `📁 ${files[0]}${files.length > 1 ? ` 等 ${files.length} 个文件` : ''}` : null,
            asset.thread_id ? `🔗 [去帖子](https://discord.com/channels/${ctx.env.GUILD_ID}/${asset.thread_id})` : null,
            `🕐 <t:${ts}:R>`,
        ].filter(Boolean).join('\n'),
        inline: false,
    };
}

function pageButtons(prefix, key, result) {
    if (result.totalPages <= 1) return [];
    const row = { type: 1, components: [] };
    if (result.page > 1) {
        row.components.push({
            type: 2, style: 1,
            custom_id: `${prefix}:${key}:${result.page - 1}`,
            label: '◀ 上一页',
        });
    }
    if (result.page < result.totalPages) {
        row.components.push({
            type: 2, style: 1,
            custom_id: `${prefix}:${key}:${result.page + 1}`,
            label: '下一页 ▶',
        });
    }
    return row.components.length > 0 ? [row] : [];
}

/** 构建素材搜索结果 payload（命令与翻页共用） */
export async function buildTagSearchPayload(ctx, tagsStr, page) {
    const tagList = parseTags(tagsStr);
    if (tagList.length === 0) return { content: '❌ 标签得给我，至少一个。' };

    const result = await searchAssets(ctx, tagList, page);
    if (result.assets.length === 0) {
        return { content: '没有找到符合的素材，换个关键词试试。' };
    }

    const embed = {
        color: 0x3498db,
        title: '🔍 搜索结果',
        description: `搜索关键词: \`${tagList.join('`, `')}\`\n共找到 **${result.total}** 个素材 | 第 ${result.page}/${result.totalPages} 页`,
        timestamp: new Date().toISOString(),
        fields: result.assets.map(a => assetField(ctx, a, result.filesByAsset)),
    };

    return { embeds: [embed], components: pageButtons('archive_search_page', tagsStr, result) };
}

/** 构建角色搜索结果 payload（命令与翻页共用） */
export async function buildCharSearchPayload(ctx, nameQuery, page) {
    if (!nameQuery || nameQuery.trim().length === 0) return { content: '请提供要搜索的角色名。' };

    const q = nameQuery.trim();
    const result = await searchAssets(ctx, [q], page, true);
    if (result.assets.length === 0) {
        return { content: `没有找到叫「${q}」的角色卡。` };
    }

    const embed = {
        color: 0x9b59b6,
        title: '🎭 搜索结果',
        description: `搜索角色名: **${q}**\n共找到 **${result.total}** 条 | 第 ${result.page}/${result.totalPages} 页`,
        timestamp: new Date().toISOString(),
        fields: result.assets.map(a => assetField(ctx, a, result.filesByAsset)),
    };

    return { embeds: [embed], components: pageButtons('archive_char_page', nameQuery, result) };
}

function getOption(interaction, name) {
    return (interaction.data.options || []).find(o => o.name === name)?.value;
}

export async function executeTagSearch(ctx, interaction) {
    const tagsStr = getOption(interaction, 'tags') || '';
    const page = getOption(interaction, 'page') || 1;
    return {
        __deferFlags: 64,
        __run: async () => {
            try {
                const payload = await buildTagSearchPayload(ctx, tagsStr, page);
                await editOriginal(ctx.env, interaction, payload);
            } catch (error) {
                console.error('[search] 搜索素材出错:', error);
                await editOriginal(ctx.env, interaction, { content: '出错了：' + error.message });
            }
        },
    };
}

export async function executeCharSearch(ctx, interaction) {
    const nameQuery = getOption(interaction, 'name') || '';
    const page = getOption(interaction, 'page') || 1;
    return {
        __deferFlags: 64,
        __run: async () => {
            try {
                const payload = await buildCharSearchPayload(ctx, nameQuery, page);
                await editOriginal(ctx.env, interaction, payload);
            } catch (error) {
                console.error('[charsearch] 搜索角色卡出错:', error);
                await editOriginal(ctx.env, interaction, { content: '出错了：' + error.message });
            }
        },
    };
}

/** 翻页按钮：custom_id = archive_search_page:<tags>:<page> / archive_char_page:<name>:<page> */
export async function handleSearchPageButton(ctx, interaction) {
    const customId = interaction.data.custom_id;
    const isChar = customId.startsWith('archive_char_page:');
    const rest = customId.slice(isChar ? 'archive_char_page:'.length : 'archive_search_page:'.length);
    const sep = rest.lastIndexOf(':');
    const key = rest.slice(0, sep);
    const page = parseInt(rest.slice(sep + 1), 10) || 1;

    const payload = isChar
        ? await buildCharSearchPayload(ctx, key, page)
        : await buildTagSearchPayload(ctx, key, page);

    return {
        type: 7, // UPDATE_MESSAGE
        data: { ...payload, flags: 64 },
    };
}

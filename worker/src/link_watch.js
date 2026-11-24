/**
 * 链接更新盯梢
 *
 * 背景：作者更新作品时通常只改文件名、不换链接。日常操作是把文件
 * 对应的链接直接发进素材帖子里——所以盯梢对象 = 帖子里出现的链接，
 * 外加 /关注链接 命令手动登记的链接。
 *
 * 机制：
 *   1. 扫帖登记：定时（随 5 分钟 cron 分批轮转）扫素材帖的新消息，把人类
 *      发言里的 http(s) 链接登记进 link_watch（跳过 Discord CDN 等
 *      内容永不变的域名、跳过 bot 发言）。
 *   2. 定时比对：每条链接约 20 小时重抓一次，比对文件名 + SHA-256。
 *      哈希变了 = 作者更新了 → 走 pipeline.processImportedFile 把新版
 *      自动续进原帖、刷新首楼，再往通知频道报一声。
 *      只有文件名变、内容没变 → 只更新记录，不打扰。
 *   3. 更新通知直接发进对应帖子（帖子会被顶到论坛前面）；
 *      没有帖子的独立链接才回退通知频道 / 日志频道。
 *   4. 连续失败 5 次标记 dead 并记一条日志，不再重试。
 */

import * as api from './discord_api.js';
import { generateHash } from './core/hash.js';
import { processImportedFile } from './pipeline.js';
import { sendLog } from './core/logger.js';

const SCAN_BATCH = 10;          // 每 tick 扫的帖子数（实测单 tick 约处理 15 帖就被运行时截断，取 10 留余量；547 帖约 4.5 小时轮完）
const SCAN_FIRST_LIMIT = 100;   // 新帖首次扫描从头看多少条（链接一般在帖子靠前的位置）
const CHECK_BATCH = 15;         // 每 tick 比对的链接数
const CHECK_INTERVAL_HOURS = 20;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FAILS = 5;
const CURSOR_ID = 'linkwatch_scan_cursor';

const SKIP_HOSTS = new Set([
    'cdn.discordapp.com',
    'media.discordapp.net',
    'discordapp.com',
    'tenor.com',
    'media.tenor.com',
    'giphy.com',
]);

/**
 * Discord 帖子/消息链接解析：发进帖子的「对应链接」基本都是这种——
 * 指向源服务器里作者的原帖。链接不变，作者更新时改的是原帖里的文件。
 * 形式：/channels/<guild>/<threadId> 或 /channels/<guild>/<channel>/<message>
 */
function parseDiscordLink(url) {
    const m = String(url).match(/^https?:\/\/discord\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    return { guildId: m[1], channelId: m[2], messageId: m[3] || m[2] };
}

// ---------- 基础工具 ----------

function extractUrls(text) {
    if (!text) return [];
    const out = [];
    const re = /https?:\/\/[^\s<>"'`）】]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const url = m[0].replace(/[.,;:!?，。；：、]+$/, '');
        try {
            const host = new URL(url).hostname.toLowerCase();
            if (!SKIP_HOSTS.has(host)) out.push(url);
        } catch { /* 不是合法 URL，跳过 */ }
    }
    return [...new Set(out)];
}

function filenameFromResponse(resp, finalUrl) {
    const cd = resp.headers.get('content-disposition') || '';
    const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
    if (star) {
        try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
    }
    const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
    if (plain) return (plain[1] || plain[2]).trim();
    try {
        const seg = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
        if (seg) return decodeURIComponent(seg);
    } catch { /* fall through */ }
    return 'download';
}

async function fetchLinkFile(url) {
    const resp = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept': '*/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const len = Number(resp.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw new Error('文件过大（' + Math.round(len / 1024 / 1024) + 'MB）');
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) throw new Error('文件过大');
    if (buffer.length < 4) throw new Error('文件为空或过小');
    return { buffer, filename: filenameFromResponse(resp, resp.url || url) };
}

// ---------- 登记 ----------

async function registerLink(ctx, { url, source, assetId = null, threadId = null, postedBy = null }) {
    const { data, error } = await ctx.supabase
        .from('link_watch')
        .upsert(
            { url, asset_id: assetId, thread_id: threadId, source, posted_by: postedBy },
            { onConflict: 'url', ignoreDuplicates: true }
        )
        .select('id');
    if (error) {
        console.error('[LinkWatch] 登记失败:', url, error.message);
        return false;
    }
    return Array.isArray(data) && data.length > 0; // true = 新登记
}

async function assetName(ctx, link) {
    if (link.asset_id) {
        const { data } = await ctx.supabase
            .from('assets').select('name').eq('id', link.asset_id).maybeSingle();
        if (data?.name) return data.name;
    }
    return link.filename || link.url;
}

// ---------- 扫帖登记 ----------

async function loadCursor(ctx) {
    const { data } = await ctx.supabase
        .from('poll_state').select('last_message_id').eq('id', CURSOR_ID).maybeSingle();
    const n = parseInt(data?.last_message_id || '0', 10);
    return Number.isFinite(n) ? n : 0;
}

async function saveCursor(ctx, offset) {
    await ctx.supabase
        .from('poll_state')
        .upsert({ id: CURSOR_ID, last_message_id: String(offset), updated_at: new Date().toISOString() });
}

async function scanThreadsTick(ctx) {
    const { env } = ctx;
    const offset = await loadCursor(ctx);
    const { data: assets } = await ctx.supabase
        .from('assets')
        .select('id, thread_id')
        .not('thread_id', 'is', null)
        .order('thread_id', { ascending: true })
        .range(offset, offset + SCAN_BATCH - 1);

    if (!assets || assets.length === 0) {
        await saveCursor(ctx, 0);
        return;
    }

    let newLinks = 0;
    for (const asset of assets) {
        try {
            const { data: state } = await ctx.supabase
                .from('thread_scan_state')
                .select('last_message_id')
                .eq('thread_id', asset.thread_id)
                .maybeSingle();

            const messages = state?.last_message_id
                ? await api.listMessagesAfter(env, asset.thread_id, state.last_message_id, 100)
                : await api.listMessagesAfter(env, asset.thread_id, '0', SCAN_FIRST_LIMIT);
            if (!messages || messages.length === 0) continue;

            for (const message of messages) {
                if (message.author?.bot) continue;
                if (env.DISCORD_APPLICATION_ID && message.author?.id === env.DISCORD_APPLICATION_ID) continue;
                for (const url of extractUrls(message.content || '')) {
                    const added = await registerLink(ctx, {
                        url,
                        source: 'thread',
                        assetId: asset.id,
                        threadId: asset.thread_id,
                        postedBy: message.author?.id || null,
                    });
                    if (added) newLinks++;
                }
            }

            await ctx.supabase
                .from('thread_scan_state')
                .upsert({
                    thread_id: asset.thread_id,
                    last_message_id: messages[messages.length - 1].id,
                    updated_at: new Date().toISOString(),
                });
        } catch (e) {
            console.error('[LinkWatch] 扫帖失败:', asset.thread_id, e.message);
        }
        // 逐帖推进游标：tick 中途被截断也不丢已扫进度
        await saveCursor(ctx, offset + assets.indexOf(asset) + 1).catch(() => {});
    }

    await saveCursor(ctx, assets.length < SCAN_BATCH ? 0 : offset + SCAN_BATCH);
    if (newLinks > 0) {
        await sendLog(env, 'info', {
            module: 'LinkWatch',
            operation: '扫帖登记',
            message: `本轮新登记 ${newLinks} 条链接盯梢。`,
        }).catch(() => {});
    }
}

// ---------- 定时比对 ----------

async function notifyUpdate(ctx, link, oldFilename, newFilename) {
    const { env } = ctx;
    const name = await assetName(ctx, link);
    // 首选：直接发进对应帖子——既是通知，也把帖子顶到论坛前面
    if (link.thread_id) {
        const content = `《${name}》已更新：${oldFilename || ''} → ${newFilename}，新版在下面。`;
        const ok = await api.postMessage(env, link.thread_id, { content }).catch(e => {
            console.error('[LinkWatch] 帖内通知发送失败:', e.message);
            return null;
        });
        if (ok) return;
    }
    const threadUrl = link.thread_id && env.GUILD_ID
        ? `https://discord.com/channels/${env.GUILD_ID}/${link.thread_id}`
        : null;
    const content = `《${name}》已更新：${oldFilename || ''} → ${newFilename}，新版已自动续进原帖。`
        + (threadUrl ? `\n${threadUrl}` : `\n${link.url}`);
    if (env.UPDATE_NOTIFY_CHANNEL_ID) {
        await api.postMessage(env, env.UPDATE_NOTIFY_CHANNEL_ID, { content }).catch(e =>
            console.error('[LinkWatch] 通知频道发送失败:', e.message));
    } else {
        await sendLog(env, 'info', {
            module: 'LinkWatch',
            operation: '链接更新',
            message: content,
        }).catch(() => {});
    }
}

/**
 * Discord 帖子链接比对：读源帖首楼消息，比对附件文件名 + 内容哈希。
 * 前提：bot 必须在源服务器里且能看该频道，否则 Discord 直接拒绝，
 * 连续失败会标 dead 并在日志里说明（多半是没权限）。
 */
async function checkDiscordLink(ctx, link, discord, now) {
    const msg = await api.getMessage(ctx.env, discord.channelId, discord.messageId);
    const att = (msg.attachments || [])[0];
    let filename;
    let buffer = null;
    if (att) {
        filename = att.filename;
        const resp = await fetch(att.url, { signal: AbortSignal.timeout(25000) });
        if (!resp.ok) throw new Error('附件下载失败 HTTP ' + resp.status);
        buffer = Buffer.from(await resp.arrayBuffer());
    } else {
        // 没有附件的帖：用正文当比对信号（作者改帖即触发）
        filename = (msg.content || '').slice(0, 40) || '（空帖）';
        buffer = Buffer.from(msg.content || '', 'utf-8');
    }
    const hash = generateHash(buffer);

    if (!link.hash) {
        await ctx.supabase.from('link_watch')
            .update({ filename, hash, last_checked_at: now, fail_count: 0 })
            .eq('id', link.id);
        return;
    }
    if (hash === link.hash) {
        await ctx.supabase.from('link_watch')
            .update({ filename, last_checked_at: now, fail_count: 0 })
            .eq('id', link.id);
        return;
    }
    // 变了：有附件就走入库流水线续进原帖；纯文字帖只通知
    let changed = false;
    if (att && buffer) {
        const status = await processImportedFile(ctx, { name: filename, url: link.url, buffer });
        changed = status === 'success' || status === 'appended';
        if (!changed) {
            await sendLog(ctx.env, 'warning', {
                module: 'LinkWatch',
                operation: '更新处理异常',
                message: `源帖内容变了但入库状态是 ${status}：${link.url}（新文件 ${filename}）`,
            }).catch(() => {});
        }
    }
    await ctx.supabase.from('link_watch')
        .update({
            filename, hash, last_checked_at: now, fail_count: 0,
            ...(changed || !att ? { last_changed_at: now } : {}),
        })
        .eq('id', link.id);
    if (changed || !att) {
        await notifyUpdate(ctx, link, link.filename, filename);
    }
}

async function checkLinksTick(ctx) {
    const cutoff = new Date(Date.now() - CHECK_INTERVAL_HOURS * 3600 * 1000).toISOString();
    const { data: links } = await ctx.supabase
        .from('link_watch')
        .select('*')
        .eq('status', 'watching')
        .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
        .order('last_checked_at', { ascending: true, nullsFirst: true })
        .limit(CHECK_BATCH);
    if (!links || links.length === 0) return;

    for (const link of links) {
        const now = new Date().toISOString();
        try {
            const discord = parseDiscordLink(link.url);
            if (discord) {
                // 外服帖子链接：bot 不在源服务器就读不到，只保留登记当索引，
                // 不做必然失败的比对，免得刷屏和误标 dead
                if (discord.guildId !== ctx.env.GUILD_ID) continue;
                await checkDiscordLink(ctx, link, discord, now);
                continue;
            }
            const { buffer, filename } = await fetchLinkFile(link.url);
            const hash = generateHash(buffer);

            if (!link.hash) {
                // 首次抓取：只记基线，不算更新
                await ctx.supabase.from('link_watch')
                    .update({ filename, hash, last_checked_at: now, fail_count: 0 })
                    .eq('id', link.id);
                continue;
            }

            if (hash !== link.hash) {
                const status = await processImportedFile(ctx, { name: filename, url: link.url, buffer });
                const changed = status === 'success' || status === 'appended';
                await ctx.supabase.from('link_watch')
                    .update({
                        filename, hash, last_checked_at: now, fail_count: 0,
                        ...(changed ? { last_changed_at: now } : {}),
                    })
                    .eq('id', link.id);
                if (changed) {
                    await notifyUpdate(ctx, link, link.filename, filename);
                } else {
                    await sendLog(ctx.env, 'warning', {
                        module: 'LinkWatch',
                        operation: '更新处理异常',
                        message: `链接内容变了但入库状态是 ${status}：${link.url}（新文件 ${filename}）`,
                    }).catch(() => {});
                }
                continue;
            }

            // 内容没变：文件名变了也只更新记录（防签名链接的假改名打扰）
            await ctx.supabase.from('link_watch')
                .update({ filename, last_checked_at: now, fail_count: 0 })
                .eq('id', link.id);
        } catch (e) {
            const fails = (link.fail_count || 0) + 1;
            const dead = fails >= MAX_FAILS;
            await ctx.supabase.from('link_watch')
                .update({
                    last_checked_at: now,
                    fail_count: fails,
                    ...(dead ? { status: 'dead' } : {}),
                })
                .eq('id', link.id);
            if (dead) {
                await sendLog(ctx.env, 'warning', {
                    module: 'LinkWatch',
                    operation: '链接失效',
                    message: `连续 ${fails} 次抓不到，已停止盯梢：${link.url}\n最后错误：${e.message}`,
                }).catch(() => {});
            }
        }
    }
}

export async function linkWatchTick(ctx) {
    await scanThreadsTick(ctx).catch(e => console.error('[LinkWatch] 扫帖出错:', e));
    // 2026-11-24 她要求暂停 20 小时比对：LINK_WATCH_PAUSED=1 时只扫帖登记、不比对；改回 0 即恢复
    if (ctx.env.LINK_WATCH_PAUSED === '1') return;
    await checkLinksTick(ctx).catch(e => console.error('[LinkWatch] 比对出错:', e));
}

// ---------- /关注链接 命令 ----------

function getOption(interaction, name) {
    return (interaction.data.options || []).find(o => o.name === name)?.value;
}

export function executeWatchLinkCommand(ctx, interaction) {
    return {
        __deferFlags: 64,
        __run: async () => {
            const reply = (content) => api.editOriginal(ctx.env, interaction, { content }).catch(() => {});
            const url = (getOption(interaction, 'url') || '').trim();
            const nameQuery = (getOption(interaction, 'name') || '').trim();

            let parsed;
            try { parsed = new URL(url); } catch { /* handled below */ }
            if (!parsed || !/^https?:$/.test(parsed.protocol)) {
                await reply('链接格式不对，需要 http 或 https 开头的完整链接。');
                return;
            }
            if (SKIP_HOSTS.has(parsed.hostname.toLowerCase())) {
                await reply('这个链接的内容不会变化（Discord CDN 等），盯梢没有意义，请换作者的原链接。');
                return;
            }
            // Discord 帖子链接靠 bot 的读取权限比对，登记时不预抓基线，交给定时比对

            let asset = null;
            if (nameQuery) {
                const { data } = await ctx.supabase
                    .from('assets')
                    .select('id, name, thread_id')
                    .ilike('name', `%${nameQuery}%`)
                    .limit(5);
                if (!data || data.length === 0) {
                    await reply(`没找到叫「${nameQuery}」的素材。请先导入该素材，或不填名字直接登记。`);
                    return;
                }
                if (data.length > 1) {
                    await reply(`「${nameQuery}」匹配到多个素材：${data.map(a => a.name).join('、')}。请把名字写得更准确。`);
                    return;
                }
                asset = data[0];
            }

            const { data: existing } = await ctx.supabase
                .from('link_watch').select('id').eq('url', url).maybeSingle();
            if (existing) {
                await reply('这个链接已经在盯梢中了。');
                return;
            }

            // 先抓一次记基线（抓不到也登记，之后定时重试）；Discord 帖子链接跳过预抓
            let baseline = null;
            let fetchError = null;
            if (!parseDiscordLink(url)) {
                try {
                    const fetched = await fetchLinkFile(url);
                    baseline = { filename: fetched.filename, hash: generateHash(fetched.buffer) };
                } catch (e) {
                    fetchError = e.message;
                }
            }

            const { error } = await ctx.supabase.from('link_watch').insert({
                url,
                asset_id: asset?.id || null,
                thread_id: asset?.thread_id || null,
                source: 'command',
                posted_by: interaction.member?.user?.id || interaction.user?.id || null,
                filename: baseline?.filename || null,
                hash: baseline?.hash || null,
                last_checked_at: new Date().toISOString(),
            });
            if (error) {
                await reply('出错了：' + error.message);
                return;
            }

            const target = asset ? `《${asset.name}》` : '该链接';
            const discordLink = parseDiscordLink(url);
            if (discordLink && discordLink.guildId !== ctx.env.GUILD_ID) {
                await reply(`已登记。但源帖在其他服务器，bot 不在该服务器内，无法自动检测更新，仅作索引保存。`);
            } else if (discordLink) {
                await reply(`已登记盯梢：${target}，源帖文件变化时会自动把新版续进原帖。`);
            } else if (baseline) {
                await reply(`已登记盯梢：${target}，当前文件「${baseline.filename}」，链接内容变化时会自动把新版续进原帖。`);
            } else {
                await reply(`已登记盯梢：${target}。不过刚才没抓到文件（${fetchError}），先记空基线，之后定时重试。`);
            }
        },
    };
}

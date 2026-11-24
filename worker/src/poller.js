/**
 * 文件上传频道定时轮询（Workers 版的「监听」替代）
 *
 * 背景：图床（CloudFlare-ImgBed）上传文件后会通过 webhook 把文件推到
 * 一个固定的 Discord 频道。网关版 importer 靠 messageCreate 事件实时
 * 处理；Workers 没有消息事件，改用 Cron 定时以 REST 拉取该频道的新
 * 消息，逐条走与监听版相同的流水线（pipeline.processChannelMessage），
 * 处理完在原消息上加相同的表情反馈。
 *
 * 进度书签存在 Supabase 的 poll_state 表（id = 'imgbed_channel'），
 * 每处理完一条就推进一次，崩溃/超时不会重复处理太多。
 *
 * 与网关版一致的消息过滤：真正的 bot 账号发言忽略；webhook 消息放行
 * （图床正是 webhook 推送，REST 消息对象带 webhook_id）。
 */
import * as api from './discord_api.js';
import { processChannelMessage } from './pipeline.js';
import { sendLog } from './core/logger.js';

const STATE_ID = 'imgbed_channel';

async function loadBookmark(ctx) {
    const { data } = await ctx.supabase
        .from('poll_state')
        .select('last_message_id')
        .eq('id', STATE_ID)
        .maybeSingle();
    return data?.last_message_id || null;
}

async function saveBookmark(ctx, messageId) {
    await ctx.supabase
        .from('poll_state')
        .upsert({ id: STATE_ID, last_message_id: messageId, updated_at: new Date().toISOString() });
}

export async function pollImgbedChannel(ctx) {
    const { env } = ctx;
    const channelId = env.POLL_CHANNEL_ID;
    if (!channelId) return; // 未配置轮询频道，静默跳过

    let bookmark = await loadBookmark(ctx);

    if (!bookmark) {
        // 首次运行：只把书签钉在当前最新一条消息上，不补扫历史
        // （历史素材都在 Supabase 里，她明确不需要补扫）
        const latest = await api.listMessagesAfter(env, channelId, null, 1);
        if (latest.length > 0) {
            await saveBookmark(ctx, latest[latest.length - 1].id);
            await sendLog(env, 'info', {
                module: 'Poller',
                operation: '首次启动',
                message: `文件上传频道轮询已启用，书签钉在消息 ${latest[latest.length - 1].id}，此后的新文件将被自动导入。`,
            });
        }
        return;
    }

    const messages = await api.listMessagesAfter(env, channelId, bookmark, 100);
    for (const message of messages) {
        try {
            // 本频道是专门的收件频道：图床的 txt 帖由 relay bot 以 bot 账号
            // 发出（无 webhook_id），旧过滤会把它们整批跳过。放行 bot 帖；
            // 本 bot 从不在此频道发消息（只加表情），不会自循环；
            // 仍跳过本 bot 自己的帖子以防万一。
            const isSelf = !!ctx.env.DISCORD_APPLICATION_ID
                && message.author?.id === ctx.env.DISCORD_APPLICATION_ID;
            if (!isSelf && (message.attachments || []).length > 0) {
                await processChannelMessage(ctx, message);
            }
        } catch (e) {
            console.error('[Poller] 处理消息失败:', message.id, e.message);
            await sendLog(env, 'error', {
                module: 'Poller',
                operation: '处理失败',
                message: `消息: ${message.id}\n错误: ${e.message}`,
            }).catch(() => {});
        } finally {
            // 无论成败都推进书签，避免一条坏消息堵住整个队列；
            // 失败的文件在日志频道有记录，可手动用 /导入 补
            await saveBookmark(ctx, message.id).catch(() => {});
        }
    }
}

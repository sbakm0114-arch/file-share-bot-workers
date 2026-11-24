/**
 * 巡检：跟着定时 cron 抽查 assets 的帖子与文件还能不能下载。
 * 每 tick 抽查一批（游标轮转，全库约几小时轮一遍）：
 * 帖子被删 / 帖子里的文件不见了 / 文件 CDN 拉不动 → 判定损坏，
 * 在对应卡的帖子里发提示；帖子本身没了就报到日志频道。
 * 同一次损坏只提示一次（asset_health.warned_at），每 tick 最多发 3 条提示。
 */

import * as api from './discord_api.js';

const BATCH = 5;
const WARN_CAP = 3;
const CURSOR_KEY = 'health_cursor';

const REASON_TEXT = {
    thread_deleted: '帖子已经不在了',
    files_missing: '帖子里的文件不见了',
    cdn_failed: '文件链接失效了',
};

async function loadCursor(ctx) {
    const { data } = await ctx.supabase
        .from('poll_state').select('last_message_id').eq('id', CURSOR_KEY).maybeSingle();
    return data?.last_message_id || '';
}

async function saveCursor(ctx, value) {
    await ctx.supabase.from('poll_state')
        .upsert({ id: CURSOR_KEY, last_message_id: value }, { onConflict: 'id' });
}

async function setHealth(ctx, assetId, status, reason) {
    const row = {
        asset_id: assetId,
        status,
        reason: reason || null,
        checked_at: new Date().toISOString(),
    };
    // 恢复正常时顺带清掉提示标记：下次再坏能重新提示
    if (status === 'ok') row.warned_at = null;
    await ctx.supabase.from('asset_health').upsert(row, { onConflict: 'asset_id' });
}

/** 检查一张卡：ok / broken(+reason) / no_thread / no_files / skip（临时错误，下轮再看） */
async function checkAsset(ctx, asset) {
    if (!asset.thread_id) return { status: 'no_thread' };
    try {
        await api.getChannel(ctx.env, asset.thread_id);
    } catch (e) {
        if (e.status === 404 || e.status === 403) return { status: 'broken', reason: 'thread_deleted' };
        return { status: 'skip' };
    }
    let messages;
    try {
        messages = await api.listMessagesAfter(ctx.env, asset.thread_id, '0', 100);
    } catch (e) {
        if (e.status === 404 || e.status === 403) return { status: 'broken', reason: 'thread_deleted' };
        return { status: 'skip' };
    }
    const { data: rows } = await ctx.supabase
        .from('attachments').select('filename').eq('asset_id', asset.id);
    if (!rows || rows.length === 0) return { status: 'no_files' };
    const threadAtts = [];
    for (const m of messages || []) {
        for (const a of m.attachments || []) threadAtts.push(a);
    }
    const byName = new Map(threadAtts.map(a => [a.filename, a]));
    const found = rows.filter(r => byName.has(r.filename));
    if (found.length === 0) return { status: 'broken', reason: 'files_missing' };
    const target = byName.get(found[0].filename);
    try {
        const resp = await fetch(target.url, {
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok && resp.status !== 206) return { status: 'broken', reason: 'cdn_failed' };
    } catch {
        return { status: 'broken', reason: 'cdn_failed' };
    }
    return { status: 'ok' };
}

async function warn(ctx, asset, reason) {
    if (reason === 'thread_deleted') {
        if (ctx.env.LOG_CHANNEL_ID) {
            await api.postMessage(ctx.env, ctx.env.LOG_CHANNEL_ID, {
                content: `⚠️ 巡检：《${asset.name}》的帖子已删除，该卡当前无法下载。`,
            }).catch(() => {});
        }
        return;
    }
    await api.postMessage(ctx.env, asset.thread_id, {
        content: `⚠️ 巡检提示：这张卡的文件当前无法下载（${REASON_TEXT[reason] || reason}）。如有备份，请补充到帖子中。`,
    }).catch(() => {});
}

/** 发积压的待提示（broken 且还没提示过），返回发了几条 */
async function flushWarnings(ctx, cap) {
    const { data: pending } = await ctx.supabase
        .from('asset_health')
        .select('asset_id, reason')
        .eq('status', 'broken')
        .is('warned_at', null)
        .limit(cap);
    let sent = 0;
    for (const row of pending || []) {
        const { data: asset } = await ctx.supabase
            .from('assets').select('id, name, thread_id').eq('id', row.asset_id).maybeSingle();
        if (asset) await warn(ctx, asset, row.reason);
        await ctx.supabase.from('asset_health')
            .update({ warned_at: new Date().toISOString() })
            .eq('asset_id', row.asset_id);
        sent++;
    }
    return sent;
}

export async function healthSweepTick(ctx) {
    let budget = WARN_CAP - await flushWarnings(ctx, WARN_CAP);

    let cursor = await loadCursor(ctx);
    let { data: assets } = await ctx.supabase
        .from('assets')
        .select('id, name, thread_id')
        .not('thread_id', 'is', null)
        .gt('id', cursor)
        .order('id', { ascending: true })
        .limit(BATCH);
    if (!assets || assets.length === 0) {
        cursor = '';
        ({ data: assets } = await ctx.supabase
            .from('assets')
            .select('id, name, thread_id')
            .not('thread_id', 'is', null)
            .order('id', { ascending: true })
            .limit(BATCH));
    }
    for (const asset of assets || []) {
        const result = await checkAsset(ctx, asset);
        if (result.status !== 'skip') {
            await setHealth(ctx, asset.id, result.status, result.reason);
        }
        cursor = asset.id;
        await saveCursor(ctx, cursor);
    }

    if (budget > 0) await flushWarnings(ctx, budget);
}

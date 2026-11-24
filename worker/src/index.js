/**
 * file-share-bot · Cloudflare Workers 入口
 *
 * 两个触发面：
 *   fetch     —— Discord Interactions（斜杠命令 / 按钮 / 选择菜单 / 模态框 / 自动补全）
 *   scheduled —— Cron 定时轮询图床 Discord 频道（见 poller.js）
 *
 * 交互处理约定（各 handler 遵循）：
 *   - 返回普通对象 { type, data }        → 直接作为交互响应
 *   - 返回 { __deferFlags, __run }       → 先回 DEFERRED（可带 flags），__run 里干活并编辑原始回复
 *   - 返回 { __deferUpdate, __run }      → 先回 DEFERRED_UPDATE_MESSAGE，__run 里干活
 */
import { verifyKey } from 'discord-interactions';
import { createSupabase } from './core/supabase.js';
import { createArchiveStore } from './core/archive_store.js';
import { createApiConfigStore } from './core/api_config_store.js';
import { executeImportCommand } from './handlers/import_command.js';
import { executeArchiveUpload } from './handlers/archive_upload.js';
import { executeTagSearch, executeCharSearch, handleSearchPageButton } from './handlers/archive_search.js';
import { executeManual } from './handlers/manual.js';
import { executeApiPanel, handleApiComponent, handleApiModal } from './handlers/api_panel.js';
import { pollImgbedChannel } from './poller.js';
import { linkWatchTick, executeWatchLinkCommand } from './link_watch.js';
import { healthSweepTick } from './health_check.js';
import { COMMANDS } from './commands.js';

function makeCtx(env) {
    const supabase = createSupabase(env);
    return {
        env,
        supabase,
        archive: createArchiveStore(supabase),
        apiConfig: createApiConfigStore(supabase),
    };
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** 把 handler 的返回值翻译成真正的 HTTP 响应 + 后台任务 */
function settle(result, execCtx) {
    if (result && typeof result.__run === 'function') {
        execCtx.waitUntil(
            Promise.resolve()
                .then(() => result.__run())
                .catch(e => console.error('[worker] 后台任务出错:', e))
        );
        if (result.__deferUpdate) {
            return jsonResponse({ type: 6 });
        }
        return jsonResponse({ type: 5, data: { flags: result.__deferFlags || 0 } });
    }
    return jsonResponse(result || { type: 5, data: { flags: 64 } });
}

async function routeCommand(ctx, interaction) {
    const name = interaction.data.name;
    switch (name) {
        case '导入': return executeImportCommand(ctx, interaction);
        case '文件上传': return executeArchiveUpload(ctx, interaction);
        case '标签搜索': return executeTagSearch(ctx, interaction);
        case '角色搜索': return executeCharSearch(ctx, interaction);
        case '使用手册': return executeManual(ctx, interaction);
        case '关注链接': return executeWatchLinkCommand(ctx, interaction);
        case '更换api': return executeApiPanel(ctx, interaction);
        default:
            return { type: 4, data: { content: '未知命令', flags: 64 } };
    }
}

async function routeComponent(ctx, interaction) {
    const customId = interaction.data.custom_id || '';
    if (customId.startsWith('archive_search_page:') || customId.startsWith('archive_char_page:')) {
        return handleSearchPageButton(ctx, interaction);
    }
    if (customId.startsWith('api_')) {
        return handleApiComponent(ctx, interaction);
    }
    return { type: 6 };
}

async function routeModal(ctx, interaction) {
    const customId = interaction.data.custom_id || '';
    if (customId.startsWith('api_modal_')) {
        return handleApiModal(ctx, interaction);
    }
    return { type: 6 };
}

function routeAutocomplete(interaction) {
    // 素材标签已改为自由填写，不再提供词表补全
    return { type: 8, data: { choices: [] } };
}

export default {
    async fetch(request, env, execCtx) {
        const url = new URL(request.url);
        // 一次性管理路由：用 Worker 自身的 DISCORD_TOKEN 注册斜杠命令（部署后由管理员触发）
        if (url.pathname === '/admin/register') {
            if (!env.ADMIN_TOKEN || url.searchParams.get('token') !== env.ADMIN_TOKEN) {
                return new Response('Forbidden', { status: 403 });
            }
            if (!env.DISCORD_TOKEN || !env.DISCORD_APPLICATION_ID || !env.GUILD_ID) {
                return new Response('DISCORD_TOKEN 尚未配置', { status: 500 });
            }
            const res = await fetch(
                `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + env.DISCORD_TOKEN },
                    body: JSON.stringify(COMMANDS),
                }
            );
            const text = await res.text();
            return new Response(`register → HTTP ${res.status}: ${text.slice(0, 500)}`, {
                status: res.ok ? 200 : 502,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }

        if (request.method !== 'POST') {
            return new Response('file-share-bot (workers) is running.');
        }

        const signature = request.headers.get('x-signature-ed25519');
        const timestamp = request.headers.get('x-signature-timestamp');
        if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
            return new Response('Missing signature headers', { status: 401 });
        }

        const body = await request.text();
        const isValid = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
        if (!isValid) {
            return new Response('Bad request signature', { status: 401 });
        }

        let interaction;
        try {
            interaction = JSON.parse(body);
        } catch {
            return new Response('Bad JSON', { status: 400 });
        }

        // PING → PONG（Discord 保存 Interactions Endpoint 时的验活）
        if (interaction.type === 1) {
            return jsonResponse({ type: 1 });
        }

        let ctx;
        try {
            ctx = makeCtx(env);
        } catch (e) {
            console.error('[worker] 初始化失败:', e.message);
            if (interaction.type === 2) {
                return jsonResponse({ type: 4, data: { content: '❌ Bot 后端未配置完成（Supabase），请联系管理员。', flags: 64 } });
            }
            return jsonResponse({ type: 6 });
        }

        try {
            switch (interaction.type) {
                case 2: return settle(await routeCommand(ctx, interaction), execCtx);
                case 3: return settle(await routeComponent(ctx, interaction), execCtx);
                case 4: return jsonResponse(routeAutocomplete(interaction));
                case 5: return settle(await routeModal(ctx, interaction), execCtx);
                default: return jsonResponse({ type: 6 });
            }
        } catch (e) {
            console.error('[worker] 处理交互出错:', e);
            if (interaction.type === 2) {
                return jsonResponse({ type: 4, data: { content: '❌ 处理时发生错误: ' + e.message, flags: 64 } });
            }
            return jsonResponse({ type: 6 });
        }
    },

    async scheduled(event, env, execCtx) {
        try {
            const ctx = makeCtx(env);
            execCtx.waitUntil(
                pollImgbedChannel(ctx).catch(e => console.error('[Poller] 轮询出错:', e))
            );
            execCtx.waitUntil(
                linkWatchTick(ctx).catch(e => console.error('[LinkWatch] 盯梢出错:', e))
            );
            execCtx.waitUntil(
                healthSweepTick(ctx).catch(e => console.error('[Health] 巡检出错:', e))
            );
        } catch (e) {
            console.error('[Poller] 初始化失败:', e.message);
        }
    },
};

/**
 * /使用手册：把 bot 的用法一次性讲清（仅自己可见，不刷屏）。
 */

export function executeManual(ctx, interaction) {
    const embed = {
        color: 0x5865f2,
        title: '📖 使用手册',
        description: '本 bot 的全部功能与用法如下。',
        fields: [
            {
                name: '🎭 存卡',
                value: [
                    '`/导入` 上传卡文件——bot 发到论坛里，大家能搜、能下；同名的卡续进原帖，不开新帖。',
                    '也可以把文件直接发到文件上传频道，它每 5 分钟自己来收。',
                ].join('\n'),
                inline: false,
            },
            {
                name: '📁 存素材',
                value: '`/文件上传`（暂时用不了）：本来是只存档、不发帖的存法，但存进去的素材目前没有取出来的入口、搜索也搜不到，存了也用不上。先别用它，存东西用 `/导入`。',
                inline: false,
            },
            {
                name: '🔍 找东西',
                value: [
                    '`/角色搜索` 按角色名或作者找卡，结果带帖子链接。',
                    '`/标签搜索` 按关键词找（名字、作者、简介里搜），多个词用空格分隔，需全部命中。',
                ].join('\n'),
                inline: false,
            },
            {
                name: '🔗 链接盯梢',
                value: '`/关注链接` 登记作者链接——文件更新后，bot 自动把新版续进原帖。其他服务器的帖子链接 bot 无权限读取，只能登记作索引。',
                inline: false,
            },
            {
                name: '🩺 巡检',
                value: 'bot 会定期抽查卡的文件是否还能下载；下不了的会在对应帖子里发提示，帖子已删除的报到日志频道。',
                inline: false,
            },
            {
                name: '⚙️ 管理',
                value: '`/更换api` 更换解析用的 API（管理员）。',
                inline: false,
            },
        ],
        footer: { text: '文件分享 bot · 使用手册' },
    };
    return { type: 4, data: { embeds: [embed], flags: 64 } };
}

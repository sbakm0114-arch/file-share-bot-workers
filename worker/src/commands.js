/**
 * 斜杠命令定义（注册用，见 scripts/register_commands.mjs）
 *
 * 与网关版 command/ 目录一一对应，另加 Workers 版新增的 /导入。
 * 选项类型：3=STRING 4=INTEGER 11=ATTACHMENT
 */
export const COMMANDS = [
    {
        name: '导入',
        description: '把文件导入归档系统（自动识别角色卡/世界书/预设/文本并发到对应论坛）',
        options: [
            { type: 11, name: 'file', description: '要导入的文件', required: true },
            { type: 11, name: 'file2', description: '追加文件 2（可选）', required: false },
            { type: 11, name: 'file3', description: '追加文件 3（可选）', required: false },
            { type: 11, name: 'file4', description: '追加文件 4（可选）', required: false },
            { type: 11, name: 'file5', description: '追加文件 5（可选）', required: false },
        ],
    },
    {
        name: '文件上传',
        description: '上传素材文件到归档系统，支持自动识别 SillyTavern 角色卡',
        options: [
            { type: 11, name: 'file', description: '要上传的素材文件', required: true },
            { type: 3, name: 'tags', description: '标签（用空格分隔，例如: BL Completed）', required: true },
        ],
    },
    {
        name: '标签搜索',
        description: '按标签组合搜索已归档的素材',
        options: [
            { type: 3, name: 'tags', description: '关键词（用空格分隔，在名字/作者/简介里找，例如: BL 校园）', required: true },
            { type: 4, name: 'page', description: '页码', required: false, min_value: 1 },
        ],
    },
    {
        name: '角色搜索',
        description: '按角色名搜索 SillyTavern 角色卡',
        options: [
            { type: 3, name: 'name', description: '角色名（支持模糊搜索）', required: true },
            { type: 4, name: 'page', description: '页码', required: false, min_value: 1 },
        ],
    },
    {
        name: '更换api',
        description: '打开 LLM API 设置面板，配置或更换 AI 提供商',
        options: [],
    },
    {
        name: '使用手册',
        description: '查看 bot 的使用手册',
        type: 1,
        options: [],
    },
];

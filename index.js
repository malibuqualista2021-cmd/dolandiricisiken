const { Telegraf } = require('telegraf');
require('dotenv').config();

if (!process.env.BOT_TOKEN) {
    console.error('HATA: BOT_TOKEN tanımlanmamis!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = (process.env.ADMIN_ID || '1567981486').toString();
const TARGET_CHAT_ID = process.env.CHAT_ID || process.env.TARGET_CHAT_ID || null;
const MEMBER_SCAN_INTERVAL_MS = Number(process.env.MEMBER_SCAN_INTERVAL_MS || 30000);

const ALLOWED_USER_IDS = new Set([ADMIN_ID]);
if (process.env.ALLOWED_USER_IDS) {
    process.env.ALLOWED_USER_IDS.split(',').forEach((id) => {
        const trimmed = id.trim();
        if (trimmed) ALLOWED_USER_IDS.add(trimmed);
    });
}

const ALLOWED_UPDATES = ['message', 'edited_message', 'chat_member', 'my_chat_member'];
const trackedMembers = new Map();

const IMPERSONATION_MARKERS = [
    'malibu',
    'malibuanaliz',
    'fatmainal',
    'fatmainal162',
];

const CYRILLIC_LOOKALIKES = {
    а: 'a', е: 'e', о: 'o', р: 'r', с: 'c', у: 'y', х: 'x', і: 'i',
    м: 'm', л: 'l', и: 'i', б: 'b', в: 'v', н: 'n', к: 'k', т: 't',
    ԍ: 'g', ɑ: 'a', ℓ: 'l', ı: 'i',
};

function normalizeForCheck(text) {
    if (!text) return '';
    let s = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    s = s.replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
        .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
    s = [...s].map((ch) => CYRILLIC_LOOKALIKES[ch] || ch).join('');
    s = s.replace(/\s+/g, '');
    s = s.replace(/[^a-z0-9]/g, '');
    return s;
}

function getMatchedMarker(user) {
    if (!user) return null;
    const checks = [
        ['first_name', user.first_name],
        ['last_name', user.last_name],
        ['username', user.username],
        ['full_name', `${user.first_name || ''}${user.last_name || ''}`],
    ];
    for (const [field, value] of checks) {
        const normalized = normalizeForCheck(value);
        const marker = IMPERSONATION_MARKERS.find((m) => normalized.includes(m));
        if (marker) return { field, marker, normalized };
    }
    return null;
}

function isAllowedUser(user) {
    return user && ALLOWED_USER_IDS.has(user.id.toString());
}

function isImpersonator(user) {
    if (!user || isAllowedUser(user)) return false;
    return getMatchedMarker(user) !== null;
}

function matchesTargetChat(chatId) {
    if (!TARGET_CHAT_ID) return true;
    return chatId.toString() === TARGET_CHAT_ID.toString();
}

function trackMember(chatId, user) {
    if (!user || user.is_bot) return;
    const key = `${chatId}:${user.id}`;
    trackedMembers.set(key, {
        chatId,
        userId: user.id,
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        username: user.username || '',
    });
}

function untrackMember(chatId, userId) {
    trackedMembers.delete(`${chatId}:${userId}`);
}

function getMessageType(message) {
    if (!message) return 'none';
    if (message.text) return 'text';
    if (message.photo) return 'photo';
    if (message.video) return 'video';
    if (message.document) return 'document';
    if (message.sticker) return 'sticker';
    if (message.voice) return 'voice';
    if (message.audio) return 'audio';
    if (message.animation) return 'animation';
    if (message.poll) return 'poll';
    if (message.contact) return 'contact';
    if (message.location) return 'location';
    return 'other';
}

function logEvent(fields) {
    const safe = {
        chat_id: fields.chat_id ?? null,
        chat_title: fields.chat_title ?? null,
        is_forum: fields.is_forum ?? null,
        is_supergroup: fields.is_supergroup ?? null,
        message_thread_id: fields.message_thread_id ?? null,
        topic_name: fields.topic_name ?? null,
        user_id: fields.user_id ?? null,
        username: fields.username ?? null,
        first_name: fields.first_name ?? null,
        last_name: fields.last_name ?? null,
        message_type: fields.message_type ?? null,
        source: fields.source ?? null,
        detection: fields.detection ?? null,
        matched_marker: fields.matched_marker ?? null,
        matched_field: fields.matched_field ?? null,
        decision: fields.decision ?? null,
        message_deleted: fields.message_deleted ?? false,
        user_banned: fields.user_banned ?? false,
        admin_notified: fields.admin_notified ?? false,
        group_reply_sent: fields.group_reply_sent ?? false,
        permission_error: fields.permission_error ?? null,
    };
    console.log('[EVENT]', JSON.stringify(safe));
}

async function resolveTopicName(ctx, chatId, threadId) {
    if (!threadId) return 'General';
    try {
        const topic = await ctx.telegram.getForumTopic(chatId, threadId);
        return topic.name || `thread_${threadId}`;
    } catch {
        return threadId === 1 ? 'General' : `thread_${threadId}`;
    }
}

async function getFreshUser(ctx, chatId, user) {
    if (!user) return null;
    try {
        const member = await ctx.telegram.getChatMember(chatId, user.id);
        return member.user || user;
    } catch {
        return user;
    }
}

async function processImpersonator(ctx, user, options) {
    const { source, message, threadId, topicName, chat, matchInfo } = options;
    const chatId = chat.id;

    const baseLog = {
        chat_id: chatId,
        chat_title: chat.title,
        is_forum: chat.is_forum ?? false,
        is_supergroup: chat.type === 'supergroup',
        message_thread_id: threadId ?? null,
        topic_name: topicName,
        user_id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        message_type: message ? getMessageType(message) : 'join_event',
        source,
        detection: 'impersonator',
        matched_marker: matchInfo?.marker ?? null,
        matched_field: matchInfo?.field ?? null,
    };

    let messageDeleted = false;
    let userBanned = false;
    let adminNotified = false;
    let groupReplySent = false;
    const permissionErrors = [];

    if (message && message.message_id) {
        try {
            await ctx.telegram.deleteMessage(chatId, message.message_id);
            messageDeleted = true;
        } catch (err) {
            permissionErrors.push(`delete: ${err.message}`);
        }
    }

    try {
        await ctx.telegram.banChatMember(chatId, user.id);
        userBanned = true;
        untrackMember(chatId, user.id);
    } catch (err) {
        permissionErrors.push(`ban: ${err.message}`);
    }

    const displayName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Bilinmeyen';
    const usernameLabel = user.username ? `@${user.username}` : 'username yok';
    const groupNotice = `İşte bir dolandırıcıyı daha siktik: ${displayName} (${usernameLabel}) 🚫`;

    const replyExtra = threadId ? { message_thread_id: threadId } : {};
    try {
        await ctx.telegram.sendMessage(chatId, groupNotice, replyExtra);
        groupReplySent = true;
    } catch (err) {
        permissionErrors.push(`group_reply: ${err.message}`);
    }

    try {
        const topicLine = topicName
            ? `📂 <b>Baslik:</b> ${topicName}`
            : (threadId ? `📂 <b>Topic ID:</b> ${threadId}` : '📂 <b>Baslik:</b> General');
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🚨 <b>Taklitçi Tespiti!</b>\n\n` +
            `Kaynak: ${source}\n` +
            `${topicLine}\n\n` +
            `👤 <b>Ad:</b> ${user.first_name || ''} ${user.last_name || ''}\n` +
            `🆔 <b>ID:</b> <code>${user.id}</code>\n` +
            `🔗 <b>Username:</b> @${user.username || 'yok'}\n` +
            `🗑 Silindi: ${messageDeleted ? 'evet' : 'hayir'}\n` +
            `🚫 Ban: ${userBanned ? 'evet' : 'hayir'}`,
            { parse_mode: 'HTML' }
        );
        adminNotified = true;
    } catch (err) {
        permissionErrors.push(`admin_notify: ${err.message}`);
    }

    const permissionError = permissionErrors.length ? permissionErrors.join(' | ') : null;
    let decision = 'action_completed';
    if (!userBanned && !messageDeleted) decision = 'action_failed';
    else if (permissionError) decision = 'action_partial';

    logEvent({
        ...baseLog,
        decision,
        message_deleted: messageDeleted,
        user_banned: userBanned,
        admin_notified: adminNotified,
        group_reply_sent: groupReplySent,
        permission_error: permissionError,
    });
}

async function evaluateUser(ctx, chat, user, options) {
    const { source, message, threadId, topicName } = options;
    const freshUser = await getFreshUser(ctx, chat.id, user);
    trackMember(chat.id, freshUser);

    const matchInfo = getMatchedMarker(freshUser);
    const detection = isAllowedUser(freshUser)
        ? 'allowed_user'
        : (matchInfo ? 'impersonator' : 'clean');

    logEvent({
        chat_id: chat.id,
        chat_title: chat.title,
        is_forum: chat.is_forum ?? false,
        is_supergroup: chat.type === 'supergroup',
        message_thread_id: threadId ?? null,
        topic_name: topicName,
        user_id: freshUser.id,
        username: freshUser.username,
        first_name: freshUser.first_name,
        last_name: freshUser.last_name,
        message_type: message ? getMessageType(message) : 'join_event',
        source,
        detection,
        matched_marker: matchInfo?.marker ?? null,
        matched_field: matchInfo?.field ?? null,
        decision: detection === 'clean'
            ? 'no_action'
            : (detection === 'allowed_user' ? 'allowlisted' : 'impersonator_pending'),
    });

    if (detection === 'impersonator') {
        await processImpersonator(ctx, freshUser, {
            source,
            message,
            threadId,
            topicName,
            chat,
            matchInfo,
        });
        return true;
    }
    return false;
}

async function handleUserActivity(ctx, message, source) {
    const chat = ctx.chat;
    if (!chat) return;

    if (!matchesTargetChat(chat.id)) {
        logEvent({
            chat_id: chat.id,
            chat_title: chat.title,
            source,
            detection: 'chat_skipped',
            decision: 'target_chat_mismatch',
            permission_error: `expected=${TARGET_CHAT_ID}, got=${chat.id}`,
        });
        return;
    }

    const user = message?.from || ctx.from;
    if (!user || user.is_bot) return;

    if (message?.new_chat_members?.length) {
        for (const joinedUser of message.new_chat_members) {
            await evaluateUser(ctx, chat, joinedUser, {
                source: 'new_chat_members',
                message: null,
                threadId: message.message_thread_id ?? null,
                topicName: chat.is_forum ? await resolveTopicName(ctx, chat.id, message.message_thread_id ?? null) : null,
            });
        }
    }

    const threadId = message?.message_thread_id ?? null;
    const topicName = chat.is_forum
        ? await resolveTopicName(ctx, chat.id, threadId)
        : null;

    await evaluateUser(ctx, chat, user, { source, message, threadId, topicName });
}

bot.use(async (ctx, next) => {
    const updateType = ctx.updateType || 'unknown';
    const chatId = ctx.chat?.id ?? ctx.update?.chat_member?.chat?.id ?? null;
    console.log('[UPDATE]', JSON.stringify({ updateType, chat_id: chatId }));
    return next();
});

bot.on('message', async (ctx) => {
    try {
        await handleUserActivity(ctx, ctx.message, 'message');
    } catch (err) {
        console.error('message handler hatasi:', err.message);
    }
});

bot.on('edited_message', async (ctx) => {
    try {
        await handleUserActivity(ctx, ctx.editedMessage, 'edited_message');
    } catch (err) {
        console.error('edited_message handler hatasi:', err.message);
    }
});

bot.on('chat_member', async (ctx) => {
    try {
        const update = ctx.update.chat_member;
        const chat = update.chat;
        if (!matchesTargetChat(chat.id)) {
            logEvent({
                chat_id: chat.id,
                source: 'chat_member',
                detection: 'chat_skipped',
                decision: 'target_chat_mismatch',
                permission_error: `expected=${TARGET_CHAT_ID}, got=${chat.id}`,
            });
            return;
        }

        const { old_chat_member, new_chat_member } = update;
        const user = new_chat_member.user;
        const status = new_chat_member.status;

        if (status === 'left' || status === 'kicked' || status === 'banned') {
            untrackMember(chat.id, user.id);
            return;
        }

        if (['member', 'restricted', 'administrator'].includes(status)) {
            const topicName = chat.is_forum ? 'General' : null;
            const fakeCtx = { ...ctx, chat };
            const nameChanged = (
                (old_chat_member.user?.first_name || '') !== (user.first_name || '') ||
                (old_chat_member.user?.last_name || '') !== (user.last_name || '') ||
                (old_chat_member.user?.username || '') !== (user.username || '')
            );
            const wasOutside = ['left', 'kicked', 'banned'].includes(old_chat_member.status);

            if (wasOutside || nameChanged) {
                await evaluateUser(fakeCtx, chat, user, {
                    source: nameChanged && !wasOutside ? 'chat_member_name_change' : 'chat_member_join',
                    message: null,
                    threadId: null,
                    topicName,
                });
            } else {
                trackMember(chat.id, user);
            }
        }
    } catch (err) {
        console.error('chat_member handler hatasi:', err.message);
    }
});

bot.on('my_chat_member', async (ctx) => {
    const update = ctx.update.my_chat_member;
    const chat = update.chat;
    const newStatus = update.new_chat_member.status;
    const me = update.new_chat_member.user;

    logEvent({
        chat_id: chat.id,
        chat_title: chat.title,
        is_forum: chat.is_forum ?? false,
        is_supergroup: chat.type === 'supergroup',
        user_id: me.id,
        username: me.username,
        source: 'my_chat_member',
        detection: 'bot_status_change',
        decision: `status_${newStatus}`,
    });

    if (newStatus === 'administrator' && matchesTargetChat(chat.id)) {
        await logBotPermissions(chat.id, me.id);
    }
});

async function logBotPermissions(chatId, botId) {
    try {
        const member = await bot.telegram.getChatMember(chatId, botId);
        const canDelete = member.can_delete_messages ?? false;
        const canBan = member.can_restrict_members ?? false;
        const errors = [];
        if (member.status !== 'administrator') errors.push(`bot_not_admin: status=${member.status}`);
        if (!canBan) errors.push('missing_can_restrict_members');
        if (!canDelete) errors.push('missing_can_delete_messages');

        logEvent({
            chat_id: chatId,
            source: 'startup_permission_check',
            detection: 'bot_permissions',
            decision: `delete=${canDelete},ban=${canBan},status=${member.status}`,
            permission_error: errors.length ? errors.join(' | ') : null,
        });
    } catch (err) {
        logEvent({
            chat_id: chatId,
            source: 'startup_permission_check',
            detection: 'bot_permissions',
            decision: 'check_failed',
            permission_error: err.message,
        });
    }
}

async function scanTrackedMembers() {
    if (trackedMembers.size === 0) return;

    for (const [key, tracked] of [...trackedMembers.entries()]) {
        if (!matchesTargetChat(tracked.chatId)) continue;
        try {
            const member = await bot.telegram.getChatMember(tracked.chatId, tracked.userId);
            const user = member.user;
            if (!user || user.is_bot) continue;

            const status = member.status;
            if (status === 'left' || status === 'kicked' || status === 'banned') {
                untrackMember(tracked.chatId, tracked.userId);
                continue;
            }

            const nameChanged = (
                tracked.first_name !== (user.first_name || '') ||
                tracked.last_name !== (user.last_name || '') ||
                tracked.username !== (user.username || '')
            );

            trackMember(tracked.chatId, user);

            if (!nameChanged) continue;

            const fakeCtx = { telegram: bot.telegram };
            let chat;
            try {
                chat = await bot.telegram.getChat(tracked.chatId);
            } catch {
                continue;
            }

            logEvent({
                chat_id: chat.id,
                chat_title: chat.title,
                user_id: user.id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                source: 'member_scan_name_change',
                detection: 'profile_changed',
                decision: 'recheck',
            });

            await evaluateUser(fakeCtx, chat, user, {
                source: 'member_scan',
                message: null,
                threadId: null,
                topicName: chat.is_forum ? 'General' : null,
            });
        } catch (err) {
            logEvent({
                chat_id: tracked.chatId,
                user_id: tracked.userId,
                source: 'member_scan',
                detection: 'scan_error',
                decision: 'failed',
                permission_error: err.message,
            });
        }
    }
}

async function runStartupChecks() {
    console.log('--- SISTEM BASLATILIYOR ---');
    console.log('ADMIN_ID:', ADMIN_ID);
    console.log('ALLOWED_USER_IDS:', [...ALLOWED_USER_IDS].join(', '));
    console.log('TARGET_CHAT_ID:', TARGET_CHAT_ID || '(tum gruplar)');
    console.log('MEMBER_SCAN_INTERVAL_MS:', MEMBER_SCAN_INTERVAL_MS);
    console.log('UYARI: Privacy Mode KAPALI olmali (@BotFather -> /setprivacy -> Disable)');

    const webhook = await bot.telegram.getWebhookInfo();
    if (webhook.url) {
        console.log('Webhook aktif bulundu, polling icin kaldiriliyor...');
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    }

    const me = await bot.telegram.getMe();
    console.log(`Bot hazir: @${me.username} (id=${me.id})`);

    if (TARGET_CHAT_ID) {
        try {
            const chat = await bot.telegram.getChat(TARGET_CHAT_ID);
            console.log(`Hedef grup: ${chat.title} | forum=${chat.is_forum} | type=${chat.type}`);
            await logBotPermissions(TARGET_CHAT_ID, me.id);
        } catch (err) {
            console.error('Hedef grup kontrolu basarisiz:', err.message);
        }
    } else {
        console.log('UYARI: CHAT_ID tanimli degil. Uye taramasi sadece mesaj atan kullanicilar icin calisir.');
    }

    console.log('allowedUpdates:', ALLOWED_UPDATES.join(', '));
    console.log('------------------------------------------');
}

bot.catch((err) => {
    console.error('Bot handler hatasi:', err.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

runStartupChecks()
    .then(() => bot.launch({ allowedUpdates: ALLOWED_UPDATES }))
    .then(() => {
        console.log('Grup Koruma Botu aktif. Forum topic mesajlari dinleniyor.');
        setInterval(scanTrackedMembers, MEMBER_SCAN_INTERVAL_MS);
        console.log(`Uye profil taramasi aktif (${MEMBER_SCAN_INTERVAL_MS}ms).`);
    })
    .catch((err) => {
        console.error('Bot baslatma hatasi:', err.message);
        if (err.message && err.message.includes('Conflict')) {
            console.error('COKLU INSTANCE: Ayni token ile baska bir bot calisiyor olabilir.');
        }
        process.exit(1);
    });

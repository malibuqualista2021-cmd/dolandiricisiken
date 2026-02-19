const { Telegraf } = require('telegraf');
require('dotenv').config();

if (!process.env.BOT_TOKEN) {
    console.error('HATA: BOT_TOKEN tanımlanmamış!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID || '1567981486';

console.log('--- SISTEM BASLATILIYOR ---');
console.log('ADMIN_ID:', ADMIN_ID);
if (process.env.BOT_TOKEN) {
    console.log('BOT_TOKEN bulundu (ilk 5 karakter):', process.env.BOT_TOKEN.substring(0, 5) + '...');
} else {
    console.log('HATA: BOT_TOKEN Bulunamadı! Lütfen Railway Variables kısmını kontrol edin.');
}

console.log('Sistem başlatılıyor...');
console.log('ADMIN_ID:', ADMIN_ID);
if (process.env.BOT_TOKEN) {
    console.log('BOT_TOKEN bulundu (ilk 5 karakter):', process.env.BOT_TOKEN.substring(0, 5) + '...');
} else {
    console.log('HATA: BOT_TOKEN Bulunamadı!');
}

// İsim kontrol fonksiyonu
const isImpersonator = (user) => {
    if (user.id.toString() === ADMIN_ID) return false;

    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.toLowerCase();
    // "malibu" kelimesini ve harf arası boşluklu hallerini yakalar
    return fullName.includes('malibu') || fullName.replace(/\s/g, '').includes('malibu');
};

// 1. Yeni mesaj atıldığında isim kontrolü (İsim değiştirenleri yakalar)
bot.on('message', async (ctx) => {
    const user = ctx.from;

    if (isImpersonator(user)) {
        try {
            console.log(`[TAKLİT TESPİTİ] ${user.first_name} (@${user.username || 'yok'}) banlanıyor.`);
            await ctx.banChatMember(user.id);

            // Gruba gönderilecek mesaj
            await ctx.reply('İşte bir dolandırıcıyı daha siktik. 🚫');

            // Admin'e detaylı bildirim
            await ctx.telegram.sendMessage(ADMIN_ID, `🚨 <b>Grupta Taklitçi Tespiti!</b>\n\n` +
                `Bir kullanıcı ismini <b>Malibu</b> yaparak mesaj attı ve anında banlandı.\n\n` +
                `👤 <b>Ad:</b> ${user.first_name} ${user.last_name || ''}\n` +
                `🆔 <b>ID:</b> <code>${user.id}</code>\n` +
                `🔗 <b>Username:</b> @${user.username || 'yok'}`, { parse_mode: 'HTML' });
        } catch (err) {
            console.error('Ban hatası:', err.message);
        }
    }
});

// 2. Yeni birisi katıldığında isim kontrolü
bot.on('chat_member', async (ctx) => {
    const { new_chat_member } = ctx.update.chat_member;
    const user = new_chat_member.user;

    if ((new_chat_member.status === 'member' || new_chat_member.status === 'restricted') && isImpersonator(user)) {
        try {
            console.log(`[TAKLİT GİRİŞİ] ${user.first_name} taklitçi ismiyle girmeye çalıştı. Yasaklanıyor.`);
            await ctx.banChatMember(user.id);

            // Gruba gönderilecek mesaj
            await ctx.reply('İşte bir dolandırıcıyı daha siktik. 🚫');

            // Admin'e detaylı bildirim
            await ctx.telegram.sendMessage(ADMIN_ID, `🚨 <b>Taklitçi Kapıda Yakalandı!</b>\n\n` +
                `Bir kullanıcı isminde <b>Malibu</b> geçerek gruba katılmaya çalıştı ve anında banlandı.\n\n` +
                `👤 <b>Ad:</b> ${user.first_name} ${user.last_name || ''}\n` +
                `🆔 <b>ID:</b> <code>${user.id}</code>`, { parse_mode: 'HTML' });
        } catch (err) {
            console.error('Giriş ban hatası:', err.message);
        }
    }
});

bot.launch({
    allowedUpdates: ['chat_member', 'message']
}).then(() => {
    console.log('------------------------------------------');
    console.log('Grup Koruma Botu Aktif. Malibu taklitçileri yasaklanacak.');
    return bot.telegram.getMe();
}).then((me) => {
    console.log(`Bot başarılı bir şekilde @${me.username} olarak başlatıldı.`);
    console.log('------------------------------------------');
}).catch((err) => {
    console.error('Bot başlatılırken KRİTİK HATA oluştu:');
    console.error(err);
});

// Hataları yakala
bot.catch((err) => {
    console.error('Bot hatası:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

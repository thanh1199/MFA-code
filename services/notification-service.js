// ============================================================
// notification-service.js
// Teams Webhook / Chatwork への通知を一元管理
// NOTIFICATION_INCLUDE_CODES=false の場合、コードをマスク
// ============================================================
const axios = require('axios');

function maskCode(code) {
    if (!code) return '(なし)';
    if (code.length <= 4) return '****';
    return '*'.repeat(code.length - 4) + code.slice(-4);
}

function formatCode(code) {
    const includeCodes = String(process.env.NOTIFICATION_INCLUDE_CODES || 'true').toLowerCase() === 'true';
    return includeCodes ? code : maskCode(code);
}

function buildSummaryText(summary) {
    const dateStr = new Date(summary.runAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const lines = [];
    lines.push(`📢 MFAコード発番結果`);
    lines.push(`実行日時: ${dateStr}`);
    lines.push(`対象件数: ${summary.total}名 | 成功: ${summary.success}名 | 失敗: ${summary.error}名`);
    lines.push(`SELF_USER更新: ${summary.selfUpdated ? '✅ 成功' : '⚠️ 失敗/未実行'}`);
    if (summary.results && summary.results.length > 0) {
        lines.push('────────────────');
        for (const r of summary.results) {
            const emoji = r.status === 'Success' ? '✅' : '⚠️';
            const codePart = r.status === 'Success' ? ` → ${formatCode(r.code)}` : ` → ${r.status}`;
            lines.push(`${emoji} ${r.name || r.username}${codePart}`);
        }
    }
    if (summary.failedUsernames && summary.failedUsernames.length > 0) {
        lines.push('────────────────');
        lines.push(`失敗ユーザ: ${summary.failedUsernames.join(', ')}`);
    }
    lines.push('');
    lines.push('_MFAコード発番くん (Auto Mode) より自動通知_');
    return lines.join('\n');
}

async function sendTeams(summary) {
    const url = (process.env.TEAMS_WEBHOOK_URL || '').trim();
    if (!url) return { skipped: true, reason: 'TEAMS_WEBHOOK_URL not set' };
    const text = buildSummaryText(summary);
    const isWorkflowWebhook = url.includes('logic.azure.com') || url.includes('powerplatform.com') || url.includes('powerautomate');
    let payload;
    if (isWorkflowWebhook) {
        payload = {
            type: 'message',
            attachments: [{
                contentType: 'application/vnd.microsoft.card.adaptive',
                contentUrl: null,
                content: {
                    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [{ type: 'TextBlock', text, wrap: true }]
                }
            }]
        };
    } else {
        payload = { text };
    }
    try {
        await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        return { success: true };
    } catch (e) {
        const detail = e.response ? `${e.response.status}` : e.message;
        return { success: false, error: detail };
    }
}

async function sendChatwork(summary) {
    const token = (process.env.CHATWORK_API_TOKEN || '').trim();
    const roomId = (process.env.CHATWORK_ROOM_ID || '').trim();
    if (!token || !roomId) return { skipped: true, reason: 'Chatwork not configured' };
    const body = buildSummaryText(summary);
    try {
        await axios.post(
            `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
            new URLSearchParams({ body }).toString(),
            {
                headers: {
                    'X-ChatWorkToken': token,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000
            }
        );
        return { success: true };
    } catch (e) {
        const detail = e.response ? `${e.response.status}` : e.message;
        return { success: false, error: detail };
    }
}

async function notify(summary) {
    const results = {
        teams: await sendTeams(summary),
        chatwork: await sendChatwork(summary)
    };
    return results;
}

module.exports = { notify, buildSummaryText, formatCode, maskCode };

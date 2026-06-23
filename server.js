// ================================================================
// MFAコード発番くん v3.0
// OAuth 2.0 + PKCE + Playwright UI自動化 + マルチ組織対応版
// ================================================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const jsforce = require('jsforce');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { generateMfaCodeViaUI, shutdownBrowser } = require('./playwright-service');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mfa-code-generator-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// ユーティリティ
// ================================================================
function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`[${ts}] ${msg}`);
}

// ================================================================
// OAuth 2.0 マルチ組織設定
// ================================================================
function getOAuthConfig(loginUrl) {
    const isSandbox = loginUrl && loginUrl.includes('test.salesforce.com');
    let clientId, clientSecret;

    if (isSandbox) {
        clientId = process.env.SF_SANDBOX_CLIENT_ID || process.env.SF_PROD_CLIENT_ID;
        clientSecret = process.env.SF_SANDBOX_CLIENT_SECRET || process.env.SF_PROD_CLIENT_SECRET;
    } else {
        clientId = process.env.SF_PROD_CLIENT_ID;
        clientSecret = process.env.SF_PROD_CLIENT_SECRET;
    }

    return {
        clientId: clientId ? clientId.trim() : clientId,
        clientSecret: clientSecret ? clientSecret.trim() : clientSecret,
        loginUrl: (loginUrl || 'https://login.salesforce.com').trim(),
        redirectUri: (process.env.SF_CALLBACK_URL || 'http://localhost:3000/oauth/callback').trim(),
        isSandbox: isSandbox
    };
}

// ================================================================
// PKCE ユーティリティ
// ================================================================
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(codeVerifier) {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

// ================================================================
// jsforce Connection 取得
// ================================================================
function getConnection(req) {
    if (req.session && req.session.sfAccessToken && req.session.sfInstanceUrl) {
        const loginUrl = req.session.oauthLoginUrl || 'https://login.salesforce.com';
        const config = getOAuthConfig(loginUrl);
        return new jsforce.Connection({
            instanceUrl: req.session.sfInstanceUrl,
            accessToken: req.session.sfAccessToken,
            refreshToken: req.session.sfRefreshToken,
            oauth2: new jsforce.OAuth2({
                loginUrl: config.loginUrl,
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                redirectUri: config.redirectUri
            })
        });
    }
    return null;
}

// ================================================================
// GET /oauth/login - OAuth認可画面へリダイレクト（PKCE対応）
// ================================================================
app.get('/oauth/login', (req, res) => {
    const loginUrl = req.query.loginUrl || 'https://login.salesforce.com';
    const config = getOAuthConfig(loginUrl);

    if (!config.clientId) {
        const envType = config.isSandbox ? 'SF_SANDBOX_CLIENT_ID' : 'SF_PROD_CLIENT_ID';
        log(`OAuth エラー: ${envType} が .env に設定されていません`);
        return res.redirect(`/#error=${encodeURIComponent(config.isSandbox ? 'Sandbox用の接続アプリケーション情報(SF_SANDBOX_CLIENT_ID)が.envに設定されていません' : '本番用の接続アプリケーション情報(SF_PROD_CLIENT_ID)が.envに設定されていません')}`);
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    req.session.pkceCodeVerifier = codeVerifier;
    req.session.oauthLoginUrl = loginUrl;

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'api full refresh_token',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    });

    const authUrl = `${loginUrl}/services/oauth2/authorize?${params.toString()}`;
    log(`OAuth認可画面へリダイレクト [${config.isSandbox ? 'Sandbox' : '本番'}] (PKCE有効)`);
    log(`  redirect_uri: [${config.redirectUri}]`);
    log(`  client_id: [${config.clientId ? config.clientId.substring(0, 20) + '...' : 'MISSING!'}]`);
    res.redirect(authUrl);
});

// ================================================================
// GET /oauth/callback - コールバック（認可コード受領 + PKCE）
// ================================================================
app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const error = req.query.error;

    if (error) {
        log(`OAuth エラー: ${error} - ${req.query.error_description}`);
        return res.redirect(`/#error=${encodeURIComponent(req.query.error_description || error)}`);
    }
    if (!code) {
        log('OAuth エラー: 認可コードがありません');
        return res.redirect('/#error=no_code');
    }

    const codeVerifier = req.session.pkceCodeVerifier;
    const loginUrl = req.session.oauthLoginUrl || 'https://login.salesforce.com';
    const config = getOAuthConfig(loginUrl);

    if (!codeVerifier) {
        log('OAuth エラー: PKCE code_verifier がセッションにありません');
        return res.redirect('/#error=missing_code_verifier');
    }

    try {
        const tokenUrl = `${loginUrl}/services/oauth2/token`;
        const tokenParams = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code_verifier: codeVerifier
        });

        log(`トークンリクエスト送信 [${config.isSandbox ? 'Sandbox' : '本番'}] (PKCE code_verifier 付与)...`);
        const tokenResponse = await axios.post(tokenUrl, tokenParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const tokenData = tokenResponse.data;
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const instanceUrl = tokenData.instance_url;
        const idUrl = tokenData.id;

        const idParts = idUrl.split('/');
        const userId = idParts[idParts.length - 1];
        const orgId = idParts[idParts.length - 2];

        delete req.session.pkceCodeVerifier;

        req.session.sfAccessToken = accessToken;
        req.session.sfRefreshToken = refreshToken;
        req.session.sfInstanceUrl = instanceUrl;
        req.session.sfUserId = userId;
        req.session.sfOrgId = orgId;

        const conn = new jsforce.Connection({
            instanceUrl: instanceUrl,
            accessToken: accessToken,
            refreshToken: refreshToken,
            oauth2: new jsforce.OAuth2({
                loginUrl: config.loginUrl,
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                redirectUri: config.redirectUri
            })
        });

        try {
            const orgResult = await conn.query("SELECT Name FROM Organization LIMIT 1");
            req.session.sfOrgName = orgResult.records.length > 0 ? orgResult.records[0].Name : '';
        } catch (e) {
            req.session.sfOrgName = '';
        }

        try {
            const userResult = await conn.query(`SELECT Name, Username FROM User WHERE Id = '${userId}' LIMIT 1`);
            req.session.sfUserName = userResult.records.length > 0 ? userResult.records[0].Name : '';
            req.session.sfLoginName = userResult.records.length > 0 ? userResult.records[0].Username : '';
        } catch (e) {
            req.session.sfUserName = '';
            req.session.sfLoginName = '';
        }

        log(`OAuth ログイン成功 [${config.isSandbox ? 'Sandbox' : '本番'}] (PKCE): ${req.session.sfUserName} (${req.session.sfLoginName}) → ${instanceUrl}`);
        res.redirect('/#loggedin');

    } catch (err) {
        const errMsg = err.response ? (err.response.data?.error_description || err.response.data?.error || err.message) : err.message;
        log(`OAuth トークン交換エラー: ${errMsg}`);
        res.redirect(`/#error=${encodeURIComponent(errMsg)}`);
    }
});

// ================================================================
// GET /api/status - 接続状態確認
// ================================================================
app.get('/api/status', (req, res) => {
    const connected = !!(req.session && req.session.sfAccessToken);
    res.json({
        connected,
        instanceUrl: req.session.sfInstanceUrl || null,
        organizationId: req.session.sfOrgId || null,
        organizationName: req.session.sfOrgName || null,
        userName: req.session.sfUserName || null,
        loginName: req.session.sfLoginName || null
    });
});

// ================================================================
// POST /api/logout - ログアウト
// ================================================================
app.post('/api/logout', async (req, res) => {
    try {
        const conn = getConnection(req);
        if (conn) {
            try { await conn.logout(); } catch (e) { /* 無視 */ }
        }
    } catch (e) { /* 無視 */ }
    req.session.destroy();
    log('ログアウト完了');
    res.json({ success: true });
});

// ================================================================
// POST /api/search - ユーザ検索
// ================================================================
app.post('/api/search', async (req, res) => {
    try {
        const conn = getConnection(req);
        if (!conn) return res.status(401).json({ error: 'Salesforceに未ログインです。再ログインしてください。' });

        const { profileName, userName, loginName, customWhere } = req.body;
        let conditions = ["IsActive = true"];

        if (profileName && profileName.trim()) {
            conditions.push(`Profile.Name LIKE '%${profileName.trim().replace(/'/g, "\\'")}%'`);
        }
        if (userName && userName.trim()) {
            conditions.push(`Name LIKE '%${userName.trim().replace(/'/g, "\\'")}%'`);
        }
        if (loginName && loginName.trim()) {
            conditions.push(`Username LIKE '%${loginName.trim().replace(/'/g, "\\'")}%'`);
        }
        if (customWhere && customWhere.trim()) {
            conditions.push(`(${customWhere.trim()})`);
        }

        const soql = `SELECT Id, Name, Username, Email, Profile.Name, IsActive, LastLoginDate FROM User WHERE ${conditions.join(' AND ')} ORDER BY Profile.Name, Name LIMIT 500`;
        log(`ユーザ検索: ${soql}`);
        const result = await conn.query(soql);
        log(`検索結果: ${result.totalSize}件`);

        const users = result.records.map(r => ({
            Id: r.Id,
            Name: r.Name,
            Username: r.Username,
            Email: r.Email,
            ProfileName: r.Profile ? r.Profile.Name : '',
            IsActive: r.IsActive,
            LastLoginDate: r.LastLoginDate
        }));

        res.json({ success: true, users, totalSize: result.totalSize });

    } catch (err) {
        log(`検索エラー: ${err.message}`);
        if (err.name === 'INVALID_SESSION_ID' || err.errorCode === 'INVALID_SESSION_ID') {
            req.session.destroy();
            return res.status(401).json({ error: 'セッションが切れました。再ログインしてください。' });
        }
        res.status(500).json({ error: `検索失敗: ${err.message}` });
    }
});

// ================================================================
// POST /api/generate - MFA確認コード発番（Playwright UI自動化）
// ================================================================
app.post('/api/generate', async (req, res) => {
    try {
        const conn = getConnection(req);
        if (!conn) return res.status(401).json({ error: 'Salesforceに未ログインです。' });

        const { userIds, expiresInHours } = req.body;
        if (!userIds || userIds.length === 0) {
            return res.status(400).json({ error: 'ユーザが選択されていません' });
        }

        log(`MFAコード発番開始 (Playwright UI): ${userIds.length}名, 有効期限: ${expiresInHours}時間`);
        const results = [];
        const instanceUrl = conn.instanceUrl;
        const accessToken = conn.accessToken;

        // 直列実行（同時実行はSalesforceのレート制限とMFAセッションの競合を避けるため）
        for (let i = 0; i < userIds.length; i++) {
            const userId = userIds[i];
            try {
                const userResult = await conn.query(
                    `SELECT Id, Name, Username, Profile.Name FROM User WHERE Id = '${userId}' LIMIT 1`
                );
                const user = userResult.records[0];
                let code = null;
                let expiresAt = null;
                let status = 'Success';

                try {
                    log(`  [${i + 1}/${userIds.length}] ${user.Name} (${user.Username}) のコード生成中...`);
                    const uiResult = await generateMfaCodeViaUI(
                        instanceUrl,
                        accessToken,
                        userId,
                        expiresInHours || 24
                    );
                    code = uiResult.code;
                    expiresAt = uiResult.expiresAt;
                } catch (uiErr) {
                    status = 'Error';
                    code = `UI操作失敗: ${uiErr.message}`;
                    log(`  [${i + 1}/${userIds.length}] UI操作エラー: ${uiErr.message}`);
                }

                const now = new Date();
                if (!expiresAt) {
                    expiresAt = new Date(now.getTime() + (expiresInHours || 24) * 60 * 60 * 1000).toISOString();
                }

                results.push({
                    index: i + 1, userId: user.Id, name: user.Name,
                    username: user.Username, profileName: user.Profile ? user.Profile.Name : '',
                    code: code || '(取得失敗)', expiresAt, status,
                    generatedAt: now.toISOString()
                });
                log(`  [${i + 1}/${userIds.length}] ${user.Name} → ${status}`);

            } catch (userErr) {
                results.push({
                    index: i + 1, userId, name: '(取得失敗)',
                    username: '', profileName: '', code: '',
                    expiresAt: '', status: `Error: ${userErr.message}`,
                    generatedAt: new Date().toISOString()
                });
                log(`  [${i + 1}/${userIds.length}] ERROR: ${userErr.message}`);
            }
        }

        const successCount = results.filter(r => r.status === 'Success').length;
        const errorCount = results.filter(r => r.status.startsWith('Error') || r.status === 'Error').length;
        log(`MFAコード発番完了: 成功=${successCount}, エラー=${errorCount}`);

        res.json({
            success: true, results,
            summary: { total: results.length, success: successCount, error: errorCount, pending: results.length - successCount - errorCount }
        });

    } catch (err) {
        log(`発番エラー: ${err.message}`);
        res.status(500).json({ error: `発番失敗: ${err.message}` });
    }
});

// ================================================================
// POST /api/export-csv
// ================================================================
app.post('/api/export-csv', (req, res) => {
    try {
        const { results } = req.body;
        if (!results || results.length === 0) return res.status(400).json({ error: '出力データがありません' });

        const bom = '\uFEFF';
        const header = 'No,ユーザID,名前,ユーザ名,プロファイル,確認コード,有効期限,ステータス,発番日時\n';
        const rows = results.map(r =>
            `${r.index},"${r.userId}","${r.name}","${r.username}","${r.profileName}","${r.code}","${r.expiresAt}","${r.status}","${r.generatedAt}"`
        ).join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="MFA_codes_${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(bom + header + rows);
        log(`CSV出力: ${results.length}件`);

    } catch (err) {
        res.status(500).json({ error: `CSV出力失敗: ${err.message}` });
    }
});

// ================================================================
// POST /api/notify-teams (Adaptive Card + 旧形式 両対応)
// ================================================================
app.post('/api/notify-teams', async (req, res) => {
    try {
        const { results, webhookUrl } = req.body;
        const url = webhookUrl || process.env.TEAMS_WEBHOOK_URL;
        if (!url) return res.status(400).json({ error: 'Teams Webhook URLが設定されていません' });

        const successCount = results.filter(r => r.status === 'Success').length;
        const dateStr = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

        const isWorkflowWebhook = url.includes('logic.azure.com') || url.includes('powerplatform.com') || url.includes('powerautomate');

        let payload;
        if (isWorkflowWebhook) {
            const bodyItems = [
                { type: 'TextBlock', text: '📢 MFAコード発番結果', size: 'Medium', weight: 'Bolder', wrap: true },
                { type: 'TextBlock', text: `${dateStr}\u3000|\u3000合計: ${results.length}名\u3000|\u3000成功: ${successCount}名`, size: 'Small', wrap: true },
                { type: 'TextBlock', text: '─────────────────', spacing: 'Small' }
            ];
            results.forEach(r => {
                const emoji = r.status === 'Success' ? '✅' : '⚠️';
                bodyItems.push({ type: 'TextBlock', text: `${emoji} **${r.name}** (${r.username}) → ${r.code}`, wrap: true, spacing: 'Small' });
            });
            bodyItems.push({ type: 'TextBlock', text: '_MFAコード発番くん より自動通知_', size: 'Small', isSubtle: true, spacing: 'Medium', wrap: true });

            payload = {
                type: 'message',
                attachments: [{
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    contentUrl: null,
                    content: {
                        '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                        type: 'AdaptiveCard',
                        version: '1.4',
                        body: bodyItems
                    }
                }]
            };
            log(`Teams通知送信 (Adaptive Card形式): ${results.length}件`);
        } else {
            const lines = results.map(r => `${r.status === 'Success' ? '✅' : '⚠️'} ${r.name} (${r.username}) → ${r.code}`);
            payload = {
                text: [
                    `📢 **MFAコード発番結果** (${dateStr})`,
                    `合計: ${results.length}名 | 成功: ${successCount}名`, '', ...lines, '',
                    `_MFAコード発番くん より自動通知_`
                ].join('\n')
            };
            log(`Teams通知送信 (レガシー形式): ${results.length}件`);
        }

        await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
        res.json({ success: true, message: 'Teams通知を送信しました' });

    } catch (err) {
        const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data).substring(0, 200)}` : err.message;
        log(`Teams通知エラー: ${detail}`);
        res.status(500).json({ error: `Teams通知失敗: ${detail}` });
    }
});

// ================================================================
// サーバ起動
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    log('======================================');
    log('MFAコード発番くん v3.0');
    log('OAuth 2.0 + PKCE + Playwright UI自動化版');
    log(`http://localhost:${PORT}`);
    log('--------------------------------------');

    const hasProd = !!process.env.SF_PROD_CLIENT_ID;
    const hasSandbox = !!process.env.SF_SANDBOX_CLIENT_ID;
    log(`本番用 Connected App:   ${hasProd ? '✅ 設定済み' : '❌ 未設定'}`);
    log(`Sandbox用 Connected App: ${hasSandbox ? '✅ 設定済み' : '⚠️  未設定 (本番用にフォールバック)'}`);

    const callbackUrl = (process.env.SF_CALLBACK_URL || 'http://localhost:3000/oauth/callback').trim();
    log(`コールバックURL: [${callbackUrl}] (${callbackUrl.length}文字)`);

    if (hasProd) {
        const cid = process.env.SF_PROD_CLIENT_ID.trim();
        log(`本番 Client ID: [${cid.substring(0, 20)}...] (${cid.length}文字)`);
    }

    log(`Playwright UI自動化: ✅ 有効 (Headful モード = 画面表示)`);
    log(`エラースクショ保存先: ./services/logs/`);
    log('======================================');
    try { const open = (await import('open')).default; open(`http://localhost:${PORT}`); } catch (e) {}
});

// ================================================================
// Graceful Shutdown - Ctrl+C 等でブラウザを閉じる
// ================================================================
process.on('SIGINT', async () => {
    log('SIGINT受信: Playwrightブラウザをクローズしています...');
    await shutdownBrowser();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    log('SIGTERM受信: Playwrightブラウザをクローズしています...');
    await shutdownBrowser();
    process.exit(0);
});

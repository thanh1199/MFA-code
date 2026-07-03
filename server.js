// ============================================================
// MFAコード発番くん v6.0 (Auto Mode)
// OAuth 2.0 + PKCE + Playwright UI 自動化 + 定期実行
// ============================================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const jsforce = require('jsforce');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const { generateMfaCodeViaUI } = require('./services/mfa-code-generator');
const { shutdownBrowser } = require('./services/playwright-browser');
const sessionStore = require('./services/salesforce-session-store');
const { autoLoginSalesforce, createConnectionFromSession, getOAuthConfig } = require('./services/salesforce-auto-login');
const { startScheduledMfaJob, runJobOnce, getStatus: getJobStatus } = require('./services/scheduled-mfa-job');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'mfa-code-generator-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`[${ts}] ${msg}`);
}

// PKCE
function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
function generateCodeChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

// ============================================================
// Connection 取得 (req.session 優先、無ければ global session-store)
// ============================================================
function getConnection(req) {
    if (req && req.session && req.session.sfAccessToken && req.session.sfInstanceUrl) {
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
    const stored = sessionStore.get();
    if (stored && stored.accessToken) {
        return createConnectionFromSession(stored);
    }
    return null;
}

// ============================================================
// (UI互換) GET /oauth/login - 手動ログイン用
// ============================================================
app.get('/oauth/login', (req, res) => {
    const loginUrl = req.query.loginUrl || process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
    const config = getOAuthConfig(loginUrl);
    if (!config.clientId) {
        return res.redirect(`/#error=${encodeURIComponent('Connected App client_id 未設定')}`);
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
    res.redirect(`${loginUrl}/services/oauth2/authorize?${params.toString()}`);
});

// ============================================================
// GET /oauth/callback - 共通コールバック
// ・req.session 用に保存 (UI ログインフロー)
// ・global session-store にも保存 (バックグラウンドジョブ用)
// ============================================================
const oauthPending = require('./services/oauth-pending-store');

app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    const state = req.query.state;

    if (error) {
        log(`OAuth エラー: ${error}`);
        return res.redirect(`/#error=${encodeURIComponent(req.query.error_description || error)}`);
    }
    if (!code) return res.redirect('/#error=no_code');

    // ★ Ưu tiên: tìm pending entry trong oauthPending store (auto-login flow)
    let codeVerifier = null;
    let loginUrl = null;
    let pendingEntry = null;
    if (state) {
        pendingEntry = oauthPending.get(state);
        if (pendingEntry) {
            codeVerifier = pendingEntry.codeVerifier;
            loginUrl = pendingEntry.loginUrl;
            log(`OAuth callback: auto-login state=${state.substring(0, 8)}... を検出`);
        }
    }

    // Fallback: req.session (manual UI login flow)
    if (!codeVerifier && req.session.pkceCodeVerifier) {
        codeVerifier = req.session.pkceCodeVerifier;
        loginUrl = req.session.oauthLoginUrl;
        log('OAuth callback: req.session から verifier 取得');
    }

    if (!codeVerifier) {
        log('❌ code_verifier が見つかりません (auto store / session のいずれにも無し)');
        if (pendingEntry && pendingEntry.reject) pendingEntry.reject(new Error('missing_code_verifier'));
        return res.redirect('/#error=missing_code_verifier');
    }

    loginUrl = loginUrl || process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
    const config = getOAuthConfig(loginUrl);

    try {
        const tokenUrl = `${loginUrl}/services/oauth2/token`;
        const tokenParams = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code_verifier: codeVerifier
        });
        const tokenRes = await axios.post(tokenUrl, tokenParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const td = tokenRes.data;
        const idParts = (td.id || '').split('/');
        const userId = idParts[idParts.length - 1];
        const orgId = idParts[idParts.length - 2];

        const conn = new jsforce.Connection({
            instanceUrl: td.instance_url,
            accessToken: td.access_token
        });
        let orgName = '', uName = '', loginName = '';
        try {
            const r = await conn.query("SELECT Name FROM Organization LIMIT 1");
            orgName = r.records[0]?.Name || '';
        } catch (e) {}
        try {
            const r = await conn.query(`SELECT Name, Username FROM User WHERE Id = '${userId}' LIMIT 1`);
            uName = r.records[0]?.Name || '';
            loginName = r.records[0]?.Username || '';
        } catch (e) {}

        // ★ Lưu vào global session-store (cả 2 flow đều dùng được)
        sessionStore.set({
            accessToken: td.access_token,
            refreshToken: td.refresh_token,
            instanceUrl: td.instance_url,
            userId, orgId,
            userName: uName, loginName, organizationName: orgName,
            loginUrl
        });

        // ★ Notify auto-login flow
        if (pendingEntry && pendingEntry.resolve) {
            pendingEntry.resolve(code);
        }

        // Cũng lưu vào req.session cho UI flow
        delete req.session.pkceCodeVerifier;
        req.session.sfAccessToken = td.access_token;
        req.session.sfRefreshToken = td.refresh_token;
        req.session.sfInstanceUrl = td.instance_url;
        req.session.sfUserId = userId;
        req.session.sfOrgId = orgId;
        req.session.sfOrgName = orgName;
        req.session.sfUserName = uName;
        req.session.sfLoginName = loginName;

        log(`✅ OAuth ログイン成功: ${uName} (${loginName}) @ ${orgName}`);
        res.redirect('/#loggedin');
    } catch (err) {
        const errMsg = err.response ? (err.response.data?.error_description || err.message) : err.message;
        log(`❌ トークン交換エラー: ${errMsg}`);
        if (pendingEntry && pendingEntry.reject) pendingEntry.reject(new Error(errMsg));
        res.redirect(`/#error=${encodeURIComponent(errMsg)}`);
    }
});

// ============================================================
// 接続状態
// ============================================================
app.get('/api/status', (req, res) => {
    const stored = sessionStore.get();
    const fromSession = !!(req.session && req.session.sfAccessToken);
    const connected = fromSession || sessionStore.isValid();
    res.json({
        connected,
        source: fromSession ? 'session' : (sessionStore.isValid() ? 'store' : null),
        instanceUrl: req.session.sfInstanceUrl || (stored && stored.instanceUrl) || null,
        organizationName: req.session.sfOrgName || (stored && stored.organizationName) || null,
        userName: req.session.sfUserName || (stored && stored.userName) || null,
        loginName: req.session.sfLoginName || (stored && stored.loginName) || null
    });
});

// ============================================================
// スケジュールジョブ手動実行 / ステータス
// ============================================================
app.post('/api/scheduled-job/run-now', async (req, res) => {
    try {
        const summary = await runJobOnce();
        res.json({ success: true, summary });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/scheduled-job/status', (req, res) => {
    res.json(getJobStatus());
});

// ============================================================
// (互換) /api/generate - UI から手動発番する場合の API
// ============================================================
app.post('/api/generate', async (req, res) => {
    try {
        const conn = getConnection(req);
        if (!conn) return res.status(401).json({ error: 'Salesforce 未ログイン' });
        const { userIds, expiresInHours } = req.body;
        if (!userIds || userIds.length === 0) return res.status(400).json({ error: 'ユーザ未選択' });
        const results = [];
        for (let i = 0; i < userIds.length; i++) {
            const userId = userIds[i];
            try {
                const ur = await conn.query(`SELECT Id, Name, Username FROM User WHERE Id = '${userId}' LIMIT 1`);
                const u = ur.records[0];
                const r = await generateMfaCodeViaUI(conn.instanceUrl, conn.accessToken, userId, expiresInHours || 24);
                results.push({ userId: u.Id, name: u.Name, username: u.Username, code: r.code, expiresAt: r.expiresAt, status: 'Success' });
            } catch (e) {
                results.push({ userId, status: `Error: ${e.message}` });
            }
        }
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// サーバ起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    log('======================================');
    log('MFAコード発番くん v4.0 (Auto Mode)');
    log(`Listening on http://localhost:${PORT}`);
    log(`AUTO_LOGIN_ON_START=${process.env.AUTO_LOGIN_ON_START}`);
    log(`SCHEDULER_ENABLED=${process.env.SCHEDULER_ENABLED}`);
    log(`SCHEDULE_INTERVAL_HOURS=${process.env.SCHEDULE_INTERVAL_HOURS}`);
    log(`PLAYWRIGHT_HEADLESS=${process.env.PLAYWRIGHT_HEADLESS}`);
    log('======================================');

    // 自動ログイン
    if (String(process.env.AUTO_LOGIN_ON_START || 'false').toLowerCase() === 'true') {
        try {
            await autoLoginSalesforce();
        } catch (e) {
            log(`❌ 自動ログイン失敗: ${e.message}`);
        }
    }

    // スケジューラ起動
    if (String(process.env.SCHEDULER_ENABLED || 'false').toLowerCase() === 'true') {
        startScheduledMfaJob();
    }

    // UI 自動オープン (オプション)
    if (String(process.env.OPEN_UI_ON_START || 'false').toLowerCase() === 'true') {
        try {
            const open = (await import('open')).default;
            open(`http://localhost:${PORT}`);
        } catch (e) {
            log(`open() スキップ: ${e.message}`);
        }
    }
});

process.on('SIGINT', async () => {
    log('SIGINT 受信: シャットダウン中...');
    await shutdownBrowser();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    log('SIGTERM 受信: シャットダウン中...');
    await shutdownBrowser();
    process.exit(0);
});

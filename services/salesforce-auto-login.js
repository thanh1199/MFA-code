// ============================================================
// salesforce-auto-login.js  v4.0 (Auto Mode)
// 想定 Phase 1 フロー (3画面):
//   ① ユーザ名入力 → [Sandbox にログイン]
//   ② パスワード入力 → [Sandbox にログイン]
//   ③ ID を検証 → SF_TEMP_VERIFICATION_CODE 入力 → [検証]
//
// 想定外の画面が出たら fail fast (高保証 / Security Key / etc.)
//
// 優先順位:
//   runtime/secrets.json (自分自身が前回生成したコード)
//     > .env SF_TEMP_VERIFICATION_CODE (seed)
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const jsforce = require('jsforce');
const { getOrCreateContext, saveContextState, saveScreenshot } = require('./playwright-browser');
const { waitForPageStable } = require('./salesforce-ui-helper');
const sessionStore = require('./salesforce-session-store');
const runtimeSecrets = require('./runtime-secrets');
const oauthPending = require('./oauth-pending-store');

function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`[${ts}] [auto-login] ${msg}`);
}

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
        clientId: clientId ? clientId.trim() : '',
        clientSecret: clientSecret ? clientSecret.trim() : '',
        loginUrl: (loginUrl || 'https://login.salesforce.com').trim(),
        redirectUri: (process.env.SF_CALLBACK_URL || 'http://localhost:3000/oauth/callback').trim(),
        isSandbox
    };
}

function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
function generateCodeChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

async function dumpPageHtml(page, label) {
    try {
        const logsDir = path.join(__dirname, '..', 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        const file = path.join(logsDir, `${label}_${Date.now()}.html`);
        const html = await page.content();
        fs.writeFileSync(file, html, 'utf-8');
        log(`HTML ダンプ: ${path.basename(file)}`);
    } catch (e) {}
}

// ============================================================
// ログインフォーム入力
// ============================================================
async function waitForLoginPageReady(page, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    const usernameSel = 'input#username:not([type="hidden"]), input[name="username"]:not([type="hidden"]), input[autocomplete="username"]:not([type="hidden"])';
    const passwordSel = 'input#password, input[name="pw"], input[type="password"]';
    const allowSel = 'input#oaapprove, input[value="Allow"], input[value="許可"]';
    while (Date.now() < deadline) {
        const has = await page.evaluate(({u, p, a}) => ({
            username: !!document.querySelector(u),
            password: !!document.querySelector(p),
            allow:    !!document.querySelector(a),
            url:      location.href
        }), { u: usernameSel, p: passwordSel, a: allowSel }).catch(() => null);
        if (has) {
            if (has.allow) return { stage: 'allow', url: has.url };
            if (has.password) return { stage: 'password', url: has.url };
            if (has.username) return { stage: 'username', url: has.url };
        }
        await page.waitForTimeout(500);
    }
    return { stage: 'unknown', url: page.url() };
}

async function fillLoginForm(page, username, password) {
    const ready = await waitForLoginPageReady(page, 45000);
    log(`ログイン画面検出: stage=${ready.stage}`);

    if (ready.stage === 'allow') return;
    if (ready.stage === 'unknown') {
        await saveScreenshot(page, 'autologin', 'no_field_detected');
        await dumpPageHtml(page, 'no_field_detected');
        throw new Error(`ログイン画面のフィールドが検出されません (URL=${ready.url})`);
    }

    const usernameSel = 'input#username:not([type="hidden"]), input[name="username"]:not([type="hidden"]), input[autocomplete="username"]:not([type="hidden"])';
    const passwordSel = 'input#password, input[name="pw"], input[type="password"]';

    log('ユーザ名入力');
    await page.locator(usernameSel).first().fill(username);
    // hidden 'un' field にもセット
    await page.evaluate((u) => {
        document.querySelectorAll('input[name="un"][type="hidden"]').forEach(el => el.value = u);
    }, username).catch(() => {});

    let hasPwd = await page.locator(passwordSel).first().isVisible({ timeout: 1500 }).catch(() => false);

    if (!hasPwd) {
        log('Username-first フロー → 「Sandbox にログイン」クリック');
        const currentUrl = page.url();
        const loginBtn = page.locator('#Login, input[id="Login"]').first();
        try {
            await Promise.all([
                page.waitForURL(url => url !== currentUrl, { timeout: 30000, waitUntil: 'domcontentloaded' }),
                loginBtn.click({ timeout: 5000 })
            ]);
        } catch (e) {}
        const passwordReady = await page.locator(passwordSel).first()
            .waitFor({ state: 'visible', timeout: 30000 })
            .then(() => true).catch(() => false);
        if (!passwordReady) {
            await saveScreenshot(page, 'autologin', 'no_password_after_next');
            await dumpPageHtml(page, 'no_password_after_next');
            throw new Error(`ユーザ名送信後にパスワード欄が出ません (URL=${page.url()})`);
        }
    }

    log('パスワード入力');
    await page.locator(passwordSel).first().fill(password);
    const currentBeforeLogin = page.url();
    const loginBtn2 = page.locator('#Login, input[id="Login"], button:has-text("ログイン"), button:has-text("Log In"), input[type="submit"]').first();
    log('Login ボタンクリック');
    try {
        await Promise.all([
            page.waitForURL(url => url !== currentBeforeLogin, { timeout: 30000, waitUntil: 'domcontentloaded' }),
            loginBtn2.click({ timeout: 5000 })
        ]);
    } catch (e) {}
}

// ============================================================
// ID 検証画面の判別 + 自動入力 (Phase 1 限定)
// ============================================================
async function detectVerifyScreen(page) {
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
        const text = document.body.textContent || '';
        const url = location.href;
        // ID検証画面でない
        if (!text.includes('ID を検証') &&
            !text.includes('Verify Your Identity') &&
            !url.includes('verification') &&
            !url.includes('verifyidentity')) {
            return 'none';
        }
        // セキュリティキー
        if (text.includes('セキュリティキー') || text.includes('Security Key') ||
            text.includes('WebAuthn') || text.includes('U2F')) {
            return 'security_key';
        }
        // Salesforce Authenticator
        if (text.includes('Salesforce Authenticator') || text.includes('モバイルアプリで承認')) {
            return 'authenticator';
        }
        // コード入力欄
        const visibleInputs = Array.from(document.querySelectorAll(
            'input[type="text"], input[type="tel"], input[type="number"], input[type="password"]'
        )).filter(i => i.type !== 'hidden' && i.offsetParent !== null);
        if (visibleInputs.length > 0 && text.includes('確認コード')) {
            return 'code_input';
        }
        return 'unknown';
    }).catch(() => 'unknown');
}

async function handleIdentityVerification(page) {
    const screen = await detectVerifyScreen(page);
    if (screen === 'none') return false;

    log(`ID検証画面を検出: ${screen}`);

    const guide = [
        '',
        '─── 想定 Phase 1 フロー ───',
        '  ① ユーザ名入力 → Sandbox にログイン',
        '  ② パスワード入力 → Sandbox にログイン',
        '  ③ ID を検証 → 仮の確認コード入力 → 検証',
        '',
        '─── 対処方法 ───',
        '  1. Salesforce で新しい仮の確認コードを発番',
        '  2. .env の SF_TEMP_VERIFICATION_CODE を更新',
        '  3. services/.playwright-storage.json があれば削除',
        '  4. runtime/secrets.json があれば削除',
        '  5. 起動.bat を再実行',
        ''
    ].join('\n');

    if (screen === 'security_key') {
        await saveScreenshot(page, 'autologin', 'verify_security_key');
        throw new Error(
            '⚠️ Phase 1 でセキュリティキー(物理デバイス)認証が要求されました。' +
            '自動運転モードでは対応できません。Salesforce 管理者に「メール検証コード方式」の有効化を依頼してください。' + guide
        );
    }
    if (screen === 'authenticator') {
        await saveScreenshot(page, 'autologin', 'verify_authenticator');
        throw new Error(
            '⚠️ Phase 1 で Salesforce Authenticator プッシュ承認が要求されました。' +
            '自動運転モードでは対応できません。' + guide
        );
    }
    if (screen === 'unknown') {
        await saveScreenshot(page, 'autologin', 'verify_unknown');
        await dumpPageHtml(page, 'verify_unknown');
        throw new Error(
            '⚠️ Phase 1 で想定外の ID 検証画面が表示されました。logs/ を確認してください。' + guide
        );
    }

    // screen === 'code_input'
    const vc = runtimeSecrets.getVerificationCode();
    if (!vc.code) {
        await saveScreenshot(page, 'autologin', 'no_verification_code');
        throw new Error(
            '⚠️ ID 検証コードが設定されていません。' +
            'runtime/secrets.json と .env SF_TEMP_VERIFICATION_CODE の両方が空です。' + guide
        );
    }
    log(`ID検証コードを自動入力 (source=${vc.source})`);

    const codeInput = page.locator(
        'input[type="text"]:visible, input[type="tel"]:visible, input[type="number"]:visible'
    ).first();
    await codeInput.waitFor({ state: 'visible', timeout: 10000 });
    await codeInput.fill(vc.code);

    const verifyBtn = page.locator('input[type="submit"], button').filter({ hasText: /検証|Verify/ }).first();
    await verifyBtn.click({ timeout: 5000 }).catch(async () => {
        await page.keyboard.press('Enter');
    });
    await page.waitForTimeout(3000);
    await waitForPageStable(page, 'after-verify');

    // 検証結果判別: エラーが残っていないかチェック
    const verifyResult = await page.evaluate(() => {
        const text = document.body.textContent || '';
        const errs = ['コードが正しくありません', '無効なコード', '期限切れ',
                      'Invalid code', 'incorrect', 'expired'];
        const hasError = errs.some(e => text.includes(e));
        const stillOnVerify = text.includes('ID を検証') &&
            Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]'))
                .some(i => i.offsetParent !== null);
        return { hasError, stillOnVerify };
    }).catch(() => ({ hasError: false, stillOnVerify: false }));

    if (verifyResult.hasError || verifyResult.stillOnVerify) {
        await saveScreenshot(page, 'autologin', 'code_rejected');
        // runtime のコードを使っていて失敗した場合、フォールバックを試す
        if (vc.source === 'runtime') {
            const envCode = (process.env.SF_TEMP_VERIFICATION_CODE || '').trim();
            if (envCode && envCode !== vc.code) {
                log('runtime コード拒否 → .env SF_TEMP_VERIFICATION_CODE でリトライ');
                await codeInput.fill(envCode);
                await verifyBtn.click({ timeout: 5000 }).catch(async () => {
                    await page.keyboard.press('Enter');
                });
                await page.waitForTimeout(3000);
                await waitForPageStable(page, 'after-verify-fallback');
                const r2 = await page.evaluate(() => {
                    const text = document.body.textContent || '';
                    const errs = ['コードが正しくありません', '無効なコード', '期限切れ', 'Invalid code', 'incorrect', 'expired'];
                    return errs.some(e => text.includes(e));
                }).catch(() => false);
                if (!r2) {
                    log('✅ .env のコードで検証成功 (runtime コードはクリア)');
                    return true;
                }
            }
        }
        throw new Error(
            '⚠️ SF_TEMP_VERIFICATION_CODE が期限切れまたは無効です。' +
            'Salesforce で新しい仮の確認コードを発番して .env を更新してください。' + guide
        );
    }

    return true;
}

async function handleAuthorizationPrompt(page) {
    try {
        const allowBtn = page.locator(`
            input[name="save"][title="許可"],
            input[name="save"][value*="許可"],
            button:has-text("許可"),
            input[id="oaapprove"],
            input[value*="Allow"],
            button:has-text("Allow")
        `).first();
        
        if (await allowBtn.isVisible({ timeout: 5000 })) {
            log('接続アプリ承認 → 「許可」クリック');
            await allowBtn.click();
            await waitForPageStable(page, 'after-allow');
        }
    } catch (e) {}
}

// ============================================================
// メイン: autoLoginSalesforce
// ============================================================
async function autoLoginSalesforce() {
    const activeUser = runtimeSecrets.getActiveLoginUser();
    const userName = activeUser.username;
    const password = activeUser.password;

    if (!userName || !password) {
        throw new Error('ログインユーザ情報が未設定です。Rotation有効時は SF_USER_A_NAME/PASSWORD, SF_USER_B_NAME/PASSWORD を確認してください');
    }

    log(`ログイン担当ユーザ: ${activeUser.key} (${userName})`);
    const loginUrl = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').trim();
    const config = getOAuthConfig(loginUrl);
    if (!config.clientId) {
        throw new Error(`${config.isSandbox ? 'SF_SANDBOX_CLIENT_ID' : 'SF_PROD_CLIENT_ID'} が設定されていません`);
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');

    const codePromise = new Promise((resolve, reject) => {
        oauthPending.register(state, { codeVerifier, loginUrl: config.loginUrl, resolve, reject });
        setTimeout(() => reject(new Error('OAuth callback timeout')), 120000);
    });

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'api full refresh_token',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state
    });
    const authUrl = `${config.loginUrl}/services/oauth2/authorize?${params.toString()}`;
    log(`OAuth 認可URL を開く (${config.isSandbox ? 'Sandbox' : '本番'})`);

    const context = await getOrCreateContext();
    const page = await context.newPage();
    let authorizationCode = null;

    try {
        await page.route('**/c.salesforce.com/**', route => route.abort());
        await page.route('**/promos.html', route => route.abort());

        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        const hasLoginForm = await page.locator('#username, input[name="username"]').count().catch(() => 0);
        if (hasLoginForm > 0) {
            await fillLoginForm(page, userName, password);
        } else {
            log('ログインフォーム未検出 → 既存 cookie で認証済みの可能性');
        }

        // Phase 1 Step 3: ID 検証
        await handleIdentityVerification(page).catch(e => { throw e; });
        await handleAuthorizationPrompt(page);

        log('OAuth callback 待機中...');
        authorizationCode = await codePromise.catch(e => {
            log(`callback 待機エラー: ${e.message}`);
            return null;
        });
        oauthPending.remove(state);

        if (!authorizationCode) {
            await saveScreenshot(page, 'autologin', 'no_auth_code');
            throw new Error('認可コードを取得できませんでした');
        }
        log('✅ OAuth callback で session 確立済み');
        await saveContextState();
        return sessionStore.get();
    } catch (err) {
        oauthPending.remove(state);
        log(`❌ ログイン失敗: ${err.message}`);
        throw err;
    } finally {
        await page.close().catch(() => {});
    }
}

function createConnectionFromSession(sfSession) {
    if (!sfSession || !sfSession.accessToken || !sfSession.instanceUrl) return null;
    const config = getOAuthConfig(sfSession.loginUrl || 'https://login.salesforce.com');
    return new jsforce.Connection({
        instanceUrl: sfSession.instanceUrl,
        accessToken: sfSession.accessToken,
        refreshToken: sfSession.refreshToken,
        oauth2: new jsforce.OAuth2({
            loginUrl: config.loginUrl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri
        })
    });
}

module.exports = { autoLoginSalesforce, createConnectionFromSession, getOAuthConfig };

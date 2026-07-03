// ============================================================
// mfa-code-generator.js  v4.0 (Auto Mode, Simplified)
// 想定フロー (3画面):
//   ① ユーザ詳細 → [生成] クリック
//   ② 「仮のコードを生成」フォーム → 期限選択 → [コードの生成]
//   ③ 「ユーザー用に生成されたコード」結果画面 → 仮のコード & 有効期限抽出
//
// 想定外の画面が出たら fail fast、メッセージで原因を示す。
// ============================================================
const path = require('path');
const fs = require('fs');
const {
    getOrCreateContext,
    saveContextState,
    saveScreenshot,
    ensureLogsDir
} = require('./playwright-browser');
const {
    waitForPageStable,
    safeEvaluate,
    findAndClickLink,
    findAndClickByText,
    dumpAllLinks
} = require('./salesforce-ui-helper');
const runtimeSecrets = require('./runtime-secrets');

function pwLog(msg) { console.log(`  [Playwright] ${msg}`); }

// ============================================================
// 現在の画面を判別
// ============================================================
async function detectCurrentScreen(page) {
    await page.waitForTimeout(1500);
    return await safeEvaluate(page, () => {
        const text = document.body.textContent || '';
        const url = location.href;

        // ✅ OK: 結果画面 (まれに飛ぶ)
        if (document.querySelector('span[id$="successDisplay:code"]')) {
            return 'result';
        }
        // ✅ OK: 期限選択フォーム (想定: 「仮のコードを生成」)
        if (document.querySelector('input[id$="generateButton"]') ||
            document.querySelector('[id$="generateDisplay"]') ||
            text.includes('仮のコードを生成') ||
            text.includes('コードの有効期限はいつにしますか')) {
            return 'generate_form';
        }
        // ⚠ NG: ID検証画面
        if (text.includes('ID を検証') ||
            text.includes('Verify Your Identity') ||
            url.includes('verification') || url.includes('verifyidentity')) {
            // セキュリティキー or WebAuthn
            if (text.includes('セキュリティキー') || text.includes('Security Key') ||
                text.includes('WebAuthn') || text.includes('U2F')) {
                return 'verify_security_key';
            }
            // Salesforce Authenticator / プッシュ承認
            if (text.includes('Salesforce Authenticator') || text.includes('モバイルアプリで承認')) {
                return 'verify_authenticator';
            }
            // コード入力欄 (visible)
            const visibleInputs = Array.from(document.querySelectorAll(
                'input[type="text"], input[type="tel"], input[type="number"], input[type="password"]'
            )).filter(i => i.type !== 'hidden' && i.offsetParent !== null);
            if (visibleInputs.length > 0 && text.includes('確認コード')) {
                return 'verify_code_input';
            }
            return 'verify_unknown';
        }
        // ⚠ NG: アクセス拒否
        if (text.includes('アクセスできません') ||
            text.includes('権限がありません') ||
            text.includes('Insufficient Privileges')) {
            return 'access_denied';
        }
        // ⚠ NG: セッション切れ
        if (text.includes('ログイン') && text.includes('パスワード') &&
            document.querySelector('input[type="password"]:not([type="hidden"])')) {
            return 'login_again';
        }
        return 'unknown';
    }).catch(() => 'unknown');
}

function buildErrorForScreen(screen, userId) {
    const guide = [
        '',
        '─── 想定フロー (確認用) ───',
        '  ① ユーザ詳細画面 → [生成] リンクをクリック',
        '  ② 「仮のコードを生成」フォーム → 期限選択 → [コードの生成]',
        '  ③ 「ユーザー用に生成されたコード」結果画面 → コード抽出',
        '',
        '─── 対処方法 ───',
        '  1. Salesforce に手動でログインして、上記フローが今でも有効か確認',
        '  2. .env の SF_TEMP_VERIFICATION_CODE が期限切れの場合は新しいコードを発番して更新',
        '  3. services/.playwright-storage.json を削除してセッションをリセット',
        '  4. 起動.bat を再実行',
        ''
    ].join('\n');

    switch (screen) {
        case 'verify_code_input':
            return new Error(
                '⚠️ [生成] 直後に再度「仮の確認コード」入力画面が表示されました。' +
                '高保証セッションが切れているか、SF_TEMP_VERIFICATION_CODE が期限切れの可能性があります。' + guide
            );
        case 'verify_security_key':
            return new Error(
                '⚠️ [生成] 直後にセキュリティキー(物理デバイス)認証が要求されました。' +
                '自動運転モードでは物理デバイス認証に対応できません。' +
                'Salesforce 管理者に「メール検証コード方式」の有効化、または対象ユーザのセキュリティキー登録解除を依頼してください。' + guide
            );
        case 'verify_authenticator':
            return new Error(
                '⚠️ [生成] 直後に Salesforce Authenticator プッシュ承認が要求されました。' +
                '自動運転モードでは対応できません。' + guide
            );
        case 'verify_unknown':
            return new Error(
                '⚠️ [生成] 直後に想定外の ID 検証画面が表示されました。' +
                'logs/ のスクリーンショットを確認してください。' + guide
            );
        case 'access_denied':
            return new Error(
                '⚠️ アクセス拒否されました。セッション切れまたは権限不足の可能性。' + guide
            );
        case 'login_again':
            return new Error(
                '⚠️ ログイン画面に戻されました。セッションが切れています。' + guide
            );
        case 'unknown':
        default:
            return new Error(
                `⚠️ 想定外の画面が表示されました (screen=${screen})。` +
                'SF_TEMP_VERIFICATION_CODE が期限切れか、セッションが失効した可能性があります。' + guide
            );
    }
}

// ============================================================
// Step: 期限選択
// ============================================================
async function selectExpiry(page, expiresInHours) {
    const hours = Number(expiresInHours || 24);
    const labelText = `${hours} 時間`;
    try {
        const r = page.getByLabel(labelText);
        if (await r.count() > 0) {
            await r.check();
            pwLog(`有効期限選択: ${labelText}`);
            return true;
        }
    } catch {}
    try {
        await page.locator(`text="${labelText}"`).click({ timeout: 3000 });
        pwLog(`有効期限選択: ${labelText}`);
        return true;
    } catch {}
    pwLog(`⚠️ 有効期限 ${labelText} を選択できません、デフォルトで続行`);
    return false;
}
// ============================================================
// Step: [生成] 後の ID 検証コード入力
// ============================================================
async function handleVerificationCodeAfterGenerate(page, userId) {
    const vc = runtimeSecrets.getVerificationCode();

    if (!vc.code) {
        await saveScreenshot(page, userId, 'no_temp_verification_code_after_generate');
        throw new Error('SF_TEMP_VERIFICATION_CODE が未設定です。[生成] 後の ID 検証を通過できません');
    }

    pwLog(`ID検証コード入力 (source=${vc.source})`);

    const input = page.locator(
        'input[type="text"]:visible, input[type="tel"]:visible, input[type="number"]:visible, input[type="password"]:visible'
    ).first();

    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill(vc.code);

    const verifyBtn = page.locator('button:has-text("検証"), input[value="検証"], button:has-text("Verify"), input[value="Verify"]').first();

    try {
        await Promise.all([
            page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
            verifyBtn.click({ timeout: 5000 })
        ]);
    } catch {
        await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(3000);
    await waitForPageStable(page, 'after-generate-verify');

    const afterScreen = await detectCurrentScreen(page);
    pwLog(`ID検証後の画面判別: ${afterScreen}`);

    if (afterScreen !== 'generate_form' && afterScreen !== 'result') {
        await saveScreenshot(page, userId, `after_verify_${afterScreen}`);
        throw buildErrorForScreen(afterScreen, userId);
    }

    return afterScreen;
}
// ============================================================
// Step: [コードの生成] ボタンクリック
// ============================================================
async function clickConfirmGenerate(page, userId) {
    const selectors = [
        'input[id$="generateDisplay:generateButton"]',
        'input[id$="generateButton"][value="コードの生成"]',
        'input[type="button"][value="コードの生成"]',
        'input[type="submit"][value*="コード"][value*="生成"]',
        'button:has-text("コードの生成")', 'button:has-text("コードを生成")',
        'button:has-text("Generate Code")'
    ];
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            await loc.waitFor({ state: 'visible', timeout: 2000 });
            await loc.click();
            pwLog(`「コードの生成」クリック`);
            return true;
        } catch {}
    }
    await saveScreenshot(page, userId, 'confirm_button_not_found');
    throw new Error('「コードの生成」ボタンが見つかりません');
}

// ============================================================
// Step: コード抽出 (Multi-strategy)
// ============================================================
async function extractCode(page) {
    // Strategy 1: id-suffix match (most reliable)
    try {
        const codeEl = page.locator('span[id$="successDisplay:code"]').first();
        if (await codeEl.count() > 0) {
            const txt = ((await codeEl.textContent({ timeout: 5000 })) || '').trim();
            if (/^[A-Z0-9]{6,12}$/i.test(txt)) return txt;
        }
    } catch {}
    // Strategy 2: label-sibling
    try {
        const txt = await safeEvaluate(page, () => {
            const labels = [...document.querySelectorAll('span.label, span, label, dt')];
            for (const lbl of labels) {
                const t = (lbl.textContent || '').trim();
                if (t === '仮のコード' || t === '確認コード') {
                    let node = lbl.nextSibling;
                    while (node) {
                        const v = (node.textContent || '').trim();
                        if (/^[A-Z0-9]{6,12}$/i.test(v)) return v;
                        node = node.nextSibling;
                    }
                    // Parent's siblings
                    let p = lbl.parentElement;
                    if (p && p.nextElementSibling) {
                        const v2 = (p.nextElementSibling.textContent || '').trim();
                        if (/^[A-Z0-9]{6,12}$/i.test(v2)) return v2;
                    }
                }
            }
            return null;
        });
        if (txt) return txt;
    } catch {}
    // Strategy 3: regex on body text
    try {
        const bodyText = await page.locator('body').textContent();
        const m = bodyText.match(/仮のコード[\s\n:：]+([A-Z0-9]{6,12})\b/i);
        if (m) return m[1];
    } catch {}
    return null;
}

// ============================================================
// Step: 有効期限抽出
// ============================================================
async function extractExpiry(page) {
    try {
        const expiryText = await safeEvaluate(page, () => {
            const labels = [...document.querySelectorAll('span.label, span, label, dt')];
            for (const lbl of labels) {
                const t = (lbl.textContent || '').trim();
                if (t === '有効期限' || /Expir/i.test(t)) {
                    let node = lbl.nextSibling;
                    while (node) {
                        const v = (node.textContent || '').trim();
                        const m = v.match(/(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2})/);
                        if (m) return m[1];
                        node = node.nextSibling;
                    }
                    let p = lbl.parentElement;
                    if (p && p.nextElementSibling) {
                        const v2 = (p.nextElementSibling.textContent || '').trim();
                        const m2 = v2.match(/(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2})/);
                        if (m2) return m2[1];
                    }
                }
            }
            return null;
        });
        if (expiryText) {
            const m = expiryText.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (m) {
                const [, Y, M, D, h, mi] = m;
                return `${Y}-${M.padStart(2,'0')}-${D.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:00+09:00`;
            }
        }
    } catch {}
    return null;
}

// ============================================================
// メイン関数
// ============================================================
async function generateMfaCodeViaUI(instanceUrl, accessToken, userId, expiresInHours) {
    const context = await getOrCreateContext();
    const page = await context.newPage();
    page.on('dialog', async d => { try { await d.accept(); } catch {} });

    try {
        // ─── Step 1: ユーザ詳細ページへ ───
        const targetPath = `/${userId}?noredirect=1`;
        const frontdoorUrl = `${instanceUrl}/secur/frontdoor.jsp?sid=${encodeURIComponent(accessToken)}&retURL=${encodeURIComponent(targetPath)}`;
        pwLog(`=== ユーザ ${userId} 処理開始 ===`);
        await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForPageStable(page, 'initial-load');

        if (page.url().includes('lightning.force.com')) {
            const classicUrl = `${instanceUrl}/${userId}?noredirect=1&isUserEntityOverride=1`;
            await page.goto(classicUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForPageStable(page, 'classic-switch');
        }

        // (Optional) Expire existing code first
        const expireResult = await findAndClickLink(
            page, ['今すぐ期限切れにする', 'Expire Now'],
            ['確認コード', 'Verification Code'], userId, '期限切れ'
        );
        if (expireResult.success) {
            await waitForPageStable(page, 'after-expire');
        }

        // ─── Step 2: [生成] クリック ───
        const generateResult = await findAndClickLink(
            page, ['生成', 'Generate'],
            ['確認コード', 'Verification Code'], userId, '生成'
        );
        if (!generateResult.success) {
            await saveScreenshot(page, userId, 'no_generate_link');
            throw new Error('[生成] リンクが見つかりません (ユーザ詳細画面の表示状態を確認してください)');
        }
        await page.waitForTimeout(2000);
        await waitForPageStable(page, 'after-generate-click');

        // ─── Step 3: 画面判別 ───
        let screen = await detectCurrentScreen(page);
        pwLog(`画面判別: ${screen}`);

        if (screen === 'verify_code_input') {
            screen = await handleVerificationCodeAfterGenerate(page, userId);
        }

        if (screen !== 'generate_form' && screen !== 'result') {
            await saveScreenshot(page, userId, `unexpected_${screen}`);
            throw buildErrorForScreen(screen, userId);
        }

        // ─── Step 4: 期限選択 → [コードの生成] (result 画面の場合はスキップ) ───
        if (screen === 'generate_form') {
            await selectExpiry(page, expiresInHours);
            await clickConfirmGenerate(page, userId);
            // 結果画面の出現を待機
            try {
                await page.waitForSelector('span[id$="successDisplay:code"]', {
                    timeout: 30000, state: 'attached'
                });
                pwLog('✅ 結果画面到達 (successDisplay:code 検出)');
            } catch (e) {
                // もう一度画面チェック → 想定外なら fail
                const after = await detectCurrentScreen(page);
                if (after !== 'result') {
                    await saveScreenshot(page, userId, `after_confirm_${after}`);
                    throw buildErrorForScreen(after, userId);
                }
            }
        }

        // ─── Step 5: コード & 有効期限抽出 ───
        const code = await extractCode(page);
        if (!code) {
            await saveScreenshot(page, userId, 'no_code_extracted');
            try {
                const html = await page.content();
                const dumpPath = path.join(ensureLogsDir(), `no_code_html_${userId}_${Date.now()}.html`);
                fs.writeFileSync(dumpPath, html, 'utf-8');
            } catch {}
            throw new Error('結果画面からコードが抽出できませんでした');
        }

        let expiresAt = await extractExpiry(page);
        if (!expiresAt) {
            expiresAt = new Date(Date.now() + (expiresInHours || 24) * 3600 * 1000).toISOString();
            pwLog(`⚠️ 有効期限を画面から抽出できず、計算値を使用: ${expiresAt}`);
        } else {
            pwLog(`✅ 有効期限: ${expiresAt}`);
        }

        await saveScreenshot(page, userId, 'success');
        pwLog(`=== 完了 ===`);
        await saveContextState();
        return { success: true, code, expiresAt };

    } catch (err) {
        const sp = await saveScreenshot(page, userId, 'error');
        const suffix = sp ? ` (スクショ: ${path.basename(sp)})` : '';
        // err.message が既に長文の guide を含む場合はそのまま、そうでなければ suffix を追加
        throw new Error(`${err.message}${err.message.includes('スクショ:') ? '' : suffix}`);
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { generateMfaCodeViaUI };

// ================================================================
// playwright-service.js v8 - ナビゲーション耐性版
// "Execution context was destroyed" エラーに対するリトライ機構
// ================================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let browserInstance = null;
let browserPromise = null;
let sharedContext = null;
let sharedContextPromise = null;

function ensureLogsDir() {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) return browserInstance;
    if (browserPromise) return browserPromise;
    browserPromise = chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    }).then(b => { browserInstance = b; browserPromise = null; return b; });
    return browserPromise;
}

async function getOrCreateContext() {
    if (sharedContext) {
        try { sharedContext.pages(); return sharedContext; }
        catch (e) { sharedContext = null; }
    }
    if (sharedContextPromise) return sharedContextPromise;
    const browser = await getBrowser();
    sharedContextPromise = browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo'
    }).then(ctx => {
        sharedContext = ctx;
        sharedContextPromise = null;
        console.log('  [Playwright] 共有コンテキスト作成');
        return ctx;
    });
    return sharedContextPromise;
}

async function closeSharedContext() {
    if (sharedContext) {
        try { await sharedContext.close(); } catch (e) {}
        sharedContext = null;
    }
}

async function shutdownBrowser() {
    await closeSharedContext();
    if (browserInstance) {
        try { await browserInstance.close(); } catch (e) {}
        browserInstance = null;
    }
}

async function saveScreenshot(page, userId, label = 'error') {
    try {
        const logsDir = ensureLogsDir();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${label}_${userId}_${ts}.png`;
        const filepath = path.join(logsDir, filename);
        await page.screenshot({ path: filepath, fullPage: true });
        console.log(`  [Playwright] スクショ: ${filename}`);
        return filepath;
    } catch (e) { return null; }
}

// ================================================================
// ★ ナビゲーション耐性ラッパー
// ================================================================
async function waitForPageStable(page, label = '') {
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
    } catch (e) {
        console.log(`  [Playwright] 安定化待ち (${label}): ${e.message}`);
    }
}

// page.evaluate を安全に実行（ナビゲーションエラー時にリトライ）
async function safeEvaluate(page, fn, arg, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await waitForPageStable(page, `evaluate-retry-${i}`);
            return await page.evaluate(fn, arg);
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('Execution context was destroyed') ||
                msg.includes('Target closed') ||
                msg.includes('Navigation')) {
                console.log(`  [Playwright] ⚠️ ナビゲーション検出 → リトライ (${i + 1}/${maxRetries})`);
                await page.waitForTimeout(2000);
                continue;
            }
            throw e;
        }
    }
    throw new Error(`safeEvaluate: ${maxRetries}回リトライしても失敗`);
}

// frame.evaluate を安全に実行
async function safeFrameEvaluate(frame, fn, arg, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await frame.evaluate(fn, arg);
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('Execution context was destroyed') ||
                msg.includes('Target closed') ||
                msg.includes('Navigation')) {
                console.log(`  [Playwright] ⚠️ frameナビゲーション → リトライ (${i + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            throw e;
        }
    }
    return null;
}

// ================================================================
// 認証画面の状態を分析
// ================================================================
async function analyzeAuthState(page) {
    try {
        const analysis = await safeEvaluate(page, () => {
            const bodyText = document.body.textContent || '';
            const url = location.href;

            const visibleTexts = [];
            document.querySelectorAll('a, button, label, span, div, h1, h2, h3, p').forEach(el => {
                if (el.offsetParent === null) return;
                const t = (el.textContent || '').trim();
                if (t && t.length < 100) visibleTexts.push(t);
            });
            const allText = visibleTexts.join(' | ');

            const biometricKeywords = [
                'Salesforce Authenticator', 'モバイルアプリ',
                'セキュリティキー', 'Security Key', 'WebAuthn', 'U2F',
                'Lightning Login',
                '組み込み Authenticator', 'Built-in', 'Touch ID', 'Face ID', 'Windows Hello',
                '生体認証'
            ];
            const codeKeywords = [
                'ワンタイムパスワード', 'One-Time Password', 'TOTP',
                'メール確認コード', 'Email Code', 'SMS'
            ];

            const detectedBiometric = biometricKeywords.filter(k => allText.includes(k));
            const detectedCode = codeKeywords.filter(k => allText.includes(k));

            const codeInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input[type="password"]'))
                .filter(inp => inp.offsetParent !== null);
            const hasVisibleCodeInput = codeInputs.length > 0;

            const alternativeLinks = Array.from(document.querySelectorAll('a, button')).filter(el => {
                if (el.offsetParent === null) return false;
                const t = (el.textContent || '');
                return t.includes('別の検証方法') || t.includes('別の確認方法') ||
                       t.includes('Use a different') || t.includes('Choose Another') ||
                       t.includes('Try Another') || t.includes('Use another');
            });
            const hasAlternativeLink = alternativeLinks.length > 0;

            let state = 'unknown';
            if (hasVisibleCodeInput) {
                state = 'code_input';
            } else if (detectedBiometric.length + detectedCode.length >= 2) {
                state = 'method_selection';
            } else if (allText.includes('承認') || allText.includes('Approve') || allText.includes('プッシュ')) {
                state = 'push_pending';
            }

            return {
                state, url,
                hasBiometricMethods: detectedBiometric.length > 0,
                hasCodeMethods: detectedCode.length > 0,
                hasAlternativeLink,
                availableBiometric: detectedBiometric,
                availableCode: detectedCode,
                hasVisibleCodeInput,
                pageTextPreview: bodyText.substring(0, 200).replace(/\s+/g, ' ')
            };
        });

        return analysis;
    } catch (e) {
        return { state: 'unknown', error: e.message };
    }
}

// ================================================================
// クリック可能要素検索 & クリック（ナビゲーション耐性版）
// ================================================================
async function findAndClickByText(page, keywords, contextKeywords, userId, label, elementTypes) {
    elementTypes = elementTypes || ['a', 'button'];

    // ページが安定するまで待つ
    await waitForPageStable(page, `find-${label}`);

    const frames = page.frames();

    for (const frame of frames) {
        try {
            const result = await safeFrameEvaluate(frame, ({ kws, ctxKws, types }) => {
                const selector = types.join(',');
                const elements = Array.from(document.querySelectorAll(selector));
                const candidates = [];
                elements.forEach((el, idx) => {
                    const text = ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                    if (!text) return;
                    const matched = kws.some(k => text.includes(k));
                    if (!matched) return;

                    let ctxText = '';
                    let parent = el.parentElement;
                    for (let i = 0; i < 10 && parent; i++) {
                        ctxText = parent.textContent || '';
                        if (ctxKws.some(c => ctxText.includes(c))) break;
                        parent = parent.parentElement;
                    }
                    const isContextual = ctxKws.length === 0 || ctxKws.some(c => ctxText.includes(c));

                    candidates.push({
                        index: idx,
                        tag: el.tagName.toLowerCase(),
                        text: text.substring(0, 80),
                        isContextual,
                        visible: el.offsetParent !== null
                    });
                });
                return { total: elements.length, candidates };
            }, { kws: keywords, ctxKws: contextKeywords, types: elementTypes });

            if (!result) continue;

            console.log(`  [Playwright] [${label}] 候補=${result.candidates.length}件`);
            result.candidates.slice(0, 5).forEach((c, i) => {
                console.log(`  [Playwright]   候補${i + 1}: <${c.tag}> "${c.text.substring(0, 40)}" visible=${c.visible} ctx=${c.isContextual}`);
            });

            const best = result.candidates.find(c => c.isContextual && c.visible)
                       || result.candidates.find(c => c.visible)
                       || result.candidates[0];

            if (best) {
                console.log(`  [Playwright] [${label}] クリック: <${best.tag}> "${best.text.substring(0, 40)}"`);
                try {
                    await safeFrameEvaluate(frame, ({ idx, types }) => {
                        const els = document.querySelectorAll(types.join(','));
                        const el = els[idx];
                        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
                    }, { idx: best.index, types: elementTypes });
                } catch (e) {
                    console.log(`  [Playwright] [${label}] クリック失敗だが続行: ${e.message}`);
                }
                return { success: true, candidate: best };
            }
        } catch (e) {
            console.log(`  [Playwright] [${label}] フレームエラー: ${e.message}`);
        }
    }
    return { success: false };
}

async function findAndClickLink(page, keywords, contextKeywords, userId, label) {
    return findAndClickByText(page, keywords, contextKeywords, userId, label, ['a']);
}

// ================================================================
// 高保証セッション自動処理（v8: ナビゲーション耐性）
// ================================================================
async function handleHighAssuranceIfNeeded(page, userId, timeoutMs = 180000) {
    // ★ 重要: 高保証画面に到達後、十分に待ってから分析
    await waitForPageStable(page, 'HA-detect');

    const isHA = await safeEvaluate(page, () => {
        const url = location.href;
        const urlInd = ['/_ui/identity/verification', '/verifyidentity', '/identityverification', 'verifyEmail'];
        if (urlInd.some(p => url.includes(p))) return true;
        const text = (document.body.textContent || '').substring(0, 3000);
        return text.includes('ID を検証') ||
               text.includes('ユーザインターフェースで MFA を管理') ||
               text.includes('ユーザインターフェースでMFAを管理') ||
               text.includes('Identity Verification') ||
               text.includes('Verify Your Identity') ||
               text.includes('仮の確認コードを生成');
    }).catch(() => false);

    if (!isHA) return false;

    console.log('  [Playwright] ============================================');
    console.log('  [Playwright] 🔐 高保証セッションが必要です');
    console.log('  [Playwright] ============================================');
    await saveScreenshot(page, userId, 'high_assurance_detected');

    // ★ 分析前にもう一度安定化を待つ
    await page.waitForTimeout(2000);

    const analysis = await analyzeAuthState(page);
    console.log('  [Playwright] 📊 認証状態分析:');
    console.log(`  [Playwright]   画面状態: ${analysis.state}`);
    console.log(`  [Playwright]   生体認証: ${analysis.hasBiometricMethods} (${(analysis.availableBiometric || []).join(', ') || 'なし'})`);
    console.log(`  [Playwright]   コード認証: ${analysis.hasCodeMethods} (${(analysis.availableCode || []).join(', ') || 'なし'})`);
    console.log(`  [Playwright]   代替リンク: ${analysis.hasAlternativeLink}`);
    console.log(`  [Playwright]   コード入力欄: ${analysis.hasVisibleCodeInput}`);

    // 分岐
    if (analysis.state === 'push_pending') {
        console.log('  [Playwright] → プッシュ承認待ち');
        await waitForVerificationComplete(page, userId, timeoutMs);
        return true;
    }

    if (analysis.state === 'method_selection') {
        console.log('  [Playwright] → 検証方法選択 → 生体認証を選択');
        await selectBiometricMethod(page, userId);
        await waitForVerificationComplete(page, userId, timeoutMs);
        return true;
    }

    if (analysis.state === 'code_input' || analysis.state === 'unknown') {
        if (analysis.hasAlternativeLink) {
            console.log('  [Playwright] → 「別の検証方法」をクリックして切替');

            const altResult = await findAndClickByText(
                page,
                ['別の検証方法を使用してください', '別の検証方法', '別の確認方法', 'Use a different', 'Choose Another'],
                [], userId, '別の検証方法',
                ['a', 'button', 'span', 'div']
            );

            if (altResult.success) {
                // ★ クリック後の画面遷移を十分待つ
                console.log('  [Playwright] クリック後の画面遷移待機（3秒）...');
                await page.waitForTimeout(3000);
                await waitForPageStable(page, 'after-alt-click');

                await saveScreenshot(page, userId, 'method_selection_shown');

                const newAnalysis = await analyzeAuthState(page);
                console.log(`  [Playwright] 切替後の画面状態: ${newAnalysis.state}`);
                console.log(`  [Playwright]   生体認証: ${(newAnalysis.availableBiometric || []).join(', ') || 'なし'}`);

                if (newAnalysis.hasBiometricMethods) {
                    await selectBiometricMethod(page, userId);
                } else {
                    console.log('  [Playwright] ⚠️ 生体認証メソッドなし → 手動操作待機');
                }

                await waitForVerificationComplete(page, userId, timeoutMs);
                return true;
            }
        }

        // フォールバック
        console.log('  [Playwright] ============================================');
        console.log('  [Playwright] ★ ブラウザで以下のいずれかを実施してください：');
        console.log('  [Playwright]   ① 確認コードを手動入力');
        console.log('  [Playwright]   ② 「別の検証方法」リンクから別方式を選択');
        console.log(`  [Playwright] 最大 ${Math.round(timeoutMs / 1000)} 秒間待機...`);
        console.log('  [Playwright] ============================================');
        await waitForVerificationComplete(page, userId, timeoutMs);
        return true;
    }

    return true;
}

async function selectBiometricMethod(page, userId) {
    const priorities = [
        { name: 'Salesforce Authenticator', keywords: ['Salesforce Authenticator', 'モバイルアプリ'] },
        { name: 'セキュリティキー', keywords: ['セキュリティキー', 'Security Key', 'WebAuthn', 'U2F'] },
        { name: 'Lightning Login', keywords: ['Lightning Login'] },
        { name: '組み込み Authenticator', keywords: ['組み込み Authenticator', 'Built-in', 'Touch ID', 'Face ID', 'Windows Hello'] }
    ];

    for (const m of priorities) {
        const r = await findAndClickByText(
            page, m.keywords, [], userId, `選択(${m.name})`,
            ['a', 'button', 'span', 'div', 'label']
        );
        if (r.success) {
            console.log(`  [Playwright] ✅ ${m.name} を選択`);
            await page.waitForTimeout(2000);

            const nextBtn = await findAndClickByText(
                page, ['次へ', 'Next', '続行', 'Continue', '送信', 'Submit', '検証', 'Verify'],
                [], userId, '次へ',
                ['button', 'input']
            );
            if (nextBtn.success) {
                await page.waitForTimeout(2000);
            }

            console.log('  [Playwright] 📱 iPhone等で生体認証を承認してください');
            return true;
        }
    }
    console.log('  [Playwright] ⚠️ 生体認証メソッドの自動選択に失敗');
    return false;
}

async function waitForVerificationComplete(page, userId, timeoutMs) {
    try {
        await page.waitForFunction(
            () => {
                const url = location.href;
                const stillVerifying = url.includes('verification') ||
                                       url.includes('verifyidentity') ||
                                       url.includes('verifyEmail') ||
                                       url.includes('identityverification');
                const text = document.body.textContent || '';
                const hasUserDetail = text.includes('ユーザの詳細') ||
                                      text.includes('User Detail') ||
                                      text.includes('仮の確認コード') ||
                                      text.includes('Temporary Verification Code');
                return !stillVerifying && hasUserDetail;
            },
            { timeout: timeoutMs, polling: 2000 }
        );
        console.log('  [Playwright] ✅ 高保証セッション取得完了');
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
    } catch (e) {
        await saveScreenshot(page, userId, 'verification_timeout');
        throw new Error('検証がタイムアウトしました');
    }
}

async function dumpAllLinks(page, userId) {
    try {
        const dumpData = await safeEvaluate(page, () => {
            const links = Array.from(document.querySelectorAll('a'));
            return links.map((a, idx) => ({
                idx, text: (a.textContent || '').trim().substring(0, 100),
                href: (a.href || '').substring(0, 150),
                visible: a.offsetParent !== null
            })).filter(l => l.text.length > 0 && l.text.length < 50);
        });
        const logsDir = ensureLogsDir();
        const dumpFile = path.join(logsDir, `links_dump_${userId}_${Date.now()}.txt`);
        fs.writeFileSync(dumpFile, dumpData.map(l => `[${l.idx}] visible=${l.visible} "${l.text}" href="${l.href}"`).join('\n'), 'utf-8');
        console.log(`  [Playwright] リンクダンプ: ${path.basename(dumpFile)}`);
    } catch (e) {}
}

// ================================================================
// メイン関数
// ================================================================
async function generateMfaCodeViaUI(instanceUrl, accessToken, userId, expiresInHours) {
    const context = await getOrCreateContext();
    const page = await context.newPage();

    page.on('dialog', async dialog => {
        console.log(`  [Playwright] ダイアログ: ${dialog.message()}`);
        await dialog.accept();
    });

    let screenshotPath = null;

    try {
        const targetPath = `/${userId}?noredirect=1`;
        const frontdoorUrl = `${instanceUrl}/secur/frontdoor.jsp?sid=${encodeURIComponent(accessToken)}&retURL=${encodeURIComponent(targetPath)}`;

        console.log(`  [Playwright] === ユーザ ${userId} 処理開始 ===`);
        await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForPageStable(page, 'initial-load');

        if (page.url().includes('lightning.force.com')) {
            const classicUrl = `${instanceUrl}/${userId}?noredirect=1&isUserEntityOverride=1`;
            await page.goto(classicUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForPageStable(page, 'classic-switch');
        }

        await saveScreenshot(page, userId, 'debug_loaded');

        // 既存コードを期限切れに
        const expireResult = await findAndClickLink(
            page, ['今すぐ期限切れにする', 'Expire Now'], ['確認コード', 'Verification Code'],
            userId, '期限切れ'
        );
        if (expireResult.success) {
            await waitForPageStable(page, 'after-expire');
            await handleHighAssuranceIfNeeded(page, userId, 180000);
        }

        // [生成] をクリック
        const generateResult = await findAndClickLink(
            page, ['生成', 'Generate'], ['確認コード', 'Verification Code'],
            userId, '生成'
        );
        if (!generateResult.success) {
            await dumpAllLinks(page, userId);
            screenshotPath = await saveScreenshot(page, userId, 'no_generate_link');
            throw new Error('[生成]リンクが見つかりません');
        }

        // ★ クリック後にナビゲーションを十分に待つ
        await page.waitForTimeout(2000);
        await waitForPageStable(page, 'after-generate-click');

        const wasHA = await handleHighAssuranceIfNeeded(page, userId, 180000);

        if (wasHA) {
            console.log(`  [Playwright] 高保証取得後、ユーザ詳細に戻り再度 [生成]`);
            await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForPageStable(page, 'after-HA-reload');
            const regenResult = await findAndClickLink(
                page, ['生成', 'Generate'], ['確認コード', 'Verification Code'],
                userId, '生成(再)'
            );
            if (!regenResult.success) {
                screenshotPath = await saveScreenshot(page, userId, 'no_generate_after_ha');
                throw new Error('高保証取得後、[生成]リンクが見つかりません');
            }
            await waitForPageStable(page, 'after-regen-click');
        }

        await saveScreenshot(page, userId, 'debug_after_generate');

        // 有効期限入力
        const hoursInputSelectors = [
            'input[type="number"]', 'input[name*="hour" i]', 'input[name*="expir" i]',
            'input[id*="expir" i]', 'select[name*="hour" i]', 'select[name*="expir" i]'
        ];
        for (const sel of hoursInputSelectors) {
            try {
                const loc = page.locator(sel).first();
                await loc.waitFor({ state: 'visible', timeout: 2000 });
                const tagName = await loc.evaluate(el => el.tagName.toLowerCase());
                if (tagName === 'select') {
                    await loc.selectOption(String(expiresInHours)).catch(async () => {
                        await loc.selectOption({ label: String(expiresInHours) });
                    });
                } else {
                    await loc.fill(String(expiresInHours || 24));
                }
                console.log(`  [Playwright] 有効期限入力: ${expiresInHours}時間`);
                break;
            } catch (e) {}
        }

        // 確認ボタン
        const confirmBtnSelectors = [
            'input[type="button"][value*="生成"]', 'input[type="submit"][value*="生成"]',
            'input[type="button"][value*="Generate"]', 'input[type="submit"][value*="Generate"]',
            'button:has-text("コードを生成")', 'button:has-text("Generate Code")',
            'button:has-text("生成")', 'button:has-text("Generate")',
            'input[name="save"]', 'input[type="submit"]'
        ];
        for (const sel of confirmBtnSelectors) {
            try {
                const loc = page.locator(sel).last();
                await loc.waitFor({ state: 'visible', timeout: 2000 });
                await loc.click();
                console.log(`  [Playwright] 確認ボタンクリック`);
                await waitForPageStable(page, 'after-confirm');
                break;
            } catch (e) {}
        }

        // コード抽出
        await page.waitForTimeout(1500);
        await saveScreenshot(page, userId, 'debug_before_extract');

        const codeSelectors = [
            'td.dataCol b', 'td.dataCol strong', 'span.tempCode', 'div.tempCode',
            'b.bigText', '.slds-text-heading_large', 'td.data2Col b', 'td.data2Col strong',
            'td b', 'td strong'
        ];

        let code = null;
        for (const sel of codeSelectors) {
            try {
                const elements = await page.locator(sel).all();
                for (const el of elements) {
                    const text = ((await el.textContent()) || '').trim();
                    if (/^[A-Z0-9]{5,12}$/i.test(text)) {
                        code = text;
                        console.log(`  [Playwright] コード取得: ${code}`);
                        break;
                    }
                }
                if (code) break;
            } catch (e) {}
        }

        if (!code) {
            const bodyText = await page.locator('body').textContent();
            const patterns = [
                /確認コード[\s:：]*([A-Z0-9]{6,10})/i,
                /[Cc]ode[\s:：]*([A-Z0-9]{6,10})/,
                /\b([A-Z0-9]{8})\b/
            ];
            for (const re of patterns) {
                const m = bodyText.match(re);
                if (m) { code = m[1]; break; }
            }
        }

        if (!code) {
            screenshotPath = await saveScreenshot(page, userId, 'no_code_found');
            throw new Error('コードが取得できませんでした');
        }

        await saveScreenshot(page, userId, 'success');
        const expiresAt = new Date(Date.now() + (expiresInHours || 24) * 3600 * 1000).toISOString();
        console.log(`  [Playwright] === 完了: ${code} ===`);
        return { success: true, code, expiresAt };

    } catch (err) {
        if (!screenshotPath) screenshotPath = await saveScreenshot(page, userId, 'error');
        throw new Error(`${err.message}${screenshotPath ? ` (スクショ: ${path.basename(screenshotPath)})` : ''}`);
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { generateMfaCodeViaUI, shutdownBrowser, closeSharedContext, getBrowser };

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

// ════════════════════════════════════════════════════════════════════
// 永続セッション保存ファイルパス
// ────────────────────────────────────────────────────────────────────
// 一度高保証セッションをクリアすると、Cookie + localStorage を
// このファイルに保存し、次回起動時に復元することで
// Salesforce 側に「信頼デバイス」と認識させ、高保証スキップを狙う。
// ⚠️ 機密情報を含むため .gitignore 必須
// ════════════════════════════════════════════════════════════════════
const STORAGE_STATE_PATH = path.join(__dirname, '.playwright-storage.json');

async function getOrCreateContext() {
    // 既存コンテキストが生きていればそれを返す
    if (sharedContext) {
        try { sharedContext.pages(); return sharedContext; }
        catch (e) { sharedContext = null; }
    }
    if (sharedContextPromise) return sharedContextPromise;

    const browser = await getBrowser();

    // ─── コンテキスト作成オプション ───
    const contextOptions = {
        viewport: { width: 1366, height: 900 },
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo'
    };

    // ★ 永続セッションファイルがあれば復元 (信頼デバイス扱いを狙う)
    if (fs.existsSync(STORAGE_STATE_PATH)) {
        try {
            contextOptions.storageState = STORAGE_STATE_PATH;
            console.log(`  [Playwright] 既存セッション復元: ${path.basename(STORAGE_STATE_PATH)}`);
        } catch (e) {
            console.log(`  [Playwright] セッション復元失敗（無視）: ${e.message}`);
        }
    } else {
        console.log('  [Playwright] 永続セッションなし → 新規作成');
    }

    sharedContextPromise = browser.newContext(contextOptions).then(ctx => {
        sharedContext = ctx;
        sharedContextPromise = null;
        console.log('  [Playwright] 共有コンテキスト作成');
        return ctx;
    });
    return sharedContextPromise;
}

// ════════════════════════════════════════════════════════════════════
// 共有コンテキストの状態を永続化する
// ────────────────────────────────────────────────────────────────────
// コード取得成功後に呼び出し、Cookie + localStorage を保存する。
// 次回起動時、getOrCreateContext() がこれを読み込んで復元する。
// ════════════════════════════════════════════════════════════════════
async function saveContextState() {
    if (!sharedContext) return;
    try {
        await sharedContext.storageState({ path: STORAGE_STATE_PATH });
        console.log(`  [Playwright] セッション保存: ${path.basename(STORAGE_STATE_PATH)}`);
    } catch (e) {
        console.log(`  [Playwright] セッション保存失敗: ${e.message}`);
    }
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
// ════════════════════════════════════════════════════════════════════
// 高保証セッション（Identity Verification）処理
// ────────────────────────────────────────────────────────────────────
// Salesforce が管理者操作前に再認証を要求する画面を自動処理する。
// 状況に応じて分岐:
//   ・既にコード画面に到達 → スキップ
//   ・プッシュ承認待ち → 完了待機のみ
//   ・検証方法選択 → 生体認証を選択
//   ・コード入力／不明 → 「別の検証方法」を試行、ダメなら手動操作待機
// ════════════════════════════════════════════════════════════════════
async function handleHighAssuranceIfNeeded(page, userId, timeoutMs = 180000) {
    // ★ 高保証画面に到達後、十分に待ってから分析する
    await waitForPageStable(page, 'HA-detect');

    // ─── ⭐ 早期成功検出: 既に「仮のコード」結果画面が表示されている場合 ───
    // (前回のセッションが信頼デバイスとして扱われ、Salesforce が
    //  高保証をスキップしたケースに対応)
    try {
        const codeAlreadyShown = await page.locator('span[id$="successDisplay:code"]').count();
        if (codeAlreadyShown > 0) {
            console.log('  [Playwright] ✅ successDisplay:code を即検出 → 高保証セッション不要');
            return false;
        }
        // 「コードの生成」フォームが直接出ている場合も同様にスキップ
        const generateFormShown = await page.locator('[id$="generateDisplay"]').count();
        if (generateFormShown > 0) {
            console.log('  [Playwright] ✅ generateDisplay フォームを検出 → 高保証セッション不要');
            return false;
        }
    } catch {}

    // ─── 高保証画面に該当するかを判定 ───
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

    // ★ 認証状態を分析する前にもう一度安定化を待つ
    await page.waitForTimeout(2000);

    const analysis = await analyzeAuthState(page);
    console.log('  [Playwright] 📊 認証状態分析:');
    console.log(`  [Playwright]   画面状態: ${analysis.state}`);
    console.log(`  [Playwright]   生体認証: ${analysis.hasBiometricMethods} (${(analysis.availableBiometric || []).join(', ') || 'なし'})`);
    console.log(`  [Playwright]   コード認証: ${analysis.hasCodeMethods} (${(analysis.availableCode || []).join(', ') || 'なし'})`);
    console.log(`  [Playwright]   代替リンク: ${analysis.hasAlternativeLink}`);
    console.log(`  [Playwright]   コード入力欄: ${analysis.hasVisibleCodeInput}`);

    // ─── 状態別に分岐処理 ───

    // [分岐1] プッシュ承認待ち → 完了を待機
    if (analysis.state === 'push_pending') {
        console.log('  [Playwright] → プッシュ承認待ち');
        await waitForVerificationComplete(page, userId, timeoutMs);
        return true;
    }

    // [分岐2] 検証方法選択 → 生体認証を選択
    if (analysis.state === 'method_selection') {
        console.log('  [Playwright] → 検証方法選択 → 生体認証を選択');
        await selectBiometricMethod(page, userId);
        await waitForVerificationComplete(page, userId, timeoutMs);
        return true;
    }

    // [分岐3] コード入力 or 不明な状態
    if (analysis.state === 'code_input' || analysis.state === 'unknown') {
        // 「別の検証方法」リンクがあれば優先的にクリック
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

        // ─── ⭐ フォールバック: 手動操作待機 + 早期成功並行監視 ───
        // 「コードの生成」フォームや「仮のコード」結果画面が出現したら
        // 即座に成功とみなし、検証完了処理を打ち切る。
        // これにより、ユーザが手動で MFA を完了した瞬間に次のステップへ進める。
        console.log('  [Playwright] ============================================');
        console.log('  [Playwright] ★ ブラウザで以下のいずれかを実施してください：');
        console.log('  [Playwright]   ① 確認コードを手動入力');
        console.log('  [Playwright]   ② 「別の検証方法」リンクから別方式を選択');
        console.log(`  [Playwright] 最大 ${Math.round(timeoutMs / 1000)} 秒間待機...`);
        console.log('  [Playwright]   ※ 「コードの生成」または「仮のコード」画面に');
        console.log('  [Playwright]      到達した時点で自動的に次へ進みます');
        console.log('  [Playwright] ============================================');

        // 並行監視: 「結果画面/生成フォーム到達」 OR 「既存の検証完了判定」
        const earlySuccess = page.waitForSelector(
            'span[id$="successDisplay:code"], [id$="generateDisplay"], input[id$="generateButton"]',
            { timeout: timeoutMs, state: 'attached' }
        ).then(() => 'early-detected').catch(() => null);

        const normalComplete = waitForVerificationComplete(page, userId, timeoutMs)
            .then(() => 'verification-complete')
            .catch((e) => { throw e; });

        try {
            const winner = await Promise.race([earlySuccess, normalComplete]);
            if (winner === 'early-detected') {
                console.log('  [Playwright] ✅ コード生成フォーム/結果画面を検出 → 高保証完了とみなす');
            } else {
                console.log('  [Playwright] ✅ 検証完了を検出');
            }
        } catch (e) {
            // どちらも失敗した場合 → 元のエラーを投げる
            throw e;
        }
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

// ════════════════════════════════════════════════════════════════════
// 検証完了を待機する
// ────────────────────────────────────────────────────────────────────
// 完了条件 (どれか1つでも満たせば成功とみなす):
//   ①「仮のコード」結果画面に到達 (span[id$="successDisplay:code"])
//   ②「コードの生成」入力フォームに到達 (id$="generateDisplay")
//   ③ URL から検証系パスが消え、かつユーザ詳細／一時コード関連の
//     文言がページに現れる
// ════════════════════════════════════════════════════════════════════
async function waitForVerificationComplete(page, userId, timeoutMs) {
    try {
        await page.waitForFunction(
            () => {
                // ─── ① 結果画面に直接到達した場合 (最速ルート) ───
                if (document.querySelector('span[id$="successDisplay:code"]')) {
                    return true;
                }

                // ─── ② コード生成フォーム画面に到達した場合 ───
                //    (高保証クリア後、有効期限選択フォームが出ている状態)
                if (document.querySelector('[id$="generateDisplay"]') ||
                    document.querySelector('input[id$="generateButton"]') ||
                    document.querySelector('[id$="generateDisplay:validFor"]')) {
                    return true;
                }

                // ─── ③ URL とテキストの組み合わせで判定 ───
                const url = location.href;
                const stillVerifying = url.includes('verification') ||
                                       url.includes('verifyidentity') ||
                                       url.includes('verifyEmail') ||
                                       url.includes('identityverification');
                const text = document.body.textContent || '';
                const hasResultKeyword = text.includes('ユーザの詳細') ||
                                         text.includes('User Detail') ||
                                         text.includes('仮の確認コード') ||
                                         text.includes('Temporary Verification Code') ||
                                         text.includes('仮のコード') ||           // ★ 追加: 実際のラベル
                                         text.includes('仮のコードを生成') ||       // ★ 追加: 実際のタイトル
                                         text.includes('ユーザー用に生成されたコード') || // ★ 追加: 実際のヘッダー
                                         text.includes('コードの有効期限はいつにしますか');  // ★ 追加: 生成フォームの文言

                return !stillVerifying && hasResultKeyword;
            },
            { timeout: timeoutMs, polling: 2000 }
        );

        console.log('  [Playwright] ✅ 高保証セッション取得完了');
        // ※ Visualforce + A4J.AJAX のため networkidle は当てにならないが
        //    念のため短時間だけ待機する
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
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
async function selectTempCodeExpiry(page, expiresInHours) {
    const hours = Number(expiresInHours || 8);
    const labelText = `${hours} 時間`;

    const radioByLabel = page.getByLabel(labelText);
    if (await radioByLabel.count() > 0) {
        await radioByLabel.check();
        console.log(`  [Playwright] 有効期限選択: ${labelText}`);
        return true;
    }

    const clicked = await page
        .locator(`text="${labelText}"`)
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);

    if (clicked) {
        console.log(`  [Playwright] 有効期限選択: ${labelText}`);
        return true;
    }

    console.log(`  [Playwright] ⚠️ 有効期限 ${labelText} を選択できません。デフォルトのまま続行`);
    return false;
}

async function handleVerifyIdentityIfShown(page, verificationCode) {
    if (!verificationCode) {
        console.log('  [Playwright] ⚠️ 確認コード未設定のため、自動入力をスキップ');
        return false;
    }

    const isVerifyPage = await page.locator('body').textContent({ timeout: 5000 })
        .then(text => text.includes('ID を検証') || text.includes('確認コード'))
        .catch(() => false);

    if (!isVerifyPage) {
        return false;
    }

    const codeInput = page.locator(
        'input[type="text"], input[type="tel"], input[type="password"]'
    ).first();

    const visible = await codeInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) {
        return false;
    }

    console.log('  [Playwright] 🔐 ID検証画面を検出 → 確認コードを自動入力');

    await codeInput.fill(verificationCode);

    const clicked = await page.getByRole('button', { name: /検証|Verify/ })
        .click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);

    if (!clicked) {
        await page.locator('input[type="submit"], input[type="button"], button')
            .filter({ hasText: /検証|Verify/ })
            .first()
            .click({ timeout: 5000 });
    }

    await page.waitForTimeout(3000);
    await waitForPageStable(page, 'after-auto-verify-code');

    return true;
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
        // ★ [生成]クリック後に ID 検証画面が出た場合、確認コードを自動入力
        await handleVerifyIdentityIfShown(
            page,
            process.env.SF_TEMP_VERIFICATION_CODE
        );
        const wasHA = await handleHighAssuranceIfNeeded(page, userId, 180000);

        if (wasHA) {
            const alreadyOnGeneratePage = await page.locator(
                'input[id$="generateDisplay:generateButton"], [id$="generateDisplay"]'
            ).count();

            const alreadyHasCode = await page.locator(
                'span[id$="successDisplay:code"]'
            ).count();

            if (alreadyOnGeneratePage === 0 && alreadyHasCode === 0) {
                console.log(`  [Playwright] 高保証後、生成画面ではないためユーザ詳細に戻る`);

                await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await waitForPageStable(page, 'after-HA-reload');

                const regenResult = await findAndClickByText(
                    page,
                    ['生成', 'Generate'],
                    ['確認コード', '仮の確認コード', 'Verification Code'],
                    userId,
                    '生成(再)',
                    ['a', 'button', 'input']
                );

                if (!regenResult.success) {
                    screenshotPath = await saveScreenshot(page, userId, 'no_generate_after_ha');
                    throw new Error('高保証取得後、[生成]リンクが見つかりません');
                }

                await waitForPageStable(page, 'after-regen-click');
            } else {
                console.log(`  [Playwright] 高保証後、既に生成画面/結果画面に到達済み`);
            }
        }

        await saveScreenshot(page, userId, 'debug_after_generate');

        // 有効期限入力
        await selectTempCodeExpiry(page, expiresInHours);

        // ════════════════════════════════════════════════════════════════════
        // 「コードの生成」ボタンクリック処理
        // ────────────────────────────────────────────────────────────────────
        // 実DOM: <input id="thePage:j_id2:generateDisplay:generateButton"
        //               value="コードの生成"
        //               onclick="A4J.AJAX.Submit(...)" />
        //
        // このボタンは Ajax4jsf (A4J.AJAX.Submit) を使用するため、
        // ・完全なナビゲーションが発生しない
        // ・networkidle / load イベントが当てにならない
        // そのため、明示的に successDisplay:code の出現を待機する。
        // ════════════════════════════════════════════════════════════════════
        const confirmBtnSelectors = [
            // ★ 最優先: 実DOMに基づく確実なセレクタ
            'input[id$="generateDisplay:generateButton"]',
            'input[id$="generateButton"][value="コードの生成"]',
            'input[type="button"][value="コードの生成"]',
            // フォールバック (UIバリエーション対応)
            'input[type="button"][value*="コード"][value*="生成"]',
            'input[type="submit"][value*="コード"][value*="生成"]',
            'button:has-text("コードの生成")', 'button:has-text("コードを生成")',
            'input[type="button"][value*="Generate"]', 'input[type="submit"][value*="Generate"]',
            'button:has-text("Generate Code")', 'button:has-text("Generate")'
        ];

        let confirmClicked = false;
        for (const sel of confirmBtnSelectors) {
            try {
                const loc = page.locator(sel).first();
                await loc.waitFor({ state: 'visible', timeout: 2000 });
                await loc.click();
                console.log(`  [Playwright] 「コードの生成」クリック: ${sel}`);
                confirmClicked = true;
                break;
            } catch (e) {}
        }

        if (!confirmClicked) {
            console.log('  [Playwright] ⚠️ 「コードの生成」ボタンが見つかりません');
            await saveScreenshot(page, userId, 'confirm_button_not_found');
        }

        // ─── ★ AJAX 完了を待機: successDisplay:code が DOM に現れるまで ───
        // A4J.AJAX.Submit はサーバ応答後に DOM を差し替えるため、
        // 結果要素の出現を直接監視するのが最も確実。
        try {
            await page.waitForSelector('span[id$="successDisplay:code"]', {
                timeout: 60000,         // ★ 60秒: 高保証再認証が割り込む可能性も考慮
                state: 'attached'
            });
            console.log('  [Playwright] ✅ successDisplay:code の出現を検出');
        } catch (e) {
            console.log(`  [Playwright] ⚠️ successDisplay:code 待機タイムアウト: ${e.message}`);
            // ※ ここで throw せず、後続の抽出ロジックに任せる
            //   (Strategy 2〜4 のフォールバックで救える可能性があるため)
        }

        // ─── 高保証セッションが再度割り込んでくる可能性に備える ───
        // 「[生成]」リンクで HA が出なかった場合でも、
        // 「コードの生成」ボタン押下時に HA が出るケースがある。
        await handleHighAssuranceIfNeeded(page, userId).catch(() => {});

        // ════════════════════════════════════════════════════════════
        // ⑧ コード抽出 v3.1 — Multi-strategy (Visualforce Classic 対応)
        // 実際のDOM: <span id="thePage:j_id2:successDisplay:code">XXXXXXXX</span>
        // ════════════════════════════════════════════════════════════
        await page.waitForTimeout(1500);
        await saveScreenshot(page, userId, 'debug_before_extract');

        // 結果画面の出現を明示的に待つ（successDisplay:code が出るまで）
        try {
            await page.waitForSelector('span[id$="successDisplay:code"]', { timeout: 15000 });
        } catch (e) {
            console.log('  [Playwright] ⚠️ successDisplay:code が15秒以内に出現せず → フォールバックへ');
        }
        await waitForPageStable(page, 'before-extract');

        let code = null;
        let extractMethod = null;

        // ─── Strategy 1: ID suffix match（最も確実：実DOMから確認済み） ───
        try {
            const codeEl = page.locator('span[id$="successDisplay:code"]').first();
            if (await codeEl.count() > 0) {
                const txt = ((await codeEl.textContent({ timeout: 5000 })) || '').trim();
                if (/^[A-Z0-9]{6,12}$/i.test(txt)) {
                    code = txt;
                    extractMethod = 'strategy-1: id-suffix';
                }
            }
        } catch (e) {
            console.log(`  [Playwright] Strategy 1 skip: ${e.message}`);
        }

        // ─── Strategy 2: <span class="label">仮のコード</span> の次の要素を読む ───
        if (!code) {
            try {
                const txt = await safeEvaluate(page, () => {
                    const labels = [...document.querySelectorAll('span.label, span, label, dt')];
                    for (const lbl of labels) {
                        const t = (lbl.textContent || '').trim();
                        if (t === '仮のコード' || t === '確認コード' || /Temporary Code/i.test(t)) {
                            let node = lbl.nextSibling;
                            while (node) {
                                const v = (node.textContent || '').trim();
                                if (/^[A-Z0-9]{6,12}$/i.test(v)) return v;
                                node = node.nextSibling;
                            }
                        }
                    }
                    return null;
                });
                if (txt) {
                    code = txt;
                    extractMethod = 'strategy-2: label-sibling';
                }
            } catch (e) {
                console.log(`  [Playwright] Strategy 2 skip: ${e.message}`);
            }
        }

        // ─── Strategy 3: CSS セレクタ配列（Lightning / 旧UI フォールバック） ───
        if (!code) {
            const codeSelectors = [
                'span[id*="successDisplay"][id$="code"]',
                '.slds-form-element__static',
                'lightning-formatted-text',
                'td.dataCol b', 'td.dataCol strong',
                'td.data2Col b', 'td.data2Col strong',
                'td b', 'td strong',
                'span.tempCode', 'div.tempCode',
                'b.bigText', '.slds-text-heading_large'
            ];
            for (const sel of codeSelectors) {
                try {
                    const elements = await page.locator(sel).all();
                    for (const el of elements) {
                        const text = ((await el.textContent()) || '').trim();
                        if (/^[A-Z0-9]{6,12}$/i.test(text)) {
                            code = text;
                            extractMethod = `strategy-3: ${sel}`;
                            break;
                        }
                    }
                    if (code) break;
                } catch (e) {}
            }
        }

        // ─── Strategy 4: ページ全体のテキストから正規表現マッチ（最終手段） ───
        if (!code) {
            try {
                const bodyText = await page.locator('body').textContent();
                const patterns = [
                    /仮のコード[\s\n:：]+([A-Z0-9]{6,12})\b/i,
                    /確認コード[\s\n:：]+([A-Z0-9]{6,12})\b/i,
                    /[Tt]emporary\s*[Cc]ode[\s\n:：]+([A-Z0-9]{6,12})\b/i,
                    /\b([A-Z0-9]{10})\b/
                ];
                for (const re of patterns) {
                    const m = bodyText.match(re);
                    if (m) {
                        code = m[1];
                        extractMethod = `strategy-4: regex`;
                        break;
                    }
                }
            } catch (e) {
                console.log(`  [Playwright] Strategy 4 skip: ${e.message}`);
            }
        }

        if (!code) {
            screenshotPath = await saveScreenshot(page, userId, 'no_code_found');
            // デバッグ用にHTMLも保存
            try {
                const html = await page.content();
                const dumpPath = path.join(ensureLogsDir(), `no_code_html_${userId}_${Date.now()}.html`);
                fs.writeFileSync(dumpPath, html, 'utf-8');
                console.log(`  [Playwright] HTMLダンプ: ${path.basename(dumpPath)}`);
            } catch {}
            throw new Error('コードが取得できませんでした');
        }

        console.log(`  [Playwright] ✅ コード取得: ${code} (${extractMethod})`);

        // ─── 有効期限を画面から実際に抽出（"2026/06/19 23:11" 形式） ───
        let expiresAt = null;
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
                    }
                }
                return null;
            });
            if (expiryText) {
                // "2026/06/19 23:11" を ISO 文字列に変換（JSTとして扱う）
                const m = expiryText.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
                if (m) {
                    const [, Y, M, D, h, mi] = m;
                    // JST (+09:00) として ISO 化
                    expiresAt = `${Y}-${M.padStart(2,'0')}-${D.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:00+09:00`;
                    console.log(`  [Playwright] ✅ 有効期限(画面): ${expiryText} → ${expiresAt}`);
                }
            }
        } catch (e) {
            console.log(`  [Playwright] 有効期限抽出失敗: ${e.message}`);
        }

        // 画面から取れなかった場合は計算値を使用（フォールバック）
        if (!expiresAt) {
            expiresAt = new Date(Date.now() + (expiresInHours || 24) * 3600 * 1000).toISOString();
            console.log(`  [Playwright] ⚠️ 有効期限は計算値: ${expiresAt}`);
        }

        await saveScreenshot(page, userId, 'success');
        console.log(`  [Playwright] === 完了: ${code} ===`);

        // ★ 成功時にセッション状態を保存（次回の高保証スキップを狙う）
        await saveContextState();

        return { success: true, code, expiresAt };

    } catch (err) {
        if (!screenshotPath) screenshotPath = await saveScreenshot(page, userId, 'error');
        throw new Error(`${err.message}${screenshotPath ? ` (スクショ: ${path.basename(screenshotPath)})` : ''}`);
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { generateMfaCodeViaUI, shutdownBrowser, closeSharedContext, getBrowser };

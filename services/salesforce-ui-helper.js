// ================================================================
// salesforce-ui-helper.js
// Salesforce 画面操作のための DOM 解析・クリック・待機ユーティリティ
// ================================================================
const fs = require('fs');
const path = require('path');
const { ensureLogsDir } = require('./playwright-browser');

async function waitForPageStable(page, label = '') {
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
    } catch (e) {
        console.log(`  [Playwright] 安定化待ち (${label}): ${e.message}`);
    }
}

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

async function findAndClickByText(page, keywords, contextKeywords, userId, label, elementTypes) {
    elementTypes = elementTypes || ['a', 'button'];
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

module.exports = {
    waitForPageStable,
    safeEvaluate,
    safeFrameEvaluate,
    analyzeAuthState,
    findAndClickByText,
    findAndClickLink,
    dumpAllLinks,
};

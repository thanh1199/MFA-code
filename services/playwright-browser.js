// ================================================================
// playwright-browser.js
// Playwright browser / context / session management
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

module.exports = {
    ensureLogsDir,
    getBrowser,
    getOrCreateContext,
    saveContextState,
    closeSharedContext,
    shutdownBrowser,
    saveScreenshot,
};
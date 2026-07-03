// ================================================================
// playwright-browser.js
// Playwright browser / context / session management
// (PLAYWRIGHT_HEADLESS 対応)
// ================================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let browserInstance = null;
let browserPromise = null;
let sharedContext = null;
let sharedContextPromise = null;

function ensureLogsDir() {
    const dir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function isHeadless() {
    return String(process.env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase() === 'true';
}

async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) return browserInstance;
    if (browserPromise) return browserPromise;
    const headless = isHeadless();
    console.log(`  [Playwright] ブラウザ起動 (headless=${headless})`);
    browserPromise = chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    }).then(b => { browserInstance = b; browserPromise = null; return b; });
    return browserPromise;
}

const STORAGE_STATE_PATH = path.join(__dirname, '.playwright-storage.json');

async function getOrCreateContext() {
    if (sharedContext) {
        try { sharedContext.pages(); return sharedContext; }
        catch (e) { sharedContext = null; }
    }
    if (sharedContextPromise) return sharedContextPromise;
    const browser = await getBrowser();
    const contextOptions = {
        viewport: { width: 1366, height: 900 },
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo'
    };
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
async function resetBrowserSession() {

    await closeSharedContext();
    console.log(`  [Playwright] Shared Context Closed`);

    try {
        if (fs.existsSync(STORAGE_STATE_PATH)) {
            fs.unlinkSync(STORAGE_STATE_PATH);
            console.log(`  [Playwright] Deleted: ${path.basename(STORAGE_STATE_PATH)}`);
        } else {
            console.log(`  [Playwright] Storage file not found`);
        }
    } catch (e) {
        console.log(`  [Playwright] Delete failed: ${e.message}`);
    }
}
module.exports = {
    ensureLogsDir,
    getBrowser,
    getOrCreateContext,
    saveContextState,
    closeSharedContext,
    resetBrowserSession,
    shutdownBrowser,
    saveScreenshot,
    isHeadless
};

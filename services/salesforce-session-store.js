// ============================================================
// salesforce-session-store.js
// プロセス内 in-memory の Salesforce セッションストア
// スケジュールジョブと OAuth callback の両方から参照される
// オプション: runtime/session.json に永続化
// ============================================================
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const SESSION_PATH = path.join(RUNTIME_DIR, 'session.json');

let session = null;

function ensureRuntimeDir() {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function loadFromDisk() {
    try {
        if (fs.existsSync(SESSION_PATH)) {
            const raw = fs.readFileSync(SESSION_PATH, 'utf-8');
            session = JSON.parse(raw);
            return session;
        }
    } catch (e) {}
    return null;
}

function persist() {
    if (!session) return;
    try {
        ensureRuntimeDir();
        fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf-8');
    } catch (e) {
        // 永続化失敗は致命ではない
    }
}

function set(newSession) {
    session = Object.assign({}, session || {}, newSession, {
        connectedAt: newSession.connectedAt || new Date().toISOString()
    });
    persist();
    return session;
}

function get() {
    if (!session) loadFromDisk();
    return session;
}

function clear() {
    session = null;
    try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch (e) {}
}

function isValid() {
    const s = get();
    return !!(s && s.accessToken && s.instanceUrl);
}

module.exports = { set, get, clear, isValid, loadFromDisk };

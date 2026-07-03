// ============================================================
// oauth-pending-store.js
// 自動ログイン中の PKCE verifier を一時保管する singleton
// autoLoginSalesforce() と /oauth/callback の間で共有
// ============================================================
const pending = new Map();   // state -> { codeVerifier, loginUrl, code, resolve, reject, createdAt }

function register(state, data) {
    pending.set(state, { ...data, createdAt: Date.now() });
    // 自動 GC: 5分以上経過した entry を削除
    for (const [k, v] of pending.entries()) {
        if (Date.now() - v.createdAt > 5 * 60 * 1000) pending.delete(k);
    }
}

function get(state) {
    return pending.get(state) || null;
}

function resolveWithCode(state, code) {
    const entry = pending.get(state);
    if (!entry) return false;
    entry.code = code;
    if (entry.resolve) entry.resolve(code);
    return true;
}

function remove(state) {
    pending.delete(state);
}

module.exports = { register, get, resolveWithCode, remove };
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const SECRETS_PATH = path.join(RUNTIME_DIR, 'secrets.json');

const USER_KEYS = ['A', 'B'];

function ensureRuntimeDir() {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readSecrets() {
    try {
        if (!fs.existsSync(SECRETS_PATH)) return {};
        return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function writeSecrets(obj) {
    ensureRuntimeDir();
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
}

function isRotationEnabled() {
    return String(process.env.MFA_ROTATION_ENABLED || 'false').toLowerCase() === 'true';
}

function normalizeUserKey(key) {
    return String(key || '').trim().toUpperCase() === 'B' ? 'B' : 'A';
}

function getActiveLoginKey() {
    const secrets = readSecrets();
    return normalizeUserKey(secrets.activeLoginUser || process.env.MFA_ACTIVE_LOGIN_USER || 'A');
}

function getOppositeLoginKey(key) {
    return normalizeUserKey(key) === 'A' ? 'B' : 'A';
}

function getConfiguredUser(key) {
    const k = normalizeUserKey(key);
    return {
        key: k,
        username: (process.env[`SF_USER_${k}_NAME`] || '').trim(),
        password: process.env[`SF_USER_${k}_PASSWORD`] || '',
        seedCode: (process.env[`SF_USER_${k}_TEMP_VERIFICATION_CODE`] || '').trim()
    };
}

function getActiveLoginUser() {
    if (!isRotationEnabled()) {
        return {
            key: 'LEGACY',
            username: (process.env.SF_USER_NAME || '').trim(),
            password: process.env.SF_PASSWORD || ''
        };
    }
    return getConfiguredUser(getActiveLoginKey());
}

function getPartnerLoginUser() {
    const activeKey = getActiveLoginKey();
    return getConfiguredUser(getOppositeLoginKey(activeKey));
}

function getVerificationCode(userKey) {
    if (!isRotationEnabled()) {
        const secrets = readSecrets();
        if (secrets.currentTempVerificationCode) {
            const expiresAt = secrets.expiresAt ? new Date(secrets.expiresAt) : null;
            if (!expiresAt || expiresAt.getTime() > Date.now()) {
                return {
                    code: secrets.currentTempVerificationCode,
                    source: 'runtime'
                };
            }
        }

        const envCode = (process.env.SF_TEMP_VERIFICATION_CODE || '').trim();
        return envCode
            ? { code: envCode, source: 'env' }
            : { code: null, source: 'none' };
    }

    const key = normalizeUserKey(userKey || getActiveLoginKey());
    const secrets = readSecrets();
    const userSecret = secrets.users && secrets.users[key];

    if (userSecret && userSecret.currentTempVerificationCode) {
        const expiresAt = userSecret.expiresAt ? new Date(userSecret.expiresAt) : null;
        if (!expiresAt || expiresAt.getTime() > Date.now()) {
            return {
                code: userSecret.currentTempVerificationCode,
                source: `runtime_${key}`
            };
        }
    }

    const configured = getConfiguredUser(key);
    return configured.seedCode
        ? { code: configured.seedCode, source: `env_${key}` }
        : { code: null, source: 'none' };
}

function saveGeneratedCodeForUser(username, code, expiresAt) {
    const secrets = readSecrets();
    const users = secrets.users || {};

    for (const key of USER_KEYS) {
        const configured = getConfiguredUser(key);
        if (configured.username && configured.username === username) {
            users[key] = {
                username,
                currentTempVerificationCode: code,
                expiresAt: expiresAt || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                generatedAt: new Date().toISOString(),
                source: 'cross_generated'
            };
            writeSecrets({
                ...secrets,
                activeLoginUser: secrets.activeLoginUser || getActiveLoginKey(),
                users
            });
            return { saved: true, key };
        }
    }

    return { saved: false, key: null };
}

function switchActiveLoginUser(nextKey) {
    const secrets = readSecrets();
    writeSecrets({
        ...secrets,
        activeLoginUser: normalizeUserKey(nextKey),
        users: secrets.users || {}
    });
}

function saveSelfGeneratedCode(code, expiresAt) {
    const obj = {
        currentTempVerificationCode: code,
        expiresAt: expiresAt || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        generatedAt: new Date().toISOString(),
        source: 'self_generated'
    };
    writeSecrets(obj);
    return obj;
}

module.exports = {
    getVerificationCode,
    saveSelfGeneratedCode,
    saveGeneratedCodeForUser,
    getActiveLoginUser,
    getPartnerLoginUser,
    getActiveLoginKey,
    getOppositeLoginKey,
    switchActiveLoginUser,
    isRotationEnabled,
    readSecrets,
    writeSecrets,
    SECRETS_PATH
};
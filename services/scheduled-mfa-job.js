// ============================================================
// scheduled-mfa-job.js  v4.0 (Auto Mode)
// SCHEDULE_INTERVAL_HOURS 毎に対象ユーザの MFA コードを自動発番
//
// 重要:
//   ・"自分自身" = process.env.SF_USER_NAME (ログインユーザ)
//   ・自分自身のコード発番に成功したら runtime/secrets.json を更新
//     (次回サイクルの SF_TEMP_VERIFICATION_CODE seed として使用)
//   ・他ターゲットユーザのコードは絶対に runtime/secrets.json に保存しない
// ============================================================
const sessionStore = require('./salesforce-session-store');
const runtimeSecrets = require('./runtime-secrets');
const notification = require('./notification-service');
const { autoLoginSalesforce, createConnectionFromSession } = require('./salesforce-auto-login');
const { generateMfaCodeViaUI } = require('./mfa-code-generator');
const { resetBrowserSession } = require('./playwright-browser');

let timer = null;
let running = false;
const state = {
    schedulerEnabled: false,
    intervalHours: 23,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastSummary: null
};

function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`[${ts}] [scheduler] ${msg}`);
}

function getSelfUsername() {
    return runtimeSecrets.getActiveLoginUser().username;
}

function getPartnerUsername() {
    return runtimeSecrets.getPartnerLoginUser().username;
}

async function resetLoginSessionForNextUser(reason) {
    log(`セッションリセット開始: ${reason}`);

    sessionStore.clear();
    log(`runtime/session.json 削除完了`);

    await resetBrowserSession();

    log(`Playwright セッション削除完了`);

    const nextUser = runtimeSecrets.getActiveLoginUser();

    log(`次回ログイン担当: ${nextUser.key} (${nextUser.username})`);
}

async function ensureSession() {
    const activeUsername = getSelfUsername();

    if (sessionStore.isValid()) {
        const stored = sessionStore.get();

        if (activeUsername && stored.loginName && stored.loginName !== activeUsername) {
            log(`既存セッションのログインユーザ不一致: current=${stored.loginName}, expected=${activeUsername}`);
            await resetLoginSessionForNextUser('ログイン担当ユーザ切替');
        } else {
            try {
                const conn = createConnectionFromSession(stored);
                await conn.query('SELECT Id FROM Organization LIMIT 1');
                return sessionStore.get();
            } catch (e) {
                log(`既存セッションが無効 → 再ログイン: ${e.message}`);
                await resetLoginSessionForNextUser('既存セッション無効');
            }
        }
    }

    log('Salesforce に自動ログイン中...');
    return await autoLoginSalesforce();
}

async function resolveTargetUsers(conn) {
    const usernamesEnv = (process.env.SCHEDULE_TARGET_USERNAMES || '').trim();
    const whereEnv = (process.env.SCHEDULE_TARGET_WHERE || '').trim();
    const selfUsername = getSelfUsername();

    let soql = null;
    if (usernamesEnv) {
        const list = usernamesEnv.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) throw new Error('SCHEDULE_TARGET_USERNAMES が空です');
        const quoted = list.map(u => `'${u.replace(/'/g, "\\'")}'`).join(',');
        soql = `SELECT Id, Name, Username, Profile.Name FROM User WHERE IsActive = true AND Username IN (${quoted})`;
    } else if (whereEnv) {
        soql = `SELECT Id, Name, Username, Profile.Name FROM User WHERE ${whereEnv}`;
    } else {
        throw new Error('SCHEDULE_TARGET_USERNAMES または SCHEDULE_TARGET_WHERE のどちらかを設定してください');
    }
    log(`ターゲット SOQL: ${soql}`);
    const result = await conn.query(soql);
    let users = result.records.map(r => ({
        Id: r.Id,
        Name: r.Name,
        Username: r.Username,
        ProfileName: r.Profile ? r.Profile.Name : '',
        isSelf: r.Username === selfUsername
    }));

    // 自分自身を必ず最後尾に
    // (理由: 他ターゲットの発番が全て終わってから自分の seed を更新するため、
    //  途中で失敗しても他ユーザのコードは取得済みになる)
    if (selfUsername) {
        let self = users.find(u => u.Username === selfUsername);
        if (!self) {
            const selfQuery = await conn.query(
                `SELECT Id, Name, Username, Profile.Name FROM User WHERE Username = '${selfUsername.replace(/'/g, "\\'")}' LIMIT 1`
            );
            if (selfQuery.records.length > 0) {
                const r = selfQuery.records[0];
                self = {
                    Id: r.Id, Name: r.Name, Username: r.Username,
                    ProfileName: r.Profile ? r.Profile.Name : '',
                    isSelf: true
                };
                users.push(self);  // ← 末尾に追加
                log(`自分自身 (${selfUsername}) をターゲット末尾に追加`);
            } else {
                log(`⚠️ 自分自身 (${selfUsername}) が User テーブルに見つかりません`);
            }
        } else {
            // 末尾に移動
            users = [...users.filter(u => u.Id !== self.Id), self];
        }
    }

    // 重複除去
    const seen = new Set();
    users = users.filter(u => seen.has(u.Id) ? false : (seen.add(u.Id), true));

    const activeUsername = getSelfUsername();
    const partnerUsername = getPartnerUsername();

    // ログイン中ユーザは絶対に発番対象から除外
    users = users.filter(u => u.Username !== activeUsername);

    // 相方ユーザは必ず末尾に追加・移動
    if (runtimeSecrets.isRotationEnabled() && partnerUsername) {
        let partner = users.find(u => u.Username === partnerUsername);

        if (!partner) {
            const partnerQuery = await conn.query(
                `SELECT Id, Name, Username, Profile.Name FROM User WHERE Username = '${partnerUsername.replace(/'/g, "\\'")}' LIMIT 1`
            );

            if (partnerQuery.records.length > 0) {
                const r = partnerQuery.records[0];
                partner = {
                    Id: r.Id,
                    Name: r.Name,
                    Username: r.Username,
                    ProfileName: r.Profile ? r.Profile.Name : '',
                    isSelf: false,
                    isRotationPartner: true
                };
                users.push(partner);
                log(`相方ユーザ (${partnerUsername}) をターゲット末尾に追加`);
            } else {
                throw new Error(`相方ユーザ (${partnerUsername}) が User テーブルに見つかりません`);
            }
        } else {
            partner.isRotationPartner = true;
            users = [...users.filter(u => u.Id !== partner.Id), partner];
        }
    }
    return users;
}

async function runJobOnce() {
    if (running) {
        log('⚠️ 既に実行中のためスキップ');
        return { skipped: true };
    }
    running = true;
    const runAt = new Date().toISOString();
    const summary = {
        runAt,
        total: 0, success: 0, error: 0,
        selfUpdated: false,
        results: [],
        failedUsernames: []
    };
    try {
        log('=== スケジュールジョブ開始 ===');
        const session = await ensureSession();
        const conn = createConnectionFromSession(session);
        const users = await resolveTargetUsers(conn);
        summary.total = users.length;
        log(`対象ユーザ ${users.length} 名 (自分自身: ${getSelfUsername() || '未設定'})`);

        const expiresInHours = Number(process.env.MFA_CODE_EXPIRES_HOURS || 24);
        const selfUsername = getSelfUsername();

        for (let i = 0; i < users.length; i++) {
            const u = users[i];
            const selfTag = u.isSelf ? ' [SELF]' : '';
            log(`[${i+1}/${users.length}] ${u.Name} (${u.Username})${selfTag} コード発番中...`);
            try {
                const r = await generateMfaCodeViaUI(
                    session.instanceUrl, session.accessToken, u.Id, expiresInHours
                );
                summary.results.push({
                    userId: u.Id, name: u.Name, username: u.Username,
                    profileName: u.ProfileName,
                    code: r.code, expiresAt: r.expiresAt,
                    isSelf: u.isSelf,
                    status: 'Success'
                });
                summary.success++;
                log(`  ✅ 成功`);

                // ⭐ 自分自身の場合のみ runtime/secrets.json を更新
                if (runtimeSecrets.isRotationEnabled() && u.isRotationPartner) {
                    const saved = runtimeSecrets.saveGeneratedCodeForUser(u.Username, r.code, r.expiresAt);
                    if (saved.saved) {
                        summary.selfUpdated = true;
                        runtimeSecrets.switchActiveLoginUser(saved.key);
                        log(`  🔐 相方ユーザ ${saved.key} のコードを保存 → 次回ログイン担当を ${saved.key} に切替`);
                        await resetLoginSessionForNextUser(`次回ログイン担当=${saved.key}`);
                    }
                } else if (!runtimeSecrets.isRotationEnabled() && u.isSelf && selfUsername && u.Username === selfUsername) {
                    runtimeSecrets.saveSelfGeneratedCode(r.code, r.expiresAt);
                    summary.selfUpdated = true;
                    log(`  🔐 runtime/secrets.json を更新 (次回ログイン seed)`);
                }
            } catch (e) {
                summary.results.push({
                    userId: u.Id, name: u.Name, username: u.Username,
                    profileName: u.ProfileName,
                    code: null, expiresAt: null,
                    isSelf: u.isSelf,
                    status: `Error: ${e.message}`
                });
                summary.error++;
                summary.failedUsernames.push(u.Username);
                log(`  ⚠️ 失敗: ${e.message}`);
            }
        }

        log(`=== 完了: 成功=${summary.success} / 失敗=${summary.error} ===`);

        // 通知
        try {
            const notifResult = await notification.notify(summary);
            log(`通知結果: ${JSON.stringify(notifResult)}`);
        } catch (e) {
            log(`通知エラー (job 自体は継続): ${e.message}`);
        }

        state.lastRunAt = new Date().toISOString();
        state.lastResult = `成功=${summary.success}, 失敗=${summary.error}`;
        state.lastSummary = summary;
        if (timer) {
            state.nextRunAt = new Date(Date.now() + state.intervalHours * 3600 * 1000).toISOString();
        }
        return summary;
    } catch (err) {
        log(`❌ ジョブ全体エラー: ${err.message}`);
        state.lastRunAt = new Date().toISOString();
        state.lastResult = `ERROR: ${err.message}`;
        summary.error = summary.total;
        return summary;
    } finally {
        running = false;
    }
}

function startScheduledMfaJob() {
    const intervalHours = Number(process.env.SCHEDULE_INTERVAL_HOURS || 23);
    state.schedulerEnabled = true;
    state.intervalHours = intervalHours;
    const ms = intervalHours * 3600 * 1000;
    log(`スケジューラ起動: ${intervalHours} 時間ごとに実行`);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
        runJobOnce().catch(e => log(`定期実行エラー: ${e.message}`));
    }, ms);
    state.nextRunAt = new Date(Date.now() + ms).toISOString();
    // 起動直後にも 1 回実行
    setTimeout(() => {
        runJobOnce().catch(e => log(`初回実行エラー: ${e.message}`));
    }, 5000);
}

function stopScheduledMfaJob() {
    if (timer) { clearInterval(timer); timer = null; }
    state.schedulerEnabled = false;
    state.nextRunAt = null;
}

function getStatus() {
    return {
        schedulerEnabled: state.schedulerEnabled,
        intervalHours: state.intervalHours,
        running,
        lastRunAt: state.lastRunAt,
        nextRunAt: state.nextRunAt,
        lastResult: state.lastResult,
        salesforceConnected: sessionStore.isValid(),
        selfUsername: getSelfUsername() || null,
        session: sessionStore.isValid() ? {
            organizationName: sessionStore.get().organizationName,
            userName: sessionStore.get().userName,
            loginName: sessionStore.get().loginName
        } : null
    };
}

module.exports = { startScheduledMfaJob, stopScheduledMfaJob, runJobOnce, getStatus };

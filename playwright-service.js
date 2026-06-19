const { generateMfaCodeViaUI } = require('./services/mfa-code-generator');
const { shutdownBrowser } = require('./services/playwright-browser');

module.exports = {
    generateMfaCodeViaUI,
    shutdownBrowser
};
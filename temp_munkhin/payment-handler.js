const vscode = require('vscode');

// --- Constants ---
const PRO_STATE_KEY = 'auto-accept-isPro';
const TRIAL_START_KEY = 'auto-accept-trial-start';
const TRIAL_NOTIFIED_KEY = 'auto-accept-trial-notified';
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const LICENSE_API = 'https://auto-accept-backend.onrender.com/api';
const FREQ_STATE_KEY = 'auto-accept-frequency';

const STRIPE_LINKS = {
    MONTHLY: 'https://buy.stripe.com/7sY00j3eN0Pt9f94549MY0v',
    LIFETIME: 'https://buy.stripe.com/3cI3cv5mVaq3crlfNM9MY0u'
};

// --- State ---
let _context = null;
let _isPro = false;

// Background polling for delayed webhook
let _proPollingTimer = null;
let _proPollingAttempts = 0;
const MAX_PRO_POLLING_ATTEMPTS = 24; // 2 minutes (5s intervals)

// --- Trial Expiration Check ---
function checkTrialExpiration() {
    if (!_context || _isPro) return; // Already pro, no need to notify

    const trialStart = _context.globalState.get(TRIAL_START_KEY);
    const hasNotified = _context.globalState.get(TRIAL_NOTIFIED_KEY, false);

    // Trial exists, is expired, and we haven't notified yet
    if (trialStart && !isTrialActive() && !hasNotified) {
        // Mark as notified
        _context.globalState.update(TRIAL_NOTIFIED_KEY, true);

        // Show expiration notification
        vscode.window.showInformationMessage(
            'Your 3-day Pro trial has ended. Basic auto-accept still works! Upgrade to unlock background mode, custom frequency, and more.',
            'View Plans',
            'Dismiss'
        ).then(choice => {
            if (choice === 'View Plans') {
                vscode.commands.executeCommand('auto-accept.openSettings');
            }
        });
    }
}

// --- Init ---
function init(context) {
    _context = context;
    _isPro = context.globalState.get(PRO_STATE_KEY, false);

    // Check if trial just expired
    checkTrialExpiration();
}

// --- State Queries ---
function isPro() {
    return _isPro;
}

function isTrialActive() {
    if (!_context) return false;
    const trialStart = _context.globalState.get(TRIAL_START_KEY);
    if (!trialStart) return false;
    return (Date.now() - trialStart) < TRIAL_DURATION_MS;
}

function hasTrialStarted() {
    if (!_context) return false;
    return _context.globalState.get(TRIAL_START_KEY) !== undefined;
}

function hasProAccess() {
    return _isPro || isTrialActive();
}

function getTrialDaysLeft() {
    if (!_context) return 0;
    const trialStart = _context.globalState.get(TRIAL_START_KEY);
    if (!trialStart) return 0;
    const remaining = TRIAL_DURATION_MS - (Date.now() - trialStart);
    return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

function getUserId() {
    if (!_context) return null;
    let userId = _context.globalState.get('auto-accept-userId');
    if (!userId) {
        userId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        _context.globalState.update('auto-accept-userId', userId);
    }
    return userId;
}

function isPlanRecurring() {
    if (!_context) return false;
    const plan = _context.globalState.get('auto-accept-plan', 'lifetime');
    return plan === 'monthly' || plan === 'pro';
}

function getPollFrequency() {
    if (!_context) return 300;
    if (hasProAccess()) {
        return _context.globalState.get(FREQ_STATE_KEY, 1000);
    }
    return 300;
}

// --- State Setters ---
function setProStatus(val) {
    _isPro = val;
    if (_context) {
        _context.globalState.update(PRO_STATE_KEY, val);
        // Reset trial notification flag when upgrading to pro
        if (val === true) {
            _context.globalState.update(TRIAL_NOTIFIED_KEY, false);
        }
    }
}

function startTrial() {
    if (_context) {
        _context.globalState.update(TRIAL_START_KEY, Date.now());
    }
}

// --- License Verification ---
function verifyLicense() {
    if (!_context) return Promise.resolve(false);
    const userId = _context.globalState.get('auto-accept-userId');
    if (!userId) return Promise.resolve(false);

    return new Promise((resolve) => {
        const https = require('https');
        https.get(`${LICENSE_API}/check-license?userId=${userId}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.plan && _context) {
                        _context.globalState.update('auto-accept-plan', json.plan);
                    }
                    const validPlans = ['lifetime', 'monthly'];
                    const isValidPlan = json.plan && validPlans.includes(json.plan.toLowerCase());
                    resolve(json.isPro === true && isValidPlan);
                } catch (e) {
                    resolve(false);
                }
            });
        }).on('error', () => resolve(false));
    });
}

function checkProStatus() {
    const userId = getUserId();
    if (!userId) return Promise.resolve(false);

    return new Promise((resolve) => {
        const https = require('https');
        https.get(`${LICENSE_API}/verify?userId=${userId}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.plan && _context) {
                        _context.globalState.update('auto-accept-plan', json.plan);
                    }
                    const validPlans = ['lifetime', 'monthly'];
                    const isValidPlan = json.plan && validPlans.includes(json.plan.toLowerCase());
                    resolve(json.isPro === true && isValidPlan);
                } catch (e) {
                    resolve(false);
                }
            });
        }).on('error', () => resolve(false));
    });
}

// --- Actions ---

// callbacks: { onProActivated, onProStatusChanged, log }
let _callbacks = {};

function setCallbacks(callbacks) {
    _callbacks = callbacks;
}

function _log(msg) {
    if (_callbacks.log) _callbacks.log(msg);
}

async function activatePro() {
    _log('Pro Activation: Starting verification process...');

    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Auto Accept: Verifying Pro status...',
            cancellable: false
        },
        async (progress) => {
            progress.report({ increment: 30 });
            await new Promise(resolve => setTimeout(resolve, 1500));
            progress.report({ increment: 30 });

            const isProNow = await verifyLicense();
            progress.report({ increment: 40 });

            if (isProNow) {
                _isPro = true;
                await _context.globalState.update(PRO_STATE_KEY, true);
                _context.globalState.update(FREQ_STATE_KEY, _context.globalState.get(FREQ_STATE_KEY, 1000));

                if (_callbacks.onProActivated) await _callbacks.onProActivated();

                _log('Pro Activation: SUCCESS - User is now Pro!');
                vscode.window.showInformationMessage(
                    'Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                    'Open Dashboard'
                ).then(choice => {
                    if (choice === 'Open Dashboard') {
                        vscode.commands.executeCommand('auto-accept.openSettings');
                    }
                });
            } else {
                _log('Pro Activation: License not found yet. Starting background polling...');
                startProPolling();
            }
        }
    );
}

function startProPolling() {
    if (_proPollingTimer) clearInterval(_proPollingTimer);

    _proPollingAttempts = 0;
    _log('Pro Polling: Starting background verification (checking every 5s for up to 2 minutes)...');

    vscode.window.showInformationMessage(
        'Payment received! Verifying your Pro status... This may take a moment.'
    );

    _proPollingTimer = setInterval(async () => {
        _proPollingAttempts++;
        _log(`Pro Polling: Attempt ${_proPollingAttempts}/${MAX_PRO_POLLING_ATTEMPTS}`);

        if (_proPollingAttempts > MAX_PRO_POLLING_ATTEMPTS) {
            clearInterval(_proPollingTimer);
            _proPollingTimer = null;
            _log('Pro Polling: Max attempts reached.');
            vscode.window.showWarningMessage(
                'Pro verification is taking longer than expected. Please click "Check Pro Status" in settings, or contact support if the issue persists.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    vscode.commands.executeCommand('auto-accept.openSettings');
                }
            });
            return;
        }

        const isProNow = await verifyLicense();
        if (isProNow) {
            clearInterval(_proPollingTimer);
            _proPollingTimer = null;

            _isPro = true;
            await _context.globalState.update(PRO_STATE_KEY, true);

            if (_callbacks.onProActivated) await _callbacks.onProActivated();

            _log('Pro Polling: SUCCESS - Pro status confirmed!');
            vscode.window.showInformationMessage(
                'Pro Activated! Thank you for your support. All Pro features are now unlocked.',
                'Open Dashboard'
            ).then(choice => {
                if (choice === 'Open Dashboard') {
                    vscode.commands.executeCommand('auto-accept.openSettings');
                }
            });
        }
    }, 5000);
}

async function cancelSubscription() {
    const userId = getUserId();

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Processing cancellation request...',
            cancellable: false
        },
        async () => {
            try {
                const https = require('https');
                const postData = JSON.stringify({ userId });

                const options = {
                    hostname: 'auto-accept-backend.onrender.com',
                    path: '/api/cancel-subscription',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                };

                const result = await new Promise((resolve, reject) => {
                    const req = https.request(options, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
                            } catch (e) {
                                resolve({ statusCode: res.statusCode, data: {} });
                            }
                        });
                    });
                    req.on('error', reject);
                    req.write(postData);
                    req.end();
                });

                if (result.statusCode === 200) {
                    vscode.window.showInformationMessage(
                        'Subscription cancelled. You will retain Pro access until the end of your billing period.',
                        'OK'
                    );
                } else {
                    vscode.window.showErrorMessage(
                        'Failed to cancel subscription. Please contact support or manage your subscription via Stripe customer portal.',
                        'Contact Support'
                    ).then(selection => {
                        if (selection === 'Contact Support') {
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/MunKhin/auto-accept-agent/issues'));
                        }
                    });
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    'Network error. Please try again or contact support.',
                    'OK'
                );
            }
        }
    );
}

module.exports = {
    // Constants
    STRIPE_LINKS,
    FREQ_STATE_KEY,
    PRO_STATE_KEY,
    TRIAL_START_KEY,

    // Init
    init,
    setCallbacks,

    // State queries
    isPro,
    isTrialActive,
    hasTrialStarted,
    hasProAccess,
    getTrialDaysLeft,
    getUserId,
    isPlanRecurring,
    getPollFrequency,

    // Actions
    verifyLicense,
    activatePro,
    startProPolling,
    cancelSubscription,
    checkProStatus,
    startTrial,
    checkTrialExpiration,

    // State setters
    setProStatus,
};

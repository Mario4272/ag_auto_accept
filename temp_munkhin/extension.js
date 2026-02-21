const vscode = require('vscode');
const path = require('path');
const payment = require('./payment-handler');

// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// states

const GLOBAL_STATE_KEY = 'auto-accept-enabled-global';
const BANNED_COMMANDS_KEY = 'auto-accept-banned-commands';
// Locking
const LOCK_KEY = 'auto-accept-instance-lock';
const HEARTBEAT_KEY = 'auto-accept-instance-heartbeat';
const INSTANCE_ID = Math.random().toString(36).substring(7);

let isEnabled = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 2000; // Default for Free
let bannedCommands = []; // List of command patterns to block

// Background Mode state
let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = 'auto-accept-background-dont-show';
const BACKGROUND_MODE_KEY = 'auto-accept-background-mode';
const VERSION_7_0_KEY = 'auto-accept-version-7.0-notification-shown';
const VERSION_8_6_0_KEY = 'auto-accept-version-8.6-notification-shown';
const RELEASY_PROMO_KEY = 'auto-accept-releasy-promo-shown';

let pollTimer;
let commandPollTimer;
let statusBarItem;
let statusSettingsItem;
let statusBackgroundItem; // New: Background Mode toggle
let outputChannel;
let currentIDE = 'unknown'; // 'cursor' | 'antigravity'
let globalContext;

// Command-based auto-accept (IDE native)
const ACCEPT_COMMANDS_ANTIGRAVITY = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.terminalSuggestion.accept'
];

const ACCEPT_COMMANDS_CURSOR = [
    'cursorai.action.acceptAndRunGenerateInTerminal',
    'cursorai.action.acceptGenerateInTerminal'
];

function getAcceptCommandsForIDE() {
    const ide = (currentIDE || '').toLowerCase();
    if (ide === 'antigravity') return ACCEPT_COMMANDS_ANTIGRAVITY;
    if (ide === 'cursor') return ACCEPT_COMMANDS_CURSOR;
    return [];
}

async function executeAcceptCommandsForIDE() {
    const commands = getAcceptCommandsForIDE();
    if (commands.length === 0) return;
    await Promise.allSettled(commands.map(cmd => vscode.commands.executeCommand(cmd)));
}

// Handlers (used by both IDEs now)
let cdpHandler;
let relauncher;

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // only supporting these 3 for now
}

async function activate(context) {
    globalContext = context;
    console.log('Auto Accept Extension: Activator called.');

    // Initialize payment handler
    payment.init(context);
    payment.setCallbacks({
        log,
        onProActivated: async () => {
            // Update CDP handler if running
            if (cdpHandler && cdpHandler.setProStatus) {
                cdpHandler.setProStatus(true);
            }

            pollFrequency = payment.getPollFrequency();

            // Sync sessions with new pro status
            if (isEnabled) {
                await syncSessions();
            }

            updateStatusBar();
            await handlePaidActivation(context);
        }
    });

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-accept.toggle';
        statusBarItem.text = '$(sync~spin) Auto Accept: Loading...';
        statusBarItem.tooltip = 'Auto Accept is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'auto-accept.openSettings';
        statusSettingsItem.text = '$(gear)';
        statusSettingsItem.tooltip = 'Auto Accept Settings & Pro Features';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Background Mode status bar item
        statusBackgroundItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        statusBackgroundItem.command = 'auto-accept.toggleBackground';
        statusBackgroundItem.text = '$(globe) Background: OFF';
        statusBackgroundItem.tooltip = 'Background Mode (Pro) - Works on all chats';
        context.subscriptions.push(statusBackgroundItem);
        // Don't show by default - only when Auto Accept is ON

        console.log('Auto Accept: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);

        // Load frequency - Pro/trial users get custom, free users get 300ms
        pollFrequency = payment.getPollFrequency();

        // Load background mode state
        backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.globalState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);


        // 1.5 Verify License Background Check
        payment.verifyLicense().then(isValid => {
            if (payment.isPro() !== isValid) {
                payment.setProStatus(isValid);
                log(`License re-verification: Updated Pro status to ${isValid}`);

                if (cdpHandler && cdpHandler.setProStatus) {
                    cdpHandler.setProStatus(isValid);
                }

                if (!isValid && !payment.isTrialActive()) {
                    pollFrequency = 300; // Downgrade speed for non-trial free users
                }
                updateStatusBar();
            }
        });

        // 1.6 Periodic Trial Expiration Check (every hour)
        setInterval(() => {
            payment.checkTrialExpiration();
        }, 60 * 60 * 1000); // Check every hour

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Auto Accept');
        context.subscriptions.push(outputChannel);

        log(`Auto Accept: Activating...`);
        log(`Auto Accept: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - Both IDEs use CDP now
        try {
            const { CDPHandler } = require('./main_scripts/cdp-handler');
            const { Relauncher } = require('./main_scripts/relauncher');

            cdpHandler = new CDPHandler(log);
            relauncher = new Relauncher(log);
            log(`CDP handlers initialized for ${currentIDE}.`);
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Auto Accept Error: ${err.message}`);
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('auto-accept.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('auto-accept.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('auto-accept.toggleBackground', () => handleBackgroundToggle(context)),
            vscode.commands.registerCommand('auto-accept.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('auto-accept.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('auto-accept.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('auto-accept.activatePro', () => payment.activatePro()),
            vscode.commands.registerCommand('auto-accept.onPaid', () => handlePaidActivation(context))
        );

        // 6. Register URI Handler for deep links (e.g., from Stripe success page)
        const uriHandler = {
            handleUri(uri) {
                log(`URI Handler received: ${uri.toString()}`);
                if (uri.path === '/activate' || uri.path === 'activate') {
                    log('Activation URI detected - verifying pro status...');
                    payment.activatePro();
                }
            }
        };
        context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
        log('URI Handler registered for activation deep links.');

        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        // 8. Show Version 5.0 Notification (Once)
        showVersionNotification(context);

        // 9. Show Releasy AI Cross-Promo (Once, after first session)
        showReleasyCrossPromo(context);

        log('Auto Accept: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Auto Accept Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    log('Checking for active CDP session...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        log('CDP is active and available.');
        return true;
    } else {
        log('CDP not found on target ports (9000 +/- 3).');
        if (showPrompt && relauncher) {
            log('Initiating CDP setup flow...');
            await relauncher.ensureCDPAndRelaunch();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    if (isEnabled) {
        log('Initializing Auto Accept environment...');
        // Start polling immediately via commands, CDP connects in background
        await startPolling();
        ensureCDPOrPrompt(false); // non-blocking CDP attempt
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        // Auto-start trial on first toggle for free users
        if (!isEnabled && !payment.isPro() && !payment.hasTrialStarted()) {
            payment.startTrial();
            vscode.window.showInformationMessage(
                '3-day free trial activated! All Pro features are unlocked. Try Auto Accept out by prompting your agent as usual!',
                'Learn More'
            ).then(choice => {
                if (choice === 'Learn More') {
                    vscode.commands.executeCommand('auto-accept.openSettings');
                }
            });
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Auto Accept: Enabled');
            // Start command polling immediately, CDP connects in background
            startPolling();
            ensureCDPOrPrompt(false); // non-blocking CDP attempt
        } else {
            log('Auto Accept: Disabled');
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handlePaidActivation(context) {
    if (!payment.isPro()) {
        log('handlePaidActivation called but Pro not verified.');
        return;
    }
    log('Paid activation confirmed. Starting CDP setup...');
    await ensureCDPOrPrompt(true);
    if (isEnabled) {
        await startPolling();
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }
    if (!payment.hasProAccess()) {
        const panel = getSettingsPanel();
        if (panel) {
            panel.showUpgradePrompt(globalContext, currentIDE);
        } else {
            vscode.window.showInformationMessage(
                'Upgrade to Pro to unlock Background Mode and browser-based auto-accept.',
                'Upgrade'
            ).then(choice => {
                if (choice === 'Upgrade') {
                    vscode.commands.executeCommand('auto-accept.openSettings');
                }
            });
        }
        return;
    }

    log('Initiating CDP Setup flow...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    if (!payment.hasProAccess()) {
        log('Custom frequency requires Pro');
        return;
    }
    pollFrequency = freq;
    await context.globalState.update(payment.FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
        if (commandPollTimer) {
            clearInterval(commandPollTimer);
        }
        commandPollTimer = setInterval(() => {
            if (!isEnabled) return;
            executeAcceptCommandsForIDE().catch(() => { });
        }, pollFrequency);
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    if (!payment.hasProAccess()) {
        log('Banned commands customization requires Pro');
        return;
    }
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBackgroundToggle(context) {
    log('Background toggle clicked');

    if (!payment.hasProAccess()) {
        vscode.window.showInformationMessage(
            'Background Mode is a Pro feature.',
            'Learn More'
        ).then(choice => {
            if (choice === 'Learn More') {
                const panel = getSettingsPanel();
                if (panel) panel.createOrShow(context.extensionUri, context);
            }
        });
        return;
    }

    // Pro tier: CDP required for Background Mode
    if (!backgroundModeEnabled) {
        const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;
        if (!cdpAvailable && relauncher) {
            log('Background Mode requires CDP. Prompting for setup...');
            await relauncher.ensureCDPAndRelaunch();
            return;
        }
    }

    // Check if we should show first-time dialog
    const dontShowAgain = context.globalState.get(BACKGROUND_DONT_SHOW_KEY, false);

    if (!dontShowAgain && !backgroundModeEnabled) {
        // First-time enabling: Show confirmation dialog
        const choice = await vscode.window.showInformationMessage(
            'Turn on Background Mode?\n\n' +
            'This lets Auto Accept work on all your open chats at once. ' +
            'It will switch between tabs to click Accept for you.\n\n' +
            'You might see tabs change quickly while it works.',
            { modal: true },
            'Enable',
            "Don't Show Again & Enable",
            'Cancel'
        );

        if (choice === 'Cancel' || !choice) {
            log('Background mode cancelled by user');
            return;
        }

        if (choice === "Don't Show Again & Enable") {
            await context.globalState.update(BACKGROUND_DONT_SHOW_KEY, true);
            log('Background mode: Dont show again set');
        }

        // Enable it
        backgroundModeEnabled = true;
        await context.globalState.update(BACKGROUND_MODE_KEY, true);
        log('Background mode enabled');
    } else {
        // Simple toggle
        backgroundModeEnabled = !backgroundModeEnabled;
        await context.globalState.update(BACKGROUND_MODE_KEY, backgroundModeEnabled);
        log(`Background mode toggled: ${backgroundModeEnabled}`);

        // If background mode is being turned OFF, stop background loops
        if (!backgroundModeEnabled && cdpHandler && isEnabled) {
            log('Background mode OFF: Stopping background loops...');

            // Stop current session and restart in simple mode
            await cdpHandler.stop();
            await syncSessions();
            log('Background mode OFF: Restarted in simple mode');
        } else if (backgroundModeEnabled && cdpHandler && isEnabled) {
            // Background mode turned ON - restart in background mode
            log('Background mode ON: Switching to background mode...');
            await syncSessions();
        }

        // Hide overlay if being disabled (redundant safety - cdp-handler also does this)
        if (!backgroundModeEnabled && cdpHandler) {
            cdpHandler.hideBackgroundOverlay().catch(() => { });
        }
    }

    // Update UI immediately
    updateStatusBar();
}



async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions (Mode: ${backgroundModeEnabled ? 'Background' : 'Simple'})...`);
        try {
            await cdpHandler.start({
                isPro: payment.hasProAccess(),
                isBackgroundMode: backgroundModeEnabled,
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (commandPollTimer) clearInterval(commandPollTimer);
    log('Auto Accept: Monitoring session...');

    // Initial trigger
    await syncSessions();
    await executeAcceptCommandsForIDE();

    // IDE command polling (accepts via native commands)
    // Free users get fixed 300ms; Pro/trial users get custom frequency
    commandPollTimer = setInterval(() => {
        if (!isEnabled) return;
        executeAcceptCommandsForIDE().catch(() => { });
    }, pollFrequency);

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // Check for instance locking - only the first extension instance should control CDP
        const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
        const activeInstance = globalContext.globalState.get(lockKey);
        const myId = globalContext.extension.id;

        if (activeInstance && activeInstance !== myId) {
            const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
            if (lastPing && (Date.now() - lastPing) < 15000) {
                if (!isLockedOut) {
                    log(`CDP Control: Locked by another instance (${activeInstance}). Standby mode.`);
                    isLockedOut = true;
                    updateStatusBar();
                }
                return;
            }
        }

        // We are the leader or lock is dead
        globalContext.globalState.update(lockKey, myId);
        globalContext.globalState.update(`${lockKey}-ping`, Date.now());

        if (isLockedOut) {
            log('CDP Control: Lock acquired. Resuming control.');
            isLockedOut = false;
            updateStatusBar();
        }

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (commandPollTimer) {
        clearInterval(commandPollTimer);
        commandPollTimer = null;
    }
    if (cdpHandler) await cdpHandler.stop();
    log('Auto Accept: Polling stopped');
}


// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `Auto Accept handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- BACKGROUND MODE UPSELL ---
// Called when free user switches tabs (could have been auto-handled)
async function showBackgroundModeUpsell(context) {
    if (payment.isPro()) return; // Already Pro, no upsell

    const UPSELL_COOLDOWN_KEY = 'auto-accept-bg-upsell-last';
    const UPSELL_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes between upsells

    const lastUpsell = context.globalState.get(UPSELL_COOLDOWN_KEY, 0);
    const now = Date.now();

    if (now - lastUpsell < UPSELL_COOLDOWN_MS) return; // Too soon

    await context.globalState.update(UPSELL_COOLDOWN_KEY, now);

    const choice = await vscode.window.showInformationMessage(
        `Auto Accept could've handled this tab switch automatically.`,
        { detail: 'Enable Background Mode to keep all your agents moving in parallel—no manual tab switching needed.' },
        'Enable Background Mode',
        'Not Now'
    );

    if (choice === 'Enable Background Mode') {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Auto Accept is running.`;
        let bgColor = undefined;
        let icon = '$(check)';

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += ' (CDP Connected)';
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '$(sync~spin)';
        }

        // Show trial countdown in status bar
        if (!payment.isPro() && payment.isTrialActive()) {
            const daysLeft = payment.getTrialDaysLeft();
            statusText += ` (Trial: ${daysLeft}d left)`;
            tooltip += ` | Pro Trial: ${daysLeft} day(s) remaining`;
        }

        statusBarItem.text = `${icon} Auto Accept: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

        // Show Background Mode toggle when Auto Accept is ON
        if (statusBackgroundItem) {
            if (backgroundModeEnabled) {
                statusBackgroundItem.text = '$(sync~spin) Background: ON';
                statusBackgroundItem.tooltip = 'Background Mode is on. Click to turn off.';
                statusBackgroundItem.backgroundColor = undefined;
            } else {
                statusBackgroundItem.text = '$(globe) Background: OFF';
                statusBackgroundItem.tooltip = 'Click to turn on Background Mode (works on all your chats).';
                statusBackgroundItem.backgroundColor = undefined;
            }
            statusBackgroundItem.show();
        }

    } else {
        statusBarItem.text = '$(circle-slash) Auto Accept: OFF';
        statusBarItem.tooltip = 'Click to enable Auto Accept.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

        // Hide Background Mode toggle when Auto Accept is OFF
        if (statusBackgroundItem) {
            statusBackgroundItem.hide();
        }
    }
}

// Re-implement checkInstanceLock correctly with context
async function checkInstanceLock() {
    if (payment.isPro()) return true;
    if (!globalContext) return true; // Should not happen

    const lockId = globalContext.globalState.get(LOCK_KEY);
    const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
    const now = Date.now();

    // 1. If no lock or lock is stale (>10s), claim it
    if (!lockId || (now - lastHeartbeat > 10000)) {
        await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 2. If we own the lock, update heartbeat
    if (lockId === INSTANCE_ID) {
        await globalContext.globalState.update(HEARTBEAT_KEY, now);
        return true;
    }

    // 3. Someone else owns the lock and it's fresh
    return false;
}

async function showVersionNotification(context) {
    // Check if 8.6.0 notification has been shown
    const hasShown8_6 = context.globalState.get(VERSION_8_6_0_KEY, false);
    if (!hasShown8_6) {
        // Show 8.6.0 notification
        const title = "What's new in Auto Accept 8.6.0";
        const body = `Simpler setup. More control.

Manual CDP Setup — Platform-specific scripts give you full control over shortcut configuration

Copy-to-Clipboard — Easy script transfer to your terminal

Platform Support — Windows PowerShell, macOS Terminal, and Linux Bash scripts

Enhanced Security — No automatic file modification, you run scripts when ready

Same Great Features — All the Auto Accept functionality you love, now with clearer setup`;
        const btnDashboard = "View Dashboard";
        const btnGotIt = "Got it";

        // Mark as shown immediately to prevent loops/multiple showings
        await context.globalState.update(VERSION_8_6_0_KEY, true);

        const selection = await vscode.window.showInformationMessage(
            `${title}\n\n${body}`,
            { modal: true },
            btnGotIt,
            btnDashboard
        );

        if (selection === btnDashboard) {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
        return;
    }

    // Legacy: Check if 7.0 notification has been shown (for backward compatibility)
    const hasShown7_0 = context.globalState.get(VERSION_7_0_KEY, false);
    if (hasShown7_0) return;

    // Show 7.0 notification (only for users who haven't seen any notification)
    const title = "What's new in Auto Accept 7.0";
    const body = `Smarter. Faster. More reliable.

Smart Away Notifications — Get notified only when actions happened while you were truly away.

Session Insights — See exactly what happened when you turn off Auto Accept: file edits, terminal commands, and blocked interruptions.

Improved Background Mode — Faster, more reliable multi-chat handling.

Enhanced Stability — Complete analytics rewrite for rock-solid tracking.`;
    const btnDashboard = "View Dashboard";
    const btnGotIt = "Got it";

    // Mark as shown immediately to prevent loops/multiple showings
    await context.globalState.update(VERSION_7_0_KEY, true);

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        btnGotIt,
        btnDashboard
    );

    if (selection === btnDashboard) {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
    }
}

async function showReleasyCrossPromo(context) {
    const hasShown = context.globalState.get(RELEASY_PROMO_KEY, false);
    if (hasShown) return;

    // Mark as shown immediately to prevent multiple showings
    await context.globalState.update(RELEASY_PROMO_KEY, true);

    const title = "New from the Auto Accept team";
    const body = `Releasy AI — Marketing for Developers

Turn your GitHub commits into Reddit posts automatically.

- AI analyzes your changes
- Generates engaging posts
- Auto-publishes to Reddit

Zero effort marketing for your side projects.`;

    const selection = await vscode.window.showInformationMessage(
        `${title}\n\n${body}`,
        { modal: true },
        "Check it out",
        "Maybe later"
    );

    if (selection === "Check it out") {
        vscode.env.openExternal(
            vscode.Uri.parse('https://releasyai.com?utm_source=auto-accept&utm_medium=extension&utm_campaign=version_promo')
        );
    }
}

function deactivate() {
    stopPolling();
    if (cdpHandler) {
        cdpHandler.stop();
    }
}

module.exports = { activate, deactivate };

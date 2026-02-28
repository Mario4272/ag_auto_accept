import * as vscode from 'vscode';
import { ConfigService } from '../config/config';
import { Logger } from '../util/logger';

/**
 * PollingDetector
 * 
 * Implements "Context-Aware Polling" to bypass VS Code security restrictions around WebViews.
 * 
 * STRATEGY:
 * - However, we discovered internal Ag commands:
 *      * antigravity.terminalCommand.accept
 *      * antigravity.agent.acceptAgentStep
 * - These commands are only enabled when a prompt is pending (controlled by internal context keys).
 * 
 * IMPLEMENTATION:
 * - We periodically (e.g. 500ms) attempt to execute these commands.
 * - If the command is disabled (context key false), the execution is a no-op or silently fails.
 * - If the command is enabled, it accepts the prompt.
 * 
 * SAFETY:
 * - Ideally, we would check the blocklist. We cannot.
 * - This is safer than "Blind Keypresses" because it uses specific command IDs.
 */
export class PollingDetector implements vscode.Disposable {
    private intervalParams: any | undefined;

    private disposables: vscode.Disposable[] = [];

    // The "Prelude Ladder" - non-disruptive commands to surface context.
    private readonly PRELUDE_LADDER = [
        'antigravity.openReviewChanges',
        'chatEditing.viewChanges'
    ];

    // Aggressive commands - only used when manually triggered (forced)
    private readonly DISRUPTIVE_PRELUDE_LADDER = [
        'workbench.view.scm',
        'workbench.scm.focus'
    ];

    private lastPreludeTime: number = 0;
    private readonly PRELUDE_INTERVAL = 30000; // 30 seconds
    private suppressedUntil: number = 0;
    private lastPendingEditsState: boolean = false;
    private currentSessionId: number = 0;
    private sessionOpened: boolean = false;
    private lastSummaryTime: number = 0;
    // The "Command Ladder" - an ordered list of commands to attempt.
    private readonly COMMAND_LADDER = [
        // 1. Chat Editing (Cascade/Chat blocks)
        'antigravity.closeAllDiffZones', // NEW: Closes cascade diffs, finalizing edits (v0.2.12)
        'chatEditing.acceptAllFiles',
        'chatEditing.acceptFile',
        'inlineChat.acceptChanges',
        'inlineChat2.keep',

        // 2. Focused Edits (Hunks/Files in diff view)
        'antigravity.prioritized.agentAcceptAllInFile',
        'antigravity.prioritized.agentAcceptFocusedHunk',

        // 3. Step/Terminal Approvals
        'antigravity.agent.acceptAgentStep',
        'antigravity.terminalCommand.accept',

        // 4. Fallbacks/Completions
        'antigravity.command.accept',
        'antigravity.acceptCompletion',
        'antigravity.prioritized.supercompleteAccept',
        'antigravity.prioritized.terminalSuggestion.accept',

        // 5. Side Panel / Notification Fallbacks (v0.2.7 Candidates)
        'refactorPreview.apply',
        'acceptRenameInput',
        'acceptRenameInputWithPreview',
        'workbench.files.action.acceptLocalChanges',
        'inlineChat.acceptChanges',
        'mergeEditor.acceptMerge',
        'mergeEditor.acceptAllCombination',
        'merge.acceptAllInput1',
        'merge.acceptAllInput2',
        'interactive.acceptChanges',
        'notification.acceptPrimaryAction',
        'notebook.inlineChat.acceptChangesAndRun',

        // 6. Terminal / QuickInput fallbacks (restored from v0.2.10, but at the bottom)
        'quickInput.acceptInBackground',
        'quickInput.accept'
    ];

    constructor(
        private configService: ConfigService,
        private logger: Logger
    ) {
        this.logger.log('[PollingDetector] Initializing Context-Aware Polling...');

        this.disposables.push(this.configService.onDidUpdateConfig(() => {
            this.updateState();
        }));

        this.updateState();
    }

    private updateState() {
        const config = this.configService.getConfig();
        const shouldBeEnabled = config.enabled;

        if (shouldBeEnabled && !this.intervalParams) {
            this.start();
        } else if (!shouldBeEnabled && this.intervalParams) {
            this.stop();
        }
    }

    public start() {
        if (this.intervalParams) return;

        this.logger.log('[PollingDetector] Starting polling loop (1000ms)...');
        this.intervalParams = setInterval(async () => {
            await this.poll();
        }, 1000);
    }

    public stop() {
        if (this.intervalParams) {
            this.logger.log('[PollingDetector] Stopping polling loop.');
            clearInterval(this.intervalParams);
            this.intervalParams = undefined;
        }
    }
    public async poll(force: boolean = false) {
        const config = this.configService.getConfig();
        const verbose = config.features?.tracingMode || false;
        const autoOpen = config.features?.autoOpenReviewChanges || false;

        // 1. Context Prelude: Try to open/surface the review context
        const now = Date.now();

        // Manual force always runs prelude
        if (force) {
            await this.runPrelude(true, verbose);
        } else if (autoOpen && now > this.suppressedUntil && now - this.lastPreludeTime >= this.PRELUDE_INTERVAL) {
            // Only auto-open if session hasn't been "surfaced" yet
            if (!this.sessionOpened) {
                this.lastPreludeTime = now;
                await this.runPrelude(false, verbose);
                this.sessionOpened = true;
            }
        }

        // 2. Main Acceptance Ladder
        let resolvedAny = false;
        const pollingMode = config.logging?.polling?.mode || "state";
        const summaryInterval = config.logging?.polling?.summaryEveryMs || 10000;

        // Dynamic ladder including learned commands
        const dynamicLadder = [
            ...(config.learnedCommands || []),
            ...this.COMMAND_LADDER
        ];

        for (const cmd of dynamicLadder) {
            try {
                if (pollingMode === "debug") this.logger.log(`[Polling] Ladder TRY: ${cmd}`);

                // Wrap executeCommand with a 250ms timeout to prevent hanging the entire loop
                let timeoutId: NodeJS.Timeout;
                const executePromise = vscode.commands.executeCommand(cmd);
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('Timeout')), 250);
                });

                // Prevent UnhandledPromiseRejectionWarning if it settles after the race
                timeoutPromise.catch(() => { });

                await Promise.race([executePromise, timeoutPromise]).then(
                    () => {
                        clearTimeout(timeoutId);
                        resolvedAny = true;

                        if (pollingMode === "debug") {
                            this.logger.log(`[Polling] Ladder RESOLVED: ${cmd}`);
                        }

                        // Session transition detection
                        if (!this.lastPendingEditsState) {
                            this.lastPendingEditsState = true;
                            this.currentSessionId++;
                            this.sessionOpened = false;
                            this.logger.log(`[Polling] SESSION START: Pending edits detected (ID: ${this.currentSessionId})`);
                        }
                    },
                    (err) => {
                        clearTimeout(timeoutId);
                        if (pollingMode === "debug") {
                            this.logger.log(`[Polling] Ladder REJECTED: ${cmd} (${err})`);
                        } else if (pollingMode === "errors") {
                            // In errors mode, we might still want to see why it failed if it's not just "disabled"
                            // But VS Code commands often fail with "Command not enabled" which is noise.
                        }
                    }
                );
            } catch (error) {
                if (pollingMode !== "off") {
                    this.logger.log(`[Polling] Ladder ERROR: ${cmd} (${error})`);
                }
            }
        }

        // Session transition detection (End)
        if (!resolvedAny && this.lastPendingEditsState) {
            this.lastPendingEditsState = false;
            this.logger.log(`[Polling] SESSION END: All pending edits cleared (Session ${this.currentSessionId})`);
        }

        // Rate-limited summary (Heartbeat)
        if (pollingMode === "debug" || (pollingMode === "state" && verbose)) {
            if (now - this.lastSummaryTime >= summaryInterval) {
                this.lastSummaryTime = now;
                this.logger.log(`[Polling] Heartbeat: ${resolvedAny ? "PROMPT ACTIVE" : "IDLE"} (Session: ${this.currentSessionId})`);
            }
        }
    }
    private async runPrelude(disruptive: boolean, verbose: boolean) {
        for (const cmd of this.PRELUDE_LADDER) {
            try {
                if (verbose) this.logger.log(`[Polling] Prelude TRY: ${cmd}`);
                await vscode.commands.executeCommand(cmd);
            } catch (e) { }
        }

        if (disruptive) {
            for (const cmd of this.DISRUPTIVE_PRELUDE_LADDER) {
                try {
                    if (verbose) this.logger.log(`[Polling] Disruptive Prelude TRY: ${cmd}`);
                    await vscode.commands.executeCommand(cmd);
                } catch (e) { }
            }
        }
    }

    /**
     * Call this when the user manually interacts with the UI to stop auto-opening for a while.
     */
    public suppressAutoOpen(durationMs: number = 60000) {
        this.suppressedUntil = Date.now() + durationMs;
        this.logger.log(`[Polling] Auto-open suppressed for ${durationMs}ms`);
    }

    dispose() {
        this.stop();
        this.disposables.forEach(d => d.dispose());
    }
}

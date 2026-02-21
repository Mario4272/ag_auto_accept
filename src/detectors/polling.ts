import * as vscode from 'vscode';
import { ConfigService } from '../config/config';
import { Logger } from '../util/logger';

/**
 * PollingDetector
 * 
 * Implements "Context-Aware Polling" to bypass VS Code security restrictions around WebViews.
 * 
 * STRATEGY:
 * - We cannot read the text inside the Antigravity Chat Interface (WebView).
 * - Therefore, we cannot enforce determining if a prompt is "safe" or "blocked".
 * - However, we discovered internal Antigravity commands:
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

    // The "Prelude Ladder" - commands to surface context before trying to accept.
    private readonly PRELUDE_LADDER = [
        'antigravity.openReviewChanges',
        'chatEditing.viewChanges',
        'workbench.view.scm',
        'workbench.scm.focus'
    ];

    // The "Command Ladder" - an ordered list of commands to attempt.
    private readonly COMMAND_LADDER = [
        // 1. Chat Editing (Cascade/Chat blocks)
        'chatEditing.acceptAllFiles',
        'chatEditing.acceptFile',

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
        'antigravity.prioritized.terminalSuggestion.accept'
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

    public async poll() {
        const config = this.configService.getConfig();
        const verbose = config.features?.tracingMode || false;

        // 1. Context Prelude: Try to open/surface the review context
        for (const cmd of this.PRELUDE_LADDER) {
            try {
                if (verbose) this.logger.log(`[Polling] Prelude TRY: ${cmd}`);
                // Best-effort, sequential fire
                await vscode.commands.executeCommand(cmd).then(
                    () => { if (verbose) this.logger.log(`[Polling] Prelude RESOLVED: ${cmd}`); },
                    (err) => { if (verbose) this.logger.log(`[Polling] Prelude REJECTED: ${cmd} (${err})`); }
                );
            } catch (e) {
                // Ignore
            }
        }

        // 2. Main Acceptance Ladder
        for (const cmd of this.COMMAND_LADDER) {
            try {
                if (verbose) this.logger.log(`[Polling] Ladder TRY: ${cmd}`);
                // Sequential fire to maintain precedence
                await vscode.commands.executeCommand(cmd).then(
                    () => {
                        this.logger.log(`[Polling] Ladder RESOLVED: ${cmd}`);
                        // If we resolved an accept command, we're likely done for this tick
                    },
                    (err) => {
                        if (verbose) this.logger.log(`[Polling] Ladder REJECTED: ${cmd} (${err})`);
                    }
                );
            } catch (error) {
                if (verbose) this.logger.log(`[Polling] Ladder ERROR: ${cmd} (${error})`);
            }
        }
    }

    dispose() {
        this.stop();
        this.disposables.forEach(d => d.dispose());
    }
}

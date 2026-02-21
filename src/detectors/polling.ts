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
        // Iterate through the command ladder and try to execute each command.
        // We rely on the command's internal context key (internal to Antigravity)
        // to determine if the command is active. If inactive, executeCommand is no-op.
        for (const cmd of this.COMMAND_LADDER) {
            try {
                // We do not 'await' here to prevent one slow command from blocking the entire loop,
                // but we trigger them sequentially in the loop for order of precedence.
                vscode.commands.executeCommand(cmd).then(
                    () => { },
                    () => { } // Ignore errors
                );
            } catch (error) {
                // Ignore synchronous errors
            }
        }
    }

    dispose() {
        this.stop();
        this.disposables.forEach(d => d.dispose());
    }
}

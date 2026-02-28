import * as vscode from 'vscode';
import { ConfigService } from './config/config';
import { Logger } from './util/logger';
import { PolicyService } from './policy/policy';

import { AcceptService } from './actions/accept';
import { HeuristicDetector } from './detectors/heuristic';
import { PollingDetector } from './detectors/polling';
import { UIService } from './ui/ui';
import { TraceService } from './trace/trace';

let configService: ConfigService;
let logger: Logger;
let statusBarItem: vscode.StatusBarItem;
let uiService: UIService;
let traceService: TraceService;

export function activate(context: vscode.ExtensionContext) {
    console.log('[Ag] Activating version 0.2.7');
    logger = new Logger();
    logger.log('Activating Ag AutoAccept...');

    try {
        configService = new ConfigService(logger);
    } catch (e) {
        logger.log(`Fatal error initializing ConfigService: ${e}`);
        return;
    }

    // Initialize Status Bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);
    updateStatusBar();
    statusBarItem.show();

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('agAutoAccept.toggle', () => {
            const current = configService.getConfig().enabled;
            configService.updateEnabled(!current);
            vscode.window.showInformationMessage(`Ag AutoAccept: ${!current ? 'Enabled' : 'Disabled'}`);
        }),
        vscode.commands.registerCommand('agAutoAccept.openConfig', () => {
            const uri = vscode.Uri.file(configService.getConfigPath());
            vscode.window.showTextDocument(uri);
        }),
        vscode.commands.registerCommand('agAutoAccept.reloadConfig', () => {
            configService.loadConfig();
            vscode.window.showInformationMessage('Ag AutoAccept: Config reloaded');
        }),
        vscode.commands.registerCommand('agAutoAccept.showLog', () => {
            logger.show();
        }),
        vscode.commands.registerCommand('agAutoAccept.debugCommands', async () => {
            const allCommands = await vscode.commands.getCommands(true);
            const content = allCommands.sort().join('\n');
            const fs = require('fs');
            const path = require('path');

            // Write to workspace root if available, else extension path
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const rootPath = (workspaceFolders && workspaceFolders.length > 0)
                ? workspaceFolders[0].uri.fsPath
                : context.extensionPath;

            const filePath = path.join(rootPath, 'all_available_commands.txt');
            fs.writeFileSync(filePath, content);
            vscode.window.showInformationMessage(`Dumped ${allCommands.length} commands to ${filePath}`);
            logger.log(`Dumped ALL commands to ${filePath}`);
        }),
        vscode.commands.registerCommand('agAutoAccept.controlPanel', () => {
            uiService.showControlPanel();
        }),
        vscode.commands.registerCommand('agAutoAccept.toggleTracing', () => {
            traceService.toggleTracing();
        }),
        vscode.commands.registerCommand('agAutoAccept.toggleLearningMode', () => {
            traceService.toggleLearningMode();
        }),
        vscode.commands.registerCommand('agAutoAccept.captureTraces', () => {
            traceService.captureAndDiscover();
        }),
        vscode.commands.registerCommand('agAutoAccept.checkDiscoveryStatus', () => {
            traceService.checkDiscoveryStatus();
        }),
        vscode.commands.registerCommand('agAutoAccept.testLadder', async () => {
            logger.log('Manually triggering command ladder (FORCED)...');
            // In v0.2.0, we just trigger the polling loop's logic immediately
            await pollingDetector.poll(true);
            vscode.window.showInformationMessage('Ag AutoAccept: Command ladder triggered.');
        }),
        vscode.commands.registerCommand('agAutoAccept.acceptPendingFilesVerify', async () => {
            logger.log('Manual "Accept Files (Verify)" triggered.');
            try {
                // 1. Attempt the main multi-file accept command
                await vscode.commands.executeCommand('chatEditing.acceptAllFiles');

                // 2. Small delay to allow state to propagate
                await new Promise(resolve => setTimeout(resolve, 500));

                // 3. Probe/Verify
                // Since no official API exists to count pending edits, we report status based on what we can see.
                logger.log('Accept attempted but cannot definitively verify; command may be no-op in this context.');
                vscode.window.showInformationMessage('Ag AutoAccept: Accept attempted (verification inconclusive). Check Output log.');
            } catch (e) {
                logger.log(`Verify Command ERROR: ${e}`);
                vscode.window.showErrorMessage(`Accept Verify failed: ${e}`);
            }
        })
    );

    // Subscribe to config changes
    configService.onDidUpdateConfig(() => {
        updateStatusBar();
        uiService.updateTracingStatusBar();
    });

    // Initialize other services
    const policyService = new PolicyService(configService, logger);
    const acceptService = new AcceptService(logger);

    // Initialize Detectors
    const heuristicDetector = new HeuristicDetector(logger);
    const pollingDetector = new PollingDetector(configService, logger);

    // Initialize UI and Trace Services
    uiService = new UIService(configService, logger);
    traceService = new TraceService(configService, logger);
    context.subscriptions.push(uiService);

    context.subscriptions.push(heuristicDetector);
    context.subscriptions.push(pollingDetector);

    heuristicDetector.start();
    pollingDetector.start();

    // Wire up detection -> policy -> action pipeline
    heuristicDetector.onApprovalRequired(async (ctx) => {
        logger.log(`Approval required: ${ctx.id} (${ctx.summary})`);

        try {
            const decision = policyService.evaluate(ctx);

            if (decision.allowed) {
                logger.log(`Policy ALLOWED. Attempting approval...`);
                const accepted = await acceptService.approve(ctx);

                if (accepted) {
                    logger.log(`Approval SUCCESS: ${ctx.id}`);
                    vscode.window.setStatusBarMessage(`$(check) Auto-Accepted: ${ctx.summary}`, 3000);
                } else {
                    logger.log(`Approval FAILED (action execution failed): ${ctx.id}`);
                }
            } else {
                const message = `AutoAccept Blocked: ${decision.reason}`;
                logger.log(message);

                vscode.window.showWarningMessage(
                    `AutoAccept Blocked: ${decision.reason}`,
                    'Open Config',
                    'Disable AutoAccept'
                ).then(selection => {
                    if (selection === 'Open Config') {
                        vscode.commands.executeCommand('agAutoAccept.openConfig');
                    } else if (selection === 'Disable AutoAccept') {
                        vscode.commands.executeCommand('agAutoAccept.toggle');
                    }
                });
            }
        } catch (e) {
            logger.log(`Error processing approval: ${e}`);
        }
    });

    // Implement "Respect User Close" heuristic
    let lastWasDiff = false;
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const isDiff = editor?.document.uri.scheme === 'diff' || editor?.document.uri.path.includes('.git');
        if (lastWasDiff && !isDiff) {
            // User moved away from a diff/review view
            pollingDetector.suppressAutoOpen(60000);
        }
        lastWasDiff = !!isDiff;
    }));

    logger.log('Ag AutoAccept activated.');
}

function updateStatusBar() {
    const enabled = configService.getConfig().enabled;
    statusBarItem.text = `$(shield) Ag AutoAccept: ${enabled ? 'ON' : 'OFF'}`;
    statusBarItem.command = 'agAutoAccept.controlPanel';
    statusBarItem.tooltip = 'Click to open Ag AutoAccept Control Panel';
    if (enabled) {
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

export function deactivate() {
    configService?.dispose();
}

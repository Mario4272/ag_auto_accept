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
    console.log('[Antigravity] Activating version 0.1.4');
    logger = new Logger();
    logger.log('Activating Antigravity AutoAccept...');

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
        vscode.commands.registerCommand('antigravity-autoaccept.toggle', () => {
            const current = configService.getConfig().enabled;
            configService.updateEnabled(!current);
            vscode.window.showInformationMessage(`AutoAccept: ${!current ? 'Enabled' : 'Disabled'}`);
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.openConfig', () => {
            const uri = vscode.Uri.file(configService.getConfigPath());
            vscode.window.showTextDocument(uri);
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.reloadConfig', () => {
            configService.loadConfig();
            vscode.window.showInformationMessage('AutoAccept: Config reloaded');
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.showLog', () => {
            logger.show();
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.debugCommands', async () => {
            const allCommands = await vscode.commands.getCommands(true);
            const content = allCommands.sort().join('\n');
            const fs = require('fs');
            const path = require('path');
            const filePath = path.join(context.extensionPath, 'all_available_commands.txt');
            fs.writeFileSync(filePath, content);
            vscode.window.showInformationMessage(`Dumped ${allCommands.length} commands to ${filePath}`);
            logger.log(`Dumped ALL commands to ${filePath}`);
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.controlPanel', () => {
            uiService.showControlPanel();
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.toggleTracing', () => {
            traceService.toggleTracing();
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.captureTraces', () => {
            traceService.captureAndDiscover();
        }),
        vscode.commands.registerCommand('antigravity-autoaccept.testLadder', async () => {
            logger.log('Manually triggering command ladder...');
            // In v0.2.0, we just trigger the polling loop's logic immediately
            await pollingDetector.poll();
            vscode.window.showInformationMessage('AutoAccept: Command ladder triggered.');
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
                        vscode.commands.executeCommand('antigravity-autoaccept.openConfig');
                    } else if (selection === 'Disable AutoAccept') {
                        vscode.commands.executeCommand('antigravity-autoaccept.toggle');
                    }
                });
            }
        } catch (e) {
            logger.log(`Error processing approval: ${e}`);
        }
    });

    logger.log('Antigravity AutoAccept activated.');
}



function updateStatusBar() {
    const enabled = configService.getConfig().enabled;
    statusBarItem.text = `$(shield) AutoAccept: ${enabled ? 'ON' : 'OFF'}`;
    statusBarItem.command = 'antigravity-autoaccept.toggle';
    statusBarItem.tooltip = 'Click to toggle AutoAccept';
    if (enabled) {
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

export function deactivate() {
    configService?.dispose();
}

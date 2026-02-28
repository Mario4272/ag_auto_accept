import * as vscode from 'vscode';
import { ConfigService } from '../config/config';
import { Logger } from '../util/logger';

export class UIService {
    private tracingStatusBarItem: vscode.StatusBarItem;

    constructor(
        private configService: ConfigService,
        private logger: Logger
    ) {
        this.tracingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.updateTracingStatusBar();
    }

    public updateTracingStatusBar() {
        const tracingEnabled = this.configService.getConfig().features?.tracingMode || false;
        if (tracingEnabled) {
            this.tracingStatusBarItem.text = `$(pulse) Ag Tracing: ON`;
            this.tracingStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.tracingStatusBarItem.tooltip = 'Ag Tracing is ACTIVE. Click to open Control Panel.';
            this.tracingStatusBarItem.show();
        } else {
            this.tracingStatusBarItem.hide();
        }

        // Show a second status bar or modify this one for Learning Mode?
        // Let's just update the tooltip or text for now to indicate learning status
        const learningEnabled = this.configService.getConfig().features?.learningMode || false;
        if (learningEnabled) {
            this.tracingStatusBarItem.text = `$(pulse) Tracing: LEARN`;
            this.tracingStatusBarItem.show();
        }
    }

    public async showControlPanel() {
        const config = this.configService.getConfig();
        const autoAcceptEnabled = config.enabled;
        const tracingEnabled = config.features?.tracingMode || false;

        const items: vscode.QuickPickItem[] = [
            {
                label: `$(shield) ${autoAcceptEnabled ? 'Disable' : 'Enable'} AutoAccept`,
                description: autoAcceptEnabled ? 'Currently ON' : 'Currently OFF',
                id: 'toggle_autoaccept'
            } as any,
            {
                label: `$(pulse) ${tracingEnabled ? 'Disable' : 'Enable'} Discovery Tracing`,
                description: tracingEnabled ? 'Currently ON (Capturing commands)' : 'Currently OFF',
                id: 'toggle_tracing'
            } as any,
            {
                label: `$(mortar-board) ${config.features?.learningMode ? 'Disable' : 'Enable'} Passive Learning`,
                description: config.features?.learningMode ? 'Currently AUTO-LEARNING' : 'Discover commands from your clicks',
                id: 'toggle_learning'
            } as any,
            {
                label: '$(record) Capture Traces (Manual)',
                description: 'Analyze Ag traces for missing button commands',
                id: 'capture_traces'
            } as any,
            {
                label: '$(rocket) Accept Files (Test Ladder)',
                description: 'Manually trigger the command ladder for active diffs',
                id: 'test_ladder'
            } as any,
            {
                label: '$(gear) Open Configuration',
                id: 'open_config'
            } as any,
            {
                label: '$(output) Show Output Log',
                id: 'show_log'
            } as any,
            {
                label: '$(search) Check Discovery Status',
                description: 'Verifies if Passive Learning is currently seeing data',
                id: 'check_discovery'
            } as any,
            {
                label: '$(database) Dump All IDE Commands',
                description: 'Exports every registered command to project root',
                id: 'dump_all_commands'
            } as any
        ];

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Ag AutoAccept Control Panel'
        });

        if (!selection) return;

        this.logger.log(`Control Panel: User selected ${selection.label}`);

        switch ((selection as any).id) {
            case 'toggle_autoaccept':
                vscode.commands.executeCommand('agAutoAccept.toggle');
                break;
            case 'toggle_tracing':
                vscode.commands.executeCommand('agAutoAccept.toggleTracing');
                break;
            case 'toggle_learning':
                vscode.commands.executeCommand('agAutoAccept.toggleLearningMode');
                break;
            case 'capture_traces':
                vscode.commands.executeCommand('agAutoAccept.captureTraces');
                break;
            case 'test_ladder':
                vscode.commands.executeCommand('agAutoAccept.testLadder');
                break;
            case 'open_config':
                vscode.commands.executeCommand('agAutoAccept.openConfig');
                break;
            case 'show_log':
                vscode.commands.executeCommand('agAutoAccept.showLog');
                break;
            case 'check_discovery':
                // Trigger an immediate discovery pulse and show feedback
                vscode.window.showInformationMessage('Checking discovery status... please check output log.');
                vscode.commands.executeCommand('agAutoAccept.checkDiscoveryStatus');
                break;
            case 'dump_all_commands':
                vscode.commands.executeCommand('agAutoAccept.debugCommands');
                break;
        }
    }

    public dispose() {
        this.tracingStatusBarItem.dispose();
    }
}

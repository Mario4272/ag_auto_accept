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
            this.tracingStatusBarItem.text = `$(pulse) Tracing: ON`;
            this.tracingStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.tracingStatusBarItem.tooltip = 'Antigravity Tracing is ACTIVE. Click to open Control Panel.';
            this.tracingStatusBarItem.show();
        } else {
            this.tracingStatusBarItem.hide();
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
                label: '$(record) Capture Traces & Discover Commands',
                description: 'Analyze Antigravity traces for missing button commands',
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
            } as any
        ];

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Antigravity AutoAccept Control Panel'
        });

        if (!selection) return;

        this.logger.log(`Control Panel: User selected ${selection.label}`);

        switch ((selection as any).id) {
            case 'toggle_autoaccept':
                vscode.commands.executeCommand('antigravity-autoaccept.toggle');
                break;
            case 'toggle_tracing':
                vscode.commands.executeCommand('antigravity-autoaccept.toggleTracing');
                break;
            case 'capture_traces':
                vscode.commands.executeCommand('antigravity-autoaccept.captureTraces');
                break;
            case 'test_ladder':
                vscode.commands.executeCommand('antigravity-autoaccept.testLadder');
                break;
            case 'open_config':
                vscode.commands.executeCommand('antigravity-autoaccept.openConfig');
                break;
            case 'show_log':
                vscode.commands.executeCommand('antigravity-autoaccept.showLog');
                break;
        }
    }

    public dispose() {
        this.tracingStatusBarItem.dispose();
    }
}

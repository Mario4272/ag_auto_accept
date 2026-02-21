import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../util/logger';
import { ConfigService } from '../config/config';

export class TraceService {
    private readonly traceDir: string;

    constructor(
        private configService: ConfigService,
        private logger: Logger
    ) {
        this.traceDir = path.join(os.homedir(), '.antigravity-autoaccept', 'traces');
        if (!fs.existsSync(this.traceDir)) {
            fs.mkdirSync(this.traceDir, { recursive: true });
        }
    }

    public async toggleTracing() {
        const config = this.configService.getConfig();
        const currentMode = config.features?.tracingMode || false;
        const newMode = !currentMode;

        // Update config
        const newConfig = {
            ...config,
            features: {
                ...config.features,
                tracingMode: newMode
            }
        };
        this.configService.updateConfig(newConfig);

        if (newMode) {
            await vscode.commands.executeCommand('antigravity.enableTracing');
            vscode.window.showInformationMessage('AutoAccept: Tracing ENABLED. Click the UI button once, then run Capture Traces.');
            this.logger.log('Antigravity tracing enabled for discovery.');
        } else {
            // No easy way to disable tracing via command found in list, 
            // but we stop our capture behavior.
            vscode.window.showInformationMessage('AutoAccept: Tracing mode DISABLED.');
            this.logger.log('Antigravity tracing mode disabled.');
        }
    }

    public async captureAndDiscover() {
        this.logger.log('Capturing traces for discovery...');

        try {
            const workbenchTrace = await vscode.commands.executeCommand<any>('antigravity.getWorkbenchTrace');
            const managerTrace = await vscode.commands.executeCommand<any>('antigravity.getManagerTrace');

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const wbPath = path.join(this.traceDir, `${timestamp}-workbench.json`);
            const mgPath = path.join(this.traceDir, `${timestamp}-manager.json`);

            fs.writeFileSync(wbPath, JSON.stringify(workbenchTrace, null, 2));
            fs.writeFileSync(mgPath, JSON.stringify(managerTrace, null, 2));

            this.logger.log(`Traces saved to ${this.traceDir}`);

            const candidates = this.parseTraces(workbenchTrace);
            if (candidates.length > 0) {
                const uniqueCandidates = [...new Set(candidates)];
                this.logger.log(`Discovery SUCCESS! Found command candidates: ${uniqueCandidates.join(', ')}`);

                const selection = await vscode.window.showInformationMessage(
                    `Found ${uniqueCandidates.length} command candidates! Review them in the output log?`,
                    'Show Log',
                    'Open Trace Folder'
                );

                if (selection === 'Show Log') {
                    this.logger.show();
                } else if (selection === 'Open Trace Folder') {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(wbPath));
                }
            } else {
                vscode.window.showWarningMessage('Discovery FAILED: No executeCommand calls found in trace. Did you click the button?');
                this.logger.log('No command candidates found in workbench trace.');
            }

        } catch (e) {
            this.logger.log(`Error during trace capture: ${e}`);
            vscode.window.showErrorMessage(`Trace capture failed: ${e}`);
        }
    }

    private parseTraces(trace: any): string[] {
        if (!trace || !Array.isArray(trace)) return [];

        const commands: string[] = [];

        // Very basic recursion to find "executeCommand" strings or command IDs
        const search = (obj: any) => {
            if (!obj) return;
            if (typeof obj === 'string') {
                if (obj.startsWith('antigravity.') || obj.startsWith('chatEditing.')) {
                    commands.push(obj);
                }
            } else if (typeof obj === 'object') {
                for (const key in obj) {
                    search(obj[key]);
                }
            }
        };

        search(trace);
        return commands;
    }
}

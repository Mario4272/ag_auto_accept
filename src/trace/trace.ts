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

            const wbStr = this.toWritableTrace(workbenchTrace, 'workbench');
            const mgStr = this.toWritableTrace(managerTrace, 'manager');

            fs.writeFileSync(wbPath, wbStr);
            fs.writeFileSync(mgPath, mgStr);

            this.logger.log(`[Trace] Wrote workbench: ${wbPath} (size: ${wbStr.length})`);
            this.logger.log(`[Trace] Wrote manager: ${mgPath} (size: ${mgStr.length})`);

            // Use the normalized workbench object for parsing
            let wbObj = workbenchTrace;
            if (typeof workbenchTrace === 'string') {
                try {
                    wbObj = JSON.parse(this.normalizePossibleDoubleEncodedJsonString(workbenchTrace));
                } catch {
                    wbObj = workbenchTrace;
                }
            }

            const candidates = this.parseTraces(wbObj);
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
        if (!trace) return [];

        const commands: string[] = [];
        const seen = new Set<any>();

        const search = (obj: any) => {
            if (!obj || seen.has(obj)) return;
            if (typeof obj === 'object') seen.add(obj);

            if (typeof obj === 'string') {
                // Look for command IDs
                if (obj.startsWith('antigravity.') || obj.startsWith('chatEditing.')) {
                    commands.push(obj);
                }
            } else if (Array.isArray(obj)) {
                for (const item of obj) {
                    search(item);
                }
            } else if (typeof obj === 'object') {
                for (const key in obj) {
                    // Also check keys if they might contain command IDs
                    if (key === 'command' || key === 'commandId' || key === 'id') {
                        if (typeof obj[key] === 'string' && (obj[key].startsWith('antigravity.') || obj[key].startsWith('chatEditing.'))) {
                            commands.push(obj[key]);
                        }
                    }
                    search(obj[key]);
                }
            }
        };

        search(trace);
        return commands;
    }

    private toWritableTrace(payload: unknown, label: string): string {
        if (payload === undefined) return `${label}: TRACE RETURNED UNDEFINED`;
        if (payload === null) return `${label}: TRACE RETURNED NULL`;
        if (typeof payload === 'string') {
            return this.normalizePossibleDoubleEncodedJsonString(payload);
        }
        try {
            return JSON.stringify(payload, null, 2);
        } catch {
            return `${label}: TRACE STRINGIFY FAILED`;
        }
    }

    private normalizePossibleDoubleEncodedJsonString(s: string): string {
        const t = s.trim();
        if (!t.startsWith('"')) return s;
        try {
            const parsed = JSON.parse(t);
            if (typeof parsed === 'string') return parsed; // unwrapped
        } catch { }
        return s;
    }
}

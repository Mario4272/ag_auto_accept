import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../util/logger';
import { ConfigService } from '../config/config';

export class TraceService {
    private readonly traceDir: string;

    private learningInterval: NodeJS.Timeout | undefined;
    private discoveredInSession = new Set<string>();

    private readonly TRACE_MANAGER_CMD = 'antigravity.getManagerTrace';
    private readonly TRACE_WORKBENCH_CMD = 'antigravity.getWorkbenchTrace';

    constructor(
        private configService: ConfigService,
        private logger: Logger
    ) {
        this.logger.log('[PollingDetector] Initializing Context-Aware Polling...');
        this.traceDir = path.join(os.homedir(), '.ag-autoaccept', 'traces');
        if (!fs.existsSync(this.traceDir)) {
            fs.mkdirSync(this.traceDir, { recursive: true });
        }

        // Auto-start if configured
        if (this.configService.getConfig().features?.learningMode) {
            this.startLearningMode();
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
            vscode.window.showInformationMessage('Ag AutoAccept: Tracing ENABLED. Click the UI button once, then run Capture Traces.');
            this.logger.log('Ag tracing enabled for discovery.');
        } else {
            // No easy way to disable tracing via command found in list, 
            // but we stop our capture behavior.
            vscode.window.showInformationMessage('Ag AutoAccept: Tracing mode DISABLED.');
            this.logger.log('Ag tracing mode disabled.');
        }
    }

    public async toggleLearningMode() {
        const config = this.configService.getConfig();
        const currentMode = config.features?.learningMode || false;
        const newMode = !currentMode;

        const newConfig = {
            ...config,
            features: {
                ...config.features,
                learningMode: newMode
            }
        };
        this.configService.updateConfig(newConfig);

        if (newMode) {
            this.startLearningMode();
            vscode.window.showInformationMessage('AutoAccept: Learning Mode ENABLED. Automating discovery...');
        } else {
            this.stopLearningMode();
            vscode.window.showInformationMessage('AutoAccept: Learning Mode DISABLED.');
        }
    }

    private async startLearningMode() {
        if (this.learningInterval) return;
        this.logger.log('[TraceService] Passive Learning Mode starting...');

        // Ensure Antigravity's internal tracing is enabled so we have data to discover
        try {
            await vscode.commands.executeCommand('antigravity.enableTracing');
            this.logger.log('[TraceService] Ag tracing auto-enabled for Passive Learning.');
        } catch (e) {
            this.logger.log('[TraceService] WARNING: Failed to auto-enable Ag tracing: ' + e);
        }

        this.learningInterval = setInterval(() => this.passiveDiscover(), 15000); // 15s interval
        this.logger.log('[TraceService] Passive Learning loop started (15s).');
    }

    private stopLearningMode() {
        if (this.learningInterval) {
            clearInterval(this.learningInterval);
            this.learningInterval = undefined;
            this.logger.log('[TraceService] Passive Learning Mode stopped.');
        }
    }

    private async passiveDiscover() {
        try {
            const config = this.configService.getConfig();
            const verbose = config.logging?.polling?.mode === 'debug' || config.features?.tracingMode;

            if (verbose) {
                this.logger.log('[Discovery] Passive Learning Heartbeat...');
            }

            const wbTrace = await vscode.commands.executeCommand<any>(this.TRACE_WORKBENCH_CMD);
            const mgTrace = await vscode.commands.executeCommand<any>(this.TRACE_MANAGER_CMD);

            if (!wbTrace && !mgTrace) {
                if (verbose) this.logger.log('[Discovery] Both traces returned empty/undefined.');
                return;
            }

            const wbObj = this.parseTraceObject(wbTrace);
            const mgObj = this.parseTraceObject(mgTrace);

            const wbCandidates = this.parseTraces(wbObj);
            const mgCandidates = this.parseTraces(mgObj);
            const candidates = Array.from(new Set([...wbCandidates, ...mgCandidates]));

            const known = new Set([
                ...(config.commands || []),
                ...(config.learnedCommands || []),
                // Hardcoded ladder from PollingDetector (simplified check)
                'chatEditing.acceptAllFiles', 'chatEditing.acceptFile',
                'antigravity.terminalCommand.accept', 'antigravity.agent.acceptAgentStep',
                'workbench.files.action.acceptLocalChanges', 'inlineChat.acceptChanges',
                'inlineChat2.keep',
                'mergeEditor.acceptMerge', 'notification.acceptPrimaryAction',
                'notebook.inlineChat.acceptChangesAndRun'
            ]);

            for (const cand of candidates) {
                if (!known.has(cand) && !this.discoveredInSession.has(cand)) {
                    this.discoveredInSession.add(cand);
                    this.logger.log(`[Discovery] NEW command candidate found passively: ${cand}`);

                    const selection = await vscode.window.showInformationMessage(
                        `New Auto-Accept candidate found: ${cand}. Add to your learned commands list?`,
                        'Yes, Add It',
                        'Ignore'
                    );

                    if (selection === 'Yes, Add It') {
                        const learned = config.learnedCommands || [];
                        if (!learned.includes(cand)) {
                            this.configService.updateConfig({
                                ...config,
                                learnedCommands: [...learned, cand]
                            });
                            vscode.window.showInformationMessage(`Learned: ${cand}`);
                        }
                    }
                }
            }
        } catch (e) {
            this.logger.log(`[Discovery] Passive Learning ERROR: ${e}`);
        }
    }

    public async checkDiscoveryStatus() {
        this.logger.log('[Discovery] MANUAL STATUS CHECK triggered.');
        const config = this.configService.getConfig();
        const learningEnabled = config.features?.learningMode;
        this.logger.log(`[Discovery] Learning Mode: ${learningEnabled ? 'ENABLED' : 'DISABLED'}`);

        const diagHeader = `=== Ag Discovery Diagnostics ===`;
        this.logger.log(diagHeader);

        try {
            const wbTrace = await vscode.commands.executeCommand<any>(this.TRACE_WORKBENCH_CMD);
            const mgTrace = await vscode.commands.executeCommand<any>(this.TRACE_MANAGER_CMD);

            const managerStatus = mgTrace ? (mgTrace === 'UNDEFINED' ? 'UNDEFINED' : 'CAPTURED') : 'NONE';
            const workbenchStatus = wbTrace ? (wbTrace === 'UNDEFINED' ? 'UNDEFINED' : 'CAPTURED') : 'NONE';
            this.logger.log(`[Discovery] Manager Trace Status: ${managerStatus}`);
            this.logger.log(`[Discovery] Workbench Trace Status: ${workbenchStatus}`);

            const wbStr = this.toWritableTrace(wbTrace, 'workbench');
            const mgStr = this.toWritableTrace(mgTrace, 'manager');

            this.logger.log(`[Discovery] Workbench Trace size: ${wbStr.length} characters.`);
            this.logger.log(`[Discovery] Manager Trace size: ${mgStr.length} characters.`);

            if (wbStr.length < 100 && wbStr.includes('UNDEFINED')) {
                this.logger.log('[Discovery] WARNING: Workbench trace is UNDEFINED. Is tracing enabled?');
            }
            if (mgStr.length < 100 && mgStr.includes('UNDEFINED')) {
                this.logger.log('[Discovery] WARNING: Manager trace is UNDEFINED. v0.2.7 may require a newer Antigravity engine.');
            }

            const wbObj = this.parseTraceObject(wbTrace);
            const mgObj = this.parseTraceObject(mgTrace);

            const wbCandidates = this.parseTraces(wbObj);
            const mgCandidates = this.parseTraces(mgObj);

            this.logger.log(`[Discovery] Workbench Trace: Found ${wbCandidates.length} candidates.`);
            this.logger.log(`[Discovery] Manager Trace: Found ${mgCandidates.length} candidates.`);

            const totalCount = wbCandidates.length + mgCandidates.length;

            if (totalCount > 0) {
                if (wbCandidates.length > 0) this.logger.log(`[Discovery] WB Top: ${wbCandidates.slice(0, 5).join(', ')}`);
                if (mgCandidates.length > 0) this.logger.log(`[Discovery] MG Top: ${mgCandidates.slice(0, 5).join(', ')}`);
                vscode.window.showInformationMessage(`Discovery Status: OK. Found ${totalCount} candidates.`);
            } else {
                vscode.window.showInformationMessage('Discovery Status: Connected, but 0 candidates match filter.');
                this.logger.log('[Discovery] No keywords matched in either trace buffer.');
                // Log a snippet of the raw trace to the output for manual inspection
                this.logger.log(`[Discovery] WB Snippet: ${wbStr.substring(0, 500)}...`);
            }
        } catch (e) {
            this.logger.log(`[Discovery] Error during status check: ${e}`);
            vscode.window.showErrorMessage(`Discovery Status Error: ${e}`);
        }
    }

    public async captureAndDiscover() {
        this.logger.log('Capturing traces for discovery...');

        try {
            const workbenchTrace = await vscode.commands.executeCommand<any>('antigravity.getWorkbenchTrace');
            const managerTrace = await vscode.commands.executeCommand<any>('antigravity.getManagerTrace');

            // Handle manager trace being undefined (Val's request)
            if (managerTrace === undefined) {
                this.logger.log('WARNING: Manager trace returned undefined; discovery may be incomplete.');
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const wbPath = path.join(this.traceDir, `${timestamp}-workbench.json`);
            const mgPath = path.join(this.traceDir, `${timestamp}-manager.json`);

            const wbStr = this.toWritableTrace(workbenchTrace, 'workbench');
            const mgStr = this.toWritableTrace(managerTrace, 'manager');

            fs.writeFileSync(wbPath, wbStr);
            fs.writeFileSync(mgPath, mgStr);

            this.logger.log(`[Trace] Wrote workbench: ${wbPath} (size: ${wbStr.length})`);
            this.logger.log(`[Trace] Wrote manager: ${mgPath} (size: ${mgStr.length})`);

            const wbObj = this.parseTraceObject(workbenchTrace);
            const mgObj = this.parseTraceObject(managerTrace);

            const candidates = Array.from(new Set([
                ...this.parseTraces(wbObj),
                ...this.parseTraces(mgObj)
            ]));
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

        const commands = new Set<string>();
        const seen = new Set<any>();

        // Discovery keywords requested by Val
        const DISCOVERY_KEYWORDS = [
            'antigravity.',
            'chatEditing.',
            'agentAccept',
            'acceptAll',
            'acceptFile',
            'commandId',
            'command',
            'execute',
            'workbench.action',
            'vscode.commands',
            'cascade.',
            'chat.'
        ];

        const isCommandCandidate = (val: string) => {
            if (val.length < 5 || val.length > 150) return false;
            if (val.includes(' ') || val.includes('\n')) return false;

            const lowerVal = val.toLowerCase();
            const matchesKeyword = DISCOVERY_KEYWORDS.some(k => lowerVal.includes(k.toLowerCase()));

            // Broad capture: anything with dots is likely a command ID or filename
            if (val.includes('.')) {
                // Heuristic: If it has multiple dots, it's VERY likely a command ID
                if ((val.match(/\./g) || []).length >= 2) return true;

                // If only one dot, avoid common file extensions unless they match keywords
                const noiseExtensions = ['.ts', '.js', '.json', '.yml', '.md', '.txt', '.scss', '.css', '.html'];
                if (noiseExtensions.some(ext => val.endsWith(ext))) {
                    return matchesKeyword;
                }
                return true;
            }

            return matchesKeyword;
        };

        const search = (obj: any) => {
            if (!obj || (typeof obj === 'object' && seen.has(obj))) return;
            if (typeof obj === 'object') seen.add(obj);

            if (typeof obj === 'string') {
                if (isCommandCandidate(obj)) {
                    commands.add(obj);
                }
            } else if (Array.isArray(obj)) {
                for (const item of obj) {
                    search(item);
                }
            } else if (typeof obj === 'object') {
                for (const key in obj) {
                    // Check if key itself is a keyword of interest
                    if (key === 'command' || key === 'commandId' || key === 'id' || key === 'id') {
                        if (typeof obj[key] === 'string' && isCommandCandidate(obj[key])) {
                            commands.add(obj[key]);
                        }
                    }
                    search(obj[key]);
                }
            }
        };

        search(trace);

        // Filter out too broad strings and known noise if necessary
        return Array.from(commands).filter(cmd => {
            // Must have at least one dot or be one of the known specific verbs
            return cmd.includes('.') || cmd.toLowerCase().includes('accept');
        });
    }
    private toWritableTrace(trace: any, type: string): string {
        if (trace === undefined) return `// ${type} trace data: UNDEFINED`;
        if (trace === null) return `// ${type} trace data: NULL`;
        return typeof trace === 'string' ? trace : JSON.stringify(trace, null, 2);
    }

    private parseTraceObject(trace: any): any {
        if (!trace) return null;
        if (typeof trace === 'string') {
            try {
                return JSON.parse(this.normalizePossibleDoubleEncodedJsonString(trace));
            } catch {
                return trace;
            }
        }
        return trace;
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

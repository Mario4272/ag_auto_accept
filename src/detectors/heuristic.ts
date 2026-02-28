import * as vscode from 'vscode';
import { Detector } from './base';
import { Logger } from '../util/logger';
import { ApprovalContext } from '../types';

export class HeuristicDetector implements Detector {
    private _onApprovalRequired = new vscode.EventEmitter<ApprovalContext>();
    public readonly onApprovalRequired = this._onApprovalRequired.event;
    private disposables: vscode.Disposable[] = [];

    constructor(private logger: Logger) { }

    start(): void {
        this.logger.log('Starting Heuristic Detector...');

        // Monitor Output Channels (as Documents)
        // This is tricky because OutputChannels don't always fire onDidChangeTextDocument for the *content* in a way that is easily parseable as a stream without re-reading the whole doc.
        // But let's try.
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme === 'output') {
                // Check if it's the Ag output channel? 
                // We don't know the exact name, maybe "Ag Agent"?
                // Log the name to help debug
                // this.logger.log(`Scanning Output Channel: ${e.document.fileName}`); 
                this.checkDocumentChanges(e);
            }
        }));

        // Monitor Terminals
        // NOTE: onDidWriteTerminalData is a Proposed API and causes activation failure in production.
        // We must disable this for now until we have a better solution or the API is finalized.
        /*
        // @ts-ignore - onDidWriteTerminalData might be proposed API or missing in definition
        this.disposables.push((vscode.window as any).onDidWriteTerminalData((e: any) => {
            if (e.data.includes('Do you want to continue?') || e.data.includes('Approve this action?')) {
                this.handleTerminalData(e);
            }
        }));
        */
    }

    private checkDocumentChanges(e: vscode.TextDocumentChangeEvent) {
        // Very naive heuristic for v0.1.0
        for (const change of e.contentChanges) {
            if (change.text.includes('Requires approval') ||
                change.text.includes('Do you want to proceed?') ||
                change.text.includes('Run command?') ||
                change.text.includes('Always run') ||
                change.text.includes('Run Alt+') ||
                change.text.includes('Run Alt') ||
                change.text.includes('Run') && change.text.includes('Reject')) {
                this.logger.log(`[Heuristic] Potential approval detected in Output: ${change.text.trim()}`);

                const ctx: ApprovalContext = {
                    id: Math.random().toString(36).substring(7),
                    timestamp: new Date().toISOString(),
                    type: 'unknown',
                    source: 'heuristic.output',
                    summary: 'Heuristic detection from Output Channel',
                    raw: change.text
                };

                this._onApprovalRequired.fire(ctx);
            }
        }
    }

    /*
    private handleTerminalData(_e: any) {
        // This is less reliable if the prompt is a UI element and not just terminal text.
        // But we keep it as a fallback for CLI-based approvals.
        this.logger.log(`[Heuristic] Potential approval detected in Terminal`);
        const ctx: ApprovalContext = {
            id: Math.random().toString(36).substring(7),
            timestamp: new Date().toISOString(),
            type: 'terminal',
            source: 'heuristic.terminal',
            summary: 'Heuristic detection from Terminal',
            terminal: {
                rawCommand: 'unknown (heuristic)'
            }
        };
        this._onApprovalRequired.fire(ctx);
    }
    */

    dispose() {
        this.disposables.forEach(d => d.dispose());
        this._onApprovalRequired.dispose();
    }
}

import * as vscode from 'vscode';

export class Logger {
    private channel: vscode.OutputChannel;

    constructor() {
        this.channel = vscode.window.createOutputChannel('Ag AutoAccept');
    }

    log(message: string) {
        const timestamp = new Date().toISOString();
        this.channel.appendLine(`[${timestamp}] ${message}`);
    }

    show() {
        this.channel.show();
    }
}

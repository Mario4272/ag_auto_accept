import * as vscode from 'vscode';

export async function activate(_context: vscode.ExtensionContext) {
    const all = await vscode.commands.getCommands(true);
    console.log('--- ALL COMMANDS ---');
    all.sort().forEach(c => console.log(c));
}

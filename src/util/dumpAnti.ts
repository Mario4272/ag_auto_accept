import * as vscode from 'vscode';

export async function activate(_context: vscode.ExtensionContext) {
    const all = await vscode.commands.getCommands(true);
    const agCommands = all.filter(c => c.toLowerCase().includes('ag')).sort();
    console.log('--- AG RELATED COMMANDS ---');
    agCommands.forEach(c => console.log(c));
}

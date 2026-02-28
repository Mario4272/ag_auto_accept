import * as vscode from 'vscode';
import { Logger } from '../util/logger';
import { Mutex } from '../util/mutex';
import { ApprovalContext } from '../types';

export class AcceptService {
    private mutex = new Mutex();

    constructor(private logger: Logger) { }

    public async approve(ctx: ApprovalContext): Promise<boolean> {
        return this.mutex.dispatch(async () => {
            this.logger.log(`Attempting to approve: ${ctx.id} (${ctx.summary})`);

            // 1. Try official Ag command
            try {
                // Heuristic command IDs - ideally these are documented or discovered
                const commands = await vscode.commands.getCommands();
                const approveCmd = commands.find(c => c.includes('antigravity.approve') || c.includes('antigravity.accept'));

                if (approveCmd) {
                    this.logger.log(`Executing command: ${approveCmd}`);
                    await vscode.commands.executeCommand(approveCmd);
                    return true;
                }
            } catch (e) {
                this.logger.log(`Error executing Ag approval: ${e}`);
            }

            // 2. Try generic "Accept" layout commands if available
            // This is "Plan B".

            this.logger.log(`No explicit approval command found. Attempted generic acceptance.`);
            return false;
        });
    }
}

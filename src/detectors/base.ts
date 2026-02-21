import * as vscode from 'vscode';
import { ApprovalContext } from '../types';

export interface Detector extends vscode.Disposable {
    start(): void;
    onApprovalRequired: vscode.Event<ApprovalContext>;
}

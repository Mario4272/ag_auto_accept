export type ApprovalType = "terminal" | "filesystem" | "network" | "unknown";

export interface ApprovalContext {
    id: string;                       // stable per pending approval if possible; otherwise generated
    timestamp: string;                // ISO
    type: ApprovalType;
    source: string;                   // e.g., "ag.agent", "chat.panel", "output.channel"
    summary?: string;                 // short human summary
    terminal?: {
        rawCommand?: string;            // full command text if available
        executable?: string;            // best-effort parse
        cwd?: string;
    };
    filesystem?: {
        filesTouched?: string[];        // paths if available
        diffStat?: { files: number; insertions: number; deletions: number; };
    };
    network?: {
        hosts?: string[];
        urls?: string[];
    };
    raw?: any;                        // store raw payload from detector for debugging
}

export interface Decision {
    allowed: boolean;
    reason?: string;
    matchedRule?: string;
}

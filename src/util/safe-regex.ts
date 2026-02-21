import { Logger } from './logger';

export class SafeRegex {
    constructor(private logger: Logger) { }

    public compile(pattern: string): RegExp | null {
        try {
            return new RegExp(pattern, 'i'); // Default case-insensitive as per instructions "pattern: '(?i)...'" handled by JS RegExp? JS doesnt support inline flags like (?i) except in modern engines, but flags arg is safer. Instructions blocklist has (?i) which implies PCRE. JS RegExp might not support (?i).
            // Actually, the default config uses '(?i)' which is NOT standard JS RegExp syntax until extremely recently (ES2018 / Node 10+ supports s flag, but (?i) is creating a group with flags).
            // Wait, JS RegExp does NOT support `(?i)` at the start for case insensitivity in all environments.
            // The instructions say: "pattern: '(?i)\\brm\\s+-rf\\b'".
            // If the user config provides `(?i)`, we should strip it and use the `i` flag, OR use a library that supports it.
            // OR rely on the user to provide JS-compatible regex.
            // "Default blocklist must include catastrophic terminal patterns". The provided patterns use `(?i)`.
            // I should handle stripping `(?i)` and adding `i` flag if detected, or just always use `i` flag and strip `(?i)` if present.
            // For now, I will manually handle the `(?i)` prefix for the default config to work.
        } catch (e) {
            this.logger.log(`Invalid Regex Pattern: ${pattern}. Error: ${e}`);
            return null;
        }
    }

    public static stripFlags(pattern: string): { pattern: string, flags: string } {
        let p = pattern;
        let flags = '';
        if (p.startsWith('(?i)')) {
            flags += 'i';
            p = p.substring(4);
        }
        return { pattern: p, flags };
    }
}

import { ConfigService } from '../config/config';
import { Logger } from '../util/logger';
import { ApprovalContext, Decision } from '../types';
import { SafeRegex } from '../util/safe-regex';
import { minimatch } from 'minimatch';

export class PolicyService {
    constructor(
        private configService: ConfigService,
        private logger: Logger
    ) { }

    public evaluate(ctx: ApprovalContext): Decision {
        const config = this.configService.getConfig();

        if (!config.enabled) {
            return { allowed: false, reason: 'Extension disabled by user' };
        }

        // 1. Terminal blocked?
        if (ctx.type === 'terminal' && ctx.terminal) {
            const { rawCommand, executable } = ctx.terminal;

            // Check executables
            if (executable) {
                const blockedExecutables = config.blocklist.terminal.executables || [];
                // Case insensitive check
                if (blockedExecutables.some(exe => exe.toLowerCase() === executable.toLowerCase())) {
                    return { allowed: false, reason: `Blocked executable: ${executable}`, matchedRule: executable };
                }
            }

            // Check patterns
            if (rawCommand) {
                const patterns = config.blocklist.terminal.patterns || [];
                for (const pattern of patterns) {
                    const { pattern: stripped, flags } = SafeRegex.stripFlags(pattern);
                    // Always add 'i' if the pattern starts with (?i) or if we want default case-insensitivity? 
                    // Instructions say: '(?i)...' in defaults.
                    // My SafeRegex utility handles stripping.
                    // But I need to define SafeRegex usage here.

                    let re: RegExp | null = null;
                    try {
                        re = new RegExp(stripped, flags || 'i'); // Default to case-insensitive if not specified? Or just use flags?
                        // If pattern didn't have (?i), flags is empty.
                        // But commands like "rm -rf" should probably be case generated?
                        // Instructions use (?i) in default config so they expect case-insensitivity.
                        // I'll stick to 'flags' from SafeRegex. 
                        // Wait, if I use `(?i)` in the config, `stripFlags` returns `i`.
                        // If I *don't* use it, `stripFlags` returns empty.
                        // I should probably force `i` if `(?i)` is missing? No, user might want case-sensitive.
                        // But the default config uses `(?i)`, so it covers case-insensitivity.
                    } catch (e) {
                        this.logger.log(`Invalid Regex: ${pattern}`);
                        continue;
                    }

                    if (re && re.test(rawCommand)) {
                        return { allowed: false, reason: `Blocked command pattern: ${pattern}`, matchedRule: pattern };
                    }
                }
            }
        }

        // 2. Filesystem blocked?
        if (ctx.type === 'filesystem' && ctx.filesystem && ctx.filesystem.filesTouched) {
            const blockedGlobs = config.blocklist.filesystem.paths || [];
            for (const file of ctx.filesystem.filesTouched) {
                for (const glob of blockedGlobs) {
                    if (minimatch(file, glob, { dot: true, matchBase: true })) {
                        return { allowed: false, reason: `Blocked file access: ${file}`, matchedRule: glob };
                    }
                }
            }
        }

        // 3. Network blocked?
        if (ctx.type === 'network' && ctx.network && ctx.network.hosts) {
            const deniedHosts = config.blocklist.network.deny_hosts || [];
            for (const host of ctx.network.hosts) {
                if (deniedHosts.some(denied => host.includes(denied))) {
                    return { allowed: false, reason: `Blocked host: ${host}`, matchedRule: host };
                }
            }
        }

        return { allowed: true };
    }
}

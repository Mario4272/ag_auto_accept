import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { Logger } from '../util/logger';

export interface Config {
    version: string;
    enabled: boolean;
    mode: string;
    features: {
        domAutomation: boolean;
        tracingMode: boolean;
    };
    blocklist: {
        terminal: {
            patterns: string[];
            executables: string[];
        };
        filesystem: {
            paths: string[];
        };
        network: {
            deny_hosts: string[];
        };
    };
}

const DEFAULT_CONFIG: Config = {
    version: "0.1.0",
    enabled: true,
    mode: "auto_accept_all",
    features: {
        domAutomation: false,
        tracingMode: false
    },
    blocklist: {
        terminal: {
            patterns: [],
            executables: []
        },
        filesystem: {
            paths: []
        },
        network: {
            deny_hosts: []
        }
    }
};

export class ConfigService {
    private configPath: string;
    private config: Config = DEFAULT_CONFIG;
    private _onDidUpdateConfig = new vscode.EventEmitter<Config>();
    public readonly onDidUpdateConfig = this._onDidUpdateConfig.event;
    private watcher: fs.FSWatcher | undefined;

    constructor(private logger: Logger) {
        this.configPath = path.join(os.homedir(), '.antigravity-autoaccept', 'config.yml');
        this.ensureConfigExists();
        this.loadConfig();
        this.watchConfig();
    }

    private ensureConfigExists() {
        const configDir = path.dirname(this.configPath);
        if (!fs.existsSync(configDir)) {
            try {
                fs.mkdirSync(configDir, { recursive: true });
                this.logger.log(`Created config directory: ${configDir}`);
            } catch (error) {
                this.logger.log(`Error creating config directory: ${error}`);
            }
        }

        if (!fs.existsSync(this.configPath)) {
            try {
                // In a real scenario, we'd copy the default config from resources
                // For now, we'll write a minimal default or try to copy if we can locate resources
                // We will rely on the extension context passed in initialization to find resources in a future step
                // For now, just write a stringified default config to be safe
                const minimalConfig = yaml.dump(DEFAULT_CONFIG);
                fs.writeFileSync(this.configPath, minimalConfig);
                this.logger.log(`Created default config at: ${this.configPath}`);
            } catch (error) {
                this.logger.log(`Error creating config file: ${error}`);
            }
        }
    }

    public loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const fileContent = fs.readFileSync(this.configPath, 'utf8');
                const parsed = yaml.load(fileContent) as any;

                // TODO: Add strict Zod validation here
                // For now, simple merger with default to ensure structure
                this.config = {
                    ...DEFAULT_CONFIG, ...parsed,
                    blocklist: { ...DEFAULT_CONFIG.blocklist, ...parsed.blocklist },
                    features: { ...DEFAULT_CONFIG.features, ...parsed.features }
                };

                this.logger.log(`Config loaded from ${this.configPath}`);
                this._onDidUpdateConfig.fire(this.config);
            }
        } catch (error) {
            this.logger.log(`Error loading config: ${error}. Using cached/default config.`);
            vscode.window.showErrorMessage(`Antigravity AutoAccept: Error loading config. Using last known good config.`);
        }
    }

    private watchConfig() {
        try {
            this.watcher = fs.watch(this.configPath, (eventType) => {
                if (eventType === 'change') {
                    this.logger.log('Config file changed, reloading...');
                    // Debounce slightly
                    setTimeout(() => this.loadConfig(), 500);
                }
            });
        } catch (error) {
            this.logger.log(`Error watching config file: ${error}`);
        }
    }

    public getConfig(): Config {
        return this.config;
    }

    public getConfigPath(): string {
        return this.configPath;
    }

    public updateEnabled(enabled: boolean) {
        this.updateConfig({ ...this.config, enabled });
    }

    public updateConfig(newConfig: Config) {
        try {
            this.config = newConfig;
            this._onDidUpdateConfig.fire(this.config);

            // Persist to file
            const currentContent = fs.readFileSync(this.configPath, 'utf8');
            const parsed = yaml.load(currentContent) as any;

            // Merge changes back to preserve file structure as much as possible
            parsed.enabled = newConfig.enabled;
            parsed.mode = newConfig.mode;
            parsed.features = { ...parsed.features, ...newConfig.features };

            fs.writeFileSync(this.configPath, yaml.dump(parsed));
            this.logger.log(`Config updated and persisted to ${this.configPath}`);
        } catch (error) {
            this.logger.log(`Error updating config: ${error}`);
        }
    }

    dispose() {
        this.watcher?.close();
    }
}

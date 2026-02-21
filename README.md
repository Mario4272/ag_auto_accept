# Antigravity AutoAccept

**Automatic Agent Approval for Antigravity with Safety Guardrails.**

This extension automatically accepts "approval required" prompts from the Antigravity agent, allowing for uninterrupted workflows. It includes a robust, user-configurable blocklist to prevent dangerous commands or sensitive file modifications.

## Features

- **Auto-Accept**: Automatically approves agent actions by default.
- **Safety Blocklist**: Blocks dangerous terminal commands (e.g., `rm -rf`, `sudo`), sensitive file access (e.g., `.env`, `.ssh`), and specific network hosts.
- **Configurable**: User-editable configuration file (`~/.antigravity-autoaccept/config.yml`) with hot-reload.
- **Toggleable**: One-click kill switch via the Status Bar or Command Palette.
- **Auditable**: Logs all decisions (Accept/Block) to the "Antigravity AutoAccept" Output Channel.

## Installation

1.  Download the `.vsix` artifact.
2.  Run `code --install-extension antigravity-autoaccept-0.1.0.vsix` or use the "Install from VSIX..." command in VS Code.
3.  Reload VS Code.

## Configuration

The extension uses a YAML configuration file located at `~/.antigravity-autoaccept/config.yml`.
This file is automatically created on first run with safe defaults.

To edit:
- Run command: `AutoAccept: Open Config File`

### Example Config

```yaml
version: 0.1.0
enabled: true
mode: "auto_accept_all"

blocklist:
  terminal:
    patterns:
      - '(?i)\brm\s+-rf\b' # Block forced recursive deletion
  filesystem:
    paths:
      - "**/.env"         # Block access to environment files
```

## Commands

- `AutoAccept: Toggle Enabled`: Enable/Disable the extension.
- `AutoAccept: Open Config File`: Open the configuration file for editing.
- `AutoAccept: Reload Config`: Manually reload the configuration (happens automatically on save).
- `AutoAccept: Show Output Log`: specific output channel with audit logs.

## Development

### Build

```bash
npm install
npm run build
```

### Test

```bash
npm run test
```

### Package

```bash
npm run package
```

# Ag AutoAccept

Automatically approves agent actions (terminal commands, agent steps, etc.) in the Ag interface based on a user-defined policy.

## Features

- **Context-Aware Polling**: Bypasses WebView limitations to auto-accept prompts.
- **Learning Mode**: Passively discovers new command IDs from Ag traces.
- **Safety Policy**: (In development) Blocklist/Allowlist support for automated actions.
- **Configurable**: User-editable configuration file (`~/.ag-autoaccept/config.yml`) with hot-reload.
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

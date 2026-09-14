# Install Hotlap

Hotlap runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

`npx hotlap` runs a Node.js server. It needs Node.js 22.16+ (22.x), 23.11+
(23.x), or 24.10 and later, and supports Intel and Apple Silicon Macs, Linux,
and Windows. The desktop app includes its server runtime.

Standalone release archives need no separate Node installation. They support
Apple Silicon Macs, Linux x64/arm64, and Windows x64/arm64. Intel Macs use npm
or the desktop app. SSH connections install a matching runtime on the remote
machine; Intel Mac SSH hosts need Node and npm. WSL receives its runtime from
the desktop app.

You need an installed, authenticated provider before starting a thread. You can
launch Hotlap and configure providers afterwards.

## Run without installing

```bash
npx hotlap@latest
```

This starts the server and opens the local web app. Run
`npx hotlap@latest --help` for command-line options.

Hotlap stores its data in `~/.hotlap`, separately from T3 Code. Installing
Hotlap does not migrate or synchronize a T3 Code profile.

## Desktop app

Download the installer for your operating system and processor from
[Hotlap Releases](https://github.com/shwarmadev/hotlap/releases).

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install and authenticate provider CLIs inside that distro. Hotlap installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx hotlap app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx hotlap app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Use Hotlap's TestFlight distribution for iOS or the Android APK linked from
[Hotlap Releases](https://github.com/shwarmadev/hotlap/releases). The phone
connects to a server on another machine using a pairing URL over your LAN or
Tailscale. Hotlap has no hosted T3 Connect relay or separate hosted web app.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Hotlap's provider settings.                             |

Provider CLIs must be on the server's `PATH`. If Hotlap cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Hotlap can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Hotlap does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating](./updating.md): update the app and connected servers.

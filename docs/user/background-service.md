# Running Hotlap in the background

On Linux and macOS, Hotlap can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host Hotlap:

| Task                            | Command                               |
| ------------------------------- | ------------------------------------- |
| Install and start               | `npx hotlap@latest service install`   |
| Inspect status and log location | `npx hotlap@latest service status`    |
| Update or repair                | `npx hotlap@latest service update`    |
| Stop and remove from startup    | `npx hotlap@latest service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.

Install and update use the version of the CLI you invoke. For nightly, use
`npx hotlap@nightly service update`; replace `nightly` with an exact version to pin
one. An older CLI refuses to replace a newer service unless you explicitly add
`--allow-downgrade`.

Updating restarts the server. Finish active work first, and wait for any remote
update already in progress. To match a remote client's version, follow
[Updating Hotlap](./updating.md).

Existing npm-managed services continue using Node and the `hotlap` npm package,
including on Intel Macs. Keep their Node executable installed. Hotlap data lives
in `~/.hotlap`, separately from T3 Code.

Standalone builds instead download a checksum-verified archive from
[Hotlap Releases](https://github.com/shwarmadev/hotlap/releases). These need no
separate Node installation on Apple Silicon Macs, Linux x64/arm64, or Windows
x64/arm64. Intel Macs should use the npm commands above.

Download and review `scripts/install.sh` or `scripts/install.ps1` from the
[Hotlap repository](https://github.com/shwarmadev/hotlap/tree/main/scripts),
then run it with `sh` or PowerShell. Do not use the installers at `t3.codes`;
those install T3 Code.

The scripts place a `hotlap` launcher in `~/.local/bin` and downloaded versions
under `~/.hotlap/runtime/versions`. Run `hotlap service install` to reuse a
standalone runtime for the service. Optional installer settings:

- `HOTLAP_CHANNEL`: `stable` (default), `nightly`, or `preview`.
- `HOTLAP_VERSION`: install an exact version.
- `HOTLAP_HOME`: use another Hotlap data directory.
- `HOTLAP_INSTALL_BIN_DIR`: choose where to put the launcher.
- `HOTLAP_RELEASE_BASE_URL`: download archives from a mirror.

`preview` is a third train that maintainers cut from unreleased branches to
exercise the release pipeline. Those builds can be broken, receive no fixes,
and are never offered as updates; the installer and `hotlap update` only take you
there when you ask for the channel explicitly, and warn you when they do.

Once a self-contained `hotlap` is installed, `hotlap update` moves the machine to a
newer one without npm: it downloads the newest release on the channel the
running `hotlap` came from, verifies it, and points the `hotlap` launcher at it. When
a background service is installed for the same Hotlap data directory it asks before
restarting it, since a restart interrupts running agent turns, terminals, and
remote clients; answer no and the service keeps the old version until you run
`hotlap service restart`. From a script there is no prompt, so pass `--yes` to
restart the service. A server you started by hand is never touched; the
command tells you it is still on the old version so you can restart it
yourself. Pass an exact published version (`hotlap update <version>`) to
pin one, `--channel` to follow a different release train (moving onto preview from stable or nightly asks for confirmation), or
`--allow-downgrade` to move backwards.

`hotlap uninstall` reverses the install script: it shows what it found (the
background service, the `hotlap` launcher, every downloaded version under
`~/.hotlap/runtime`), asks once, and removes them. Your projects, threads, and
settings under `~/.hotlap/userdata` are kept; delete that directory yourself if
you want them gone too. Pass `--yes` from a script.

## Platform support

Linux needs systemd user services. Setup enables lingering so Hotlap starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

Remote clients connect over LAN or Tailscale. Hotlap does not provide the hosted
T3 Connect relay.

## Troubleshooting

Start with `hotlap service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running Hotlap as root creates a separate installation. Without
administrator access, run `hotlap serve` in a terminal and keep that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status hotlap.service`, then use the repair command printed by Hotlap.                      |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `hotlap service restart`.                        |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the runtime executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/ai.usefastlane.code.service.plist`.

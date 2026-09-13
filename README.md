# Run in Background

Keep desktop Obsidian vaults—and Obsidian Sync—available in the background
without blocking logout, restart, or operating-system shutdown.

<div align="center">
  <h3>Created by <a href="https://github.com/gabrielbacha">Gabriel Bacha</a></h3>
  <p>
    <a href="https://www.gabrielbacha.com/?utm_source=obsidian_community&amp;utm_medium=referral&amp;utm_campaign=obsidian_assets&amp;utm_content=run_in_background_readme_header"><strong>Visit gabrielbacha.com</strong></a>
    &nbsp;·&nbsp;
    <a href="https://obsidian.md/plugins?search=Gabriel%20Bacha"><strong>Explore more Obsidian plugins</strong></a>
    &nbsp;·&nbsp;
    <a href="https://github.com/gabrielbacha/Obsidian-Run-in-background/issues/new?template=feature_request.yml"><strong>Request a feature</strong></a>
  </p>
</div>

![Run in Background for Obsidian](assets/run-in-background-hero.png)

Closing a vault window can hide it instead of terminating it. Restore it from
the Dock or taskbar, by launching Obsidian again, or from a vault-specific tray
icon. Normal Quit behavior remains independently configurable.

This is especially useful when you want Obsidian Sync to keep processing
changes while the vault window is hidden. Run in Background does not replace
Obsidian Sync and cannot sync while the computer is asleep or offline.

## Highlights

- Keep one or several vaults running in the macOS menu bar or system tray.
- Let Obsidian Sync continue working while vault windows are hidden.
- Restore hidden vaults by activating Obsidian or selecting **Show Vault**.
- Optionally make Cmd+Q or the normal Quit command hide instead of terminate.
- Always allow explicit Close Vault, Relaunch, logout, restart, and shutdown.
- Distinguish vaults with custom icons and optional colored text, number,
  symbol, or emoji badges of up to three characters.
- Open the plugin settings directly from the tray menu.
- Import compatible settings from the original Tray plugin on first launch.

Run in Background requires Obsidian 1.7.2 or newer and is desktop-only. It
makes no internet requests. On sandboxed Linux packages it communicates with
the local desktop portal to request background and login-startup permission.

## Window and quit behavior

| Action | Default behavior |
| --- | --- |
| Close a vault window | Hide the vault and keep it running |
| Cmd+Q / normal Quit | Hide the vault and keep it running |
| Tray **Close Vault** | Close that vault |
| **Relaunch Obsidian** | Exit and relaunch cleanly |
| Disable the plugin | Remove listeners and tray objects cleanly |
| Logout, restart, or shutdown | Exit without blocking the operating system |

The two background behaviors have separate toggles, so window closing and the
Quit command can be configured independently.

## Settings

| Setting | Description | New-install default |
| --- | --- | --- |
| Enable Run in Background | Master switch for all plugin runtime behavior | On |
| Launch on startup | Launch Obsidian when you sign in | Off |
| Hide on launch | Always, only when opened at device login, or never start hidden | Only when opened at login |
| Run in background | Hide an ordinary window close | On |
| Keep running after Quit command | Turn Cmd+Q / Quit into hide | On |
| Hide Dock/taskbar icon | Remove Obsidian from the Dock or taskbar | Off |
| Create tray icon | Create the vault menu-bar or tray icon | On |
| Tray icon image | Select a preset or upload a square PNG/SVG | Obsidian |
| Vault badge | Add up to three characters, optionally separated by spaces | Vault initials |
| Badge color | Set a vault-specific badge background with automatic contrast | Dark |

For safety, hiding the Dock/taskbar icon keeps the tray icon enabled. Disabling
the tray icon restores the Dock/taskbar icon.

The top **Enable Run in Background** switch deactivates the entire runtime
without disabling the community plugin. While it is off, no close or Quit
behavior, tray icon, Dock/taskbar changes, or launch-at-login behavior remains
active; the settings page stays available so you can turn it back on.

### Linux startup support

Launch on startup detects native DEB/RPM and distribution packages, AppImage,
Flatpak, and Snap installations. Native packages use the standard XDG
autostart directory. Sandboxed packages request permission through the XDG
Background Portal and may show a one-time system prompt. Startup state is
coordinated across vaults so disabling it in one vault does not remove a
request still owned by another vault.

## Installation

### Community Plugins

After publication, open **Settings → Community plugins → Browse**, search for
**Run in Background**, select it, and choose **Install**, then **Enable**.

### BRAT

Before community publication, install
[BRAT](https://obsidian.md/plugins?id=obsidian42-brat), choose **Add beta
plugin**, and enter:

```text
gabrielbacha/run-in-background
```

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from a matching
[GitHub release](https://github.com/gabrielbacha/run-in-background/releases),
then place them in:

```text
<vault>/.obsidian/plugins/run-in-background/
```

Reload Obsidian and enable **Run in Background** under Community plugins.

## Using the tray menu

Each vault menu contains:

- **Show Vault** and **Hide Vault**
- **Open Plugin Settings**
- **Relaunch Obsidian**
- **Close Vault**

The menu header and tooltip identify the active vault as `Vault: <name>`.

## Troubleshooting

### The vault is running but no window is visible

Click Obsidian in the Dock/taskbar, launch Obsidian again, or choose **Show
Vault** from its tray menu.

### Cmd+Q does not terminate Obsidian

Disable **Keep running after Quit command**, or use **Close Vault** from the
tray menu. Logout, restart, and shutdown always bypass this setting.

### I cannot find either the Dock icon or tray icon

Run in Background prevents this combination in its own settings. Launch
Obsidian again to restore the vault if another application or macOS preference
temporarily hides the icons.

### Linux opens visibly after login

Select **Only when opened at login** under **Hide on launch** and enable
**Launch on startup** from this plugin. Remove duplicate Obsidian entries from
your desktop environment's startup-applications tool so the unmarked launcher
does not start a second visible session.

Linux uses one plugin-owned startup entry, targeted at one enabled vault. Once
Obsidian is ready, that vault opens the other startup-enabled vaults through
Obsidian's URI protocol. This avoids process-singleton races while ensuring a
vault still starts after it was explicitly closed in the previous session.
Per-vault marker records coordinate the enabled set. The plugin automatically
removes the competing per-vault desktop entries created by version 1.3.3.
Each Linux vault publishes its tray item on an independent D-Bus connection,
avoiding Electron's shared StatusNotifierItem collision when several vaults are
open in one Obsidian process.

### Sync pauses after hiding a Linux window

Version 1.3.2 and newer disables Electron background throttling for hidden
vault windows. Update the plugin and fully restart Obsidian so the new window
lifecycle is active.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, pull-request,
and release instructions. Report vulnerabilities privately through the
repository's GitHub Security Advisories.

## Attribution and license

Run in Background is a maintained fork of
[dragonwocky/obsidian-tray](https://github.com/dragonwocky/obsidian-tray),
originally created by dragonwocky. The original project and this fork are
distributed under the [MIT License](LICENSE).

The Obsidian name and logo are trademarks of Obsidian. The bundled logo is
used to identify Obsidian and follows the
[Obsidian brand guidelines](https://obsidian.md/brand).

---

<div align="center">
  <h3>Created by <a href="https://github.com/gabrielbacha">Gabriel Bacha</a></h3>
  <p>
    <a href="https://www.gabrielbacha.com/?utm_source=obsidian_community&amp;utm_medium=referral&amp;utm_campaign=obsidian_assets&amp;utm_content=run_in_background_readme_header"><strong>Visit gabrielbacha.com</strong></a>
    &nbsp;·&nbsp;
    <a href="https://obsidian.md/plugins?search=Gabriel%20Bacha"><strong>Explore more Obsidian plugins</strong></a>
    &nbsp;·&nbsp;
    <a href="https://github.com/gabrielbacha/Obsidian-Run-in-background/issues/new?template=feature_request.yml"><strong>Request a feature</strong></a>
  </p>
</div>

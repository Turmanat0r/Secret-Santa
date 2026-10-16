# Secret Santa

Organise a Secret Santa gift exchange on your own computer. Enter the names, set
who can't draw whom, make the draw, and reveal it privately, as scratch cards or
as printed slips. Nothing ever goes over the internet.

## Install

From the project folder, in a PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

What you get:

- **Secret Santa in your Start menu**, installed for your Windows account only
  (under `%LOCALAPPDATA%\Programs`). No administrator rights are needed.
- **A portable copy** at `release\SecretSanta-1.0.0-portable.exe`. It runs from
  anywhere with no install, which is useful if an installer is blocked.
- **The installer itself** at `release\SecretSanta-1.0.0-setup.exe`, to copy to
  another PC.

The first run downloads the build tools (Node packages and Electron), which
takes a few minutes. Windows Defender scans every downloaded file, so it's slower
than it looks like it should be. That's normal. After that, setup takes about a
minute.

If Node.js isn't installed, setup offers to install it with `winget` and asks
first. That one step needs administrator approval. Everything else runs as you.

Other things the same script does:

| Command | What it does |
|---|---|
| `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Check` | Reports what's installed and what's missing. Changes nothing. |
| `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Test` | Builds, then runs every test (about 2-3 minutes). |
| `powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall` | Removes the app, its shortcut and everything setup built. **Keeps your data.** |

### "Windows protected your PC"

The installer and the portable copy aren't signed with a code-signing
certificate, so on a computer they were **copied or downloaded to**, Windows
SmartScreen stops them the first time with a blue "Windows protected your PC"
box, and the Run button is hidden. To get past it:

1. Click **More info**.
2. Click **Run anyway**.

That's expected for any unsigned program, not a fault. The real fix is to sign
the files with an Authenticode code-signing certificate; electron-builder signs
both the installer and the program inside it automatically once one is
configured (`CSC_LINK` / `CSC_KEY_PASSWORD`). On the computer where you run
`setup.ps1` itself, nothing is downloaded, so SmartScreen doesn't step in.

Don't turn SmartScreen off to avoid this.

### Where it was tested

- **Launched and tested on:** Windows 11 Home, version 26H2 (build 26300.9711),
  x64. Hybrid laptop graphics (NVIDIA RTX 2070 Super Max-Q; Windows listed only
  the NVIDIA adapter on this machine). Standard user account, not administrator.
- **Should work, not verified:** other Windows 11 versions and editions, and
  Windows 10 22H2 x64.
- **Not supported:** 32-bit or ARM Windows (no build is made for them).

## Using it

1. **Names**: type one per line, or **Import names** from a text file (commas
   and tabs also separate names, so a row copied from a spreadsheet works).
2. **Details**: the exchange name, budget, date and a note appear on the reveal
   and on the slips.
3. **Keep-apart rules**: pairs who mustn't draw each other, such as partners.
4. **Generate assignments**: everyone gives once and receives once. Nobody
   draws themselves, nobody breaks a keep-apart rule, and (if ticked) nobody
   draws the person who drew them, or repeats a pair from a saved previous year.
5. **Reveal**:
   - **Private reveal**: each person picks their name and sees only their own
     match, with that person's gift clues.
   - **Scratch cards**: scratch with the mouse; double-click to uncover all at
     once.
   - **Print secret slips** or **Save slips as PDF**: two to a page, to cut and
     hand out.
6. **Previous years**: save each finished draw so next year's draw can avoid
   repeating pairs.

Everything is saved as you type; the header says **All changes saved**.

## Your data

- Kept in `%APPDATA%\Secret Santa` (open it with **Open data folder** in the
  app). It's the only place the app writes.
  - `exchange.json` holds everything you made.
  - `exchange.previous.json` is a copy taken each time the app opens, used to
    recover if `exchange.json` is ever damaged.
  - `settings.json` holds the window size and position, and the graphics mode.
  - `logs\main.log` is technical detail for troubleshooting. Names and draws are
    never written to it.
  - `chromium\` holds the browser engine's own caches. The app keeps nothing of
    yours there, and it's safe to delete while Secret Santa is closed.
- **Export backup** saves everything to a file you choose. **Import backup**
  reads one back, including backups from the older single-file browser version
  (`secret-santa-offline-plus.html`). That's how to move your old exchange over.
- Uninstalling never deletes this folder.

### If something goes wrong

The app never shows a blank window or a wall of error text. Each problem gets
one sentence and a choice:

- **Your exchange file is damaged.** The app leaves it exactly as it is and
  asks you to choose:
  - restore the copy from the last time it opened;
  - set the damaged file aside and start fresh (it's renamed, never deleted);
  - open the data folder; or
  - quit.
- **The window settings are damaged.** They're reset automatically, the old file
  is kept, and a note at the top of the window says so.
- **Part of the program is missing.** The app says which part, and to run
  `setup.ps1` again.
- **The window crashes.** You're offered to reopen it. Nothing saved is lost.
- **The window is blank or the graphics driver crashes.** See below.

### Graphics (blank or black window)

On some laptops, especially ones with two graphics chips, Chromium-based apps
can open a blank or black window. Secret Santa checks that its window actually
drew something:

1. If it didn't, or the graphics process crashed, the app **restarts once by
   itself** using OpenGL instead of Direct3D. That still uses the graphics card.
   A Windows message says it did this, and the app remembers the mode that
   worked.
2. If that also fails, it **offers** to restart with graphics acceleration
   turned off. That's slower, but works everywhere.
3. Over **Remote Desktop**, which has no graphics card, it starts with
   acceleration off automatically.

To force a mode, set the environment variable `SECRET_SANTA_GRAPHICS` to
`default`, `angle-gl` or `software`. To forget a remembered mode, delete
`settings.json` from the data folder.

## Network

```
Network:      none
Origins:      none
Purpose:      none - the app never uses the network
Offline gap:  nothing
Conflicts:    not applicable - there is no sync (see "Importing" below)
Credentials:  none
```

Secret Santa is fully usable with the network cable pulled out, because it never
uses the network at all.

- The window is drawn only from files inside the app.
- Its Content Security Policy allows no remote anything (`connect-src 'none'`).
- Every request that isn't the app's own page is cancelled.
- Chromium's own background networking is switched off at the source:
  - background fetches and component updates
  - reliability reports and hyperlink pings
  - secure-DNS probes and network media discovery
  - **proxy auto-discovery (WPAD)**, which Windows otherwise triggers at every
    start-up

There's no telemetry, crash reporting, update check, remote font or analytics.

**Importing a backup** is the only time two copies of an exchange meet. The
backup's names, details, rules, draw and wish lists replace the current ones.
Previous years are combined, so none is lost and none is duplicated. A copy of
the exchange as it was just before is kept in the data folder
(`exchange.before-import-<date>.json`), so nothing is ever discarded silently.

## For changing the code

Everything is TypeScript, plus the HTML and CSS for the window and this one
PowerShell setup script.

| Where | What |
|---|---|
| `src/main/main.ts` | The main process: startup, the window, security, graphics recovery, everything the window can ask for, shutdown. |
| `src/main/santa.ts` | The exchange itself: the draw, checking data, backups. No Electron, so it's easy to test. |
| `src/main/storage.ts` | Files: safe saving, damaged files, the requirements walk, settings, the log. |
| `src/main/policy.ts` | The rules: network allowlist, Content Security Policy, Chromium switches, graphics fallbacks. |
| `src/main/preload.cts` | The only bridge between the window and the main process (`window.santa`). |
| `src/renderer/` | The window: `index.html`, `styles.css`, `app.ts`. It can't touch files or the network. |
| `src/shared/types.d.ts` | Types both sides agree on. Declarations only. |
| `requirements.json` | Everything the app needs to run, walked at every start and close. Add a requirement here, not in code. |
| `test/` | Tests, run against the real app (`setup.ps1 -Test`). |

Build output (`dist/`, `release/`, `src/renderer/app.js`) is never committed.

For a quick run during development, use `npm start` in a normal terminal. VS
Code's built-in tools set `ELECTRON_RUN_AS_NODE`, which stops Electron opening a
window; the tests and `setup.ps1` clear it, and the installed app ignores it.

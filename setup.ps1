<#
.SYNOPSIS
  Sets up Secret Santa: installs what's missing, builds it, and adds it to the Start menu.

.DESCRIPTION
  Run it from the project folder with:

      powershell -ExecutionPolicy Bypass -File .\setup.ps1

  Every other operation is a flag on this same script:

      -Check      Report what's missing and what's already done. Changes nothing.
      -Test       Build, then run all the tests.
      -Uninstall  Remove everything this script created. Your Secret Santa data is kept.

  Works in Windows PowerShell 5.1 (built into Windows). Needs no administrator
  rights, except to install Node.js if it's missing - and then it asks first.
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Test,
    [switch]$Uninstall
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Where things are
# ---------------------------------------------------------------------------

$ProjectDir   = $PSScriptRoot
$AppName      = 'Secret Santa'
$DataDir      = Join-Path $env:APPDATA $AppName
$StartMenu    = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$ReleaseDir   = Join-Path $ProjectDir 'release'
$NodeMinimum  = [version]'22.18.0'   # oldest Node that runs the TypeScript tests directly
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

# Editors such as VS Code set this for programs they start; it would make
# Electron run as plain Node with no window. It is never wanted here.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Say([string]$Text) { Write-Host $Text }
function Good([string]$Text) { Write-Host "  [ok]      $Text" -ForegroundColor Green }
function Missing([string]$Text) { Write-Host "  [missing] $Text" -ForegroundColor Yellow }
function Note([string]$Text) { Write-Host "  [note]    $Text" -ForegroundColor Cyan }

# Print one plain sentence saying what went wrong, and stop.
function Stop-Setup([string]$Sentence) {
    Write-Host ''
    Write-Host $Sentence -ForegroundColor Red
    exit 1
}

# Ask a yes/no question. Anything but "y" or "yes" means no.
function Ask-YesNo([string]$Question) {
    $answer = Read-Host "$Question [y/N]"
    return ($answer -match '^(y|yes)$')
}

# The app's version, from package.json.
function Get-AppVersion {
    $package = Get-Content (Join-Path $ProjectDir 'package.json') -Raw | ConvertFrom-Json
    return [string]$package.version
}

# Name of the sync service if the project is inside a synced folder, else $null.
function Get-SyncedFolderName {
    $path = $ProjectDir.ToLowerInvariant()
    foreach ($name in @('OneDrive', 'iCloudDrive', 'iCloud Drive', 'Dropbox', 'Google Drive', 'Box')) {
        if ($path.Contains('\' + $name.ToLowerInvariant())) { return $name }
    }
    return $null
}

# The installed Node.js version, or $null if there isn't one.
function Get-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { return $null }
    $text = (& node --version) 2>$null
    if ($text -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    return $null
}

# Re-read PATH from the registry, so a program installed a moment ago is found.
function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# Run an npm command in the project folder, showing its output as it goes.
# Returns $true if it worked. Spots the Windows path-length limit by name.
function Invoke-Npm([string]$Arguments) {
    Push-Location $ProjectDir
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        cmd /c "npm $Arguments 2>&1" | Tee-Object -Variable lines | Out-Host
        $code = $LASTEXITCODE
        $ErrorActionPreference = $previous
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        $text = ($lines | Out-String)
        if ($text -match 'ENAMETOOLONG|path too long|filename or extension is too long|MAX_PATH') {
            Stop-Setup "The build failed because a file path got longer than Windows' 260-character limit. Move the project to a short folder such as C:\dev\secret-santa and run setup again."
        }
        return $false
    }
    return $true
}

# The installed copy's details from Windows' list of installed apps, or $null.
function Get-InstalledApp {
    if (-not (Test-Path $UninstallKey)) { return $null }
    foreach ($key in Get-ChildItem $UninstallKey) {
        $item = Get-ItemProperty $key.PSPath
        $props = $item.PSObject.Properties
        if ($null -ne $props['DisplayName'] -and [string]$item.DisplayName -like "$AppName*") {
            # The per-user installer doesn't record InstallLocation, so work the
            # folder out from the program's icon path, or else the uninstaller's.
            $location = ''
            if ($null -ne $props['InstallLocation']) { $location = [string]$item.InstallLocation }
            if ($location -eq '' -and $null -ne $props['DisplayIcon']) {
                $icon = ([string]$item.DisplayIcon) -replace ',\d+$', '' -replace '"', ''
                if ($icon -ne '') { $location = Split-Path $icon -Parent }
            }
            if ($location -eq '' -and $null -ne $props['UninstallString'] -and [string]$item.UninstallString -match '^"([^"]+)"') {
                $location = Split-Path $Matches[1] -Parent
            }
            $version = $null
            if ($null -ne $props['DisplayVersion']) { $version = [string]$item.DisplayVersion }
            return [pscustomobject]@{
                Key             = $key.PSPath
                Version         = $version
                InstallLocation = $location
                UninstallString = [string]$item.UninstallString
            }
        }
    }
    return $null
}

# The Start menu shortcut and the file it points at, or $null if there's no shortcut.
function Get-Shortcut {
    $path = Join-Path $StartMenu "$AppName.lnk"
    if (-not (Test-Path $path)) { return $null }
    $shell = New-Object -ComObject WScript.Shell
    $target = $shell.CreateShortcut($path).TargetPath
    return [pscustomobject]@{ Path = $path; Target = $target; TargetExists = (Test-Path $target) }
}

# Wait until Secret Santa isn't running, asking the person to close it.
function Wait-AppClosed {
    while ($null -ne (Get-Process -Name $AppName -ErrorAction SilentlyContinue)) {
        Read-Host "$AppName is open. Close it, then press Enter to continue" | Out-Null
    }
}

# ---------------------------------------------------------------------------
# -Check: report only
# ---------------------------------------------------------------------------

function Invoke-Check {
    Say "Secret Santa - checking (nothing will be changed)"
    Say ''
    $synced = Get-SyncedFolderName
    if ($null -ne $synced) { Missing "The project is inside $synced. Move it to a local folder such as C:\dev\secret-santa." }
    else { Good "Project folder is local: $ProjectDir" }
    if ($ProjectDir.Length -gt 60) { Note "The project path is $($ProjectDir.Length) characters long; a shorter one avoids Windows' path limit." }

    $longPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -ErrorAction SilentlyContinue)
    if ($null -ne $longPaths -and $longPaths.PSObject.Properties['LongPathsEnabled'] -and $longPaths.LongPathsEnabled -eq 1) { Good 'Windows long paths are turned on' }
    else { Note "Windows long paths are off, so keep the project at a short path (it is fine as long as builds work)." }

    $node = Get-NodeVersion
    if ($null -eq $node) { Missing 'Node.js is not installed' }
    elseif ($node -lt $NodeMinimum) { Missing "Node.js $node is too old; $NodeMinimum or newer is needed" }
    else { Good "Node.js $node" }
    if ($null -ne (Get-Command git -ErrorAction SilentlyContinue)) { Good 'git is installed (needed only for -Test)' }
    else { Note 'git is not installed (needed only for -Test)' }

    if (Test-Path (Join-Path $ProjectDir 'node_modules\.package-lock.json')) { Good 'Packages are installed (node_modules)' }
    else { Missing 'Packages are not installed yet' }
    if (Test-Path (Join-Path $ProjectDir 'node_modules\electron\dist\electron.exe')) { Good 'Electron is downloaded' }
    else { Missing 'Electron has not been downloaded yet' }
    if ((Test-Path (Join-Path $ProjectDir 'dist\main\main.js')) -and (Test-Path (Join-Path $ProjectDir 'src\renderer\app.js'))) { Good 'The app has been built' }
    else { Missing 'The app has not been built yet' }

    $version = Get-AppVersion
    $installer = Join-Path $ReleaseDir "SecretSanta-$version-setup.exe"
    if (Test-Path $installer) { Good "Installer built: release\SecretSanta-$version-setup.exe" }
    else { Missing "Installer not built yet (release\SecretSanta-$version-setup.exe)" }

    $installed = Get-InstalledApp
    if ($null -eq $installed) { Missing 'Secret Santa is not installed' }
    else {
        $exe = ''
        if ([string]$installed.InstallLocation -ne '') { $exe = Join-Path ([string]$installed.InstallLocation) "$AppName.exe" }
        if ($exe -ne '' -and (Test-Path $exe)) { Good "Installed: version $($installed.Version) in $($installed.InstallLocation)" }
        else { Missing "Windows lists Secret Santa as installed, but $exe is missing" }
    }
    $shortcut = Get-Shortcut
    if ($null -eq $shortcut) { Missing 'No Start menu shortcut' }
    elseif ($shortcut.TargetExists) { Good 'Start menu shortcut works' }
    else { Missing "The Start menu shortcut points at $($shortcut.Target), which doesn't exist" }

    if (Test-Path $DataDir) { Good "Your data folder: $DataDir" }
    else { Note "No data yet; it will be kept in $DataDir" }
    exit 0
}

# ---------------------------------------------------------------------------
# Getting ready to build (used by setup and -Test)
# ---------------------------------------------------------------------------

function Initialize-Build {
    $synced = Get-SyncedFolderName
    if ($null -ne $synced) {
        Stop-Setup "This project is inside $synced, which can damage files mid-save. Move it to a local folder with a short path, such as C:\dev\secret-santa, and run setup again."
    }
    if ($ProjectDir.Length -gt 60) {
        Note "The project path is long ($($ProjectDir.Length) characters). If the build fails, move it somewhere short like C:\dev\secret-santa."
    }

    # Node.js
    $node = Get-NodeVersion
    if ($null -eq $node -or $node -lt $NodeMinimum) {
        if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) {
            Stop-Setup "Secret Santa needs Node.js $NodeMinimum or newer to build, and winget (which could install it) isn't available on this computer. Install Node.js LTS from nodejs.org, then run setup again."
        }
        Say "Node.js $NodeMinimum or newer is needed to build Secret Santa, and isn't installed."
        Say 'Installing it needs administrator approval - Windows will ask.'
        if (-not (Ask-YesNo 'Install Node.js LTS now with winget?')) {
            Stop-Setup "Secret Santa can't be built without Node.js. Run setup again when you'd like to install it."
        }
        & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
        Update-PathFromRegistry
        $node = Get-NodeVersion
        if ($null -eq $node -or $node -lt $NodeMinimum) {
            Stop-Setup 'Node.js still is not available. Close this window, open a new PowerShell window, and run setup again.'
        }
    }
    Good "Node.js $node"

    # Packages: only reinstall when package-lock.json has changed since the last install.
    $marker = Join-Path $ProjectDir 'node_modules\.package-lock.json'
    $lock = Join-Path $ProjectDir 'package-lock.json'
    if ((-not (Test-Path $marker)) -or ((Get-Item $lock).LastWriteTime -gt (Get-Item $marker).LastWriteTime)) {
        Say 'Installing packages (Windows Defender scans every file, so this can take a few minutes)...'
        if (-not (Invoke-Npm 'ci --no-fund --no-audit')) { Stop-Setup 'Installing the packages failed. The messages above say why; running setup again often fixes a network hiccup.' }
    }
    Good 'Packages installed'

    # Electron downloads its program files on first use; do it now, while we're online.
    if (-not (Test-Path (Join-Path $ProjectDir 'node_modules\electron\dist\electron.exe'))) {
        Say 'Downloading Electron...'
        Push-Location $ProjectDir
        try { & node 'node_modules\electron\install.js' } finally { Pop-Location }
        if (-not (Test-Path (Join-Path $ProjectDir 'node_modules\electron\dist\electron.exe'))) {
            Stop-Setup "Electron couldn't be downloaded. Check the internet connection and run setup again."
        }
    }
    Good 'Electron downloaded'

    Say 'Building...'
    if (-not (Invoke-Npm 'run build')) { Stop-Setup 'The build failed. The messages above say which file and line.' }
    Good 'Built'
}

# ---------------------------------------------------------------------------
# -Test
# ---------------------------------------------------------------------------

function Invoke-Tests {
    Say 'Secret Santa - building and running the tests'
    Initialize-Build
    if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
        Stop-Setup 'The tests check what is committed to git, and git is not installed.'
    }
    Say 'Running the tests (each one starts the real app; this takes a few minutes)...'
    if (Invoke-Npm 'test') { Say ''; Say 'All tests passed.'; exit 0 }
    Stop-Setup 'Some tests failed - see the messages above.'
}

# ---------------------------------------------------------------------------
# -Uninstall
# ---------------------------------------------------------------------------

function Invoke-Uninstall {
    Say 'Secret Santa - uninstalling (your data will be kept)'
    Wait-AppClosed
    $installed = Get-InstalledApp
    if ($null -ne $installed) {
        $uninstaller = $null
        if ($installed.UninstallString -match '^"([^"]+)"') { $uninstaller = $Matches[1] }
        elseif ($installed.UninstallString -ne '') { $uninstaller = $installed.UninstallString }
        if ($null -ne $uninstaller -and (Test-Path $uninstaller)) {
            Say 'Removing the installed app...'
            Start-Process -FilePath $uninstaller -ArgumentList '/S', '/currentuser' -Wait | Out-Null
            # The uninstaller hands off to a copy of itself, so wait until it has really finished.
            $deadline = (Get-Date).AddSeconds(90)
            while ($null -ne (Get-InstalledApp) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        }
        if ($null -ne (Get-InstalledApp)) { Stop-Setup "The installed copy couldn't be removed. Remove $AppName from Settings > Apps, then run this again." }
        Good 'Installed app removed'
    } else {
        Good 'The app was not installed'
    }
    $shortcut = Get-Shortcut
    if ($null -ne $shortcut) { Remove-Item $shortcut.Path -Force; Good 'Start menu shortcut removed' }

    foreach ($relative in @('release', 'dist', 'node_modules')) {
        $path = Join-Path $ProjectDir $relative
        if (Test-Path $path) { Remove-Item $path -Recurse -Force; Good "Removed $relative" }
    }
    $script = Join-Path $ProjectDir 'src\renderer\app.js'
    if (Test-Path $script) { Remove-Item $script -Force; Good 'Removed src\renderer\app.js' }

    Say ''
    if (Test-Path $DataDir) { Say "Your Secret Santa data was kept in $DataDir" }
    exit 0
}

# ---------------------------------------------------------------------------
# Default: set everything up
# ---------------------------------------------------------------------------

function Invoke-Setup {
    Say 'Secret Santa - setting up'
    Initialize-Build

    Say 'Packaging the installer and the portable copy (this takes a minute or two)...'
    if (-not (Invoke-Npm 'run package')) { Stop-Setup 'Packaging failed. The messages above say why.' }
    $version = Get-AppVersion
    $installer = Join-Path $ReleaseDir "SecretSanta-$version-setup.exe"
    $portable = Join-Path $ReleaseDir "SecretSanta-$version-portable.exe"
    if (-not (Test-Path $installer)) { Stop-Setup "Packaging finished but the installer isn't there ($installer), so nothing was installed." }
    Good "Packaged release\SecretSanta-$version-setup.exe"

    Wait-AppClosed
    Say 'Installing for your Windows account only (no administrator rights needed)...'
    $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait -PassThru
    if ($process.ExitCode -ne 0) { Stop-Setup "The installer stopped with an error (code $($process.ExitCode))." }

    # Check what the installer did, and never leave a shortcut that opens nothing.
    $installed = Get-InstalledApp
    if ($null -eq $installed) { Stop-Setup "The installer finished, but Windows doesn't list Secret Santa as installed." }
    if ([string]$installed.InstallLocation -eq '') { Stop-Setup "The installer finished, but Windows doesn't say where Secret Santa was installed." }
    $exe = Join-Path ([string]$installed.InstallLocation) "$AppName.exe"
    if (-not (Test-Path $exe)) { Stop-Setup "The installer finished, but $exe is missing." }
    $shortcut = Get-Shortcut
    if ($null -ne $shortcut -and -not $shortcut.TargetExists) {
        Remove-Item $shortcut.Path -Force
        Stop-Setup "The Start menu shortcut pointed at something missing, so it was removed. Run setup again."
    }
    if ($null -eq $shortcut) { Stop-Setup "Secret Santa was installed to $exe, but no Start menu shortcut was made." }
    Good "Installed to $($installed.InstallLocation)"
    Good 'Added to the Start menu'

    Say ''
    Say "Done. Open Secret Santa from the Start menu."
    Say "  Your data is kept in:  $DataDir"
    if (Test-Path $portable) { Say "  Portable copy (no install needed): release\SecretSanta-$version-portable.exe" }
    exit 0
}

if ($Check) { Invoke-Check }
elseif ($Uninstall) { Invoke-Uninstall }
elseif ($Test) { Invoke-Tests }
else { Invoke-Setup }

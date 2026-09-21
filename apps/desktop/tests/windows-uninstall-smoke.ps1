<# Production uninstaller checks with isolated application identity and seeded data. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Language, [Parameter(Mandatory)][string]$PackageName)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
$copy = @{}
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-uninstall.json') -Raw | ConvertFrom-Json
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
    if ($_ -match ('^LangString (UNINSTALL_\w+) \$\{LANG_' + $Language + '\} "(.*)"$')) { $copy[$Matches[1]] = $Matches[2] }
}
$installPath = Join-Path $OutputDirectory 'Uninstall App'
$homePath = Join-Path $OutputDirectory 'Harness Home'
$desktopPath = Join-Path $homePath 'profiles/desktop'
$externalPath = Join-Path $OutputDirectory 'External Project'
$localPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $ProductName
$cachePath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ($PackageName + '-updater')
$uninstaller = Join-Path $OutputDirectory 'uninstall-copy.exe'
$process = $null
function Wait-Text([string]$Text) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $control = [InstallerCapture]::FindText($process.Id, $Text)
        if ($control -ne [IntPtr]::Zero) { return $control }
        if ($process.HasExited) { throw "Uninstaller exited: $($process.ExitCode)" }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 20)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($process.Id))"
}
function State([IntPtr]$Control) { return [InstallerCapture]::SendMessage($Control, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() }
function Wait-State([IntPtr]$Control, [int]$Expected) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ((State $Control) -ne $Expected) {
        if ($timer.Elapsed.TotalSeconds -gt 10) { throw "Checkbox state did not become $Expected" }
        Start-Sleep -Milliseconds 25
    }
}
function Wait-Exit {
    if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Uninstaller timed out' }
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
    $process.Dispose()
    $script:process = $null
}
try {
    foreach ($mode in $expected.cases) {
        $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
        try {
            if (-not $setup.WaitForExit(30000)) { $setup.Kill(); $setup.WaitForExit(); throw 'Setup timed out' }
            if ($setup.ExitCode -ne 0) { throw "Setup failed: $($setup.ExitCode)" }
        } finally { $setup.Dispose() }
        foreach ($path in @($desktopPath, $localPath, $cachePath, $externalPath)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
        [IO.File]::WriteAllText((Join-Path $externalPath 'keep.txt'), 'outside data root')
        if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'linked-project'))) {
            New-Item -ItemType Junction -Path (Join-Path $desktopPath 'linked-project') -Target $externalPath | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $homePath 'session.txt'), 'keep session')
        [IO.File]::WriteAllText((Join-Path $desktopPath 'plugin.txt'), 'desktop plugin')
        [IO.File]::WriteAllText((Join-Path $localPath 'draft.txt'), 'unsent draft')
        [IO.File]::WriteAllText((Join-Path $cachePath 'download.txt'), 'update')
        [IO.File]::WriteAllText((Join-Path $localPath 'uninstall.ini'), "[Harness]`r`nHome=$homePath`r`nHomeLength=$($homePath.Length)`r`n", [Text.Encoding]::Unicode)
        Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
        $arguments = '_?=' + $installPath
        if ($mode -eq 'silent') { $arguments = '/S --delete-app-data ' + $arguments }
        if ($mode -eq 'upgrade') { $arguments = '/S --updated ' + $arguments }
        $process = Start-Process -FilePath $uninstaller -ArgumentList $arguments -PassThru -WindowStyle Hidden
        if ($mode -notin @('silent', 'upgrade')) {
            $welcomeText = if ($Language -eq 'ENGLISH') { 'Welcome' } else { -join [char[]]@(0x6B22, 0x8FCE) }
            $welcome = Wait-Text $welcomeText
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            $all = Wait-Text $copy.UNINSTALL_ALL
            $desktop = Wait-Text $copy.UNINSTALL_DESKTOP
            $local = Wait-Text $copy.UNINSTALL_LOCAL
            if ((State $all) -ne $expected.defaultCleanupState -or (State $desktop) -ne $expected.defaultCleanupState -or (State $local) -ne $expected.defaultCleanupState) { throw 'Data removal defaults differ from the expected output' }
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-options.png'), $false)
            if ($mode -eq 'desktop' -or $mode -eq 'all') {
                [InstallerCapture]::Click($desktop)
                Wait-State $desktop 1
                [InstallerCapture]::Click($all)
                $warning = Wait-Text ($copy.UNINSTALL_ALL_WARNING.Split('$')[0])
                $dialog = [InstallerCapture]::TopLevel($warning)
                [void][InstallerCapture]::SaveNative($dialog, (Join-Path $OutputDirectory 'uninstall-warning.png'), $false)
                # Rejecting all-data cleanup must preserve the independently selected child.
                [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($dialog, 2))
                Wait-State $all 0
                if ((State $desktop) -ne 1) { throw 'Cancel changed the independent desktop selection' }
                if ($mode -eq 'all') {
                    [InstallerCapture]::Click($all)
                    $warning = Wait-Text ($copy.UNINSTALL_ALL_WARNING.Split('$')[0])
                    $dialog = [InstallerCapture]::TopLevel($warning)
                    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($dialog, 1))
                    Wait-State $desktop 1
                }
            }
            if ($mode -eq 'local') { [InstallerCapture]::Click($local); Wait-State $local 1 }
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            $finishedText = if ($Language -eq 'ENGLISH') { 'has been uninstalled' } else { -join [char[]]@(0x5DF2, 0x7ECF, 0x4ECE) }
            [void](Wait-Text $finishedText)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
        }
        Wait-Exit
        if (Test-Path -LiteralPath $installPath) { throw 'Application directory remained' }
        if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Cleanup followed a junction into a project' }
        if ((Test-Path (Join-Path $homePath 'session.txt')) -ne ($mode -ne 'all')) { throw "Session retention failed: $mode" }
        if ((Test-Path (Join-Path $desktopPath 'plugin.txt')) -ne ($mode -notin @('all', 'desktop'))) { throw "Profile retention failed: $mode" }
        if ((Test-Path (Join-Path $localPath 'draft.txt')) -ne ($mode -ne 'local')) { throw "Local data retention failed: $mode" }
        if ((Test-Path (Join-Path $cachePath 'download.txt')) -ne ($mode -ne 'local')) { throw "Update cache retention failed: $mode" }
        Write-Output "passed: $mode"
    }
} finally {
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    # Only unique test identities below known application-data parents are removed.
    foreach ($pair in @(@($localPath, [Environment]::GetFolderPath('ApplicationData')), @($cachePath, [Environment]::GetFolderPath('LocalApplicationData')))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1] -or -not ([IO.Path]::GetFileName($target).StartsWith('Harness Installer Test ') -or [IO.Path]::GetFileName($target).StartsWith('harness-installer-test-'))) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}

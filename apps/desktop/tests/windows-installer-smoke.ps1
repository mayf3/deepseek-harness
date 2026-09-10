<# Native installation checks use a unique product identity and a private directory. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey,
    [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
[InstallerCapture]::ProductName = $ProductName
$installPath = Join-Path $OutputDirectory 'Installed App'
$appPath = Join-Path $installPath ($ProductName + '.exe')
$uninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[string]]::new()
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-installer.json') -Raw | ConvertFrom-Json
$copy = @{}
$locale = if ([Globalization.CultureInfo]::InstalledUICulture.TwoLetterISOLanguageName -eq 'zh') { 'SIMPCHINESE' } else { 'ENGLISH' }
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
    if ($_ -match ('^LangString (INSTALLER_\w+) \$\{LANG_' + $locale + '\} "(.*)"$')) { $copy[$Matches[1]] = $Matches[2] }
}
function Wait-Control([Diagnostics.Process]$Process, [string]$Text, [switch]$Dialog) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Process exited before '$Text': $($Process.ExitCode)" }
        $control = if ($Dialog) { [InstallerCapture]::FindDialogText($Process.Id, $Text) } else { [InstallerCapture]::FindText($Process.Id, $Text) }
        if ($control -ne [IntPtr]::Zero) { return $control }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($Process.Id))"
}
function Start-Setup([string]$Theme, [string]$Path = $installPath) {
    $arguments = '/THEME=' + $Theme
    if ($Path) { $arguments += ' /D=' + $Path }
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $processes.Add($process)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($process.HasExited) { throw "Setup exited: $($process.ExitCode)" }
        $window = [InstallerCapture]::Find($process.Id)
        if ($window -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    [InstallerCapture]::Reveal($window)
    [void](Wait-Control $process $copy.INSTALLER_INSTALL)
    return $process
}
function Click-Control([Diagnostics.Process]$Process, [string]$Text) {
    [InstallerCapture]::Click((Wait-Control $Process $Text))
}
function Dismiss([Diagnostics.Process]$Process, [string]$Text) {
    $control = Wait-Control $Process $Text -Dialog
    $dialog = [InstallerCapture]::TopLevel($control)
    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($dialog, 2))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::IsWindow($dialog)) {
        if ($timer.Elapsed.TotalSeconds -gt 10) { throw 'Dialog did not close' }
        Start-Sleep -Milliseconds 25
    }
}
function Finish-Setup([Diagnostics.Process]$Process, [bool]$Launch, [string]$Theme) {
    [void](Wait-Control $Process $copy.INSTALLER_FINISH)
    $checkbox = Wait-Control $Process $copy.INSTALLER_LAUNCH
    $state = [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($state -ne $expected.launchCheckboxState) { throw 'Unexpected launch checkbox default' }
    if (-not $Launch) {
        [InstallerCapture]::Click($checkbox)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) {
            if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Checkbox did not toggle' }
            Start-Sleep -Milliseconds 25
        }
    }
    $window = [InstallerCapture]::Find($Process.Id)
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory ($Theme + '-finish.png')))
    if ($Launch) {
        $finish = Wait-Control $Process $copy.INSTALLER_FINISH
        [void][InstallerCapture]::SendMessage($window, 0x28, $finish, [IntPtr]1)
        [void][InstallerCapture]::PostMessage($finish, 0x100, [IntPtr]13, [IntPtr]::Zero)
    } else {
        Click-Control $Process $copy.INSTALLER_FINISH
    }
    if (-not $Process.WaitForExit(10000) -or $Process.ExitCode -ne 0) { throw 'Finish did not exit successfully' }
}
function Run-Silent([string]$Arguments, [int]$Code) {
    $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    $processes.Add($process)
    if (-not $process.WaitForExit(60000)) { throw 'Silent setup did not exit' }
    if ($process.ExitCode -ne $Code) { throw "Silent setup returned $($process.ExitCode), expected $Code" }
}
try {
    $process = Start-Setup light
    $window = [InstallerCapture]::Find($process.Id)
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-welcome.png'))
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    $edit = Wait-Control $process $installPath
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-path.png'))
    Click-Control $process $copy.INSTALLER_BROWSE
    Dismiss $process $copy.INSTALLER_CHOOSE_PATH
    [void][InstallerCapture]::SendMessage($window, 0x28, $edit, [IntPtr]1)
    [void][InstallerCapture]::SendMessage($edit, 0xC, [IntPtr]::Zero, 'C:\Windows\Harness Installer Test')
    [void][InstallerCapture]::PostMessage($edit, 0x100, [IntPtr]13, [IntPtr]::Zero)
    Dismiss $process $copy.INSTALLER_PATH_INVALID
    [void][InstallerCapture]::SendMessage($edit, 0xC, [IntPtr]::Zero, $installPath)
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $false light
    if (-not (Test-Path -LiteralPath $appPath) -or (Test-Path -LiteralPath (Join-Path $installPath 'launched.txt'))) { throw 'Unchecked launch behavior failed' }
    $results.Add('enter-validates-current-path-and-unchecked-launch')

    $process = Start-Setup dark ''
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    [void](Wait-Control $process $installPath)
    [void][InstallerCapture]::Save([InstallerCapture]::Find($process.Id), (Join-Path $OutputDirectory 'dark-welcome.png'))
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $true dark
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $app = Get-Process -Name $ProductName -ErrorAction SilentlyContinue
        if ($app) { break }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 15)
    if (-not $app -or $app.Path -ne $appPath) { throw 'Finish did not launch the installed test application' }
    $processes.Add($app)
    $results.Add('registered-directory-and-checked-launch')

    $process = Start-Setup dark
    Click-Control $process $copy.INSTALLER_INSTALL
    [void](Wait-Control $process $copy.INSTALLER_RUNNING -Dialog)
    $visible = [InstallerCapture]::VisibleText($process.Id)
    if ($visible.Contains('msctls_progress32') -ne $expected.nativeProgressVisible) { throw 'Stock green progress bar is visible' }
    if (-not $visible.Contains('HarnessInstallerProgress')) { throw 'Custom progress page is missing' }
    [void][InstallerCapture]::Save([InstallerCapture]::Find($process.Id), (Join-Path $OutputDirectory 'dark-progress.png'))
    Dismiss $process $copy.INSTALLER_RUNNING
    if (-not $process.WaitForExit(10000) -or $app.HasExited) { throw 'Running application was not preserved' }
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Test application did not exit' }
    $results.Add('running-app-preserved-and-native-progress-hidden')

    $otherPath = Join-Path $OutputDirectory 'Other Installation'
    New-Item -ItemType Directory -Path $otherPath | Out-Null
    $otherApp = Join-Path $otherPath ($ProductName + '.exe')
    Copy-Item -LiteralPath $appPath -Destination $otherApp
    $otherProcess = Start-Process -FilePath $otherApp -PassThru -WindowStyle Hidden
    $processes.Add($otherProcess)
    [void](Wait-Control $otherProcess 'Installer test application is running.' -Dialog)
    Run-Silent '/S --updated' 0
    if ($otherProcess.HasExited) { throw 'Unrelated installation was stopped' }
    Dismiss $otherProcess 'Installer test application is running.'
    if (-not $otherProcess.WaitForExit(10000)) { throw 'Unrelated test application did not exit' }
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'Silent update moved the registered installation' }
    $registration = Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)
    if ($registration.InstallLocation.TrimEnd('\') -ne $installPath) { throw 'Silent update changed InstallLocation' }
    $results.Add('silent-update-retains-directory-and-ignores-unrelated-process')
    Run-Silent ('/S /allusers /D=' + $installPath) 2
    $foreign = Join-Path $OutputDirectory 'Foreign App'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    Set-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Value 'preserved'
    Run-Silent ('/S /D=' + $foreign) 2
    if ((Get-Content -LiteralPath (Join-Path $foreign 'keep.txt')) -ne 'preserved') { throw 'Foreign directory changed' }
    $results.Add('invalid-destination-rejection')
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
        if (-not $uninstallProcess.WaitForExit(60000)) { $uninstallProcess.Kill(); $uninstallProcess.WaitForExit(); throw 'Test uninstaller timed out' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (Test-Path -LiteralPath $appPath) {
            if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Test installation was not removed' }
            Start-Sleep -Milliseconds 50
        }
        $uninstallProcess.Dispose()
    }
}
$results.Add('uninstall')
if (Compare-Object @($expected.cases) @($results)) { throw 'Installer results differ from expected behavior' }
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'results.json') -Encoding UTF8
$results | ForEach-Object { Write-Output "PASS: $_" }

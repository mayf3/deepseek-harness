param([string]$Worker, [string]$Root)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. $Worker
$identity = [Guid]::NewGuid().ToString('N')
$keyRoot = 'Software\DeepSeekHarness\CommandTests\' + $identity
$environmentKey = $keyRoot + '\Environment'
$ownerKey = $keyRoot + '\Owner'
$options = @{ EnvironmentKey=$environmentKey; OwnerKey=$ownerKey; MachinePath=''; MutexName=('Local\DshCommandTest-' + $identity) }
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey)
    try { return $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
}
function State([string]$Directory) { return Invoke-DshCommandPath @options -Request @{ operation='inspect'; directory=$Directory } }
function Apply([string]$Operation, [string]$Directory) {
    $state = State $Directory
    return Invoke-DshCommandPath @options -Request @{ operation=$Operation; directory=$Directory; expected=$state.fingerprint }
}
try {
    $desktop = Join-Path $Root ('Desktop space ' + [char]0x4e2d + [char]0x6587)
    $other = Join-Path $Root 'Other Desktop'
    $npm = Join-Path $Root 'npm'
    $system = Join-Path $Root 'system'
    New-Item -ItemType Directory -Force $desktop, $other, $npm, $system | Out-Null
    [IO.File]::WriteAllText((Join-Path $desktop 'dsh.exe'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $other 'dsh.exe'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $npm 'dsh.cmd'), 'fixture')
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
    try { $key.SetValue('Path', $npm, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    $before = State $desktop
    Require ($before.activeCommand -eq (Join-Path $npm 'dsh.cmd')) 'existing npm command was not detected'
    [void](Apply 'install' $desktop)
    Require ((UserPath) -eq ($desktop + ';' + $npm)) 'installation changed unrelated PATH entries'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', (UserPath) + ';extra-user-entry', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq ($npm + ';extra-user-entry')) 'removal lost concurrent user entries'
    $stale = State $desktop
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', (UserPath) + ';newer-entry', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    $rejected = $false
    try { [void](Invoke-DshCommandPath @options -Request @{ operation='install'; directory=$desktop; expected=$stale.fingerprint }) }
    catch { $rejected = $_.Exception.Data['code'] -eq 'ESTALE' }
    Require $rejected 'stale confirmation was accepted'
    [void](Apply 'install' $desktop)
    [void](Apply 'install' $other)
    $newer = UserPath
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $newer) 'old uninstaller removed the newer command'
    Require ((State $other).managed) 'old uninstaller deleted newer ownership'
    [IO.File]::WriteAllText((Join-Path $system 'dsh.exe'), 'fixture')
    $options.MachinePath = $system
    Require ((State $other).activeCommand -eq (Join-Path $system 'dsh.exe')) 'machine PATH precedence was hidden'
    [void](Apply 'remove' $other)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    $manualPath = $npm + ';' + $desktop + ';' + $desktop
    try { $key.SetValue('Path', $manualPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'unowned manual PATH entries were removed'
    [void](Apply 'install' $desktop)
    [void](Apply 'install' $desktop)
    Require ((UserPath) -eq ($desktop + ';' + $manualPath)) 'repair adopted or duplicated manual PATH entries'
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'removal did not preserve preexisting duplicates'
    [void](Apply 'install' $desktop)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', $manualPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'removal deleted a retained entry after the owned entry was removed manually'
    'WINDOWS_COMMAND_PATH_OK'
} finally {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyRoot, $false)
}

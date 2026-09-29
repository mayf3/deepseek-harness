<# Installer/uninstaller adapter for the same per-user PATH transaction used by Desktop. #>
param(
    [ValidateSet('install','remove')][string]$Operation,
    [Parameter(Mandatory)][string]$Directory,
    [string]$Language = '1033',
    [switch]$Silent
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'command-path.ps1')
try {
    $locales = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'command-messages.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $messages = if ($Language -eq '2052') { $locales.zh } else { $locales.en }
    $machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
    try { $machinePath = [string]$machine.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $machine.Dispose() }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $options = @{ EnvironmentKey='Environment'; OwnerKey='Software\DeepSeekHarness\Command'; MachinePath=$machinePath; MutexName=('Global\DeepSeekHarness.Command.' + $sid) }
    $state = Invoke-DshCommandPath @options -Request @{ operation='inspect'; directory=$Directory }
    $previousDesktop = $state.ownedDirectory -and $state.activeCommand -and
        [string]::Equals($state.activeCommand, (Join-Path $state.ownedDirectory 'dsh.cmd'), [StringComparison]::OrdinalIgnoreCase)
    if ($Operation -eq 'install' -and $state.activeCommand -and -not $previousDesktop) {
        if ($Silent) { exit 2 }
        Add-Type -AssemblyName System.Windows.Forms
        $text = $messages.cliCommandSwitch + [Environment]::NewLine + [Environment]::NewLine +
            $messages.cliCommandSelected.Replace('{path}', $state.activeCommand) + [Environment]::NewLine + [Environment]::NewLine +
            $messages.cliCommandPreserve
        $choice = [Windows.Forms.MessageBox]::Show($text, $messages.cliCommandTitle, [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Question, [Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($choice -ne [Windows.Forms.DialogResult]::Yes) { exit 0 }
    }
    $result = Invoke-DshCommandPath @options -Request @{ operation=$Operation; directory=$Directory; expected=$state.fingerprint }
    Send-DshCommandEnvironmentChange
    if (-not $Silent -and $Operation -eq 'install' -and $result.activeCommand -and
        -not [string]::Equals($result.activeCommand, (Join-Path $Directory 'dsh.cmd'), [StringComparison]::OrdinalIgnoreCase)) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show($messages.cliCommandShadowed, $messages.cliCommandTitle)
    }
} catch {
    exit 1
}

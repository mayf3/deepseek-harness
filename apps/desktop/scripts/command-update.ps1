<# Native installer handoff; only the matching transaction can be cancelled or removed. #>
param(
    [ValidateSet('prepare','finish')][string]$Operation,
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$Token,
    [string]$Version = 'uninstall'
)
$ErrorActionPreference = 'Stop'
if ($Token -notmatch '^[A-Za-z0-9.+-]{1,128}$' -or $Version -notmatch '^[A-Za-z0-9.+-]{1,128}$') { exit 1 }
$control = Join-Path $Application 'resources\runtime\cli\cli-control.exe'
$executable = Join-Path $Application 'DeepSeek Harness.exe'
$process = $null
try {
    if ($Operation -eq 'finish' -and -not (Test-Path -LiteralPath $executable)) {
        $directory = [IO.DirectoryInfo]::new($Application)
        $marker = Join-Path $directory.Parent.FullName ('.' + $directory.Name + '.dsh-cli-update')
        if (Test-Path -LiteralPath $marker) {
            $item = Get-Item -LiteralPath $marker -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4096) { exit 1 }
            $lines = [IO.File]::ReadAllLines($marker)
            if ($lines.Length -eq 4 -and $lines[0] -eq 'DSH_CLI_UPDATE_1' -and $lines[2] -eq $Token) { [IO.File]::Delete($marker) }
        }
        exit 0
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $control
    $start.Arguments = if ($Operation -eq 'prepare') { 'hold ' + $Token + ' ' + $Version } else { 'cancel ' + $Token }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($Operation -eq 'prepare') {
        $ready = $process.StandardOutput.ReadLineAsync()
        if (-not $ready.Wait(15000) -or $ready.Result -ne 'READY') {
            if ($process.HasExited -and $process.ExitCode -eq 75) { exit 75 }
            throw 'CLI controller did not become ready.'
        }
        $process.StandardInput.WriteLine('HANDOFF')
        $committed = $process.StandardOutput.ReadLineAsync()
        if (-not $committed.Wait(15000) -or $committed.Result -ne 'COMMITTED') { throw 'CLI handoff was not committed.' }
    }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(15000)) { throw 'CLI controller did not exit.' }
    exit $process.ExitCode
} catch {
    exit 1
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

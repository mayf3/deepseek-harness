$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$probeRoot = Join-Path $temporaryRoot 'dsh-win32-abi-probes'
New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null

$vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "Visual Studio locator not found: $vswhere" }
$vsInstall = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $vsInstall) { throw 'Visual Studio C++ build tools not found' }
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "MSVC environment script not found: $vcvars" }

$processProbe = Join-Path $probeRoot 'win32-process.exe'
$processObject = Join-Path $probeRoot 'win32-process.obj'
$processSource = Join-Path $repoRoot 'packages/subprocess/win32-process/verify/abi-probe.cpp'
$sandboxProbe = Join-Path $probeRoot 'sandbox-windows-acl.exe'
$sandboxObject = Join-Path $probeRoot 'sandbox-windows-acl.obj'
$sandboxSource = Join-Path $repoRoot 'packages/sandbox/sandbox-windows-acl/verify/abi-probe.cpp'

$probeCommand = "call `"$vcvars`" && cl /nologo /std:c++20 /EHsc /W4 /Fo:`"$processObject`" /Fe:`"$processProbe`" `"$processSource`" && `"$processProbe`" && cl /nologo /std:c++20 /EHsc /W4 /Fo:`"$sandboxObject`" /Fe:`"$sandboxProbe`" `"$sandboxSource`" advapi32.lib && `"$sandboxProbe`""
& cmd.exe /d /s /c $probeCommand
if ($LASTEXITCODE -ne 0) { throw 'Win32 ABI probe compilation or execution failed' }

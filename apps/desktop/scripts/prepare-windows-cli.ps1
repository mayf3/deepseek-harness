<# Compile the console CLI and private update controller for the Desktop x64 runtime. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
New-Item -ItemType Directory -Force (Join-Path $output 'bin') | Out-Null
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../cli/launcher.cpp'))
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Desktop CLI preparation requires Visual Studio C++ Build Tools.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ Build Tools are missing.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
foreach ($name in @('dsh', 'cli-control')) {
    $definition = if ($name -eq 'cli-control') { '/DDSH_CLI_CONTROL=1' } else { '' }
    $script = Join-Path $output "compile-$name.cmd"
    $object = Join-Path $output "$name.obj"
    $executable = if ($name -eq 'dsh') { Join-Path $output 'bin\dsh.exe' } else { Join-Path $output "$name.exe" }
    $setup = 'call "{0}" >nul' -f $vcvars.Replace('%', '%%')
    $compile = 'cl /nologo /std:c++17 /MT /O2 /W4 /WX /EHsc {0} "{1}" /Fo"{2}" /Fe"{3}"' -f $definition, $source.Replace('%', '%%'), $object.Replace('%', '%%'), $executable.Replace('%', '%%')
    [IO.File]::WriteAllLines($script, @('@echo off', $setup, 'if errorlevel 1 exit /b %errorlevel%', $compile), [Text.Encoding]::Default)
    & $env:ComSpec /d /v:off /c $script
    if ($LASTEXITCODE -ne 0) { throw "Desktop CLI compilation failed: $name" }
    Remove-Item -LiteralPath $script, $object
}

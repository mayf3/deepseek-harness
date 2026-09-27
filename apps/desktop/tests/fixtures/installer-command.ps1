<# Record the native installer's command choice without changing the user's PATH. #>
param(
    [ValidateSet('install','remove')][string]$Operation,
    [Parameter(Mandatory)][string]$Directory,
    [string]$Language,
    [switch]$Silent
)
$ErrorActionPreference = 'Stop'
@{ operation=$Operation; directory=$Directory; language=$Language; silent=[bool]$Silent } |
    ConvertTo-Json -Compress |
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'command-actions.jsonl') -Encoding UTF8

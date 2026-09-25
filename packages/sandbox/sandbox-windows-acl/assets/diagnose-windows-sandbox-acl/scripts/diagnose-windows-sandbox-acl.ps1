<#
.SYNOPSIS
    Read-only diagnosis, and whitelisted repair, of Windows ACL objects that the
    DSH sandbox cannot open.

.DESCRIPTION
    A denial inside the DSH sandbox is worth diagnosing only when it contradicts
    what the active mode promises: writes inside the workspace, or reads that the
    signed-in user should plainly have. This script reports why such an object is
    unreadable or unopenable, and repairs exactly one class of cause.

    Diagnosis (the default) never writes anything: it reads each requested path
    and every ancestor with .NET and native icacls, and prints machine-parseable
    lines for the caller to interpret.

    Repair (-Fix) removes ONLY allow ACEs whose SID is an AppContainer package SID
    (S-1-15-2-*). Those grant nothing to anyone on this machine while making the
    object unopenable to every caller below Medium integrity. Repair requires
    -AllowRoot, refuses any target outside it, refuses reparse points and
    dangerous roots, records an SDDL/icacls backup, and re-reads each object to
    confirm that no other ACE and no mandatory label changed.

    The script never creates, deletes, or writes the contents of any file. Its
    only footprint outside the ACLs it is asked to repair is the backup it writes
    under -Out.

.PARAMETER Path
    One or more failing paths. Each is diagnosed together with its ancestors.

.PARAMETER AllowRoot
    Required with -Fix. Every repaired object must be inside this directory.

.PARAMETER Out
    Required with -Fix. Directory receiving the ACL backup and rollback notes.

.PARAMETER Fix
    Remove S-1-15-2-* allow ACEs. Absent means diagnose only.

.PARAMETER GrantFullControl
    Grant the current user full control on the requested path. Full control is what
    the documented precondition needs: it carries WRITE_DAC for the DACL and
    WRITE_OWNER for the mandatory label DSH writes in the same call, while taking
    ownership supplies only WRITE_DAC. The owner is never changed. Mutually
    exclusive with -Fix.

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path 'C:\Users\me\.ssh'

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path '<workspace>\.dsh-acl-fixture-x\case1' -AllowRoot '<workspace>\.dsh-acl-fixture-x' -Out '<workspace>\.dsh-acl-fixture-x\report' -Fix
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$AllowRoot,
  [string]$Out,
  [switch]$Fix,
  [switch]$GrantFullControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PACKAGE_SID = '^S-1-15-2-'
$LOW_LABEL_SID = 'S-1-16-4096'

function Write-Line { param([string]$Text) Write-Output $Text }

# Unwrap nested exceptions: PowerShell wraps Win32 failures, and only the inner
# exception carries the real HRESULT the caller needs to classify the failure.
function Get-HResultChain {
  param([System.Exception]$Exception)
  $chain = @()
  $e = $Exception
  while ($null -ne $e) {
    $chain += ('{0}=0x{1:X8}/win32={2}: {3}' -f $e.GetType().Name, $e.HResult, ($e.HResult -band 0xFFFF), $e.Message)
    $e = $e.InnerException
  }
  return ($chain -join ' <- ')
}

function Get-CurrentIdentity {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent()
}

# Integrity level and sandbox markers decide the symptom shape: the same foreign
# ACE fails a grant when the caller is below Medium and merely blocks the child
# when the caller is not.
# The integrity level lives in the token's group list, which .NET filters out of
# WindowsIdentity.Groups, so read it through GetTokenInformation. Add-Type compiles
# in-process on PowerShell 7. Never spawn whoami.exe for this: inside a below-Medium
# token that process fails to initialize (STATUS_DLL_INIT_FAILED, 0xc0000142) and
# raises an application-error dialog on the user's desktop.
function Get-IntegritySid {
  try {
    if (-not ('DshTokenInfo' -as [type])) {
      Add-Type -Namespace Dsh -Name TokenInfo -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
[StructLayout(LayoutKind.Sequential)]
public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
public static int Level(IntPtr token) {
  uint length;
  GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
  if (length == 0) { return -1; }
  IntPtr buffer = Marshal.AllocHGlobal((int)length);
  try {
    if (!GetTokenInformation(token, 25, buffer, length, out length)) { return -1; }
    IntPtr sid = Marshal.PtrToStructure<TOKEN_MANDATORY_LABEL>(buffer).Label.Sid;
    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
  } finally { Marshal.FreeHGlobal(buffer); }
}
'@
    }
    $level = [Dsh.TokenInfo]::Level([System.Security.Principal.WindowsIdentity]::GetCurrent().Token)
    switch ($level) {
      0 { return 'S-1-16-0 (Untrusted)' }
      4096 { return 'S-1-16-4096 (Low)' }
      8192 { return 'S-1-16-8192 (Medium)' }
      12288 { return 'S-1-16-12288 (High)' }
      16384 { return 'S-1-16-16384 (System)' }
      default { return 'unknown' }
    }
  } catch {
    return 'unknown'
  }
}

function Get-CallerFacts {
  $sid = Get-IntegritySid
  $markers = @()
  foreach ($name in (Get-ChildItem env: | Select-Object -ExpandProperty Name)) {
    if ($name -like 'SBX_*' -or $name -like 'CODEX_*') { $markers += $name }
  }
  return @{ Integrity = $sid; Markers = $markers }
}

function Test-DangerousRoot {
  param([string]$FullPath)
  $trimmed = $FullPath.TrimEnd('\')
  if ($trimmed -match '^[A-Za-z]:$') { return 'drive root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'))) { return 'user profile root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\'))) { return 'Windows directory' }
  return $null
}

function Test-UnderRoot {
  param([string]$FullPath, [string]$Root)
  $r = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $c = [System.IO.Path]::GetFullPath($FullPath)
  return $c.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ObjectFacts {
  param([string]$FullPath, [System.Security.Principal.WindowsIdentity]$Identity, [string]$MeSid)
  $facts = [ordered]@{
    Object = $FullPath
    Readable = $false
    Error = ''
    PackageAces = @()
    OtherAppContainerSids = @()
    Owner = ''
    OwnerIsMe = $false
    MyRights = ''
    HasWriteDac = $false
    HasWriteOwner = $false
    LowLabel = $false
    AclLines = @()
  }
  try {
    # Get-Acl reads the security descriptor directly. On .NET Core the
    # FileSystemInfo.GetAccessControl() form is an extension method, which
    # PowerShell cannot invoke with instance syntax.
    $acl = Get-Acl -LiteralPath $FullPath
    $facts.Readable = $true
  } catch {
    $facts.Error = Get-HResultChain -Exception $_.Exception
    return $facts
  }
  foreach ($rule in $acl.Access) {
    # Orphaned and capability SIDs have no NTAccount form and Translate throws on
    # them, so fall back to the reference's own text.
    $reference = $rule.IdentityReference
    $sid = if ($reference -is [System.Security.Principal.SecurityIdentifier]) { $reference.Value }
      else { try { $reference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $reference.Value } }
    if ($sid -match $PACKAGE_SID -and $rule.AccessControlType -eq 'Allow') {
      $facts.PackageAces += ('SID={0} INHERITED={1} INHERITABLE={2} RIGHTS={3}' -f $sid, $rule.IsInherited, $rule.InheritanceFlags, $rule.FileSystemRights)
    } elseif ($sid -match '^S-1-15-' -and $sid -notmatch $PACKAGE_SID) {
      $facts.OtherAppContainerSids += $sid
    }
    if ($sid -eq $MeSid -and $rule.AccessControlType -eq 'Allow') {
      $facts.MyRights = ($facts.MyRights + ';' + [string]$rule.FileSystemRights).Trim(';')
      # FileSystemRights names these ChangePermissions (WRITE_DAC) and
      # TakeOwnership (WRITE_OWNER); there is no WriteDac/WriteOwner member.
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0) { $facts.HasWriteDac = $true }
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0) { $facts.HasWriteOwner = $true }
    }
  }
  try {
    $facts.Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $facts.OwnerIsMe = ($facts.Owner -eq $MeSid)
    # Ownership carries an implicit READ_CONTROL and WRITE_DAC: a target the caller
    # owns stays writable even when no ACE names the caller with WriteDac.
    if ($facts.OwnerIsMe) { $facts.HasWriteDac = $true }
  } catch {
    $facts.Owner = 'unreadable'
  }
  # The mandatory label lives in the SACL. Reading the SACL needs a privilege while
  # icacls prints the label without one, but icacls renders it by name, which is
  # localized: try the integrity SID first and keep the English name as a fallback.
  try {
    $facts.AclLines = @(icacls $FullPath)
    $text = $facts.AclLines -join "`n"
    $facts.LowLabel = ($text -match $LOW_LABEL_SID) -or ($text -match 'Mandatory Label')
  } catch {
    $facts.LowLabel = $false
  }
  return $facts
}

function Get-Ancestors {
  param([string]$FullPath)
  $list = @()
  $current = [System.IO.Path]::GetFullPath($FullPath)
  while ($true) {
    $list += $current
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  return $list
}

# --- main ---------------------------------------------------------------

$identity = Get-CurrentIdentity
$meSid = $identity.User.Value
$caller = Get-CallerFacts
Write-Line ('CALLER SID={0} INTEGRITY={1} SANDBOX_MARKERS={2}' -f $meSid, $caller.Integrity, (($caller.Markers | Sort-Object) -join ','))

if ($Fix -and $GrantFullControl) {
  Write-Line 'REFUSED -Fix and -GrantFullControl are separate repairs; run one at a time'
  exit 2
}
if ($Fix -or $GrantFullControl) {
  foreach ($required in @('AllowRoot', 'Out')) {
    if (-not (Get-Variable -Name $required -ValueOnly)) {
      Write-Line ('REFUSED the requested repair requires -{0}' -f $required)
      exit 2
    }
  }
  if (-not (Test-Path -LiteralPath $Out)) { New-Item -ItemType Directory -Path $Out | Out-Null }
}

$fixed = 0
$granted = 0
$refused = 0

foreach ($requested in $Path) {
  $full = [System.IO.Path]::GetFullPath($requested)
  Write-Line ('PATH={0}' -f $full)
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Line '  MISSING'
    Write-Line 'VERDICT=NOT_THIS_CLASS'
    continue
  }

  $packageTargets = @()
  foreach ($ancestor in (Get-Ancestors -FullPath $full)) {
    if (-not (Test-Path -LiteralPath $ancestor)) { continue }
    $f = Get-ObjectFacts -FullPath $ancestor -Identity $identity -MeSid $meSid
    Write-Line ('  OBJECT={0} READABLE={1}{2}' -f $f.Object, $f.Readable, $(if ($f.Readable) { '' } else { ' ERROR=' + $f.Error }))
    if ($f.Readable) {
      Write-Line ('    OWNER={0} IS_CURRENT_USER={1} MY_RIGHTS=[{2}] WRITE_DAC={3} WRITE_OWNER={4} LOW_LABEL={5}' -f $f.Owner, $f.OwnerIsMe, $f.MyRights, $f.HasWriteDac, $f.HasWriteOwner, $f.LowLabel)
      foreach ($ace in $f.PackageAces) { Write-Line ('    PACKAGE_ACE {0}' -f $ace) }
      foreach ($sid in ($f.OtherAppContainerSids | Sort-Object -Unique)) { Write-Line ('    OTHER_S1_15 SID={0} (reported only)' -f $sid) }
    }
    if ($f.PackageAces.Count -gt 0) { $packageTargets += $f }
  }

  # Verdict: a confirmed package ACE is the blocker; otherwise an unmet
  # precondition; otherwise this is not the class of failure this skill owns.
  # The precondition is judged on the requested path itself. Ancestors above the
  # tree DSH grants are not part of that grant, so their ownership and rights would
  # otherwise mark every healthy path as a precondition failure.
  $targetFacts = Get-ObjectFacts -FullPath $full -Identity $identity -MeSid $meSid
  $unreadable = -not $targetFacts.Readable
  $needsPrecondition = (-not $unreadable) -and $targetFacts.PackageAces.Count -eq 0 -and
    ((-not $targetFacts.OwnerIsMe) -or (-not $targetFacts.HasWriteDac) -or (-not $targetFacts.HasWriteOwner))

  if ($packageTargets.Count -gt 0) {
    $blocked = @($packageTargets | Where-Object { (-not $_.OwnerIsMe) -or (-not $_.HasWriteDac) })
    Write-Line ('VERDICT={0}' -f $(if ($blocked.Count -gt 0) { 'BOTH' } else { 'CULPRIT' }))
  } elseif ($unreadable) {
    Write-Line 'VERDICT=UNREADABLE'
  } elseif ($needsPrecondition) {
    Write-Line 'VERDICT=PRECONDITION'
  } else {
    Write-Line 'VERDICT=NOT_THIS_CLASS'
  }

  if ($GrantFullControl) {
    if ($unreadable) { Write-Line 'GRANT_REFUSED the object could not be read; the grant needs an unconfined caller'; $refused++; continue }
    if ($targetFacts.PackageAces.Count -gt 0) { Write-Line 'GRANT_REFUSED remove the package SID ACE first with -Fix'; $refused++; continue }
    if ($targetFacts.HasWriteDac -and $targetFacts.HasWriteOwner) { Write-Line ('GRANT_SKIPPED {0} already carries WRITE_DAC and WRITE_OWNER' -f $full); continue }
    if (-not (Test-UnderRoot -FullPath $full -Root $AllowRoot)) { Write-Line ('GRANT_REFUSED {0} is outside -AllowRoot' -f $full); $refused++; continue }
    $danger = Test-DangerousRoot -FullPath $full
    if ($danger) { Write-Line ('GRANT_REFUSED {0} is a {1}' -f $full, $danger); $refused++; continue }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.LinkType) { Write-Line ('GRANT_REFUSED {0} is a reparse point ({1})' -f $full, $item.LinkType); $refused++; continue }
    $backup = Join-Path $Out ('acl-backup-{0}.txt' -f ([guid]::NewGuid().ToString('N')))
    $before = @(icacls $full)
    $before | Set-Content -LiteralPath $backup
    Write-Line ('BACKUP {0} -> {1}' -f $full, $backup)
    # Address the grant by SID so no account name has to resolve, and leave the
    # owner alone: ownership transfer reaches far beyond this fault.
    icacls $full /grant "*${meSid}:(F)" | Out-Null
    $code = $LASTEXITCODE
    $after = Get-ObjectFacts -FullPath $full -Identity $identity -MeSid $meSid
    if ($code -eq 0 -and $after.HasWriteDac -and $after.HasWriteOwner) {
      Write-Line ('GRANTED {0} SID={1}' -f $full, $meSid); $granted++
      Write-Line ('ROLLBACK icacls "{0}" /remove:g "*{1}"' -f $full, $meSid)
    } else {
      Write-Line ('GRANT_FAILED {0} exit={1}; an unelevated caller cannot grant WRITE_DAC on a directory it does not own, so one elevated run of this command is required' -f $full, $code)
      $refused++
    }
    continue
  }

  if (-not $Fix) { continue }

  if ($unreadable) {
    Write-Line 'FIX_REFUSED the object could not be read; repair needs an unconfined caller'
    $refused++
    continue
  }
  foreach ($target in $packageTargets) {
    if (-not (Test-UnderRoot -FullPath $target.Object -Root $AllowRoot)) {
      Write-Line ('FIX_REFUSED {0} is outside -AllowRoot' -f $target.Object); $refused++; continue
    }
    $danger = Test-DangerousRoot -FullPath $target.Object
    if ($danger) { Write-Line ('FIX_REFUSED {0} is a {1}' -f $target.Object, $danger); $refused++; continue }
    $item = Get-Item -LiteralPath $target.Object -Force
    if ($item.LinkType) { Write-Line ('FIX_REFUSED {0} is a reparse point ({1})' -f $target.Object, $item.LinkType); $refused++; continue }
    if (-not ($target.OwnerIsMe -and $target.HasWriteDac)) {
      Write-Line ('FIX_REFUSED {0} needs WRITE_DAC first: grant the current user full control (WRITE_DAC and WRITE_OWNER); taking ownership alone is not enough' -f $target.Object)
      $refused++
      continue
    }
    $backup = Join-Path $Out ('acl-backup-{0}.txt' -f ([guid]::NewGuid().ToString('N')))
    $before = @(icacls $target.Object)
    $before | Set-Content -LiteralPath $backup
    Write-Line ('BACKUP {0} -> {1}' -f $target.Object, $backup)
    foreach ($ace in $target.PackageAces) {
      if ($ace -notmatch 'SID=(S-1-15-2-[\d-]+)') { continue }
      $sid = $Matches[1]
      icacls $target.Object /remove:g "*$sid" | Out-Null
      $code = $LASTEXITCODE
      $after = Get-ObjectFacts -FullPath $target.Object -Identity $identity -MeSid $meSid
      # Prove the removal was surgical. icacls prints the object's first ACE on the
      # same line as the path, so strip the path first: otherwise removing an ACE
      # that led that line reads as a change to every following line.
      $keepBefore = @($before | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith($target.Object, [System.StringComparison]::OrdinalIgnoreCase)) { $line = $line.Substring($target.Object.Length).Trim() }
        $line
      } | Where-Object { $_ -notmatch $PACKAGE_SID })
      $keepAfter = @($after.AclLines | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith($target.Object, [System.StringComparison]::OrdinalIgnoreCase)) { $line = $line.Substring($target.Object.Length).Trim() }
        $line
      } | Where-Object { $_ -notmatch $PACKAGE_SID })
      $collateral = (($keepBefore -join "`n") -eq ($keepAfter -join "`n"))
      if ($code -eq 0 -and $after.PackageAces.Count -eq 0 -and $collateral) {
        Write-Line ('FIXED {0} SID={1}' -f $target.Object, $sid); $fixed++
        Write-Line ('ROLLBACK icacls "{0}" /grant "*{1}:(X,RA)"' -f $target.Object, $sid)
      } else {
        Write-Line ('FIX_FAILED {0} SID={1} exit={2} collateral_change={3}' -f $target.Object, $sid, $code, (-not $collateral))
        $refused++
      }
    }
  }
}

if ($Fix -or $GrantFullControl) { Write-Line ('SUMMARY FIXED={0} GRANTED={1} REFUSED={2}' -f $fixed, $granted, $refused) }

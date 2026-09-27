; Native command admission also covers direct installer and uninstaller launches.
Var InstallerCliToken
Var InstallerCliApplication
!ifdef BUILD_UNINSTALLER
  !define DSH_CLI_PREFIX "un."
!else
  !define DSH_CLI_PREFIX ""
  !macro dshPrepareCliUpdate
    Call PrepareCliUpdate
  !macroend
  !macro dshFinishCliUpdate
    Call FinishCliUpdate
  !macroend
!endif

Function ${DSH_CLI_PREFIX}PrepareCliUpdate
  ${If} $InstallerCliToken != ""
    Return
  ${EndIf}
  StrCpy $InstallerCliApplication $INSTDIR
  ${IfNot} ${FileExists} "$INSTDIR\resources\runtime\cli\bin\dsh.exe"
    Return
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\dsh-command-update.ps1" "${INSTALLER_SOURCE_DIR}\..\scripts\command-update.ps1"
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $InstallerCliToken $0 36 1
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dsh-command-update.ps1" -Operation prepare -Application "$INSTDIR" -Token "$InstallerCliToken" -Version "${VERSION}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_CLI_BUSY)" /SD IDOK
    Call ${DSH_CLI_PREFIX}FinishCliUpdate
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function ${DSH_CLI_PREFIX}FinishCliUpdate
  Push $0
  Push $1
  ${If} $InstallerCliToken != ""
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dsh-command-update.ps1" -Operation finish -Application "$InstallerCliApplication" -Token "$InstallerCliToken"'
    Pop $0
    Pop $1
    StrCpy $InstallerCliToken ""
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

!ifdef BUILD_UNINSTALLER
Function un.onGUIEnd
  Call un.FinishCliUpdate
FunctionEnd

Function un.onUninstSuccess
  Call un.FinishCliUpdate
FunctionEnd

Function un.onUninstFailed
  Call un.FinishCliUpdate
FunctionEnd
!endif

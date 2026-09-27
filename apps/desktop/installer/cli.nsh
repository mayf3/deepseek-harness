; Native command admission also covers direct installer and uninstaller launches.
Var InstallerCliToken
Var InstallerCliApplication
!ifdef BUILD_UNINSTALLER
  !define DSH_CLI_PREFIX "un."
!else
  !define DSH_CLI_PREFIX ""
!endif

Function ${DSH_CLI_PREFIX}PrepareCliUpdate
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
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

!ifdef BUILD_UNINSTALLER
Function un.onGUIEnd
!else
Function .onGUIEnd
!endif
  ${If} $InstallerCliToken != ""
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dsh-command-update.ps1" -Operation finish -Application "$InstallerCliApplication" -Token "$InstallerCliToken"'
    Pop $0
    Pop $1
  ${EndIf}
FunctionEnd

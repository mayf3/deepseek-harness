; Exercises the production copy hook's NSIS register, stack, and error-flag behavior.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Desktop installer copy smoke"
OutFile "${OUTPUT_FILE}"
!include "..\..\scripts\installer.nsh"

Section
  InitPluginsDir
  File "/oname=$PLUGINSDIR\window-frame.dll" "${SOURCE_DLL}"
  CreateDirectory "$PLUGINSDIR\source"
  CreateDirectory "$PLUGINSDIR\target"
  FileOpen $0 "$PLUGINSDIR\source\payload.txt" w
  FileWrite $0 "payload"
  FileClose $0
  StrCpy $0 "zero"
  StrCpy $1 "one"
  StrCpy $R0 "output directory"
  StrCpy $R1 "retry counter"
  Push "stack sentinel"
  ClearErrors
  !insertmacro customInstallerCopyFiles "$PLUGINSDIR\source" "$PLUGINSDIR\target"
  IfErrors failed
  StrCmp $0 "zero" 0 failed
  StrCmp $1 "one" 0 failed
  StrCmp $R0 "output directory" 0 failed
  StrCmp $R1 "retry counter" 0 failed
  Pop $2
  StrCmp $2 "stack sentinel" 0 failed
  FileOpen $2 "$PLUGINSDIR\target\payload.txt" r
  FileRead $2 $3
  FileClose $2
  StrCmp $3 "payload" 0 failed

  SetErrors
  !insertmacro customInstallerCopyFiles "$PLUGINSDIR\source" "$PLUGINSDIR\target"
  IfErrors +2
    Goto failed
  ClearErrors
  !insertmacro customInstallerCopyFiles "$PLUGINSDIR\missing" "$PLUGINSDIR\target"
  IfErrors +2
    Goto failed
  SetErrorLevel 0
  Quit
  failed:
  SetErrorLevel 1
  Quit
SectionEnd

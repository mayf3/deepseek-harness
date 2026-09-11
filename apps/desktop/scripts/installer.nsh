!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  !include "${__FILEDIR__}\installer-directories.nsh"
!endif

!macro customInstall
  !insertmacro dshFinishDirectories
!macroend

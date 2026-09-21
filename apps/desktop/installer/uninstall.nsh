; User data removal is opt-in and never runs for silent or upgrade uninstalls.
!include nsDialogs.nsh
!include WinMessages.nsh

Var UnLocal
Var UnAll
Var UnDesktop
Var UnPreviousDesktop
Var UnLocalControl
Var UnAllControl
Var UnDesktopControl

Function un.DataInit
  StrCpy $UnLocal 0
  StrCpy $UnAll 0
  StrCpy $UnDesktop 0
  StrCpy $UnPreviousDesktop 0
  StrCpy $UnHome "$PROFILE\.dsh"
  StrCpy $1 "$APPDATA\${PRODUCT_FILENAME}\uninstall.ini"
  !ifdef APP_PACKAGE_NAME
    ${IfNot} ${FileExists} "$1"
      StrCpy $1 "$APPDATA\${APP_PACKAGE_NAME}\uninstall.ini"
    ${EndIf}
  !endif
  ReadINIStr $0 "$1" "Harness" "Home"
  ${If} $0 != ""
    StrCpy $UnHome $0
    ReadINIStr $2 "$1" "Harness" "HomeLength"
    StrLen $3 $UnHome
    ${If} $2 != $3
      StrCpy $UnHome ""
    ${EndIf}
  ${ElseIf} ${FileExists} "$1"
    StrCpy $UnHome ""
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
FunctionEnd

Function un.DataPage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(UNINSTALL_DATA_TITLE)" "$(UNINSTALL_DATA_SUBTITLE)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "$(UNINSTALL_DATA_INTRO)"
  Pop $0
  ${NSD_CreateCheckbox} 0 26u 100% 14u "$(UNINSTALL_LOCAL)"
  Pop $UnLocalControl
  ${NSD_SetState} $UnLocalControl $UnLocal
  ${NSD_CreateLabel} 9u 39u 95% 20u "$(UNINSTALL_LOCAL_DETAIL)"
  Pop $0
  ${NSD_CreateCheckbox} 0 66u 100% 14u "$(UNINSTALL_ALL)"
  Pop $UnAllControl
  ${NSD_SetState} $UnAllControl $UnAll
  ${NSD_OnClick} $UnAllControl un.AllDataChanged
  ${NSD_CreateCheckbox} 14u 82u 95% 14u "$(UNINSTALL_DESKTOP)"
  Pop $UnDesktopControl
  ${NSD_SetState} $UnDesktopControl $UnDesktop
  ${If} $UnHome == ""
    EnableWindow $UnAllControl 0
    EnableWindow $UnDesktopControl 0
  ${EndIf}
  ${If} $UnAll == 1
    EnableWindow $UnDesktopControl 0
  ${EndIf}
  ${NSD_CreateLabel} 23u 95u 90% 25u "$(UNINSTALL_DESKTOP_DETAIL)"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.AllDataChanged
  Pop $0
  ${NSD_GetState} $UnAllControl $UnAll
  ${If} $UnAll == 1
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$(UNINSTALL_ALL_WARNING)" /SD IDCANCEL IDOK confirmed
    StrCpy $UnAll 0
    ${NSD_SetState} $UnAllControl 0
    Return
    confirmed:
    ${NSD_GetState} $UnDesktopControl $UnPreviousDesktop
    StrCpy $UnDesktop 1
    ${NSD_SetState} $UnDesktopControl 1
    EnableWindow $UnDesktopControl 0
  ${Else}
    StrCpy $UnDesktop $UnPreviousDesktop
    ${NSD_SetState} $UnDesktopControl $UnPreviousDesktop
    EnableWindow $UnDesktopControl 1
  ${EndIf}
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $UnLocalControl $UnLocal
  ${NSD_GetState} $UnAllControl $UnAll
  ${NSD_GetState} $UnDesktopControl $UnDesktop
FunctionEnd

; The helper refuses unsafe roots and never descends into reparse points.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR") i.r0 ?c'
  ${If} $0 != 0
    DetailPrint "$(UNINSTALL_DATA_FAILED)"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(UNINSTALL_DATA_FAILED)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

Function un.CleanData
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ${If} $UnAll != 1
    StrCpy $UnTarget $INSTDIR
    Call un.PreserveHome
  ${EndIf}
  ${If} ${Silent}
    Return
  ${EndIf}
  ${If} $UnAll == 1
    StrCpy $UnTarget $UnHome
    Call un.RemoveData
  ${ElseIf} $UnDesktop == 1
    StrCpy $UnTarget "$UnHome\profiles\desktop"
    Call un.RemoveData
  ${EndIf}
  ${If} $UnLocal == 1
    StrCpy $UnTarget "$APPDATA\${PRODUCT_FILENAME}"
    Call un.PreserveHome
    Call un.RemoveData
    !ifdef APP_PACKAGE_NAME
      StrCpy $UnTarget "$APPDATA\${APP_PACKAGE_NAME}"
      Call un.PreserveHome
      Call un.RemoveData
    !endif
    StrCpy $UnTarget "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}"
    Call un.PreserveHome
    Call un.RemoveData
  ${EndIf}
FunctionEnd

Function un.PreserveHome
  ${If} $UnAll == 1
    Return
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallPathsOverlap(w "$UnTarget", w "$UnHome") i.r0 ?c'
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(UNINSTALL_HOME_CONFLICT)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

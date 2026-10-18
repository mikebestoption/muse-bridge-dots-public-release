; Muse Bridge 0.3.3 — native-compiled NSIS installer
; Hand-written fallback for the electron-builder NSIS target, compiled with the
; native Linux makensis (the wine-based builder cannot execute 32-bit PE on
; the build VM). Install behavior is identical to the electron-builder NSIS
; config: per-user, Start Menu shortcut, HKCU uninstall entry, and the
; %APPDATA% userData folder (API key / Vault) is never touched.

!include "MUI2.nsh"

!define PRODUCT_NAME "Muse Bridge"
!define PRODUCT_VERSION "0.3.3"
!define PRODUCT_PUBLISHER "Michael Rodriguez"
!define APP_EXE "Muse Bridge.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MuseBridge"
!define SRC_DIR "dist\win-unpacked"

Name "${PRODUCT_NAME}"
OutFile "dist\MuseBridge-0.3.3-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Muse Bridge"
RequestExecutionLevel user
SetCompressor /SOLID lzma

VIProductVersion "0.3.3.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "Muse Bridge Setup"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"

; ---- Close a running copy before touching its files ----
; Upgrading over a still-running Muse Bridge (window open or sitting in the
; system tray) fails with "Error opening file for writing": the running
; process holds its DLLs (e.g. d3dcompiler_47.dll) open, so NSIS cannot
; overwrite them. App and installer both run per-user, so taskkill needs no
; admin rights. If the app is not running, taskkill simply reports that the
; process was not found and the install carries on.
!macro CloseRunningApp
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXE}" /T'
  Sleep 2000 ; give Windows a moment to release the file handles
!macroend

Function .onInit
  !insertmacro CloseRunningApp
FunctionEnd

; ---- Pages ----
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run Muse Bridge"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---- Install ----
Section "Install"
  SetShellVarContext current
  ; Again, in case the app was relaunched while this installer sat open.
  !insertmacro CloseRunningApp
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"

  ; Shortcuts: Start Menu (user Programs) + Desktop
  CreateShortCut "$SMPROGRAMS\Muse Bridge.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$DESKTOP\Muse Bridge.lnk" "$INSTDIR\${APP_EXE}"

  ; Uninstaller + HKCU uninstall entry (Settings -> Apps)
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; ---- Uninstall ----
; Removes the program tree, shortcuts, and registry entry only.
; The userData folder in %APPDATA% (API key, Vault, history) is deliberately
; NOT removed, so settings survive uninstall/reinstall by design.
Section "Uninstall"
  SetShellVarContext current
  ; A running copy would hold its files open and defeat the RMDir below.
  !insertmacro CloseRunningApp
  Delete "$SMPROGRAMS\Muse Bridge.lnk"
  Delete "$DESKTOP\Muse Bridge.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd

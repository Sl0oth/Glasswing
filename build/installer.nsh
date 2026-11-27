; Restyles the installer to match the browser: a small dark card with a thin accent-colored bar,
; rather than the standard Windows wizard. It needs no input, and when it's done the setup window
; inside the app takes over. Colors are the same as src/renderer/setup.css.

!define GLASS_BG "17171C"
!define GLASS_BG_BGR 0x1C1717
!define GLASS_TRACK_BGR 0x332D2D
!define GLASS_ACCENT_BGR 0xFF840A
!define GLASS_WIDTH 460
!define GLASS_HEIGHT 150

!define MUI_CUSTOMFUNCTION_GUIINIT GlasswingGuiInit
!define MUI_PAGE_CUSTOMFUNCTION_SHOW GlasswingPageShow
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; The update downloads aren't part of the install folder. An update runs this uninstaller too, and
; it's still using them then, so they only go when the app does.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\glasswing-updater"
  ${endIf}
!macroend

!macro GlasswingHide parent id
  GetDlgItem $R9 ${parent} ${id}
  ShowWindow $R9 0
!macroend

Function GlasswingGuiInit
  Push $0
  Push $1
  Push $2
  Push $R9

  ; The wizard's header, separator, branding and buttons: none of them are used.
  !insertmacro GlasswingHide $HWNDPARENT 1
  !insertmacro GlasswingHide $HWNDPARENT 2
  !insertmacro GlasswingHide $HWNDPARENT 3
  !insertmacro GlasswingHide $HWNDPARENT 1028
  !insertmacro GlasswingHide $HWNDPARENT 1034
  !insertmacro GlasswingHide $HWNDPARENT 1035
  !insertmacro GlasswingHide $HWNDPARENT 1036
  !insertmacro GlasswingHide $HWNDPARENT 1037
  !insertmacro GlasswingHide $HWNDPARENT 1038
  !insertmacro GlasswingHide $HWNDPARENT 1039
  !insertmacro GlasswingHide $HWNDPARENT 1256

  SetCtlColors $HWNDPARENT FFFFFF ${GLASS_BG}

  ; Dark title bar in the same color as the window. Versions of Windows without this just ignore it.
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 35, *i ${GLASS_BG_BGR}, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 36, *i 0xFFFFFF, i 4)'

  ; Small, and centered.
  System::Call 'user32::GetSystemMetrics(i 0) i .r0'
  System::Call 'user32::GetSystemMetrics(i 1) i .r1'
  IntOp $0 $0 - ${GLASS_WIDTH}
  IntOp $0 $0 / 2
  IntOp $1 $1 - ${GLASS_HEIGHT}
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i r0, i r1, i ${GLASS_WIDTH}, i ${GLASS_HEIGHT}, i 0x14)'

  Pop $R9
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function GlasswingPageShow
  Push $0
  Push $1
  Push $R9

  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 FFFFFF ${GLASS_BG}
  System::Call 'user32::SetWindowPos(i r0, i 0, i 0, i 0, i ${GLASS_WIDTH}, i ${GLASS_HEIGHT}, i 0x14)'

  !insertmacro GlasswingHide $0 1016
  !insertmacro GlasswingHide $0 1027

  ; The line of text.
  GetDlgItem $1 $0 1006
  SetCtlColors $1 FFFFFF ${GLASS_BG}
  CreateFont $R9 "Segoe UI" 11 400
  SendMessage $1 0x0030 $R9 1
  SendMessage $1 0x000C 0 "STR:Installing Glasswing…"
  System::Call 'user32::SetWindowPos(i r1, i 0, i 24, i 22, i 396, i 26, i 0x14)'

  ; The bar, drawn flat so it can have the accent color.
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(i r1, w "", w "")'
  SendMessage $1 0x0409 0 ${GLASS_ACCENT_BGR}
  SendMessage $1 0x2001 0 ${GLASS_TRACK_BGR}
  System::Call 'user32::SetWindowLong(i r1, i -20, i 0)'
  System::Call 'user32::SetWindowPos(i r1, i 0, i 24, i 58, i 396, i 5, i 0x34)'

  Pop $R9
  Pop $1
  Pop $0
FunctionEnd

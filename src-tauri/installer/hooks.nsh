; Tracker installer hooks.
; Best-effort: stop any leftover sensor sidecar so its files aren't locked
; during install/uninstall (it can outlive a crashed app on older builds).
; User data in %LOCALAPPDATA%\com.chilloutgames.gametracker is intentionally
; left untouched so games, sessions and screenshots survive a reinstall.

!macro NSIS_HOOK_PREINSTALL
  ; Always close any running instance so we can update in place (no uninstall).
  ; The app saves continuously and recovers open sessions on next launch, so a
  ; forced close here is safe. Kills the installed binary and the sensor sidecar.
  nsExec::Exec 'taskkill /F /IM ${MAINBINARYNAME}.exe'
  nsExec::Exec 'taskkill /F /IM gametracker.exe'
  nsExec::Exec 'taskkill /F /IM sensorbridge.exe'
  nsExec::Exec 'taskkill /F /IM sensorbridge-x86_64-pc-windows-msvc.exe'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $TrackerDesktopState == ${BST_CHECKED}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
  ; Hand the setup page's "Setup type" choice to the app: it reads this marker on
  ; launch and seeds the "remote only" setting from it (seed_install_mode in
  ; src-tauri/src/lib.rs). Both types install the same files — only the flag differs.
  ;
  ; A silent/passive auto-update never shows that page, so the state is still
  ; empty; write nothing in that case, or every background update would reset a
  ; mode the user had since changed in Settings.
  ${If} $TrackerRemoteOnlyState == ${BST_CHECKED}
    StrCpy $2 "remote"
  ${ElseIf} $TrackerRemoteOnlyState == ${BST_UNCHECKED}
    StrCpy $2 "full"
  ${Else}
    StrCpy $2 ""
  ${EndIf}
  ${If} $2 != ""
    ClearErrors
    FileOpen $3 "$INSTDIR\install-mode.txt" w
    ${IfNot} ${Errors}
      FileWrite $3 $2
      FileClose $3
    ${EndIf}
  ${EndIf}
  ; If the user already had elevated autostart, repoint the scheduled task at this
  ; install folder (reinstall / moved directory — the old path would 404 at logon).
  nsExec::ExecToStack 'schtasks /Query /TN "GameTracker Autostart"'
  Pop $0
  Pop $1
  ${If} $0 = 0
    nsExec::Exec 'schtasks /Create /TN "GameTracker Autostart" /TR "\"$INSTDIR\${MAINBINARYNAME}.exe\" --minimized" /SC ONLOGON /RL HIGHEST /F'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM sensorbridge.exe'
  nsExec::Exec 'taskkill /F /IM sensorbridge-x86_64-pc-windows-msvc.exe'
  ; Not a bundled resource, so the uninstaller's generated Delete list misses it —
  ; left behind it would keep $INSTDIR non-empty and block the final RMDir.
  Delete "$INSTDIR\install-mode.txt"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend

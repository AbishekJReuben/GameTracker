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
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM sensorbridge.exe'
  nsExec::Exec 'taskkill /F /IM sensorbridge-x86_64-pc-windows-msvc.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend

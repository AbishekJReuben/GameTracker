package __PACKAGE__;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/**
 * Invisible trampoline behind the Notes tile and the notification.
 *
 * Launching an Activity is what makes the system collapse the notification
 * shade; a Service PendingIntent would open the dock UNDER the shade. This
 * starts the dock and finishes in the same frame. It runs in its own empty task
 * affinity (manifest), so finishing drops you back into whatever app you were
 * in — not into GameTracker.
 */
public class NotesDockActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    try {
      if (ClipboardBridge.backgroundEnabled(this) && ClipboardBridge.overlayGranted(this)) {
        Intent svc = new Intent(this, ClipboardService.class).setAction(ClipboardService.ACTION_SHOW_DOCK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
        else startService(svc);
      } else {
        // Shared notes aren't set up (or no overlay permission): land on the
        // app's Notes screen, where both are switched on.
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
          open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
          open.putExtra("gt_open", "clipboard");
          startActivity(open);
        }
      }
    } catch (Exception ignored) {
    }
    finish();
    overridePendingTransition(0, 0);
  }
}

package __PACKAGE__;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * Restarts the shared-clipboard overlay/sync service after a reboot so it's
 * always-on across restarts. Only starts it if the user had it enabled.
 */
public class ClipboardBootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (intent == null || intent.getAction() == null) return;
    String a = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(a)
        && !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(a)
        && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
      return;
    }
    SharedPreferences p = ctx.getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
    if (p.getBoolean("enabled", false)) {
      ClipboardBridge.startService(
          ctx,
          true,
          p.getString("secret", ""),
          p.getString("deviceId", ""),
          p.getString("signalUrl", ""));
    }
  }
}

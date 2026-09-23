package __PACKAGE__;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * "Notes" Quick Settings tile — opens the floating Notes dock over whatever is
 * on screen.
 *
 * This is the screenshot-free way in: the edge handle is a permanent overlay
 * window, so it shows up in every screenshot and screen recording; the tile
 * lives in the notification shade and is never on screen when you capture.
 * Adding the tile therefore switches the edge handle off (unless the user has
 * already chosen either way), and the dock's menu can bring it back.
 */
public class NotesTileService extends TileService {

  @Override
  public void onTileAdded() {
    super.onTileAdded();
    SharedPreferences p = getSharedPreferences(ClipboardBridge.PREFS, Context.MODE_PRIVATE);
    if (!p.contains(ClipboardService.PREF_EDGE_HANDLE)) {
      p.edit().putBoolean(ClipboardService.PREF_EDGE_HANDLE, false).apply();
      poke(ClipboardService.ACTION_EDGE_HANDLE);
    }
    updateTile();
  }

  @Override
  public void onStartListening() {
    super.onStartListening();
    updateTile();
  }

  @Override
  public void onClick() {
    super.onClick();
    if (isLocked()) {
      // The dock is an app overlay; it can't draw over the keyguard.
      unlockAndRun(this::launchDock);
    } else {
      launchDock();
    }
  }

  private void launchDock() {
    Intent i = new Intent(this, NotesDockActivity.class);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION
        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startActivityAndCollapse(PendingIntent.getActivity(this, 11, i,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
      } else {
        startActivityAndCollapseLegacy(i);
      }
    } catch (Exception ignored) {
    }
  }

  @SuppressWarnings("deprecation")
  private void startActivityAndCollapseLegacy(Intent i) {
    startActivityAndCollapse(i);
  }

  /** Tell a running ClipboardService to re-read its prefs. Best-effort: the
   *  service also reads them on every start. */
  private void poke(String action) {
    if (!ClipboardService.isRunning()) return;
    try {
      Intent svc = new Intent(this, ClipboardService.class).setAction(action);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
      else startService(svc);
    } catch (Exception ignored) {
    }
  }

  private void updateTile() {
    Tile t = getQsTile();
    if (t == null) return;
    boolean running = ClipboardService.isRunning();
    t.setLabel("Notes");
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      t.setSubtitle(running ? ClipboardService.tileSubtitle() : "Tap to open");
    }
    t.setState(running ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    t.updateTile();
  }
}

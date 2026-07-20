package __PACKAGE__;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;

/**
 * Transparent proxy Activity that lets the background {@link ClipboardService}
 * pick an image from the gallery.
 *
 * A foreground {@code Service} can't receive an Activity-result callback, so it
 * has no way to launch {@code ACTION_PICK} / the Photo Picker directly. This
 * Activity exists purely to:
 *   1. Launch the system photo picker (Photo Picker on Android 13+, the storage
 *      {@code ACTION_PICK} intent as a fallback on older devices — minSdk is 24).
 *   2. Forward the chosen content {@link Uri} to {@link ClipboardService} via
 *      {@link ClipboardService#ACTION_UPLOAD_IMAGE} on a successful result.
 *   3. Grant the service read access to the URI by flagging the forward intent
 *      (some OEMs scope the picker's read grant to the receiving Activity only).
 *
 * It finishes immediately in every path (success, cancel, error) so the user is
 * never left staring at a blank transparent window.
 */
public class ClipboardPickActivity extends Activity {
  private static final int REQ_PICK = 0x7013;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // The system Photo Picker (PickVisualMedia) is preferred: no permission
    // needed, works on every Android 13+ device, and grants one-shot read URI
    // access. Older OS versions fall back to ACTION_PICK on MediaStore.Images.
    try {
      Intent pick;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pick = new Intent(MediaStore.ACTION_PICK_IMAGES);
        pick.setType("image/*");
      } else {
        pick = new Intent(Intent.ACTION_PICK);
        pick.setType("image/*");
      }
      // Some OEM picker UIs want the ACTION_GET_CONTENT fallback for image/* —
      // try the chooser-free picker first; resolveActivity guards the launch.
      if (pick.resolveActivity(getPackageManager()) != null) {
        startActivityForResult(pick, REQ_PICK);
      } else {
        Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
        fallback.setType("image/*");
        fallback.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(fallback, REQ_PICK);
      }
    } catch (Exception e) {
      finish();
    }
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    try {
      if (requestCode == REQ_PICK && resultCode == RESULT_OK && data != null && data.getData() != null) {
        Uri uri = data.getData();
        Intent fwd = new Intent(this, ClipboardService.class);
        fwd.setAction(ClipboardService.ACTION_UPLOAD_IMAGE);
        fwd.putExtra(Intent.EXTRA_STREAM, uri);
        // Forward the picker's read grant so the service's ContentResolver read
        // succeeds even on OEMs that scope the grant to this Activity only.
        fwd.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          try {
            startForegroundService(fwd);
          } catch (Exception ignored) {
            startService(fwd);
          }
        } else {
          startService(fwd);
        }
        // Best-effort persistable grant so a slow service read (large image)
        // still works after the Activity goes away.
        try {
          ContentResolver cr = getContentResolver();
          cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
          // Not persistable — the in-flight service read still has the grant.
        }
      }
    } catch (Exception ignored) {
    } finally {
      finish();
    }
  }
}

package __PACKAGE__;

import static android.content.pm.PackageManager.PERMISSION_GRANTED;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.telephony.SubscriptionManager;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import rikka.shizuku.Shizuku;

/**
 * Launcher entry that toggles only Advanced Calling / Enhanced 4G LTE for the
 * default voice SIM. It never changes the preferred-network mask.
 */
public final class VoLteToggleShortcutActivity extends Activity {
    private static final int SHIZUKU_PERMISSION_REQUEST = 4706;
    private static final String SHIZUKU_PACKAGE = "moe.shizuku.privileged.api";
    private static final String SETUP_URL = "https://shizuku.rikka.app/guide/setup/";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Shizuku.OnBinderReceivedListener binderReceivedListener = this::begin;
    private final Shizuku.OnRequestPermissionResultListener permissionListener =
            (requestCode, grantResult) -> {
                if (requestCode != SHIZUKU_PERMISSION_REQUEST) return;
                if (grantResult == PERMISSION_GRANTED) {
                    begin();
                } else {
                    showAndFinish("Shizuku permission was not granted");
                }
            };
    private final ServiceConnection userServiceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            if (isFinishing() || worker.isShutdown()) return;
            try {
                worker.execute(() -> toggle(binder));
            } catch (RejectedExecutionException ignored) {
                // A delayed Shizuku callback can arrive after onDestroy().
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            if (!isFinishing()) {
                showAndFinish("Shizuku stopped before VoLTE could be changed");
            }
        }
    };
    private final Shizuku.UserServiceArgs userServiceArgs =
            new Shizuku.UserServiceArgs(new ComponentName(
                    BuildConfig.APPLICATION_ID,
                    NetworkToggleUserService.class.getName()))
                    .daemon(false)
                    .processNameSuffix("volte-toggle")
                    .tag("volte-toggle")
                    .debuggable(BuildConfig.DEBUG)
                    .version(BuildConfig.VERSION_CODE);
    private boolean serviceBound;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Shizuku.addBinderReceivedListenerSticky(binderReceivedListener);
        Shizuku.addRequestPermissionResultListener(permissionListener);
        begin();
    }

    @Override
    protected void onDestroy() {
        Shizuku.removeBinderReceivedListener(binderReceivedListener);
        Shizuku.removeRequestPermissionResultListener(permissionListener);
        if (serviceBound) {
            try {
                Shizuku.unbindUserService(userServiceArgs, userServiceConnection, true);
            } catch (Throwable ignored) {
                // The activity is already finishing; the helper will die with Shizuku.
            }
        }
        worker.shutdownNow();
        super.onDestroy();
    }

    private void begin() {
        if (isFinishing()) return;
        try {
            if (!Shizuku.pingBinder() || Shizuku.isPreV11()) {
                showSetup("Start Shizuku first, then tap VoLTE again");
                return;
            }
            if (Shizuku.checkSelfPermission() != PERMISSION_GRANTED) {
                if (Shizuku.shouldShowRequestPermissionRationale()) {
                    showSetup("Allow GameTracker in Shizuku, then tap VoLTE again");
                } else {
                    Shizuku.requestPermission(SHIZUKU_PERMISSION_REQUEST);
                }
                return;
            }
            if (Shizuku.getUid() != 0 && Shizuku.getUid() != 2000) {
                showAndFinish("Shizuku did not provide a supported privileged identity");
                return;
            }
            bindService();
        } catch (Throwable error) {
            showSetup("Shizuku is unavailable: " + safeMessage(error));
        }
    }

    private void bindService() {
        if (serviceBound) return;
        serviceBound = true;
        try {
            Shizuku.bindUserService(userServiceArgs, userServiceConnection);
        } catch (Throwable error) {
            serviceBound = false;
            showAndFinish("Could not start the VoLTE toggle: " + safeMessage(error));
        }
    }

    private void toggle(IBinder binder) {
        try {
            int subId = defaultVoiceSubscriptionId();
            boolean enabled = getVoLteSetting(binder, subId);
            setVoLteSetting(binder, subId, !enabled);
            boolean verified = getVoLteSetting(binder, subId);
            if (verified == enabled) {
                throw new IllegalStateException("The carrier did not accept the VoLTE change");
            }
            runOnUiThread(() -> showAndFinish(verified ? "VoLTE enabled" : "VoLTE disabled"));
        } catch (Throwable error) {
            runOnUiThread(() -> showAndFinish("VoLTE toggle failed: " + safeMessage(error)));
        }
    }

    private static boolean getVoLteSetting(IBinder binder, int subId) throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(NetworkToggleUserService.DESCRIPTOR);
            data.writeInt(subId);
            if (!binder.transact(NetworkToggleUserService.TRANSACTION_GET_VOLTE, data, reply, 0)) {
                throw new RemoteException("VoLTE service rejected the read");
            }
            reply.readException();
            return reply.readInt() != 0;
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private static void setVoLteSetting(IBinder binder, int subId, boolean enabled)
            throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(NetworkToggleUserService.DESCRIPTOR);
            data.writeInt(subId);
            data.writeInt(enabled ? 1 : 0);
            if (!binder.transact(NetworkToggleUserService.TRANSACTION_SET_VOLTE, data, reply, 0)) {
                throw new RemoteException("VoLTE service rejected the write");
            }
            reply.readException();
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private static int defaultVoiceSubscriptionId() {
        int subId = SubscriptionManager.getDefaultVoiceSubscriptionId();
        if (subId < 0) {
            subId = SubscriptionManager.getDefaultSubscriptionId();
        }
        return subId;
    }

    private void showSetup(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(SHIZUKU_PACKAGE);
            if (launch != null) {
                startActivity(launch);
            } else {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(SETUP_URL)));
            }
        } catch (RuntimeException ignored) {
            // Keep the shortcut side-effect free if no setup screen can be opened.
        }
        finish();
    }

    private void showAndFinish(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        finish();
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }
}

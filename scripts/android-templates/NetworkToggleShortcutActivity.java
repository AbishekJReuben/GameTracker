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
import android.telephony.TelephonyManager;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import rikka.shizuku.Shizuku;

/**
 * Launcher entry that toggles the preferred network mask for the default-data
 * SIM. It uses Shizuku only when the user has explicitly authorized this app;
 * otherwise it explains the one-time setup and leaves the radio untouched.
 */
public final class NetworkToggleShortcutActivity extends Activity {
    private static final int SHIZUKU_PERMISSION_REQUEST = 4705;
    private static final long NR_MASK = TelephonyManager.NETWORK_TYPE_BITMASK_NR;
    private static final long LTE_MASK = TelephonyManager.NETWORK_TYPE_BITMASK_LTE;
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
                showAndFinish("Shizuku stopped before the network could be changed");
            }
        }
    };
    private final Shizuku.UserServiceArgs userServiceArgs =
            new Shizuku.UserServiceArgs(new ComponentName(
                    BuildConfig.APPLICATION_ID,
                    NetworkToggleUserService.class.getName()))
                    .daemon(false)
                    .processNameSuffix("network-toggle")
                    .tag("network-toggle")
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
                showSetup("Start Shizuku first, then tap the toggle again");
                return;
            }
            if (Shizuku.checkSelfPermission() != PERMISSION_GRANTED) {
                if (Shizuku.shouldShowRequestPermissionRationale()) {
                    showSetup("Allow GameTracker in Shizuku, then tap the toggle again");
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
            showAndFinish("Could not start the privileged toggle: " + safeMessage(error));
        }
    }

    private void toggle(IBinder binder) {
        try {
            int slot = defaultDataSlot();
            long current = getAllowedNetworkTypes(binder, slot);
            boolean fiveGEnabled = (current & NR_MASK) != 0;
            String preferenceKey = "last-5g-mask-" + slot;
            long savedFiveGMask = getSharedPreferences("network-toggle", MODE_PRIVATE)
                    .getLong(preferenceKey, 0L);
            long target;

            if (fiveGEnabled) {
                target = current & ~NR_MASK;
                if ((target & LTE_MASK) == 0) target |= LTE_MASK;
                getSharedPreferences("network-toggle", MODE_PRIVATE)
                        .edit()
                        .putLong(preferenceKey, current)
                        .apply();
            } else {
                target = savedFiveGMask > 0 ? savedFiveGMask : (current | NR_MASK | LTE_MASK);
            }

            setAllowedNetworkTypes(binder, slot, target);
            long verified = getAllowedNetworkTypes(binder, slot);
            boolean enabledAfter = (verified & NR_MASK) != 0;
            if (enabledAfter == fiveGEnabled) {
                throw new IllegalStateException("The carrier did not accept the network change");
            }
            String message = enabledAfter ? "5G enabled" : "4G/LTE enabled";
            runOnUiThread(() -> showAndFinish(message));
        } catch (Throwable error) {
            runOnUiThread(() -> showAndFinish("Network toggle failed: " + safeMessage(error)));
        }
    }

    private static long getAllowedNetworkTypes(IBinder binder, int slot) throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(NetworkToggleUserService.DESCRIPTOR);
            data.writeInt(slot);
            if (!binder.transact(NetworkToggleUserService.TRANSACTION_GET_ALLOWED, data, reply, 0)) {
                throw new RemoteException("Network toggle service rejected the read");
            }
            reply.readException();
            return reply.readLong();
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private static void setAllowedNetworkTypes(IBinder binder, int slot, long mask)
            throws RemoteException {
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(NetworkToggleUserService.DESCRIPTOR);
            data.writeInt(slot);
            data.writeLong(mask);
            if (!binder.transact(NetworkToggleUserService.TRANSACTION_SET_ALLOWED, data, reply, 0)) {
                throw new RemoteException("Network toggle service rejected the write");
            }
            reply.readException();
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private int defaultDataSlot() {
        int subId = SubscriptionManager.getDefaultDataSubscriptionId();
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            int slot = SubscriptionManager.getSlotIndex(subId);
            if (slot >= 0) return slot;
        }
        int fallbackSubId = SubscriptionManager.getDefaultSubscriptionId();
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            int fallbackSlot = SubscriptionManager.getSlotIndex(fallbackSubId);
            if (fallbackSlot >= 0) return fallbackSlot;
        }
        return 0;
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
            // Keep the shortcut side-effect free if no browser/launcher can handle it.
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

package __PACKAGE__;

import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.telephony.TelephonyManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Shizuku user service for the one telephony operation that this feature needs.
 *
 * The service is deliberately allow-listed: it accepts only a physical SIM slot
 * and a long network mask, and it invokes only the Android phone shell command.
 * Shizuku runs this process as shell (UID 2000) when started through ADB, which
 * is the same identity that was proven to work on the Moto G57 Power 5G.
 */
public final class NetworkToggleUserService extends Binder {
    static final String DESCRIPTOR = "__PACKAGE__.NetworkToggleUserService";
    static final int TRANSACTION_GET_ALLOWED = 2;
    static final int TRANSACTION_SET_ALLOWED = 3;
    static final int TRANSACTION_GET_VOLTE = 4;
    static final int TRANSACTION_SET_VOLTE = 5;
    private static final int TRANSACTION_DESTROY = 16777114;
    private static final long NR_MASK = TelephonyManager.NETWORK_TYPE_BITMASK_NR;
    private static final Map<String, Long> NETWORK_BITS = createNetworkBits();
    private static final String SERVICE_MANAGER = "android.os.ServiceManager";
    private static final String ITelephony_STUB =
            "com.android.internal.telephony.ITelephony$Stub";
    private static final String ITelephony = "com.android.internal.telephony.ITelephony";

    public NetworkToggleUserService() {
        attachInterface(null, DESCRIPTOR);
    }

    @Override
    protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
            throws RemoteException {
        if (code == IBinder.INTERFACE_TRANSACTION) {
            if (reply != null) reply.writeString(DESCRIPTOR);
            return true;
        }
        if (code == TRANSACTION_DESTROY) {
            destroy();
            return true;
        }
        data.enforceInterface(DESCRIPTOR);
        if (code == TRANSACTION_GET_ALLOWED) {
            int slot = data.readInt();
            long mask = getAllowedNetworkTypes(slot);
            if (reply != null) {
                reply.writeNoException();
                reply.writeLong(mask);
            }
            return true;
        }
        if (code == TRANSACTION_SET_ALLOWED) {
            int slot = data.readInt();
            long mask = data.readLong();
            setAllowedNetworkTypes(slot, mask);
            if (reply != null) reply.writeNoException();
            return true;
        }
        if (code == TRANSACTION_GET_VOLTE) {
            int subId = data.readInt();
            boolean enabled = getVoLteSetting(subId);
            if (reply != null) {
                reply.writeNoException();
                reply.writeInt(enabled ? 1 : 0);
            }
            return true;
        }
        if (code == TRANSACTION_SET_VOLTE) {
            int subId = data.readInt();
            boolean enabled = data.readInt() != 0;
            setVoLteSetting(subId, enabled);
            if (reply != null) reply.writeNoException();
            return true;
        }
        return super.onTransact(code, data, reply, flags);
    }

    private long getAllowedNetworkTypes(int slot) {
        validateSlot(slot);
        return parseNetworkMask(runCommand(
                "/system/bin/cmd",
                "phone",
                "get-allowed-network-types-for-users",
                "-s",
                Integer.toString(slot)));
    }

    private void setAllowedNetworkTypes(int slot, long mask) {
        validateSlot(slot);
        if (mask <= 0) {
            throw new IllegalArgumentException("Network mask must be positive");
        }
        String output = runCommand(
                "/system/bin/cmd",
                "phone",
                "set-allowed-network-types-for-users",
                "-s",
                Integer.toString(slot),
                Long.toBinaryString(mask));
        if (!output.toLowerCase().contains("completed")) {
            throw new IllegalStateException("Phone command did not complete: " + output);
        }
    }

    /** Required by Shizuku's UserService lifecycle. */
    public void destroy() {
        System.exit(0);
    }

    private static void validateSlot(int slot) {
        // Physical SIM slots are small integers. Rejecting anything else also
        // keeps this service from becoming a general-purpose shell bridge.
        if (slot < 0 || slot > 3) {
            throw new IllegalArgumentException("Unsupported SIM slot: " + slot);
        }
    }

    private static void validateSubscription(int subId) {
        if (subId < 0) {
            throw new IllegalArgumentException("No active voice subscription was found");
        }
    }

    /**
     * Reads the same per-subscription Advanced Calling / Enhanced 4G LTE value
     * used by the Settings app. A normal app would use ImsMmTelManager, but on
     * Android 15/16 that manager's framework binder cache is not initialized in
     * Shizuku's standalone UserService process. Resolve the same ITelephony
     * binder directly instead. Shizuku UserServices run as the authorized
     * shell/root identity and are specifically allowed to use non-SDK APIs.
     */
    private static boolean getVoLteSetting(int subId) {
        validateSubscription(subId);
        Object result = invokeTelephony(
                "isAdvancedCallingSettingEnabled",
                new Class<?>[]{int.class},
                subId);
        if (!(result instanceof Boolean)) {
            throw new IllegalStateException("IMS returned an invalid VoLTE state");
        }
        return (Boolean) result;
    }

    private static void setVoLteSetting(int subId, boolean enabled) {
        validateSubscription(subId);
        try {
            invokeTelephony(
                    "setAdvancedCallingSettingEnabled",
                    new Class<?>[]{int.class, boolean.class},
                    subId,
                    enabled);
        } catch (IllegalStateException error) {
            // Android 10-era ITelephony used this shorter name. Keep the
            // fallback for devices whose IMS API predates the newer name.
            if (!(error.getCause() instanceof NoSuchMethodException)) {
                throw error;
            }
            invokeTelephony(
                    "setAdvancedCallingSetting",
                    new Class<?>[]{int.class, boolean.class},
                    subId,
                    enabled);
        }
    }

    private static Object invokeTelephony(
            String methodName, Class<?>[] parameterTypes, Object... args) {
        try {
            Object telephony = telephonyService();
            Class<?> telephonyInterface = Class.forName(ITelephony);
            Method method = telephonyInterface.getDeclaredMethod(methodName, parameterTypes);
            method.setAccessible(true);
            return method.invoke(telephony, args);
        } catch (InvocationTargetException error) {
            throw unwrap("VoLTE setting change", error);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("VoLTE API is unavailable on this Android build", error);
        }
    }

    private static Object telephonyService() {
        try {
            Class<?> serviceManagerClass = Class.forName(SERVICE_MANAGER);
            Method getService = serviceManagerClass.getDeclaredMethod(
                    "getService", String.class);
            getService.setAccessible(true);
            IBinder binder = (IBinder) getService.invoke(null, "phone");
            if (binder == null) {
                throw new IllegalStateException("Phone service is unavailable");
            }
            Class<?> stubClass = Class.forName(ITelephony_STUB);
            Method asInterface = stubClass.getDeclaredMethod("asInterface", IBinder.class);
            asInterface.setAccessible(true);
            Object telephony = asInterface.invoke(null, binder);
            if (telephony == null) {
                throw new IllegalStateException("Phone service returned no telephony interface");
            }
            return telephony;
        } catch (InvocationTargetException error) {
            throw unwrap("connect to phone service", error);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("VoLTE API is unavailable on this Android build", error);
        }
    }

    private static RuntimeException unwrap(String action, InvocationTargetException error) {
        Throwable cause = error.getCause();
        if (cause instanceof RuntimeException) {
            return (RuntimeException) cause;
        }
        String message = cause == null ? error.getMessage() : cause.getMessage();
        return new IllegalStateException(action + " failed"
                + (message == null || message.isEmpty() ? "" : ": " + message), cause);
    }

    private static String runCommand(String... command) {
        Process process = null;
        try {
            process = new ProcessBuilder(command)
                    .redirectErrorStream(true)
                    .start();
            String output = readAll(process.getInputStream()).trim();
            boolean finished;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                finished = process.waitFor(5, TimeUnit.SECONDS);
            } else {
                process.waitFor();
                finished = true;
            }
            if (!finished) {
                process.destroyForcibly();
                throw new IllegalStateException("Phone command timed out");
            }
            if (process.exitValue() != 0) {
                throw new IllegalStateException(output.isEmpty()
                        ? "Phone command failed"
                        : output);
            }
            return output;
        } catch (IOException e) {
            throw new IllegalStateException("Cannot execute phone command", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Phone command interrupted", e);
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    private static String readAll(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[1024];
        int read;
        while ((read = input.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
            if (buffer.size() > 128 * 1024) {
                throw new IOException("Phone command output is unexpectedly large");
            }
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    private static long parseNetworkMask(String output) {
        long mask = 0L;
        String normalized = output.replace('\n', '|').replace('\r', '|');
        String[] names = normalized.split("[|\\s]+");
        for (String name : names) {
            if (name.isEmpty()) continue;
            Long bit = NETWORK_BITS.get(name);
            if (bit == null) {
                throw new IllegalStateException("Unknown network type from phone: " + name);
            }
            mask |= bit;
        }
        if (mask <= 0) {
            throw new IllegalStateException("Phone returned an empty network mask");
        }
        return mask;
    }

    private static Map<String, Long> createNetworkBits() {
        Map<String, Long> bits = new HashMap<>();
        bits.put("GPRS", TelephonyManager.NETWORK_TYPE_BITMASK_GPRS);
        bits.put("EDGE", TelephonyManager.NETWORK_TYPE_BITMASK_EDGE);
        bits.put("UMTS", TelephonyManager.NETWORK_TYPE_BITMASK_UMTS);
        bits.put("CDMA", TelephonyManager.NETWORK_TYPE_BITMASK_CDMA);
        bits.put("EVDO_0", TelephonyManager.NETWORK_TYPE_BITMASK_EVDO_0);
        bits.put("EVDO_A", TelephonyManager.NETWORK_TYPE_BITMASK_EVDO_A);
        bits.put("1xRTT", TelephonyManager.NETWORK_TYPE_BITMASK_1xRTT);
        bits.put("HSDPA", TelephonyManager.NETWORK_TYPE_BITMASK_HSDPA);
        bits.put("HSUPA", TelephonyManager.NETWORK_TYPE_BITMASK_HSUPA);
        bits.put("HSPA", TelephonyManager.NETWORK_TYPE_BITMASK_HSPA);
        bits.put("IDEN", 1L << 10);
        bits.put("EVDO_B", TelephonyManager.NETWORK_TYPE_BITMASK_EVDO_B);
        bits.put("LTE", TelephonyManager.NETWORK_TYPE_BITMASK_LTE);
        bits.put("EHRPD", TelephonyManager.NETWORK_TYPE_BITMASK_EHRPD);
        bits.put("HSPA+", TelephonyManager.NETWORK_TYPE_BITMASK_HSPAP);
        bits.put("GSM", TelephonyManager.NETWORK_TYPE_BITMASK_GSM);
        bits.put("TD_SCDMA", TelephonyManager.NETWORK_TYPE_BITMASK_TD_SCDMA);
        bits.put("IWLAN", TelephonyManager.NETWORK_TYPE_BITMASK_IWLAN);
        bits.put("LTE_CA", TelephonyManager.NETWORK_TYPE_BITMASK_LTE_CA);
        bits.put("NR", NR_MASK);
        return bits;
    }
}

package __PACKAGE__;

import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.telephony.TelephonyManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
    private static final int TRANSACTION_DESTROY = 16777114;
    private static final long NR_MASK = TelephonyManager.NETWORK_TYPE_BITMASK_NR;
    private static final Map<String, Long> NETWORK_BITS = createNetworkBits();

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

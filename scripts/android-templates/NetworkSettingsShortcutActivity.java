package __PACKAGE__;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.telephony.SubscriptionManager;
import android.widget.Toast;

/**
 * A separate launcher icon for the phone's Mobile network settings page.
 *
 * Android does not allow an ordinary application to change preferred network
 * mode or VoLTE itself. This activity only opens the OEM settings screen; the
 * user makes the actual change there.
 */
public final class NetworkSettingsShortcutActivity extends Activity {
    private static final String EXTRA_SUB_ID = "android.provider.extra.SUB_ID";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        openMobileNetworkSettings();
    }

    private void openMobileNetworkSettings() {
        int subId = SubscriptionManager.getDefaultSubscriptionId();
        Intent[] candidates = new Intent[] {
                // Verified on Moto G57 Power 5G / Android 16: this resolves to
                // com.android.settings/.Settings$MobileNetworkActivity.
                new Intent(Settings.ACTION_NETWORK_OPERATOR_SETTINGS),
                // Android 16/AOSP fallback for devices that expose the SIM list.
                new Intent("android.settings.MOBILE_NETWORK_LIST"),
                new Intent(Settings.ACTION_WIRELESS_SETTINGS),
                new Intent(Settings.ACTION_SETTINGS)
        };

        for (Intent candidate : candidates) {
            candidate.putExtra(EXTRA_SUB_ID, subId);
            candidate.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (candidate.resolveActivity(getPackageManager()) == null) continue;
            try {
                startActivity(candidate);
                finish();
                return;
            } catch (RuntimeException ignored) {
                // Try the next settings entry point exposed by this OEM build.
            }
        }

        Toast.makeText(this, "Mobile network settings are unavailable", Toast.LENGTH_SHORT).show();
        finish();
    }
}

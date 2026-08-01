package __PACKAGE__;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.net.Uri;
import android.widget.Toast;

/**
 * Small transparent activity used as the widget's click target. It gives the
 * settings app a normal Activity launch and refreshes the widget after the user
 * returns, instead of leaving a stale value on the home screen.
 */
public class WidgetSettingsActivity extends Activity {
    public static final String EXTRA_TARGET = "widget_settings_target";
    public static final String TARGET_NETWORK = "network";
    public static final String TARGET_VOLTE = "volte";

    private static final int SETTINGS_REQUEST = 7040;
    // Settings.EXTRA_SUB_ID was added in API 28. Keep the literal so the
    // minSdk 24 companion does not load a newer field on older devices.
    private static final String EXTRA_SUB_ID = "android.provider.extra.SUB_ID";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state == null) {
            openForTarget();
        } else {
            finish();
        }
    }

    private void openForTarget() {
        String target = getIntent().getStringExtra(EXTRA_TARGET);
        if (TARGET_NETWORK.equals(target)) {
            showNetworkChoice();
        } else {
            launchSystemSettings();
        }
    }

    private void showNetworkChoice() {
        new AlertDialog.Builder(this)
                .setTitle("Preferred network type")
                .setMessage(
                        "Android normally keeps this setting inside Mobile network settings. " +
                                "The advanced diagnostic menu is device-specific and can disable " +
                                "calling or data if an incompatible mode is selected."
                )
                .setPositiveButton("Mobile network settings", (dialog, which) -> launchSystemSettings())
                .setNeutralButton("Advanced 4636 menu", (dialog, which) -> launchTestingDialer())
                .setNegativeButton("Cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    private void launchSystemSettings() {
        int subId = android.telephony.SubscriptionManager.getDefaultSubscriptionId();

        // On the user's Moto G57 Power 5G running Android 16, ADB resolves
        // NETWORK_OPERATOR_SETTINGS directly to Settings$MobileNetworkActivity, which is the
        // screen containing Preferred network type and VoLTE. Keep the other OEM variants as
        // fallbacks because Settings action availability is device/carrier dependent.
        Intent[] candidates = new Intent[] {
                new Intent(Settings.ACTION_NETWORK_OPERATOR_SETTINGS),
                new Intent("android.settings.MOBILE_NETWORK_LIST"),
                new Intent("android.settings.MOBILE_NETWORK_SETTINGS"),
                new Intent(Settings.ACTION_WIRELESS_SETTINGS),
                new Intent(Settings.ACTION_SETTINGS)
        };
        for (Intent candidate : candidates) {
            candidate.putExtra(EXTRA_SUB_ID, subId);
            candidate.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (candidate.resolveActivity(getPackageManager()) == null) continue;
            try {
                startActivityForResult(candidate, SETTINGS_REQUEST);
                return;
            } catch (RuntimeException ignored) {
                // Try the next documented/general settings fallback.
            }
        }

        Toast.makeText(this, "Mobile network settings are unavailable", Toast.LENGTH_SHORT).show();
        finish();
    }

    private void launchTestingDialer() {
        // ACTION_SECRET_CODE is intentionally not used: Android reserves it for
        // the default dialer/carrier apps. ACTION_DIAL only pre-fills the code;
        // the user remains in control of whether the OEM dialer opens its menu.
        Intent dialer = new Intent(Intent.ACTION_DIAL);
        dialer.setData(Uri.parse("tel:*%23*%234636%23*%23*"));
        dialer.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (dialer.resolveActivity(getPackageManager()) == null) {
            Toast.makeText(this, "A phone dialer is unavailable", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        try {
            startActivityForResult(dialer, SETTINGS_REQUEST);
        } catch (RuntimeException ignored) {
            Toast.makeText(this, "The diagnostic menu is unavailable on this device", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SETTINGS_REQUEST) {
            PhoneSettingsWidgetProvider.updateAll(this);
            finish();
        }
    }
}

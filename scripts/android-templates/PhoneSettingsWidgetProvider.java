package __PACKAGE__;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.telephony.ims.ImsManager;
import android.telephony.ims.ImsMmTelManager;
import android.widget.RemoteViews;

/**
 * Home-screen controls for the settings shown in Android's Mobile network page.
 *
 * A regular app cannot write preferred network mode or the carrier's VoLTE
 * setting on current Android releases. The widget therefore reports the
 * readable state when the platform exposes it and sends each tap to the
 * system's mobile-network settings page. This keeps the widget useful without
 * attempting hidden Settings.Global writes or privileged telephony calls.
 */
public class PhoneSettingsWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_OPEN_NETWORK = "__PACKAGE__.WIDGET_OPEN_NETWORK";
    public static final String ACTION_OPEN_VOLTE = "__PACKAGE__.WIDGET_OPEN_VOLTE";

    private static final int REQUEST_NETWORK = 7011;
    private static final int REQUEST_VOLTE = 7012;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        update(context, manager, appWidgetIds);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent == null) return;
        String action = intent.getAction();
        if (ACTION_OPEN_NETWORK.equals(action) || ACTION_OPEN_VOLTE.equals(action)) {
            updateAll(context);
        }
    }

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName provider = new ComponentName(context, PhoneSettingsWidgetProvider.class);
        update(context, manager, manager.getAppWidgetIds(provider));
    }

    private static void update(Context context, AppWidgetManager manager, int[] ids) {
        if (ids == null || ids.length == 0) return;

        RemoteViews views = new RemoteViews(
                context.getPackageName(),
                R.layout.widget_phone_settings
        );
        String network = preferredNetworkLabel(context);
        String volte = volteLabel(context);
        views.setTextViewText(R.id.widget_network_value, network);
        views.setTextViewText(R.id.widget_volte_value, volte);
        views.setContentDescription(
                R.id.widget_network_row,
                "Open mobile network settings to change the preferred network type"
        );
        views.setContentDescription(
                R.id.widget_volte_row,
                "Open mobile network settings to change VoLTE"
        );

        Intent networkIntent = new Intent(context, WidgetSettingsActivity.class)
                .setAction(ACTION_OPEN_NETWORK)
                .putExtra(WidgetSettingsActivity.EXTRA_TARGET, WidgetSettingsActivity.TARGET_NETWORK)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent volteIntent = new Intent(context, WidgetSettingsActivity.class)
                .setAction(ACTION_OPEN_VOLTE)
                .putExtra(WidgetSettingsActivity.EXTRA_TARGET, WidgetSettingsActivity.TARGET_VOLTE)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent networkPendingIntent = PendingIntent.getActivity(
                context,
                REQUEST_NETWORK,
                networkIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent voltePendingIntent = PendingIntent.getActivity(
                context,
                REQUEST_VOLTE,
                volteIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_network_row, networkPendingIntent);
        views.setOnClickPendingIntent(R.id.widget_volte_row, voltePendingIntent);
        manager.updateAppWidget(ids, views);
    }

    private static String preferredNetworkLabel(Context context) {
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_RADIO_ACCESS)) {
            return "Not available";
        }

        // This is the official preferred-mode read, but it is intentionally
        // best-effort: ordinary apps normally do not hold the privileged read
        // permission or carrier privileges needed by this API.
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                TelephonyManager telephony = getTelephony(context);
                if (telephony != null) {
                    long allowed = telephony.getAllowedNetworkTypesForReason(
                            TelephonyManager.ALLOWED_NETWORK_TYPES_REASON_USER
                    );
                    String label = allowedNetworkLabel(allowed);
                    if (label != null) return label;
                }
            } catch (SecurityException | IllegalStateException | UnsupportedOperationException ignored) {
                // Fall through to the readable active-network snapshot.
            }
        }

        String active = activeNetworkLabel(context);
        return active == null ? "Open settings" : active + " active";
    }

    private static String activeNetworkLabel(Context context) {
        try {
            TelephonyManager telephony = getTelephony(context);
            if (telephony == null || Build.VERSION.SDK_INT < 24) return null;
            return networkTypeLabel(telephony.getDataNetworkType());
        } catch (SecurityException | IllegalStateException | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private static String volteLabel(Context context) {
        if (Build.VERSION.SDK_INT < 30) return "Open settings";
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY_IMS)) {
            return "Not available";
        }

        // Android exposes this read only to privileged/precise-phone-state or
        // carrier-privileged callers. Keep it best-effort for ordinary builds.
        try {
            int subId = SubscriptionManager.getDefaultSubscriptionId();
            if (subId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) return "No SIM";
            ImsManager imsManager = context.getSystemService(ImsManager.class);
            if (imsManager == null) return "Open settings";
            ImsMmTelManager ims = imsManager.getImsMmTelManager(subId);
            return ims.isAdvancedCallingSettingEnabled() ? "On" : "Off";
        } catch (SecurityException | IllegalArgumentException | UnsupportedOperationException ignored) {
            return "Open settings";
        }
    }

    private static TelephonyManager getTelephony(Context context) {
        return (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
    }

    private static String allowedNetworkLabel(long allowed) {
        if (allowed == 0L) return "System default";

        boolean nr = (allowed & TelephonyManager.NETWORK_TYPE_BITMASK_NR) != 0L;
        boolean lte = (allowed & TelephonyManager.NETWORK_TYPE_BITMASK_LTE) != 0L;
        boolean legacy = (allowed & (
                TelephonyManager.NETWORK_TYPE_BITMASK_GSM
                        | TelephonyManager.NETWORK_TYPE_BITMASK_GPRS
                        | TelephonyManager.NETWORK_TYPE_BITMASK_EDGE
                        | TelephonyManager.NETWORK_TYPE_BITMASK_UMTS
                        | TelephonyManager.NETWORK_TYPE_BITMASK_HSDPA
                        | TelephonyManager.NETWORK_TYPE_BITMASK_HSUPA
                        | TelephonyManager.NETWORK_TYPE_BITMASK_HSPA
                        | TelephonyManager.NETWORK_TYPE_BITMASK_HSPAP
        )) != 0L;

        if (nr && lte && legacy) return "Auto (5G)";
        if (nr && lte) return "5G / LTE";
        if (nr) return "5G only";
        if (lte) return "LTE only";
        if (legacy) return "2G / 3G";
        return "Custom mode";
    }

    private static String networkTypeLabel(int type) {
        switch (type) {
            case TelephonyManager.NETWORK_TYPE_NR:
                return "5G";
            case TelephonyManager.NETWORK_TYPE_LTE:
                return "LTE";
            case TelephonyManager.NETWORK_TYPE_HSPAP:
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_HSDPA:
            case TelephonyManager.NETWORK_TYPE_HSUPA:
            case TelephonyManager.NETWORK_TYPE_UMTS:
                return "3G";
            case TelephonyManager.NETWORK_TYPE_GSM:
            case TelephonyManager.NETWORK_TYPE_GPRS:
            case TelephonyManager.NETWORK_TYPE_EDGE:
                return "2G";
            default:
                return "Unknown";
        }
    }
}

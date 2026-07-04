package ai.sakana.tantularguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * No-op MMS receiver for default-SMS app candidacy.
 *
 * Stage 2B quarantine is SMS-only. MMS handling is intentionally out of scope
 * for this prototype; production must implement MMS storage/rendering properly
 * before advertising full default-SMS replacement.
 */
class MmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Intentionally no-op.
    }
}

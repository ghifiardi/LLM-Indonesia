package ai.sakana.tantularguard

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * No-op respond-via-message service for default-SMS app candidacy.
 *
 * Android expects a default SMS candidate to expose this entry point for
 * quick-reply flows. This prototype does not send SMS yet, so it safely stops.
 */
class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        stopSelf(startId)
        return START_NOT_STICKY
    }
}

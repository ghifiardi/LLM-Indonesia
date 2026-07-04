package ai.sakana.tantularguard

/**
 * Pure scoring/level logic for the "Misi Keamanan" gamification card.
 *
 * Four missions worth 25 points each nudge the user through the app's real
 * protection features. Kept Android-free so it is unit-testable.
 */
object GameState {

    const val KEY_CHECK_COUNT = "game_check_count"
    const val KEY_BLOCK_COUNT = "game_block_count"
    const val KEY_CELEBRATED_SCORE = "game_celebrated_score"
    const val FIVE_CHECKS_TARGET = 5

    data class Missions(
        val firstCheck: Boolean,
        val smsGuardOn: Boolean,
        val notifGuardOn: Boolean,
        val fiveChecks: Boolean,
    )

    fun score(m: Missions): Int =
        listOf(m.firstCheck, m.smsGuardOn, m.notifGuardOn, m.fiveChecks).count { it } * 25

    fun levelName(score: Int): String = when {
        score >= 100 -> "🏆 Jagoan Anti-Penipuan"
        score >= 75 -> "🔥 Penjaga Andal"
        score >= 50 -> "💪 Makin Aman"
        score >= 25 -> "🛡️ Mulai Terlindungi"
        else -> "🐣 Pemula"
    }
}

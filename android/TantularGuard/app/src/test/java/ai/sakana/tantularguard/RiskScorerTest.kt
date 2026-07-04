package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the deterministic risk layer. These lock in the safety
 * floor and the SLM-gating policy so future changes can't silently regress them.
 */
class RiskScorerTest {

    private fun verdict(text: String) =
        RiskScorer.evaluate(text, useModelStage = false).verdict

    @Test
    fun plainMessage_isAllowed() {
        assertEquals(RiskScorer.Verdict.ALLOW, verdict("Halo, meeting besok jam 10 di kantor ya"))
    }

    @Test
    fun otpRequest_isHardBlocked() {
        assertEquals(
            RiskScorer.Verdict.BLOCK,
            verdict("CS bank: sebutkan kode OTP Anda sekarang untuk verifikasi"),
        )
    }

    @Test
    fun apkRequest_isHardBlocked() {
        assertEquals(
            RiskScorer.Verdict.BLOCK,
            verdict("Silakan install APK ini untuk klaim refund Anda"),
        )
    }

    @Test
    fun remoteAccessRequest_isHardBlocked() {
        assertEquals(
            RiskScorer.Verdict.BLOCK,
            verdict("Tolong pasang AnyDesk untuk remote access agar saya bisa bantu"),
        )
    }

    @Test
    fun borderlinePromoLink_isWarnAndUsesModelStage() {
        val text = "Klik link ini untuk cek hadiah undian Anda ya kak"
        assertEquals(RiskScorer.Verdict.WARN, verdict(text))
        assertTrue(RiskScorer.shouldUseModelStage(text))
    }

    @Test
    fun clearBlock_doesNotNeedModelStage() {
        val text = "Kirim kode OTP Anda sekarang"
        assertFalse(RiskScorer.shouldUseModelStage(text))
    }

    @Test
    fun clearAllow_doesNotNeedModelStage() {
        assertFalse(RiskScorer.shouldUseModelStage("Terima kasih sudah datang kemarin"))
    }

    @Test
    fun shareVerificationCode_isAccountTakeover() {
        val v = RiskScorer.evaluate(
            "Halo, saya admin WhatsApp. Tolong kirim kode 6 digit yang masuk ke HP Anda",
            useModelStage = false,
        )
        assertEquals(RiskScorer.Verdict.BLOCK, v.verdict)
        assertTrue(v.accountTakeover)
        assertTrue(v.takeoverAdvice != null)
    }

    @Test
    fun linkedDeviceRequest_isAccountTakeover() {
        val v = RiskScorer.evaluate(
            "Scan QR ini untuk menautkan perangkat baru ke akun Anda",
            useModelStage = false,
        )
        assertTrue(v.accountTakeover)
    }

    @Test
    fun slmCanEscalateButNotDowngrade() {
        // A borderline WARN escalates to BLOCK when SLM says PENIPUAN.
        val text = "Klik link ini untuk cek hadiah undian Anda ya kak"
        val escalated = RiskScorer.evaluate(text, useModelStage = false, slmLabel = SlmLabel.PENIPUAN)
        assertEquals(RiskScorer.Verdict.BLOCK, escalated.verdict)

        // A hard BLOCK stays BLOCK even if SLM says AMAN (never downgrade).
        val hard = RiskScorer.evaluate(
            "Sebutkan kode OTP Anda",
            useModelStage = false,
            slmLabel = SlmLabel.AMAN,
        )
        assertEquals(RiskScorer.Verdict.BLOCK, hard.verdict)
    }

    @Test
    fun riskScoreIsBounded() {
        val (score, _) = RiskScorer.score(
            "otp pin cvv password link apk remote hadiah refund segera petugas",
        )
        assertTrue(score <= 1.0)
    }
}

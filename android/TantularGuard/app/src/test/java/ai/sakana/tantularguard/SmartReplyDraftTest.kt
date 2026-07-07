package ai.sakana.tantularguard

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmartReplyDraftTest {

    @Test fun draftsPoliteScheduleReply() {
        val text = "Halo, rapat besok jam 10 di kantor ya."
        val verdict = RiskScorer.evaluate(text, useModelStage = false)
        val triage = MessageTriage.analyze(text, verdict)

        val reply = SmartReplyDraft.draft(text, triage, verdict, SmartReplyDraft.Tone.POLITE).text

        assertTrue(reply.contains("Terima kasih"))
        assertTrue(reply.contains("konfirmasi", ignoreCase = true))
    }

    @Test fun draftsShortBillReply() {
        val text = "Tagihan internet Rp389.000 jatuh tempo besok."
        val verdict = RiskScorer.evaluate(text, useModelStage = false)
        val triage = MessageTriage.analyze(text, verdict)

        val reply = SmartReplyDraft.draft(text, triage, verdict, SmartReplyDraft.Tone.SHORT).text

        assertTrue(reply.contains("tagihan", ignoreCase = true))
    }

    @Test fun unsafeMessageGetsSafeReply() {
        val text = "CS bank: sebutkan kode OTP dan PIN Anda sekarang."
        val verdict = RiskScorer.evaluate(text, useModelStage = false)
        val triage = MessageTriage.analyze(text, verdict)

        val reply = SmartReplyDraft.draft(text, triage, verdict, SmartReplyDraft.Tone.FRIENDLY).text

        assertTrue(reply.contains("kanal resmi", ignoreCase = true))
        assertFalse("reply must not repeat OTP request", reply.contains("OTP"))
        assertFalse("reply must not repeat PIN request", reply.contains("PIN"))
    }

    @Test fun cancellationNeverAutoSendsAndIsPlainTextDraft() {
        val text = "Paket akan dikirim hari ini."
        val verdict = RiskScorer.evaluate(text, useModelStage = false)
        val triage = MessageTriage.analyze(text, verdict)

        val reply = SmartReplyDraft.draft(text, triage, verdict, SmartReplyDraft.Tone.CANCELLATION).text

        assertTrue(reply.contains("tunda", ignoreCase = true) || reply.contains("batalkan", ignoreCase = true))
        assertFalse(reply.contains("\n"))
    }
}

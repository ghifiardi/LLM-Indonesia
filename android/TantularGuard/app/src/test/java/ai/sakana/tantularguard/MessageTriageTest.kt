package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageTriageTest {
    @Test fun cleanChatIsGeneralLow() {
        val r = MessageTriage.analyze("Halo, jam berapa kita ketemu?")
        assertEquals("umum", r.category)
        assertEquals("rendah", r.priority)
    }

    @Test fun billExtractsAmountAndDate() {
        val r = MessageTriage.analyze("Tagihan internet Rp389.000 jatuh tempo besok")
        assertEquals("tagihan", r.category)
        assertTrue(r.items.any { it.kind == "amount" })
        assertTrue(r.items.any { it.kind == "date" })
    }

    @Test fun promoCategory() {
        assertEquals("promo", MessageTriage.analyze("Promo cashback 50% pakai voucher HEMAT50").category)
    }

    @Test fun packageExtractsCodeAndAmount() {
        val r = MessageTriage.analyze("Paket Anda dikirim. Resi JP12345 COD Rp25.000")
        assertEquals("paket", r.category)
        assertTrue(r.items.any { it.kind == "code" })
        assertTrue(r.items.any { it.kind == "amount" })
    }

    @Test fun meetingTomorrowIsSchedule() {
        assertEquals("jadwal", MessageTriage.analyze("Meeting besok jam 10 di kantor").category)
    }

    @Test fun takeoverIsHighSecurity() {
        val v = RiskScorer.evaluate("Admin WhatsApp: kirim kode 6 digit", useModelStage = false)
        val r = MessageTriage.analyze("Admin WhatsApp: kirim kode 6 digit", v)
        assertEquals("keamanan_akun", r.category)
        assertEquals("tinggi", r.priority)
    }

    @Test fun blockVerdictIsHigh() {
        val v = RiskScorer.evaluate("CS bank minta OTP", useModelStage = false)
        assertEquals("tinggi", MessageTriage.analyze("CS bank minta OTP", v).priority)
    }
}

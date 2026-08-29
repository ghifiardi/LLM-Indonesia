package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the digest self-test in tantular_assistant.py. Keep the two in sync. */
class NotificationClassifierTest {

    @Test
    fun categoriesMatchReference() {
        assertEquals("keuangan", NotificationClassifier.classify("transaksi Rp125.000 berhasil", "BCA").key)
        assertEquals("paket", NotificationClassifier.classify("paket akan tiba hari ini", "JNE").key)
        // Specific institution (sekolah) wins over the broad "pembayaran" (keuangan).
        assertEquals("sekolah", NotificationClassifier.classify("pembayaran kegiatan paling lambat Jumat", "Sekolah").key)
        assertEquals("promo", NotificationClassifier.classify("Promo diskon 40% khusus hari ini").key)
        assertEquals("keamanan_akun", NotificationClassifier.classify("Kode OTP Anda 123456").key)
        assertEquals("kesehatan", NotificationClassifier.classify("jadwal kontrol Selasa 09.00", "Dokter").key)
        assertEquals("travel", NotificationClassifier.classify("Tiket kereta Anda sudah terbit").key)
        assertEquals("umum", NotificationClassifier.classify("Halo apa kabar").key)
    }

    @Test
    fun priorityMatchesReference() {
        assertEquals("tinggi", NotificationClassifier.classify("Kode OTP 123456").priority)
        assertEquals("rendah", NotificationClassifier.classify("Promo diskon 40%").priority)
        assertEquals("tinggi", NotificationClassifier.classify("Tagihan listrik jatuh tempo").priority)
        assertEquals("sedang", NotificationClassifier.classify("transaksi Rp50.000", "Bank").priority)
    }

    @Test
    fun promoAndUmumAreUnimportant() {
        assertTrue("promo" in NotificationClassifier.UNIMPORTANT)
        assertTrue("umum" in NotificationClassifier.UNIMPORTANT)
        assertTrue("keuangan" !in NotificationClassifier.UNIMPORTANT)
        assertEquals(10, NotificationClassifier.ORDER.size)
    }

    @Test
    fun avoidsSubstringFalsePositives() {
        assertEquals(
            "umum",
            NotificationClassifier.classify(
                "I got to demo a Recursive CLI coding agent with lower token cost",
                "Ghifi",
            ).key,
        )
        assertEquals(
            "umum",
            NotificationClassifier.classify(
                "Update Incident - RITA Failed Login [3ID - TM/KYN]",
                "Our IT Group",
            ).key,
        )
        assertEquals(
            "umum",
            NotificationClassifier.classify(
                "Dengan hormat, terima kasih atas kerja sama dalam memanfaatkan fitur dan layanan.",
                "Our IT Group",
            ).key,
        )
    }

    @Test
    fun accountSecurityNeedsSpecificSecurityPhrase() {
        assertEquals("keamanan_akun", NotificationClassifier.classify("Kode login Anda 123456").key)
        assertEquals("keamanan_akun", NotificationClassifier.classify("Reset your password", "Slack").key)
    }

    @Test
    fun digestDropsGenericGroupChatNoise() {
        assertEquals(
            false,
            NotificationClassifier.shouldKeepForDigest(
                "com.whatsapp",
                "Security Strategy & Architecture (33 pesan): Ghifi",
                "umum",
            ),
        )
        assertEquals(true, NotificationClassifier.shouldKeepForDigest("com.whatsapp", "Ghifi", "umum"))
        assertEquals(true, NotificationClassifier.shouldKeepForDigest("com.whatsapp", "Group (33 pesan): Ghifi", "kerja"))
        assertEquals(false, NotificationClassifier.shouldKeepForDigest("com.android.systemui", "System", "umum"))
    }
}

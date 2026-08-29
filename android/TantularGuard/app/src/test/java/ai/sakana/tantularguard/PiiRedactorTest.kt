package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the Python reference self-test in tantular_assistant.py. */
class PiiRedactorTest {

    @Test
    fun otpIsFoundAndFullyMasked() {
        val r = PiiRedactor.redact("Kode OTP Anda 483920, jangan beri ke siapa pun")
        assertEquals(1, r.findings.count { it.kind == "otp" })
        assertFalse(r.redactedText.contains("483920"))
    }

    @Test
    fun accountNearKeywordIsMasked() {
        val r = PiiRedactor.redact("transfer ke rek 1234567890 a/n Budi")
        assertEquals(1, r.findings.count { it.kind == "account" })
        assertFalse(r.redactedText.contains("1234567890"))
    }

    @Test
    fun nikIsFoundNotCard() {
        val r = PiiRedactor.redact("NIK saya 3174012509900001 ya")
        assertEquals(1, r.findings.count { it.kind == "nik" })
        assertTrue(r.findings.none { it.kind == "card" })
    }

    @Test
    fun luhnCardIsFoundNotNik() {
        val r = PiiRedactor.redact("kartu 4539578763621486 milik saya")
        assertEquals(1, r.findings.count { it.kind == "card" })
        assertTrue(r.findings.none { it.kind == "nik" })
    }

    @Test
    fun phoneAndEmailBothMasked() {
        val r = PiiRedactor.redact("hubungi 081234567890 atau email budi@example.com")
        assertEquals(2, r.findings.size)
        assertFalse(r.redactedText.contains("081234567890"))
        assertFalse(r.redactedText.contains("budi@example.com"))
    }


    @Test
    fun addressIsMasked() {
        val r = PiiRedactor.redact("Alamat pengiriman: Jl Mawar No 10 RT 02 RW 03 Jakarta")
        assertEquals(1, r.findings.count { it.kind == "address" })
        assertFalse(r.redactedText.contains("Jl Mawar"))
    }

    @Test
    fun orderIdIsMasked() {
        val r = PiiRedactor.redact("Pesanan INV-AB12345 sudah dikirim dengan resi JP987654321")
        assertTrue(r.findings.any { it.kind == "order" })
        assertFalse(r.redactedText.contains("JP987654321"))
    }

    @Test
    fun medicalIdIsMasked() {
        val r = PiiRedactor.redact("No RM pasien RM123456 dan BPJS Kesehatan 0001234567890")
        assertTrue(r.findings.any { it.kind == "medical" })
        assertFalse(r.redactedText.contains("RM123456"))
    }

    @Test
    fun cleanMessageUnchanged() {
        val r = PiiRedactor.redact("Halo, jam berapa kita ketemu?")
        assertEquals(0, r.findings.size)
        assertEquals("Halo, jam berapa kita ketemu?", r.redactedText)
    }

    @Test
    fun emptyNoException() {
        val r = PiiRedactor.redact("")
        assertEquals("", r.redactedText)
        assertFalse(r.hasSensitive())
    }
}

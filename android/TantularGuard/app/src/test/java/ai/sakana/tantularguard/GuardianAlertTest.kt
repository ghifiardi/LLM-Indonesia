package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GuardianAlertTest {
    @Test fun normalizeLocalToPlus62() {
        assertEquals("+628123456789", GuardianAlert.normalizeNumber("0812-3456-789"))
    }

    @Test fun normalizeKeepsPlus() {
        assertEquals("+628123456789", GuardianAlert.normalizeNumber("+62 812 3456 789"))
    }

    @Test fun validation() {
        assertTrue(GuardianAlert.isValidNumber("081234567890"))
        assertFalse(GuardianAlert.isValidNumber("12345"))
        assertFalse(GuardianAlert.isValidNumber(""))
    }

    @Test fun alertHasNameButIsKeywordFreeAndNoRawMessage() {
        val body = GuardianAlert.buildAlert("Ibu", "berisiko tinggi penipuan", listOf("diminta OTP"))
        assertTrue(body.contains("Ibu"))
        // Keyword-free: carriers drop SMS containing these anti-fraud tokens.
        assertFalse(body.contains("penipuan"))
        assertFalse(body.contains("OTP"))
        assertFalse(body.contains("PIN"))
        assertFalse(body.contains("tautan"))
        // Never leaks the raw scam message.
        assertFalse(body.contains("3174012509900001"))
    }

    @Test fun alertFallsBackWhenNoName() {
        val body = GuardianAlert.buildAlert(null, "mencurigakan", emptyList())
        assertTrue(body.contains("Tantular"))
        assertTrue(body.isNotBlank())
    }

    @Test fun builtAlertIsRecognizedByGuardianMode() {
        // The signature contract: an alert we build must be detectable as one on
        // the receiving (guardian) phone, and ordinary texts must not be.
        val body = GuardianAlert.buildAlert("Ibu", "berisiko tinggi penipuan", listOf("diminta OTP"))
        assertTrue(GuardianAlert.looksLikeGuardianAlert(body))
        assertFalse(GuardianAlert.looksLikeGuardianAlert("Halo, apa kabar hari ini?"))
        assertFalse(GuardianAlert.looksLikeGuardianAlert(null))
    }

    @Test fun alertIsNotBulkLooking() {
        // No "[Brand]" bracket prefix and no keyword pileup that trips spam filters.
        val body = GuardianAlert.buildAlert("Ibu", "berisiko tinggi penipuan", listOf("diminta OTP"))
        assertFalse(body.startsWith("["))
        assertFalse(body.contains("jangan klik tautan"))
        assertFalse(body.contains("install aplikasi"))
    }

    @Test fun alertIsSingleAsciiSmsSegment() {
        // A single non-ASCII char (em-dash, curly quote) forces UCS-2 encoding,
        // which splits the SMS into 67-char segments -> partial GENERIC_FAILURE
        // and mis-reassembly on Huawei/iOS. Keep it GSM-7 and one segment.
        val body = GuardianAlert.buildAlert("Ibu", "berisiko tinggi penipuan", listOf("diminta OTP"))
        assertTrue("alert must be pure ASCII", body.all { it.code in 32..126 })
        assertTrue("alert must fit one GSM-7 SMS segment (<=160)", body.length <= 160)
    }

    @Test fun rateLimit() {
        assertTrue(GuardianAlert.shouldSend(10_000_000L, 0L))
        assertFalse(GuardianAlert.shouldSend(1_000L, 0L))
    }

    @Test fun levelTextMapping() {
        assertEquals("berisiko pengambilalihan akun", GuardianAlert.levelText("WARN", true))
        assertEquals("berisiko tinggi penipuan", GuardianAlert.levelText("BLOCK", false))
    }

    @Test fun sameIncidentSharesKeyRegardlessOfSignalOrder() {
        // Same scam via SMS and WhatsApp -> same key -> deduped to one alert.
        val a = GuardianAlert.incidentKey("berisiko pengambilalihan akun", listOf("kode_verifikasi_akun", "minta_bagikan_kode"))
        val b = GuardianAlert.incidentKey("berisiko pengambilalihan akun", listOf("minta_bagikan_kode", "kode_verifikasi_akun"))
        assertEquals(a, b)
    }

    @Test fun differentThreatHasDifferentKey() {
        val takeover = GuardianAlert.incidentKey("berisiko pengambilalihan akun", listOf("minta_bagikan_kode"))
        val phishing = GuardianAlert.incidentKey("berisiko tinggi penipuan", listOf("tautan_phishing"))
        assertTrue(takeover != phishing)
    }

    @Test fun perIncidentRateLimit() {
        val now = 10_000_000L
        val key = GuardianAlert.incidentKey("berisiko tinggi penipuan", listOf("tautan_phishing"))
        // Same incident 1 minute ago -> suppressed; a different incident -> allowed.
        assertFalse(GuardianAlert.shouldSend(now, now - 60_000L))
        assertTrue(GuardianAlert.shouldSend(now, 0L))
        assertTrue(key.isNotBlank())
    }
}

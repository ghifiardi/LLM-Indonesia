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

    @Test fun alertHasNameAndLevelButNoRawMessage() {
        val body = GuardianAlert.buildAlert("Ibu", "berisiko tinggi penipuan", listOf("diminta OTP"))
        assertTrue(body.contains("Ibu"))
        assertTrue(body.contains("berisiko tinggi penipuan"))
        assertTrue(body.contains("diminta OTP"))
        assertFalse(body.contains("3174012509900001"))
    }

    @Test fun alertFallsBackWhenNoName() {
        val body = GuardianAlert.buildAlert(null, "mencurigakan", emptyList())
        assertTrue(body.contains("Tantular Guard"))
        assertTrue(body.isNotBlank())
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

package ai.sakana.tantularguard

import org.junit.Assert.assertEquals
import org.junit.Test

class GameStateTest {

    @Test
    fun scoreCounts25PerCompletedMission() {
        assertEquals(0, GameState.score(GameState.Missions(false, false, false, false)))
        assertEquals(25, GameState.score(GameState.Missions(true, false, false, false)))
        assertEquals(50, GameState.score(GameState.Missions(true, false, true, false)))
        assertEquals(100, GameState.score(GameState.Missions(true, true, true, true)))
    }

    @Test
    fun levelNamesCoverAllBands() {
        assertEquals("🐣 Pemula", GameState.levelName(0))
        assertEquals("🛡️ Mulai Terlindungi", GameState.levelName(25))
        assertEquals("💪 Makin Aman", GameState.levelName(50))
        assertEquals("🔥 Penjaga Andal", GameState.levelName(75))
        assertEquals("🏆 Jagoan Anti-Penipuan", GameState.levelName(100))
    }
}

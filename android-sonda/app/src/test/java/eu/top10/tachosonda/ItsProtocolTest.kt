package eu.top10.tachosonda

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ItsProtocolTest {

    private fun bytes(hex: String): ByteArray = parseHex(hex)!!

    private fun msgs(frames: List<Frame>): List<ItsMessage> = frames.filterIsInstance<Frame.Msg>().map { it.msg }

    private fun junk(frames: List<Frame>): List<ByteArray> = frames.filterIsInstance<Frame.Junk>().map { it.bytes }

    @Test
    fun checksumIsSumModulo256() {
        // Start Communication от Допълнение 7 — известна последователност с контролна сума E0
        assertEquals(0xE0, ItsCodec.checksum(bytes("81 EE F0 81")))
        assertArrayEquals(bytes("81 EE F0 81 E0"), ItsCodec.withChecksum(bytes("81 EE F0 81")))
    }

    @Test
    fun requestDataStrict() {
        // EE A0 00 08 01 FF FF + CS
        val m = ItsCodec.requestData(0xA0, 1, ReqVariant.STRICT)
        assertEquals("EE A0 00 08 01 FF FF 95", m.hex())
    }

    @Test
    fun requestDataWithTypeInData() {
        val m = ItsCodec.requestData(0xA0, 2, ReqVariant.TRTP_IN_DATA)
        assertEquals("EE A0 01 08 02 FF FF 02", m.hex().substring(0, 23))
        assertEquals(ItsCodec.checksum(m, 0, m.size - 1), m.last().u())
    }

    @Test
    fun pinDigitsAsBytesOrAscii() {
        assertEquals("EE 05 04 03 FF FF FF 01 02 03 04", ItsCodec.sendPin(0x05, "1234", ascii = false).copyOfRange(0, 11).hex())
        assertEquals("31 32 33 34", ItsCodec.sendPin(0x05, "1234", ascii = true).copyOfRange(7, 11).hex())
    }

    @Test
    fun parsesSpecMessage() {
        val pinRequest = ItsCodec.build(0xA0, Its.VU, Its.REQUEST_PIN, Its.NONE)
        val out = ItsFramer().feed(pinRequest, 0)
        val m = msgs(out).single()
        assertEquals(Its.REQUEST_PIN, m.sid)
        assertEquals(Layout.SPEC, m.layout)
        assertEquals(0, m.data.size)
        assertTrue(junk(out).isEmpty())
    }

    @Test
    fun parsesMessageSplitAcrossReads() {
        val data = ItsCodec.build(0x07, Its.VU, Its.REQUEST_ACCEPTED, 1, ByteArray(20) { it.toByte() })
        val f = ItsFramer()
        assertTrue(f.feed(data.copyOfRange(0, 5), 0).isEmpty())
        assertTrue(f.feed(data.copyOfRange(5, 17), 10).isEmpty())
        val m = msgs(f.feed(data.copyOfRange(17, data.size), 20)).single()
        assertEquals(20, m.data.size)
        assertEquals(19, m.data.last().u())
    }

    @Test
    fun parsesTwoMessagesInOneRead() {
        val a = ItsCodec.build(0xA0, Its.VU, Its.SEND_ITS_ID, Its.NONE, byteArrayOf(0x07))
        val b = ItsCodec.build(0x07, Its.VU, Its.REQUEST_PIN, Its.NONE)
        val out = msgs(ItsFramer().feed(a + b, 0))
        assertEquals(listOf(Its.SEND_ITS_ID, Its.REQUEST_PIN), out.map { it.sid })
        assertEquals(0x07, out[0].data[0].u())
    }

    @Test
    fun skipsGarbageBeforeMessage() {
        val m = ItsCodec.build(0xA0, Its.VU, Its.REQUEST_PIN, Its.NONE)
        val out = ItsFramer().feed(bytes("00 11 22") + m, 0)
        assertEquals("00 11 22", junk(out).single().hex())
        assertEquals(Its.REQUEST_PIN, msgs(out).single().sid)
    }

    @Test
    fun parsesMessageWithoutCounters() {
        // TGT SRC LEN SID TRTP DATA CS — ако тахографът изпуска CC/CM
        val m = ItsCodec.withChecksum(bytes("A0 EE 01 04 FF 01"))
        val f = ItsFramer()
        assertTrue(msgs(f.feed(m, 0)).isEmpty()) // първо чака, може да е по регламента
        val out = msgs(f.idle(5000))
        assertEquals(Layout.NO_COUNTERS, out.single().layout)
        assertTrue(out.single().flag())
    }

    @Test
    fun staleBytesBecomeJunk() {
        val f = ItsFramer(staleMs = 1000)
        assertTrue(f.feed(bytes("EE 41 30"), 0).isEmpty())
        assertTrue(f.idle(500).isEmpty())
        val out = f.idle(2000)
        assertEquals("EE 41 30", junk(out).single().hex())
        assertEquals(0, f.pending)
    }

    @Test
    fun badChecksumIsNotAMessage() {
        val m = ItsCodec.build(0xA0, Its.VU, Its.REQUEST_PIN, Its.NONE)
        m[m.size - 1] = (m.last() + 1).toByte()
        val f = ItsFramer()
        f.feed(m, 0)
        assertTrue(msgs(f.idle(10_000)).isEmpty())
    }

    @Test
    fun parseHexAcceptsSpacesAndRejectsOddLength() {
        assertArrayEquals(bytes("EEA0"), parseHex("ee a0"))
        assertArrayEquals(bytes("EE A0"), parseHex("0xEE,0xA0"))
        assertNull(parseHex("EEA"))
        assertNull(parseHex("ZZ"))
    }

    // ---------- разговорът ----------

    private fun sent(acts: List<Act>): List<ByteArray> = acts.filterIsInstance<Act.Send>().map { it.bytes }

    private fun vu(sid: Int, trtp: Int = Its.NONE, data: ByteArray = ByteArray(0), to: Int = 0xA0, cc: Int = Its.NONE, cm: Int = Its.NONE) =
        msgs(ItsFramer().feed(ItsCodec.build(to, Its.VU, sid, trtp, data, cc, cm), 0)).single()

    @Test
    fun takesNumberFromTachographAndUsesIt() {
        val s = ItsSession()
        s.request(1)
        s.onMessage(vu(Its.SEND_ITS_ID, data = byteArrayOf(0x09)))
        assertEquals(0x09, s.itsId)
        // при мълчание праща отново с новия номер
        val again = sent(s.onTimeout()).single()
        assertEquals(0x09, again[1].u())
    }

    @Test
    fun pinFlowRepeatsRequestAfterSuccess() {
        val s = ItsSession()
        s.request(2)
        assertTrue(s.onMessage(vu(Its.REQUEST_PIN)).single() is Act.AskPin)
        val pin = sent(s.pin("1234")).single()
        assertEquals(Its.SEND_PIN, pin[3].u())
        val after = sent(s.onMessage(vu(Its.PAIRING_RESULT, data = byteArrayOf(1)))).single()
        assertEquals(Its.REQUEST_DATA, after[3].u())
        assertEquals(2, after[4].u())
    }

    @Test
    fun wrongPinTriesOtherFormatOnlyOnce() {
        val s = ItsSession()
        s.pin("1234")
        val retry = sent(s.onMessage(vu(Its.PAIRING_RESULT, data = byteArrayOf(0)))).single()
        assertEquals("31 32 33 34", retry.copyOfRange(7, 11).hex())
        assertTrue(sent(s.onMessage(vu(Its.PAIRING_RESULT, data = byteArrayOf(0)))).isEmpty())
        assertEquals(2, s.wrongPins)
    }

    @Test
    fun stopsSendingPinBeforeLongBan() {
        val s = ItsSession(wrongPins = ItsSession.MAX_WRONG_PINS)
        assertFalse(s.pinAllowed())
        assertTrue(sent(s.pin("1234")).isEmpty())
    }

    @Test
    fun silenceRetriesThenSwitchesVariantThenGivesUp() {
        val s = ItsSession()
        s.request(1)
        assertEquals(0, sent(s.onTimeout()).single()[2].u())          // още веднъж, LEN=0
        assertEquals(1, sent(s.onTimeout()).single()[2].u())          // другият вариант, LEN=1
        val last = s.onTimeout()
        assertTrue(sent(last).isEmpty())
        assertEquals(1, last.filterIsInstance<Act.Answered>().single().trtp)
        assertNull(s.pendingTrtp)
    }

    @Test
    fun lengthErrorSwitchesVariant() {
        val s = ItsSession()
        s.request(4)
        val acts = s.onMessage(vu(Its.NEGATIVE_ANSWER, trtp = Its.REQUEST_DATA, data = byteArrayOf(Its.REQUEST_DATA.toByte(), 0x13)))
        assertEquals(1, sent(acts).single()[2].u())
        assertEquals(ReqVariant.TRTP_IN_DATA, s.variant)
    }

    @Test
    fun joinsSubmessages() {
        val s = ItsSession()
        s.request(2)
        assertTrue(s.onMessage(vu(Its.REQUEST_ACCEPTED, 2, byteArrayOf(1, 2), cc = 1, cm = 2)).none { it is Act.Data })
        val acts = s.onMessage(vu(Its.REQUEST_ACCEPTED, 2, byteArrayOf(3), cc = 2, cm = 2))
        assertEquals("01 02 03", acts.filterIsInstance<Act.Data>().single().bytes.hex())
        assertEquals(2, acts.filterIsInstance<Act.Answered>().single().trtp)
    }

    @Test
    fun personalDataNotSharedIsExplained() {
        val m = vu(Its.DATA_UNAVAILABLE, 2, byteArrayOf(0x11))
        assertTrue(Its.describe(m).contains("съгласието"))
    }
}

package eu.top10.tachosonda

import java.io.ByteArrayOutputStream

/*
 * ITS интерфейс на тахографа — Регламент (ЕС) 2016/799, Приложение IC, Допълнение 13.
 *
 * Връзка: Bluetooth (класически), сериен профил SPP.
 * Съобщение:  TGT SRC LEN | SID TRTP CC CM DATA | CS
 *   TGT, SRC  — 1 байт; тахографът е 0xEE, телефонът започва с 0xA0,
 *               после тахографът му дава собствен номер (SendITSID).
 *   LEN       — дължина само на DATA (така пише в текста на регламента).
 *   CC, CM    — номер на подсъобщение / общ брой; 0xFF, ако не се ползват.
 *   CS        — сума на всички предишни байтове по модул 256.
 *
 * В регламента има неясноти (таблицата дава LEN=01 за RequestData без DATA,
 * не е казано дали цифрите на PIN са байтове 0–9 или ASCII), затова сондата
 * разпознава няколко варианта и записва кой е проработил.
 */

fun Byte.u(): Int = toInt() and 0xFF

fun ByteArray.hex(): String = joinToString(" ") { "%02X".format(it.u()) }

/** Шестнадесетичен изглед по 16 байта на ред, с ASCII отдясно. */
fun ByteArray.dump(): String = buildString {
    var i = 0
    while (i < this@dump.size) {
        val chunk = this@dump.copyOfRange(i, minOf(i + 16, this@dump.size))
        append("%04X  ".format(i))
        append(chunk.hex().padEnd(47))
        append("  ")
        for (b in chunk) {
            val c = b.u()
            append(if (c in 32..126) c.toChar() else '.')
        }
        append('\n')
        i += 16
    }
}

/** Чете шестнадесетичен текст („EE A0 00 08“ или „eea00008“). */
fun parseHex(text: String): ByteArray? {
    val clean = text.replace(Regex("[\\s,:;-]|0x|0X"), "")
    if (clean.isEmpty() || clean.length % 2 != 0) return null
    if (!clean.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
    return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

object Its {
    const val VU = 0xEE
    const val FIRST_ID = 0xA0
    const val NONE = 0xFF

    const val REQUEST_PIN = 0x01
    const val SEND_ITS_ID = 0x02
    const val SEND_PIN = 0x03
    const val PAIRING_RESULT = 0x04
    const val SEND_PUC = 0x05
    const val BAN_LIFTING_RESULT = 0x06
    const val REQUEST_REJECTED = 0x07
    const val REQUEST_DATA = 0x08
    const val REQUEST_ACCEPTED = 0x09
    const val DATA_UNAVAILABLE = 0x0A
    const val NEGATIVE_ANSWER = 0x0B

    private val SID_NAMES = mapOf(
        REQUEST_PIN to "RequestPIN (тахографът иска PIN)",
        SEND_ITS_ID to "SendITSID (тахографът ни дава номер)",
        SEND_PIN to "SendPIN",
        PAIRING_RESULT to "PairingResult (резултат от PIN)",
        SEND_PUC to "SendPUC",
        BAN_LIFTING_RESULT to "BanLiftingResult",
        REQUEST_REJECTED to "RequestRejected (блокирани сме)",
        REQUEST_DATA to "RequestData (искане на данни)",
        REQUEST_ACCEPTED to "RequestAccepted (данни)",
        DATA_UNAVAILABLE to "DataUnavailable (няма данни)",
        NEGATIVE_ANSWER to "NegativeAnswer (отказ)"
    )

    val TRTP_NAMES = linkedMapOf(
        1 to "стандартни данни на тахографа",
        2 to "лични данни: времена, дейности, скорост",
        3 to "GNSS позиция (лични)",
        4 to "стандартни събития",
        5 to "лични събития (напр. превишения)",
        6 to "стандартни повреди",
        7 to "данни на производителя"
    )

    private val NEGATIVE_CODES = mapOf(
        0x10 to "общ отказ",
        0x11 to "услугата не се поддържа",
        0x12 to "подфункцията не се поддържа",
        0x13 to "грешна дължина на съобщението",
        0x22 to "условията не са изпълнени или грешна последователност",
        0x31 to "извън обхват",
        0x33 to "извън обхват",
        0x78 to "отговорът се подготвя",
        0xFB to "номерът (ITS ID) не съвпада или не е намерен",
        0xFC to "номерът (ITS ID) не съвпада или не е намерен"
    )

    private val UNAVAILABLE_CODES = mapOf(
        0x10 to "няма данни",
        0x11 to "личните данни не са разрешени — включи съгласието в тахографа"
    )

    fun sidName(sid: Int): String = SID_NAMES[sid] ?: "непознат SID %02X".format(sid)

    fun trtpName(trtp: Int): String = TRTP_NAMES[trtp] ?: "тип %02X".format(trtp)

    private fun codes(data: ByteArray, table: Map<Int, String>): String =
        if (data.isEmpty()) "без код"
        else data.joinToString(", ") { b -> "%02X".format(b.u()) + (table[b.u()]?.let { " ($it)" } ?: "") }

    /** Кратко описание на съобщение от тахографа на български. */
    fun describe(m: ItsMessage): String = when (m.sid) {
        REQUEST_PIN -> "Тахографът иска PIN"
        SEND_ITS_ID -> "Тахографът ни даде номер " + (m.data.firstOrNull()?.let { "%02X".format(it.u()) } ?: "(празно)")
        PAIRING_RESULT -> if (m.flag()) "PIN е приет" else "PIN е отхвърлен"
        BAN_LIFTING_RESULT -> if (m.flag()) "Блокирането е снето" else "PUC е отхвърлен"
        REQUEST_REJECTED -> "Отказ: телефонът е блокиран. Оставащо време (сурово): ${m.data.hex()}"
        REQUEST_ACCEPTED -> "Данни — ${trtpName(m.trtp)}: ${m.data.size} байта" + m.partLabel()
        DATA_UNAVAILABLE -> "Няма данни (${trtpName(m.trtp)}): " + codes(m.data, UNAVAILABLE_CODES)
        NEGATIVE_ANSWER -> "Отказ на ${sidName(m.trtp)}: " + codes(m.data, NEGATIVE_CODES)
        else -> sidName(m.sid)
    }
}

/** Как е подредено съобщението — регламентът не е напълно ясен, затова пробваме три варианта. */
enum class Layout(val label: String) {
    SPEC("по регламента (LEN = само DATA)"),
    NO_COUNTERS("без CC/CM"),
    LEN_ALL("LEN брои и SID, TRTP, CC, CM");

    /** Обща дължина на съобщението при даден LEN, или null ако е невъзможно. */
    fun total(len: Int): Int? = when (this) {
        SPEC -> len + 8
        NO_COUNTERS -> len + 6
        LEN_ALL -> if (len >= 4) len + 4 else null
    }
}

class ItsMessage(
    val tgt: Int,
    val src: Int,
    val sid: Int,
    val trtp: Int,
    val cc: Int,
    val cm: Int,
    val data: ByteArray,
    val raw: ByteArray,
    val layout: Layout
) {
    fun flag(): Boolean = data.isNotEmpty() && data[0].u() != 0

    fun isPart(): Boolean = cc != Its.NONE && cm != Its.NONE && cm > 1

    fun partLabel(): String = if (isPart()) " (част $cc от $cm)" else ""
}

sealed class Frame {
    class Msg(val msg: ItsMessage) : Frame()
    class Junk(val bytes: ByteArray) : Frame()
}

object ItsCodec {
    fun checksum(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): Int {
        var s = 0
        for (i in from until to) s = (s + bytes[i].u()) and 0xFF
        return s
    }

    fun withChecksum(bytes: ByteArray): ByteArray = bytes + checksum(bytes).toByte()

    fun build(
        tgt: Int, src: Int, sid: Int, trtp: Int,
        data: ByteArray = ByteArray(0), cc: Int = Its.NONE, cm: Int = Its.NONE
    ): ByteArray {
        require(data.size <= 255) { "DATA е най-много 255 байта" }
        val out = ByteArray(8 + data.size)
        out[0] = tgt.toByte()
        out[1] = src.toByte()
        out[2] = data.size.toByte()
        out[3] = sid.toByte()
        out[4] = trtp.toByte()
        out[5] = cc.toByte()
        out[6] = cm.toByte()
        data.copyInto(out, 7)
        out[out.size - 1] = checksum(out, 0, out.size - 1).toByte()
        return out
    }

    fun requestData(itsId: Int, trtp: Int, variant: ReqVariant): ByteArray = when (variant) {
        ReqVariant.STRICT -> build(Its.VU, itsId, Its.REQUEST_DATA, trtp)
        ReqVariant.TRTP_IN_DATA -> build(Its.VU, itsId, Its.REQUEST_DATA, trtp, byteArrayOf(trtp.toByte()))
    }

    /** Цифрите на PIN/PUC: като байтове 0–9 или като ASCII „0“–„9“. */
    fun digits(code: String, ascii: Boolean): ByteArray {
        require(code.isNotEmpty() && code.all { it in '0'..'9' }) { "само цифри" }
        return ByteArray(code.length) { i -> if (ascii) code[i].code.toByte() else (code[i] - '0').toByte() }
    }

    fun sendPin(itsId: Int, pin: String, ascii: Boolean): ByteArray =
        build(Its.VU, itsId, Its.SEND_PIN, Its.NONE, digits(pin, ascii))

    fun sendPuc(itsId: Int, puc: String, ascii: Boolean): ByteArray =
        build(Its.VU, itsId, Its.SEND_PUC, Its.NONE, digits(puc, ascii))
}

enum class ReqVariant(val label: String) {
    STRICT("LEN=0, без DATA"),
    TRTP_IN_DATA("LEN=1, DATA=типа")
}

/**
 * Разделя потока байтове на съобщения. Байтове, които не приличат на
 * съобщение, се връщат като „непознати“ — и те отиват в дневника.
 */
class ItsFramer(private val staleMs: Long = 1500) {
    private var buf = ByteArray(0)
    private var lastData = 0L
    private var preferred: Layout? = null

    val pending: Int get() = buf.size

    fun feed(bytes: ByteArray, now: Long): List<Frame> {
        buf += bytes
        lastData = now
        return parse(force = false)
    }

    /** Ако няма нови байтове известно време, изхвърля недовършеното като непознато. */
    fun idle(now: Long): List<Frame> =
        if (buf.isEmpty() || now - lastData < staleMs) emptyList() else parse(force = true)

    private fun order(): List<Layout> {
        val p = preferred ?: return Layout.values().toList()
        return listOf(p) + Layout.values().filter { it != p }
    }

    private fun parse(force: Boolean): List<Frame> {
        val out = ArrayList<Frame>()
        val junk = ByteArrayOutputStream()
        fun flushJunk() {
            if (junk.size() > 0) {
                out.add(Frame.Junk(junk.toByteArray()))
                junk.reset()
            }
        }

        var pos = 0
        scan@ while (buf.size - pos >= 2) {
            val b0 = buf[pos].u()
            val b1 = buf[pos + 1].u()
            if (b0 != Its.VU && b1 != Its.VU) {
                junk.write(b0)
                pos++
                continue
            }
            if (buf.size - pos < 3) break
            val len = buf[pos + 2].u()
            for (layout in order()) {
                val total = layout.total(len) ?: continue
                if (buf.size - pos < total) {
                    if (force) continue
                    break@scan // чакаме още байтове
                }
                val cs = buf[pos + total - 1].u()
                if (ItsCodec.checksum(buf, pos, pos + total - 1) == cs) {
                    flushJunk()
                    out.add(Frame.Msg(decode(buf.copyOfRange(pos, pos + total), layout, len)))
                    preferred = layout
                    pos += total
                    continue@scan
                }
            }
            junk.write(b0)
            pos++
        }
        if (force) {
            while (pos < buf.size) junk.write(buf[pos++].u())
        }
        flushJunk()
        buf = buf.copyOfRange(pos, buf.size)
        return out
    }

    private fun decode(raw: ByteArray, layout: Layout, len: Int): ItsMessage {
        val tgt = raw[0].u()
        val src = raw[1].u()
        val sid = raw[3].u()
        val trtp = raw[4].u()
        return when (layout) {
            Layout.SPEC -> ItsMessage(tgt, src, sid, trtp, raw[5].u(), raw[6].u(), raw.copyOfRange(7, 7 + len), raw, layout)
            Layout.NO_COUNTERS -> ItsMessage(tgt, src, sid, trtp, Its.NONE, Its.NONE, raw.copyOfRange(5, 5 + len), raw, layout)
            Layout.LEN_ALL -> ItsMessage(tgt, src, sid, trtp, raw[5].u(), raw[6].u(), raw.copyOfRange(7, 3 + len), raw, layout)
        }
    }
}

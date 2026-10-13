package eu.top10.tachosonda

import java.io.ByteArrayOutputStream

/** Какво трябва да направи екранът в отговор на съобщение. */
sealed class Act {
    class Send(val bytes: ByteArray, val what: String) : Act()
    class Say(val text: String) : Act()
    object AskPin : Act()
    class Data(val trtp: Int, val bytes: ByteArray) : Act()
    class Answered(val trtp: Int) : Act()
}

/**
 * Разговорът с тахографа по Допълнение 13, без Bluetooth — само логиката.
 * Само чете: не изпраща нищо, което променя данни в тахографа.
 */
class ItsSession(
    var variant: ReqVariant = ReqVariant.STRICT,
    var pinAscii: Boolean = false,
    /** Грешни PIN досега (тахографът блокира: 3 → 30 сек, 6 → 5 мин, 9 → 1 ч, 12 → 24 ч, 15 → завинаги). */
    var wrongPins: Int = 0
) {
    var itsId = Its.FIRST_ID
        private set
    var pendingTrtp: Int? = null
        private set

    private var tries = 0
    private var sentWithId = Its.FIRST_ID
    private var variantSwitched = false
    private var lastPin: String? = null
    private var pinFlipped = false
    private val parts = HashMap<Int, ByteArrayOutputStream>()

    fun pinAllowed(): Boolean = wrongPins < MAX_WRONG_PINS

    fun request(trtp: Int): List<Act> {
        pendingTrtp = trtp
        tries = 0
        return listOf(sendRequest(trtp))
    }

    private fun sendRequest(trtp: Int): Act {
        sentWithId = itsId
        return Act.Send(
            ItsCodec.requestData(itsId, trtp, variant),
            "Искам: ${Its.trtpName(trtp)} [${variant.label}, номер %02X]".format(itsId)
        )
    }

    fun pin(code: String): List<Act> {
        if (!pinAllowed()) return listOf(Act.Say(PIN_STOP))
        lastPin = code
        pinFlipped = false
        return listOf(sendPin(code))
    }

    private fun sendPin(code: String): Act = Act.Send(
        ItsCodec.sendPin(itsId, code, pinAscii),
        "PIN (${code.length} цифри, " + (if (pinAscii) "като ASCII" else "като байтове 0–9") + ")"
    )

    /** Няма отговор известно време. */
    fun onTimeout(): List<Act> {
        val t = pendingTrtp ?: return emptyList()
        tries++
        return when {
            sentWithId != itsId ->
                listOf(Act.Say("Пращам отново с новия номер"), sendRequest(t))
            tries == 1 ->
                listOf(Act.Say("Няма отговор — опитвам още веднъж"), sendRequest(t))
            variant == ReqVariant.STRICT && !variantSwitched -> {
                variant = ReqVariant.TRTP_IN_DATA
                variantSwitched = true
                listOf(Act.Say("Пак няма отговор — опитвам другия вариант (${variant.label})"), sendRequest(t))
            }
            else -> {
                pendingTrtp = null
                listOf(Act.Say("Няма отговор за „${Its.trtpName(t)}“"), Act.Answered(t))
            }
        }
    }

    fun onMessage(m: ItsMessage): List<Act> {
        val acts = ArrayList<Act>()
        when (m.sid) {
            Its.SEND_ITS_ID -> m.data.firstOrNull()?.let { itsId = it.u() }

            Its.REQUEST_PIN -> acts.add(Act.AskPin)

            Its.PAIRING_RESULT -> if (m.flag()) {
                wrongPins = 0
                acts.add(Act.Say("Телефонът е одобрен от тахографа"))
                pendingTrtp?.let { tries = 0; acts.add(sendRequest(it)) }
            } else {
                wrongPins++
                val code = lastPin
                if (code != null && !pinFlipped && pinAllowed()) {
                    // регламентът не казва как се пишат цифрите — пробваме и другия начин, само веднъж
                    pinFlipped = true
                    pinAscii = !pinAscii
                    acts.add(Act.Say("Опитвам същия PIN в другия формат"))
                    acts.add(sendPin(code))
                } else {
                    acts.add(Act.Say("PIN не е приет. Грешни опити: $wrongPins. " + PIN_WARNING))
                    if (!pinAllowed()) acts.add(Act.Say(PIN_STOP))
                }
            }

            Its.REQUEST_REJECTED -> {
                acts.add(Act.Say("Тахографът е блокирал телефона за известно време. Изчакай и опитай пак."))
                answered(acts)
            }

            Its.REQUEST_ACCEPTED -> {
                val trtp = m.trtp
                if (!m.isPart()) {
                    acts.add(Act.Data(trtp, m.data))
                    answered(acts, trtp)
                } else {
                    val acc = parts.getOrPut(trtp) { ByteArrayOutputStream() }
                    if (m.cc == 1) acc.reset()
                    acc.write(m.data)
                    if (m.cc >= m.cm) {
                        parts.remove(trtp)
                        acts.add(Act.Data(trtp, acc.toByteArray()))
                        answered(acts, trtp)
                    }
                }
            }

            Its.DATA_UNAVAILABLE -> answered(acts, m.trtp)

            Its.NEGATIVE_ANSWER -> {
                val lengthError = m.data.any { it.u() == 0x13 }
                val t = pendingTrtp
                if (lengthError && t != null && variant == ReqVariant.STRICT && !variantSwitched) {
                    variant = ReqVariant.TRTP_IN_DATA
                    variantSwitched = true
                    tries = 0
                    acts.add(Act.Say("Тахографът не харесва дължината — опитвам ${variant.label}"))
                    acts.add(sendRequest(t))
                } else if (m.data.any { it.u() == 0x78 }) {
                    acts.add(Act.Say("Тахографът подготвя отговора — чакам"))
                } else {
                    answered(acts)
                }
            }
        }
        return acts
    }

    private fun answered(acts: MutableList<Act>, trtp: Int? = null) {
        val t = trtp ?: pendingTrtp ?: return
        if (pendingTrtp == t || trtp == null) pendingTrtp = null
        acts.add(Act.Answered(t))
    }

    companion object {
        const val MAX_WRONG_PINS = 5
        const val PIN_WARNING = "Внимание: при 3 грешни подред тахографът блокира за 30 сек, при 9 — за 1 час, при 15 — завинаги (трябва PUC)."
        const val PIN_STOP = "Спирам да пращам PIN, за да не блокира тахографът за дълго. Провери кода; броячът се нулира от бутона „Още…“."
    }
}

package eu.top10.tachosonda

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.UUID

/**
 * BLE разузнаване: свързва се, изрежда всички услуги и характеристики,
 * чете каквото може да се чете и се абонира за известия. Нищо не записва
 * в характеристики — само включва известията (стандартният дескриптор 2902).
 */
@SuppressLint("MissingPermission")
class GattProbe(
    private val context: Context,
    private val device: BluetoothDevice,
    private val log: (String) -> Unit
) : BluetoothGattCallback() {

    private val main = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private val ops = ArrayDeque<() -> Boolean>()

    private fun say(text: String) = main.post { log(text) }

    fun start() {
        say("BLE: свързвам се с ${device.address}…")
        gatt = device.connectGatt(context, false, this, BluetoothDevice.TRANSPORT_LE)
    }

    fun close() {
        gatt?.let {
            try { it.disconnect() } catch (ignored: Exception) { }
            try { it.close() } catch (ignored: Exception) { }
        }
        gatt = null
    }

    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
        when (newState) {
            BluetoothProfile.STATE_CONNECTED -> {
                say("BLE: свързан (статус $status), търся услуги…")
                main.postDelayed({ g.discoverServices() }, 600)
            }
            BluetoothProfile.STATE_DISCONNECTED -> say("BLE: връзката прекъсна (статус $status)")
        }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
        val sb = StringBuilder("BLE услуги (статус $status):\n")
        ops.clear()
        for (s in g.services) {
            sb.append("• услуга ${name(s.uuid)}\n")
            for (c in s.characteristics) {
                sb.append("   – ${name(c.uuid)} [${props(c.properties)}]\n")
                if (c.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
                    ops.add { g.readCharacteristic(c) }
                }
                val notify = c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
                val indicate = c.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
                if (notify || indicate) {
                    ops.add { subscribe(g, c, indicate && !notify) }
                }
            }
        }
        say(sb.toString().trimEnd())
        next()
    }

    @Suppress("DEPRECATION")
    private fun subscribe(g: BluetoothGatt, c: BluetoothGattCharacteristic, indicate: Boolean): Boolean {
        g.setCharacteristicNotification(c, true)
        val d = c.getDescriptor(CCCD) ?: return false
        d.value = if (indicate) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                  else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        return g.writeDescriptor(d)
    }

    private fun next() {
        while (ops.isNotEmpty()) {
            val op = ops.removeFirst()
            if (op()) return // чакаме отговор, после следващата
        }
        say("BLE: прочетох всичко, слушам за известия")
    }

    // Android 13+
    override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
        say("BLE чета ${name(c.uuid)}: ${show(value)}")
        next()
    }

    // до Android 12
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
        say("BLE чета ${name(c.uuid)}: ${show(c.value ?: ByteArray(0))}")
        next()
    }

    override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
        say("BLE абонамент за ${name(d.characteristic.uuid)}: статус $status")
        next()
    }

    override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
        say("BLE известие ${name(c.uuid)}: ${show(value)}")
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
        say("BLE известие ${name(c.uuid)}: ${show(c.value ?: ByteArray(0))}")
    }

    private fun show(v: ByteArray): String {
        val text = v.filter { it.u() in 32..126 }.size
        val ascii = if (v.isNotEmpty() && text == v.size) " „" + String(v, Charsets.US_ASCII) + "“" else ""
        return "${v.size} байта: ${v.hex()}$ascii"
    }

    private fun props(p: Int): String {
        val out = ArrayList<String>()
        if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) out.add("чете")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) out.add("пише")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) out.add("пише без отговор")
        if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) out.add("известия")
        if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) out.add("индикации")
        return out.joinToString(", ")
    }

    companion object {
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private val KNOWN = mapOf(
            "1800" to "Generic Access", "1801" to "Generic Attribute", "180a" to "Device Information",
            "180f" to "Battery", "2a00" to "име на устройството", "2a01" to "вид",
            "2a24" to "модел", "2a25" to "сериен номер", "2a26" to "фърмуер", "2a27" to "хардуер",
            "2a28" to "софтуер", "2a29" to "производител", "2a19" to "батерия", "2a05" to "Service Changed"
        )

        fun name(u: UUID): String {
            val s = u.toString()
            if (s.endsWith("-0000-1000-8000-00805f9b34fb") && s.startsWith("0000")) {
                val short = s.substring(4, 8)
                return short.uppercase() + (KNOWN[short]?.let { " ($it)" } ?: "")
            }
            return s
        }
    }
}

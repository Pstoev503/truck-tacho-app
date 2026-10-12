package eu.top10.tachosonda

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.UUID
import kotlin.concurrent.thread

/** Стандартният сериен профил (SPP), който Допълнение 13 изисква. */
val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

private val main = Handler(Looper.getMainLooper())

/** Отворена връзка: чете в отделна нишка, всичко се връща към главната нишка. */
class Link(
    private val socket: BluetoothSocket,
    val label: String,
    private val onBytes: (ByteArray) -> Unit,
    private val onClosed: (String) -> Unit
) {
    @Volatile private var open = true
    private val output = socket.outputStream

    init {
        thread(name = "sonda-read") {
            val input = socket.inputStream
            val buf = ByteArray(1024)
            var reason = "връзката е затворена"
            try {
                while (open) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) {
                        val chunk = buf.copyOf(n)
                        main.post { onBytes(chunk) }
                    }
                }
            } catch (e: IOException) {
                if (open) reason = "връзката прекъсна: ${e.message}"
            }
            open = false
            main.post { onClosed(reason) }
        }
    }

    fun write(bytes: ByteArray): Boolean = try {
        output.write(bytes)
        output.flush()
        true
    } catch (e: IOException) {
        false
    }

    fun close() {
        open = false
        try { socket.close() } catch (ignored: IOException) { }
    }
}

/**
 * Опитва да се свърже с устройството по няколко начина, докато някой успее:
 * SPP сигурно, SPP несигурно, другите услуги от SDP, накрая канал 1 директно.
 */
@SuppressLint("MissingPermission")
class ClassicConnector(
    private val adapter: BluetoothAdapter,
    private val log: (String) -> Unit
) {
    @Volatile private var cancelled = false
    @Volatile private var current: BluetoothSocket? = null

    fun cancel() {
        cancelled = true
        try { current?.close() } catch (ignored: IOException) { }
    }

    fun connect(device: BluetoothDevice, onConnected: (BluetoothSocket, String) -> Unit, onFailed: () -> Unit) {
        cancelled = false
        thread(name = "sonda-connect") {
            val attempts = ArrayList<Pair<String, () -> BluetoothSocket>>()
            attempts.add("SPP сигурно" to { device.createRfcommSocketToServiceRecord(SPP_UUID) })
            attempts.add("SPP несигурно" to { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) })
            val others = device.uuids?.map { it.uuid }?.filter { it != SPP_UUID }?.distinct()?.take(6).orEmpty()
            for (u in others) {
                attempts.add("услуга $u сигурно" to { device.createRfcommSocketToServiceRecord(u) })
                attempts.add("услуга $u несигурно" to { device.createInsecureRfcommSocketToServiceRecord(u) })
            }
            attempts.add("канал 1 директно" to {
                device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                    .invoke(device, 1) as BluetoothSocket
            })

            for ((how, make) in attempts) {
                if (cancelled) break
                main.post { log("… опит: $how") }
                try {
                    adapter.cancelDiscovery()
                    val s = make()
                    current = s
                    s.connect()
                    if (cancelled) { s.close(); break }
                    current = null // предадено на Link — cancel() вече не бива да го затваря
                    main.post { onConnected(s, how) }
                    return@thread
                } catch (e: Exception) {
                    val msg = e.message ?: e.javaClass.simpleName
                    main.post { log("   неуспешно: $msg") }
                    try { current?.close() } catch (ignored: IOException) { }
                }
            }
            main.post { onFailed() }
        }
    }
}

/**
 * Чака тахографът сам да се свърже с телефона (ако той е „главният“).
 * Слуша едновременно сигурно и несигурно на SPP.
 */
@SuppressLint("MissingPermission")
class SppServer(
    private val adapter: BluetoothAdapter,
    private val log: (String) -> Unit,
    private val onAccepted: (BluetoothSocket, String) -> Unit
) {
    private val servers = ArrayList<BluetoothServerSocket>()
    @Volatile private var running = false

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        running = true
        listen("сигурно") { adapter.listenUsingRfcommWithServiceRecord("Taho Sonda", SPP_UUID) }
        listen("несигурно") { adapter.listenUsingInsecureRfcommWithServiceRecord("Taho Sonda", SPP_UUID) }
    }

    private fun listen(how: String, make: () -> BluetoothServerSocket) {
        thread(name = "sonda-listen") {
            val server = try {
                make()
            } catch (e: Exception) {
                main.post { log("Не мога да чакам връзка ($how): ${e.message}") }
                return@thread
            }
            synchronized(servers) { servers.add(server) }
            main.post { log("Чакам тахографът да се свърже ($how)…") }
            try {
                val s = server.accept()
                if (running) main.post { onAccepted(s, "тахографът се свърза сам ($how)") } else s.close()
            } catch (e: IOException) {
                // затворено от stop()
            }
        }
    }

    fun stop() {
        running = false
        synchronized(servers) {
            servers.forEach { try { it.close() } catch (ignored: IOException) { } }
            servers.clear()
        }
    }
}

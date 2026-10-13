package eu.top10.tachosonda

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.provider.MediaStore
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Тахо сонда — тестово приложение: свързва се с тахографа по Bluetooth,
 * говори по Допълнение 13 (ITS интерфейс) и записва всичко в дневник.
 */
@SuppressLint("MissingPermission", "SetTextI18n")
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private var adapter: BluetoothAdapter? = null
    private lateinit var prefs: SharedPreferences
    private lateinit var logFile: File

    private lateinit var statusView: TextView
    private lateinit var devicesBox: LinearLayout
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var asciiBox: CheckBox
    private lateinit var lenBox: CheckBox
    private var syncing = false

    private class Dev(val device: BluetoothDevice) {
        var name: String? = null
        var rssi: Int? = null
        var classic = false
        var ble = false
        var bleInfo = ""
    }

    private val devices = LinkedHashMap<String, Dev>()
    private var renderPending = false

    private var link: Link? = null
    private var connector: ClassicConnector? = null
    private var server: SppServer? = null
    private var gattProbe: GattProbe? = null
    private var scanCb: ScanCallback? = null
    private val framer = ItsFramer()
    private lateinit var session: ItsSession
    private val autoQueue = ArrayDeque<Int>()
    private var autoCurrent: Int? = null
    private var pendingAction: (() -> Unit)? = null
    private var receiverOn = false

    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    // ---------------------------------------------------------------- начало

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = getSharedPreferences("sonda", Context.MODE_PRIVATE)
        session = newSession()
        val stamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
        logFile = File(getExternalFilesDir(null) ?: filesDir, "taho-sonda_$stamp.txt")
        adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        buildUi()
        header()
        registerBt()
        handler.post(idleTick)
        renderDevices()
    }

    override fun onDestroy() {
        disconnect(quiet = true)
        stopBleScan()
        if (receiverOn) {
            try { unregisterReceiver(receiver) } catch (ignored: Exception) { }
            receiverOn = false
        }
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun newSession() = ItsSession(
        variant = if (prefs.getBoolean("len1", false)) ReqVariant.TRTP_IN_DATA else ReqVariant.STRICT,
        pinAscii = prefs.getBoolean("ascii", false),
        wrongPins = prefs.getInt("wrongPins", 0)
    )

    private fun header() {
        val version = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (e: Exception) { "?" }
        val tz = TimeZone.getDefault()
        val offset = tz.getOffset(System.currentTimeMillis()) / 60000
        log("Тахо сонда $version")
        log("Телефон: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        log("Дата: " + SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date()) + ", часова зона ${tz.id} (UTC%+d мин)".format(offset))
        log("Bluetooth: " + when {
            adapter == null -> "НЯМА"
            adapter?.isEnabled == true -> "включен"
            else -> "изключен"
        })
        log("Дневникът може да съдържа данни от картата ти — пращай го само на нас.")
        help()
    }

    private fun help() {
        log(
            """
            |КАК СЕ ПОЛЗВА (в кабината):
            |1. Контакт ON, картата на водача в слот 1.
            |2. Тук: „1. Bluetooth“ → разреши всичко.
            |3. Тук: „2. Видим + чакай“ — телефонът става видим за 5 минути.
            |4. В тахографа (VDO DTCO 4.1b): OK → ▼▼ → „Водач 1“ → ▲▲ → „Bluetooth“ → „Сдвояване“,
            |   избери този телефон и потвърди кода и на двете места.
            |   Ако има опция „ITS“ или „споделяне на данни“ — разреши я.
            |   (Stoneridge: менюто Bluetooth; при някои сдвояването става и от телефона.)
            |5. Тук: „3. Търси“ → докосни тахографа (⭐ отгоре) → първо „Свържи — BLE“
            |   (VDO казва, че DTCO 4.1 ползва BLE), после пак докосни → „Свържи — класически“.
            |6. При класическа връзка тестът тръгва сам. Ако поиска PIN — въведи го.
            |7. Накрая „Сподели“ → прати ми дневника. Или „Запази“ → отива в Изтегляния.
            """.trimMargin()
        )
    }

    // ---------------------------------------------------------------- екран

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun button(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun row(vararg views: View): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        views.forEach { addView(it) }
    }

    private fun check(text: String, onChange: (Boolean) -> Unit): CheckBox = CheckBox(this).apply {
        this.text = text
        textSize = 13f
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        setOnCheckedChangeListener { _, on -> if (!syncing) onChange(on) }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setBackgroundColor(0xFFFFFFFF.toInt())
        }
        root.addView(TextView(this).apply {
            text = "Тахо сонда"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(0xFF1A1A1A.toInt())
        })
        statusView = TextView(this).apply {
            text = "Няма връзка"
            textSize = 14f
            setTextColor(0xFF555555.toInt())
        }
        root.addView(statusView)

        root.addView(row(
            button("1. Bluetooth") { ensureReady { log("Bluetooth е готов"); listBonded() } },
            button("2. Видим + чакай") { makeDiscoverable() }
        ))
        root.addView(row(
            button("3. Търси") { scan() },
            button("Сдвоени") { ensureReady { listBonded() } }
        ))

        devicesBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(ScrollView(this).apply { addView(devicesBox) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(160)))

        root.addView(row(
            button("Автоматичен тест") { autoTest() },
            button("Искане…") { chooseRequest() },
            button("PIN…") { askPin() }
        ))
        asciiBox = check("PIN като ASCII") { on ->
            session.pinAscii = on
            prefs.edit().putBoolean("ascii", on).apply()
        }
        lenBox = check("Искане с LEN=1") { on ->
            session.variant = if (on) ReqVariant.TRTP_IN_DATA else ReqVariant.STRICT
            prefs.edit().putBoolean("len1", on).apply()
        }
        root.addView(row(asciiBox, lenBox))
        root.addView(row(
            button("Байтове…") { rawMenu() },
            button("Прекъсни") { disconnect(quiet = false) },
            button("Още…") { moreMenu() }
        ))

        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextColor(0xFF111111.toInt())
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply {
            addView(logView)
            setBackgroundColor(0xFFF4F4F0.toInt())
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        root.addView(logScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(row(
            button("Запази") { saveToDownloads() },
            button("Сподели") { shareLog() }
        ))
        setContentView(root)
        syncChecks()
    }

    private fun syncChecks() {
        syncing = true
        asciiBox.isChecked = session.pinAscii
        lenBox.isChecked = session.variant == ReqVariant.TRTP_IN_DATA
        syncing = false
    }

    private fun status(text: String) {
        statusView.text = text
    }

    private fun log(text: String) {
        val line = timeFmt.format(Date()) + "  " + text + "\n"
        try {
            FileOutputStream(logFile, true).use { it.write(line.toByteArray(Charsets.UTF_8)) }
        } catch (ignored: IOException) { }
        logView.append(line)
        val t = logView.text
        if (t.length > 60_000) logView.text = t.subSequence(t.length - 40_000, t.length)
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ---------------------------------------------------------------- разрешения

    private fun perms(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_ADVERTISE
        ) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun hasPerms(): Boolean = perms().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun ensureReady(then: () -> Unit) {
        val a = adapter
        if (a == null) {
            log("Този телефон няма Bluetooth")
            return
        }
        if (!hasPerms()) {
            pendingAction = then
            requestPermissions(perms(), REQ_PERMS)
            return
        }
        if (!a.isEnabled) {
            pendingAction = then
            @Suppress("DEPRECATION")
            startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE)
            return
        }
        then()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return
        val next = pendingAction
        pendingAction = null
        if (hasPerms()) {
            log("Разрешенията са дадени")
            next?.let { ensureReady(it) }
        } else {
            log("Без разрешение за Bluetooth сондата не може да работи. Разреши го от Настройки → Приложения → Тахо сонда → Разрешения.")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_ENABLE -> {
                val next = pendingAction
                pendingAction = null
                if (adapter?.isEnabled == true) {
                    log("Bluetooth е включен")
                    next?.invoke()
                } else {
                    log("Bluetooth не е включен")
                }
            }
            REQ_DISCOVERABLE ->
                if (resultCode == RESULT_CANCELED) log("Телефонът не е направен видим")
                else log("Телефонът е видим $resultCode сек. Сега в тахографа избери „Сдвояване“ и този телефон.")
        }
    }

    // ---------------------------------------------------------------- търсене

    private fun dev(d: BluetoothDevice): Dev = devices.getOrPut(d.address) {
        Dev(d).also { log("Намерено: ${safeName(d) ?: "(без име)"} ${d.address}") }
    }

    private fun safeName(d: BluetoothDevice): String? = try { d.name } catch (e: SecurityException) { null }

    private fun label(d: BluetoothDevice): String = (devices[d.address]?.name ?: safeName(d))?.let { "$it (${d.address})" } ?: d.address

    private fun listBonded() {
        val bonded = try { adapter?.bondedDevices } catch (e: SecurityException) { null } ?: emptySet()
        log("Сдвоени с телефона: ${bonded.size}")
        for (b in bonded) {
            val d = dev(b)
            if (d.name == null) d.name = safeName(b)
        }
        renderDevices()
    }

    private fun scan() = ensureReady {
        val a = adapter ?: return@ensureReady
        log("Търся устройства 15 сек… (Bluetooth в тахографа трябва да е включен)")
        if (Build.VERSION.SDK_INT < 31) log("Ако списъкът остане празен — включи Местоположение (GPS) на телефона.")
        listBonded()
        try {
            if (a.isDiscovering) a.cancelDiscovery()
            a.startDiscovery()
        } catch (e: SecurityException) {
            log("Няма разрешение за търсене: ${e.message}")
        }
        startBleScan()
        handler.postDelayed({
            stopBleScan()
            log("Търсенето приключи: ${devices.size} устройства в списъка")
        }, 15_000)
    }

    private fun startBleScan() {
        val scanner = try { adapter?.bluetoothLeScanner } catch (e: Exception) { null } ?: return
        stopBleScan()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                runOnUiThread { onBle(result) }
            }

            override fun onScanFailed(errorCode: Int) {
                runOnUiThread { log("BLE търсенето не тръгна (код $errorCode)") }
            }
        }
        scanCb = cb
        try { scanner.startScan(cb) } catch (e: Exception) { log("BLE търсенето не тръгна: ${e.message}") }
    }

    private fun stopBleScan() {
        val cb = scanCb ?: return
        scanCb = null
        try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (ignored: Exception) { }
    }

    private fun onBle(r: ScanResult) {
        val d = dev(r.device)
        d.ble = true
        d.rssi = r.rssi
        r.scanRecord?.let { rec ->
            if (d.name == null) d.name = rec.deviceName
            val uuids = rec.serviceUuids?.joinToString { GattProbe.name(it.uuid) } ?: ""
            val mfr = rec.manufacturerSpecificData
            val maker = if (mfr != null && mfr.size() > 0) "производител 0x%04X".format(mfr.keyAt(0)) else ""
            d.bleInfo = listOf(uuids, maker).filter { it.isNotEmpty() }.joinToString(" · ")
        }
        renderDevicesSoon()
    }

    private fun isTacho(d: Dev): Boolean {
        val n = (d.name ?: safeName(d.device) ?: "").uppercase()
        return TACHO_HINTS.any { n.contains(it) }
    }

    private fun bonded(d: Dev): Boolean = try { d.device.bondState == BluetoothDevice.BOND_BONDED } catch (e: SecurityException) { false }

    private fun kind(d: Dev): String {
        val t = try { d.device.type } catch (e: SecurityException) { BluetoothDevice.DEVICE_TYPE_UNKNOWN }
        return when (t) {
            BluetoothDevice.DEVICE_TYPE_CLASSIC -> "класически"
            BluetoothDevice.DEVICE_TYPE_LE -> "BLE"
            BluetoothDevice.DEVICE_TYPE_DUAL -> "класически + BLE"
            else -> listOfNotNull(if (d.classic) "класически" else null, if (d.ble) "BLE" else null).joinToString(" + ").ifEmpty { "?" }
        }
    }

    private fun renderDevicesSoon() {
        if (renderPending) return
        renderPending = true
        handler.postDelayed({ renderPending = false; renderDevices() }, 700)
    }

    private fun renderDevices() {
        devicesBox.removeAllViews()
        val list = devices.values.sortedWith(
            compareByDescending<Dev> { isTacho(it) }
                .thenByDescending { bonded(it) }
                .thenByDescending { it.rssi ?: -999 }
        )
        if (list.isEmpty()) {
            devicesBox.addView(TextView(this).apply {
                text = "Няма устройства. Натисни „3. Търси“."
                setPadding(dp(8), dp(8), dp(8), dp(8))
                setTextColor(0xFF777777.toInt())
            })
            return
        }
        for (d in list) {
            val tacho = isTacho(d)
            val tv = TextView(this).apply {
                text = buildString {
                    if (tacho) append("⭐ ")
                    append(d.name ?: safeName(d.device) ?: "(без име)")
                    append('\n')
                    append(d.device.address).append(" · ").append(kind(d))
                    if (bonded(d)) append(" · сдвоен")
                    d.rssi?.let { append(" · сигнал $it") }
                    if (d.bleInfo.isNotEmpty()) append("\nBLE: ").append(d.bleInfo)
                }
                textSize = 13f
                setTextColor(0xFF1A1A1A.toInt())
                setPadding(dp(8), dp(6), dp(8), dp(6))
                setBackgroundColor(if (tacho) 0xFFFFF0C2.toInt() else 0xFFEFEFEF.toInt())
                setOnClickListener { deviceMenu(d) }
            }
            devicesBox.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(4)
            })
        }
    }

    private fun deviceMenu(d: Dev) {
        val items = arrayOf(
            "Свържи — BLE (DTCO 4.1 и по-нови: първо това)",
            "Свържи — класически Bluetooth (SPP)",
            "Сдвои с телефона",
            "Попитай за услугите (SDP)"
        )
        AlertDialog.Builder(this)
            .setTitle(d.name ?: d.device.address)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> connectBle(d.device)
                    1 -> connectClassic(d.device)
                    2 -> pair(d.device)
                    3 -> sdp(d.device)
                }
            }
            .show()
    }

    private fun pair(device: BluetoothDevice) = ensureReady {
        try {
            if (device.createBond()) log("Сдвояване с ${label(device)} — потвърди кода на телефона и на тахографа")
            else log("Сдвояването не започна (може вече да е сдвоен)")
        } catch (e: SecurityException) {
            log("Няма разрешение: ${e.message}")
        }
    }

    private fun sdp(device: BluetoothDevice) = ensureReady {
        log("Питам ${label(device)} какви услуги има…")
        try { device.fetchUuidsWithSdp() } catch (e: SecurityException) { log("Няма разрешение: ${e.message}") }
    }

    // ---------------------------------------------------------------- връзка

    private fun makeDiscoverable() = ensureReady {
        startServer()
        val i = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE)
            .putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300)
        @Suppress("DEPRECATION")
        startActivityForResult(i, REQ_DISCOVERABLE)
    }

    private fun startServer() {
        if (link != null) return
        val a = adapter ?: return
        if (server?.isRunning == true) return
        server = SppServer(a, ::log) { s, how -> onSocket(s, how) }.also { it.start() }
    }

    private fun connectClassic(device: BluetoothDevice) = ensureReady {
        if (link != null) {
            log("Вече има връзка — първо „Прекъсни“")
            return@ensureReady
        }
        val a = adapter ?: return@ensureReady
        stopBleScan()
        connector?.cancel()
        log("Свързвам се с ${label(device)}…")
        status("Свързване…")
        connector = ClassicConnector(a, ::log).also {
            it.connect(device, { s, how -> onSocket(s, how) }, {
                log("Не успях да се свържа. Провери: контакт ON, карта в слот 1, Bluetooth/ITS включен в тахографа, телефонът сдвоен.")
                status("Няма връзка")
            })
        }
    }

    private fun connectBle(device: BluetoothDevice) = ensureReady {
        stopBleScan()
        gattProbe?.close()
        gattProbe = GattProbe(this, device, ::log).also { it.start() }
    }

    private fun onSocket(s: BluetoothSocket, how: String) {
        if (link != null) {
            try { s.close() } catch (ignored: IOException) { }
            return
        }
        server?.stop()
        server = null
        connector?.cancel()
        connector = null
        val name = label(s.remoteDevice)
        session = newSession()
        syncChecks()
        link = Link(s, name, { b -> onBytes(b) }, { reason -> onLinkClosed(reason) })
        log("✅ СВЪРЗАН с $name — $how")
        status("Свързан: $name")
        log("Слушам 3 сек дали тахографът ще заговори сам, после пускам теста.")
        handler.postDelayed({
            if (link != null && autoCurrent == null && session.pendingTrtp == null) autoTest()
        }, 3_000)
    }

    private fun onLinkClosed(reason: String) {
        link = null
        cancelTimeout()
        autoQueue.clear()
        autoCurrent = null
        handleFrames(framer.idle(Long.MAX_VALUE))
        log("✖ $reason")
        status("Няма връзка")
    }

    private fun disconnect(quiet: Boolean) {
        cancelTimeout()
        autoQueue.clear()
        autoCurrent = null
        connector?.cancel()
        connector = null
        server?.stop()
        server = null
        gattProbe?.close()
        gattProbe = null
        val l = link
        if (l != null) l.close() else if (!quiet) log("Няма отворена връзка")
    }

    // ---------------------------------------------------------------- разговор

    private val idleTick = object : Runnable {
        override fun run() {
            handleFrames(framer.idle(SystemClock.elapsedRealtime()))
            handler.postDelayed(this, 500)
        }
    }

    private val timeoutTask = Runnable { exec(session.onTimeout()) }

    private fun armTimeout() {
        handler.removeCallbacks(timeoutTask)
        handler.postDelayed(timeoutTask, 4_000)
    }

    private fun cancelTimeout() {
        handler.removeCallbacks(timeoutTask)
    }

    private fun onBytes(b: ByteArray) {
        log("← ${b.size} байта: ${b.hex()}")
        handleFrames(framer.feed(b, SystemClock.elapsedRealtime()))
    }

    private fun handleFrames(frames: List<Frame>) {
        for (f in frames) when (f) {
            is Frame.Junk -> log("   (${f.bytes.size} байта не приличат на съобщение по Допълнение 13)")
            is Frame.Msg -> {
                val m = f.msg
                val ids = "%02X→%02X".format(m.src, m.tgt)
                log("   ⇒ " + Its.describe(m) + "   [" + Its.sidName(m.sid) + ", " + ids + ", " + m.layout.label + "]")
                if (session.pendingTrtp != null) armTimeout()
                exec(session.onMessage(m))
            }
        }
    }

    private fun exec(acts: List<Act>) {
        for (a in acts) when (a) {
            is Act.Send -> send(a.bytes, a.what)
            is Act.Say -> log("ℹ " + a.text)
            is Act.AskPin -> {
                cancelTimeout()
                askPin()
            }
            is Act.Data -> log("📦 " + Its.trtpName(a.trtp) + " — " + a.bytes.size + " байта:\n" + a.bytes.dump().trimEnd())
            is Act.Answered -> {
                if (session.pendingTrtp == null) cancelTimeout()
                if (autoCurrent == a.trtp) {
                    autoCurrent = null
                    handler.postDelayed({ autoNext() }, 700)
                }
            }
        }
        prefs.edit().putInt("wrongPins", session.wrongPins).apply()
        syncChecks()
    }

    private fun send(bytes: ByteArray, what: String) {
        val l = link
        if (l == null) {
            log("Няма връзка — първо се свържи с тахографа")
            return
        }
        log("→ $what\n   ${masked(bytes)}")
        if (!l.write(bytes)) log("   ⚠ не успях да изпратя")
        if (session.pendingTrtp != null) armTimeout()
    }

    /** PIN и PUC не се записват в дневника. */
    private fun masked(bytes: ByteArray): String {
        val secret = bytes.size > 8 && bytes[0].u() == Its.VU &&
            (bytes[3].u() == Its.SEND_PIN || bytes[3].u() == Its.SEND_PUC)
        if (!secret) return bytes.hex()
        return bytes.mapIndexed { i, b -> if (i in 7 until bytes.size - 1) "**" else "%02X".format(b.u()) }.joinToString(" ")
    }

    private fun autoTest() {
        if (link == null) {
            log("Няма връзка — първо се свържи с тахографа")
            return
        }
        autoQueue.clear()
        autoQueue.addAll(listOf(1, 2, 4, 5, 6, 3, 7))
        log("▶ Автоматичен тест: искам всички 7 вида данни един след друг")
        autoNext()
    }

    private fun autoNext() {
        if (link == null) return
        val t = autoQueue.removeFirstOrNull()
        if (t == null) {
            autoCurrent = null
            log("■ Тестът приключи. Натисни „Сподели“ и ми прати дневника.")
            return
        }
        autoCurrent = t
        exec(session.request(t))
    }

    private fun chooseRequest() {
        val keys = Its.TRTP_NAMES.keys.toList()
        val items = keys.map { "$it — ${Its.trtpName(it)}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Какви данни да поискам?")
            .setItems(items) { _, which -> exec(session.request(keys[which])) }
            .show()
    }

    private fun askPin() {
        if (!session.pinAllowed()) {
            log("ℹ " + ItsSession.PIN_STOP)
            return
        }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            hint = "поне 4 цифри"
            setText(prefs.getString("pin", ""))
        }
        AlertDialog.Builder(this)
            .setTitle("PIN на тахографа (ITS)")
            .setMessage("Кодът от менюто или упътването на тахографа. " + ItsSession.PIN_WARNING)
            .setView(input)
            .setPositiveButton("Изпрати") { _, _ ->
                val p = input.text.toString().trim()
                if (p.length < 4 || !p.all { it in '0'..'9' }) {
                    log("PIN трябва да е поне 4 цифри")
                } else {
                    prefs.edit().putString("pin", p).apply()
                    exec(session.pin(p))
                }
            }
            .setNegativeButton("Отказ") { _, _ -> if (session.pendingTrtp != null) armTimeout() }
            .show()
    }

    private fun rawMenu() {
        val items = arrayOf(
            "ITS: искане на данни, тип 1",
            "ITS: искане на данни, тип 2 (лични)",
            "Допълнение 7: Start Communication (81 EE F0 81 E0)",
            "Мои байтове…"
        )
        AlertDialog.Builder(this)
            .setTitle("Изпрати байтове")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> exec(session.request(1))
                    1 -> exec(session.request(2))
                    2 -> send(ItsCodec.withChecksum(byteArrayOf(0x81.toByte(), 0xEE.toByte(), 0xF0.toByte(), 0x81.toByte())), "Допълнение 7: Start Communication")
                    3 -> ownBytes()
                }
            }
            .show()
    }

    private fun ownBytes() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), 0)
        }
        val input = EditText(this).apply {
            hint = "напр. EE A0 00 08 01 FF FF"
            setText(prefs.getString("raw", ""))
        }
        val cs = CheckBox(this).apply {
            text = "добави контролна сума накрая"
            isChecked = true
        }
        box.addView(input)
        box.addView(cs)
        AlertDialog.Builder(this)
            .setTitle("Мои байтове (шестнадесетично)")
            .setView(box)
            .setPositiveButton("Изпрати") { _, _ ->
                val raw = parseHex(input.text.toString())
                if (raw == null) {
                    log("Неразбираеми байтове — пиши по два знака 0–9, A–F")
                } else if (raw.size > 3 && raw[0].u() == Its.VU && (raw[3].u() == Its.SEND_PIN || raw[3].u() == Its.SEND_PUC)) {
                    log("PIN се изпраща само от бутона „PIN…“ (пази от блокиране)")
                } else {
                    prefs.edit().putString("raw", input.text.toString()).apply()
                    send(if (cs.isChecked) ItsCodec.withChecksum(raw) else raw, "мои байтове")
                }
            }
            .setNegativeButton("Отказ", null)
            .show()
    }

    private fun moreMenu() {
        val items = arrayOf(
            "Как се ползва",
            "Нулирай брояча на грешни PIN (сега: ${session.wrongPins})",
            "Изчисти екрана (файлът остава)"
        )
        AlertDialog.Builder(this)
            .setTitle("Още")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> help()
                    1 -> {
                        session.wrongPins = 0
                        prefs.edit().putInt("wrongPins", 0).apply()
                        log("Броячът на грешни PIN е нулиран")
                    }
                    2 -> { logView.text = "" }
                }
            }
            .show()
    }

    // ---------------------------------------------------------------- дневник

    private fun shareLog() {
        val text = try { logFile.readText(Charsets.UTF_8) } catch (e: IOException) { logView.text.toString() }
        val body = if (text.length > 90_000) "…(началото е изрязано — целият файл: „Запази“)\n" + text.takeLast(90_000) else text
        val i = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Тахо сонда — дневник")
            putExtra(Intent.EXTRA_TEXT, body)
        }
        startActivity(Intent.createChooser(i, "Сподели дневника"))
    }

    private fun saveToDownloads() {
        if (Build.VERSION.SDK_INT < 29) {
            log("Дневникът е във файла: ${logFile.absolutePath}")
            return
        }
        try {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, logFile.name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("няма достъп до Изтегляния")
            contentResolver.openOutputStream(uri)?.use { it.write(logFile.readBytes()) }
            log("Дневникът е запазен в Изтегляния: ${logFile.name}")
        } catch (e: Exception) {
            log("Не успях да запазя: ${e.message}")
        }
    }

    // ---------------------------------------------------------------- Bluetooth събития

    private fun registerBt() {
        val f = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            addAction(BluetoothDevice.ACTION_PAIRING_REQUEST)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            addAction(BluetoothDevice.ACTION_UUID)
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, f, Context.RECEIVER_EXPORTED)
        else registerReceiver(receiver, f)
        receiverOn = true
    }

    @Suppress("DEPRECATION")
    private fun deviceExtra(i: Intent): BluetoothDevice? =
        if (Build.VERSION.SDK_INT >= 34) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        else i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)

    @Suppress("DEPRECATION")
    private fun uuidsExtra(i: Intent): String {
        val arr: Array<out android.os.Parcelable>? =
            if (Build.VERSION.SDK_INT >= 34) i.getParcelableArrayExtra(BluetoothDevice.EXTRA_UUID, ParcelUuid::class.java)
            else i.getParcelableArrayExtra(BluetoothDevice.EXTRA_UUID)
        return arr?.joinToString { p ->
            val u = (p as? ParcelUuid)?.uuid
            when {
                u == null -> p.toString()
                u == SPP_UUID -> "SPP (сериен порт) ✔"
                else -> GattProbe.name(u)
            }
        } ?: ""
    }

    private fun bondName(state: Int): String = when (state) {
        BluetoothDevice.BOND_BONDED -> "сдвоени ✔"
        BluetoothDevice.BOND_BONDING -> "сдвояване…"
        BluetoothDevice.BOND_NONE -> "не са сдвоени"
        else -> "?"
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val d = deviceExtra(i)
            when (i.action) {
                BluetoothDevice.ACTION_FOUND -> d?.let {
                    val x = dev(it)
                    x.classic = true
                    val rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE)
                    if (rssi != Short.MIN_VALUE) x.rssi = rssi.toInt()
                    i.getStringExtra(BluetoothDevice.EXTRA_NAME)?.let { n -> x.name = n }
                    renderDevicesSoon()
                }
                BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> log("Класическото търсене приключи")
                BluetoothDevice.ACTION_BOND_STATE_CHANGED -> d?.let {
                    log("Сдвояване с ${label(it)}: " + bondName(i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1)))
                    renderDevicesSoon()
                }
                BluetoothDevice.ACTION_PAIRING_REQUEST -> d?.let {
                    log("Иска сдвояване: ${label(it)} (вид ${i.getIntExtra(BluetoothDevice.EXTRA_PAIRING_VARIANT, -1)})")
                }
                BluetoothDevice.ACTION_ACL_CONNECTED -> d?.let { log("Bluetooth връзка (ниско ниво) с ${label(it)}") }
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> d?.let { log("Bluetooth връзката (ниско ниво) с ${label(it)} спря") }
                BluetoothDevice.ACTION_UUID -> d?.let { log("Услуги на ${label(it)}: " + uuidsExtra(i).ifEmpty { "(няма отговор)" }) }
                BluetoothAdapter.ACTION_STATE_CHANGED -> {
                    val st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1)
                    if (st == BluetoothAdapter.STATE_ON) log("Bluetooth се включи")
                    if (st == BluetoothAdapter.STATE_OFF) log("Bluetooth се изключи")
                }
            }
        }
    }

    companion object {
        private const val REQ_PERMS = 1
        private const val REQ_ENABLE = 2
        private const val REQ_DISCOVERABLE = 3
        private val TACHO_HINTS = listOf(
            "DTCO", "VDO", "TACHO", "TAHO", "SE5000", "STONERIDGE", "EFAS", "INTELLIC", "SMARTLINK", "SMART LINK", "KITAS"
        )
    }
}

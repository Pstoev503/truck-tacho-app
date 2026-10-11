// Парчета от най-ранната версия (Pstoev503/Drivernew, файл 'index', 19.03.2026),
// които по-късните версии изгубиха. Взети дословно, без промени.
// Ред 579-584: известие на телефона, когато приложението е във фонов режим
function showWarningModal(msg) {
    document.getElementById('warning-msg-text').innerText = msg;
    document.getElementById('warning-modal').style.display = 'flex';
    if(Notification.permission === "granted" && document.visibilityState !== "visible") { new Notification("Внимание!", { body: msg }); }
}
function closeWarningModal() { document.getElementById('warning-modal').style.display = 'none'; }

// Ред 587-596: искане на права (екран буден, известия, сензор за движение)
async function setupDeviceFeatures() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(err) { console.log('WakeLock:', err); }
    try { if("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") { Notification.requestPermission(); } } catch(err) {}
    try { 
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            let perm = await DeviceMotionEvent.requestPermission(); if(perm === 'granted') startMotionListener(); 
        } else { startMotionListener(); }
    } catch(err) { console.log('Motion:', err); }
}


// Ред 597-604: засичане на работещ двигател по вибрациите на телефона
function startMotionListener() {
    window.addEventListener('devicemotion', e => {
        if (!e.accelerationIncludingGravity) return;
        let acc = e.accelerationIncludingGravity; let magnitude = Math.sqrt(acc.x*acc.x + acc.y*acc.y + acc.z*acc.z); let diff = Math.abs(magnitude - 9.81);
        if (diff > 0.3) { isEngineOn = true; lastMotionTime = Date.now(); }
    });
    setInterval(() => { if (Date.now() - lastMotionTime > 5000) { isEngineOn = false; } }, 2000);
}

// Ред 606: екранът да остане буден и след връщане в приложението
document.addEventListener('visibilitychange', () => { if (wakeLock !== null && document.visibilityState === 'visible') { navigator.wakeLock.request('screen').then(w => wakeLock = w).catch(e => console.log(e)); } });

// Ред 655 и 666: известия за превишена скорост и за минаване на граница (части от по-дълги редове)
if(Notification.permission === "granted" && document.visibilityState !== "visible") { new Notification("ПРЕВИШЕНА СКОРОСТ!", { body: "Текуща: " + spd + " км/ч" }); }
if(Notification.permission === "granted" && document.visibilityState !== "visible") { new Notification("ГРАНИЦА!", { body: "Въведи: " + loc.countryName }); }

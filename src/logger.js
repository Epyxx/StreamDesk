// Bewusst schlank gehalten: nur wichtige Lebenszyklus-Ereignisse (Verbindung, Login, Channel-
// Beitritt, Mod-Aktionen, Polls/Predictions, Fehler) - keine einzelnen Chatnachrichten o.ä.,
// sonst läuft das Log bei aktiver Nutzung sofort über.
function timestamp() { return new Date().toLocaleTimeString('de-DE', { hour12: false }); }
function log(category, message) { console.log(`[${timestamp()}] [${category}] ${message}`); }
function logWarn(category, message) { console.warn(`[${timestamp()}] [${category}] ⚠️ ${message}`); }
function logError(category, message) { console.error(`[${timestamp()}] [${category}] ❌ ${message}`); }

module.exports = { log, logWarn, logError };

# TypeSafe OpenAI Variant Router lokal betreiben

> **Datenschutzhinweis:** Jeder relevante `openai`-User-Prompt wird zur Variantenauswahl an TypeSafe uebertragen. Der Konfigurationsdefault ist `context.mode=recent-messages`; damit kann zusaetzlich ein hart begrenzter User-/Assistant-Textverlauf uebertragen werden. Wer nur den aktuellen Prompt uebertragen will, setzt `context.mode=prompt-only`. Wer auch diese Uebertragung vermeiden will, muss das Plugin deaktivieren oder den API-Key entfernen.

## Lokale Aktivierung

Das eigenstaendige Plugin ist in [`.opencode/opencode.jsonc`](../.opencode/opencode.jsonc) neben OMA registriert:

```jsonc
[
  "./plugins/typesafe-variant-router/index.ts",
  {
    "fallbackVariant": "medium"
  }
]
```

`fallbackVariant` ist Pflicht. Beim Plugin-Start hat eine nicht leere Prozessvariable `TYPESAFE_API_KEY` Vorrang. Fehlt sie, fuehrt der Linux-/KDE-Prototyp einmalig und ohne Shell folgenden Secret-Service-Lookup aus:

```sh
secret-tool lookup service typesafe credential api-key
```

`secret-tool` wird je nach Distribution beispielsweise durch `libsecret-tools` bereitgestellt. Unter KDE muss KWallet eine aktive Secret-Service-Integration bereitstellen. Der Key wird einmalig und interaktiv unter dem festen Attributschema gespeichert:

```sh
secret-tool store --label="TypeSafe API Key" service typesafe credential api-key
```

Der geheime Wert wird auf der interaktiven Eingabe eingegeben, nicht als Kommandozeilenargument. Der Lookup hat ein Timeout von fuenf Sekunden und ein Ausgabelimit von 8192 Bytes. Key, stdout, stderr und Fehlerdetails werden nicht geloggt oder persistiert. Ist `secret-tool` nicht installiert, der Secret Service nicht verfuegbar oder der Eintrag nicht vorhanden, wird kein TypeSafe-Client erstellt; OpenCode startet normal und ein nachweislich gueltiger Fallback kann weiterhin angewandt werden.

Eine Prozessvariable bleibt beispielsweise fuer CI oder einen einzelnen Prozess moeglich:

```sh
TYPESAFE_API_KEY="..." opencode
```

Der Key darf nicht in `opencode.jsonc`, `.env`-Dateien, Logs, Test-Fixtures oder Dokumentation stehen. Das Plugin verarbeitet ausschliesslich echte Text-User-Turns mit `providerID=openai`. Andere Provider, synthetische Nachrichten und Nichttext-Turns bleiben unveraendert und erzeugen keinen TypeSafe-Aufruf. Der automatische Secret-Service-Pfad ist in dieser Prototypversion bewusst Linux-/KDE-spezifisch.

## Vollstaendiger Konfigurationsvertrag

Unbekannte Felder werden abgewiesen. Alle Variantennamen muessen nicht leer und hoechstens 128 Zeichen lang sein; Modellschluessel duerfen hoechstens 256 Zeichen lang sein.

| Feld | Zulassung | Default / Wirkung |
|---|---|---|
| `enabled` | boolean | `true`; bei `false` vollstaendiger Bypass |
| `fallbackVariant` | nicht leerer String | **kein Default, Pflichtfeld**; muss in jedem explizit konfigurierten Modell eine aktive, verifizierte Reasoning-Variante sein |
| `timeoutMs` | positive Ganzzahl, maximal `30000` | `1500`; absolutes Gesamtbudget in Millisekunden |
| `manualVariantPolicy` | `typesafe-first` oder `manual-first` | `typesafe-first` |
| `context.mode` | `prompt-only` oder `recent-messages` | `recent-messages` |
| `context.maxMessages` | positive Ganzzahl, maximal `100` | `6` |
| `context.maxChars` | positive Ganzzahl, maximal `100000` | `12000`; gemeinsames hartes Zeichenbudget fuer aktuellen Prompt und erlaubten Verlauf |
| `variantsByModel` | Map `provider/model -> variant -> definition` | `{}` |
| `variantDescriptions` | Map `variant -> String` (1 bis 4000 Zeichen) | `{}`; bekannte Profile erhalten eingebaute Kriterien |
| `notify` | `off`, `fallback` oder `always` | `fallback`; `off` zeigt nichts, `fallback` nur tatsaechlich angewandte Fallbacks und `always` auch angewandte TypeSafe-/manuelle Auswahlen; jede Meldung nennt die angewandte Variante |
| `logLevel` | `error`, `warn`, `info` oder `debug` | `warn`; steuert sichere Produktionslogs, waehrend der TypeSafe-SDK-Logger fest auf `off` steht |

Eine Definition in `variantsByModel` hat diese strikte Form:

```json
{
  "reasoning": true,
  "disabled": false,
  "options": {
    "reasoningEffort": "medium"
  }
}
```

`reasoning` ist Pflicht und muss fuer eine waehlbare Variante `true` sein. `disabled` ist optional. `options` muss ein nicht leeres, sicher klonbares JSON-Objekt sein. Das Plugin erfindet weder Varianten noch Provider-Optionen: Es uebernimmt nur defensiv validierte Runtime-Optionen beziehungsweise explizit konfigurierte Optionsobjekte. Runtime-Definitionen haben bei Namenskollision Vorrang. Die Modellschluessel verwenden die Form `openai/<modelID>`.

## Score-Auswahl und Katalogreihenfolge

Der Router stellt TypeSafe [`Score`](https://docs.typesafe.ai/primitives/score.md) den erneut validierten Variantenkatalog als geordnete Kriterienliste bereit. Die Runtime-Reihenfolge bleibt erhalten; explizit konfigurierte, noch nicht vorhandene Varianten werden deterministisch danach eingeordnet. Die eingebauten Profile folgen den offiziellen OpenAI-Semantiken fuer [`none`, `low`, `medium`, `high`, `xhigh` und `max`](https://platform.openai.com/docs/guides/reasoning):

- `none`: keine zusaetzliche Reasoning-Arbeit fuer direkte, latenzkritische Aufgaben;
- `low`: effizientes Reasoning fuer einfache Planung, Suche und Werkzeugnutzung;
- `medium`: ausgewogenes Reasoning fuer substanzielle Arbeit mit mehreren koordinierten Schritten;
- `high`: tieferes Reasoning fuer schwieriges Debugging, Planung und komplexe Abwaegungen;
- `xhigh`: sehr tiefes Reasoning fuer besonders anspruchsvolle, langlaufende oder risikoreiche Aufgaben;
- `max`: die maximal verfuegbare Reasoning-Tiefe fuer Ausnahmefaelle hoechster Komplexitaet.

Eine gueltige Antwort waehlt immer `argmax(probabilities)`. Bei exakt gleichen Wahrscheinlichkeiten gewinnt die niedrigere Reasoning-Stufe, also der fruehere Eintrag im Katalog. Es gibt keinen Confidence-Schwellwert und keinen Low-Confidence-Fallback. `confidence` kann in der normalisierten Entscheidung als sichere Metadaten erhalten bleiben, beeinflusst die Auswahl aber nicht. `score` muss endlich sein und im Bereich `0..(criteria.length-1)` liegen, wird aber nicht aus den Wahrscheinlichkeiten zurueckgerechnet: TypeSafe darf `score` und `probabilities` unabhaengig runden, und die Auswahl verwendet ausschliesslich die validierten Wahrscheinlichkeiten. Die Legend muss exakt die Indexschluessel des Katalogs und pro Eintrag die typisierte Level-Form (`profile`, `boundaries`, `examples` sowie nur String-/Stringlisten-Zusatzfelder) besitzen; ihre Texte muessen die gesendeten Kriterien nicht serialisierungsidentisch wiederholen.

## Prioritaet, Kontext und Grenzen

- **`typesafe-first`**: Eine kataloggueltige TypeSafe-Score-Auswahl darf eine manuell gesetzte Variante ersetzen. Nur technische Fehler oder eine ungueltige Antwort fuehren zum gueltigen Fallback.
- **`manual-first`**: Eine explizite, im aktuellen Katalog gueltige manuelle Variante beendet das Routing vor jedem TypeSafe-Aufruf. Ohne gueltige manuelle Variante gilt der normale TypeSafe-Pfad.
- **`prompt-only`**: Uebertraegt aktuellen Prompt und Modell-ID, aber keine Verlaufsliste.
- **`recent-messages`**: Ist der Default und erlaubt nur chronologische User-/Assistant-Textnachrichten aus der Session-History. Systemprompts, Reasoning-Parts, Tools, Anhaenge und Metadaten sind ausgeschlossen.
- Vollstaendige, bekannte Abschnitte ab `## Gortex Session Orientation` bis zur naechsten Level-2-Ueberschrift oder zum Textende werden aus dem aktuellen Prompt und aus jedem historischen User-/Assistant-Text entfernt. Text vor und nach dem Block bleibt erhalten; unvollstaendige oder anders markierte Abschnitte werden nicht heuristisch geloescht. Ein Turn, der exakt nur aus einem solchen Block besteht, bleibt absichtlich routbar: `currentPrompt` wird leer, erlaubter Verlauf kann weiterhin Kontext liefern, und eine tatsaechlich angewandte Auswahl oder ein Fallback wird normal benachrichtigt.
- `maxChars` wird zuerst auf den bereinigten aktuellen Prompt und dann auf die neuesten erlaubten, ebenfalls bereinigten Nachrichten angewandt. `maxMessages` begrenzt zusaetzlich deren Anzahl.

`chat.message` erhaelt nach dem OpenCode-Hook-Vertrag nur `providerID` und `modelID`. Es filtert den aktuellen User-Text, startet bei Bedarf die sichere History-Aufbereitung und speichert begrenzte, noch nicht gestartete Routing-Arbeit. Erst das korrelierte `chat.params` liefert das volle Modell: Daraus validiert das Plugin den Runtime-Variantenkatalog und startet damit die Auswahl. Nutzer muessen OpenCodes Modellvarianten daher nicht in `variantsByModel` duplizieren; diese Konfiguration bleibt nur eine optionale explizite Ergaenzung.

`chat.message` setzt einmalig `deadlineAt = start + timeoutMs`. History-Aufbereitung, TypeSafe-SDK-Warten und `chat.params` teilen dieses eine absolute Budget; es wird nicht pro Phase neu gestartet. Unmittelbar vor dem SDK-Aufruf wird die verbleibende Zeit erneut berechnet, sodass nach Fristablauf kein TypeSafe-Aufruf mehr beginnt. Nach Ablauf, bei fehlendem `chat.params` oder bei einer Modellabweichung wird die vorbereitete Klassifikation nicht gestartet. Spaete Antworten werden nicht auf spaetere Turns uebertragen.

Der Store ist pro Prozess auf 256 Eintraege begrenzt und verwendet mindestens 30 Sekunden TTL beziehungsweise das Doppelte von `timeoutMs`, falls das groesser ist. Ein aktiver, den Prozess nicht festhaltender Timer entfernt und storniert jeden Eintrag auch dann, wenn danach keine Store-Operation erfolgt; Kapazitaetsverdraengung, Session-Loeschung und Plugin-Dispose tun dasselbe und entfernen ihre Timer. Wiederholte oder parallele `chat.params`-Aufrufe greifen bis dahin nicht-destruktiv auf dieselbe laufende oder abgeschlossene Entscheidung zu. Provider-Optionen werden bei jedem Aufruf idempotent angewandt; sichere Diagnose-, Benachrichtigungs- und TUI-Nebenwirkungen werden pro Message-ID atomar genau einmal beansprucht.

## Sichtbare OpenCode-TUI-Variante

Nachdem die tatsaechlich ausgewaehlte, unter `manual-first` beibehaltene oder als gueltiger Fallback angewandte Variante in `output.options` uebernommen wurde, versucht das Plugin fuer OpenCode 1.18.31 die sichtbare TUI-Variante best effort nachzufuehren. Es verwendet den SDK-Endpunkt `client.tui.publish` und publiziert exakt dieses direkte TUI-Kommandoereignis:

```json
{
  "type": "tui.command.execute",
  "properties": { "command": "variant.cycle" }
}
```

Der Legacy-Endpunkt `/tui/execute-command` beziehungsweise `client.tui.executeCommand` ist dafuer ungeeignet: OpenCode 1.18.31 bildet dessen Payload durch eine alte `commandAliases`-Tabelle ab, in der `variant.cycle` fehlt. Der unbekannte Name wird dadurch als `undefined` dispatcht, waehrend der Endpunkt dennoch erfolgreich `true` melden kann. Ein Fallback auf diesen bekannten False-Positive-No-op findet deshalb nicht statt. Der Katalog fuer Provider-Routing bleibt die Zusammenfuehrung aus Runtime- und explizit konfigurierten Varianten. Fuer die sichtbare TUI verwendet die Queue dagegen nur die Namen aus dem Runtime-Modell, weil nur diese reale Positionen von `variant.cycle` sind. Wird eine konfigurierte, aber nicht im Runtime-Katalog enthaltene Variante angewandt, bleiben deren Provider-Optionen wirksam und die TUI-Synchronisierung wird uebersprungen. Entspricht die beobachtete sichtbare Variante bereits der Zielvariante, ist der Sync ein No-op. Als `skipped` entschiedene oder vollstaendig umgangene Arbeit wird verworfen und nicht synchronisiert.

Jeder vorbereitete Turn erhaelt bereits bei `chat.message` eine monotone Reihenfolge, die bis zur TUI-Beobachtung und Synchronisierungsanforderung erhalten bleibt. Schliesst ein aelterer Turn erst nach einem neueren ab, wird seine veraltete Beobachtung ignoriert. Die Queue serialisiert Befehle, gibt synchron neu eingetroffener Arbeit einen Microtask-Handoff und verwirft vor dem Versand veraltete Ziele zugunsten der neuesten Beobachtung. Nur eine Publish-Antwort mit `data: true` ohne `error` gilt als erfolgreicher Zyklus. `{ error }`, `data: false`, fehlendes `data` und Exceptions schreiben den spekulativen Variantenstand nicht fort. Trifft waehrend eines laufenden Befehls eine neuere Modell-/Session-Beobachtung ein, ist der Empfaenger des globalen Befehls mehrdeutig: Die Queue invalidiert dann ihre Projektionen und behandelt darauf basierende wartende Arbeit nicht als synchronisiert. Eine spaetere, neue autoritative Beobachtung und Anforderung kann den Sync erneut sicher versuchen. Steht im Headless-Betrieb kein TUI-Publish zur Verfuegung oder schlaegt das Publizieren fehl, bleiben Provider-Routing und angewandte Modelloptionen davon unberuehrt.

Diese Sicherungen beseitigen vermeidbare alte Zyklen, koennen aber keine rennbedingungsfreie exakte TUI-Konvergenz ueber Modell-/Session-Wechsel garantieren. OpenCode 1.18.31 stellt nur das globale `variant.cycle` bereit: Es adressiert das bei der TUI-Verarbeitung sichtbare Modell und enthaelt weder Modellidentitaet noch exakten Variantensetter oder Verarbeitungsbestaetigung. Ein Sichtbarkeitswechsel nach der letzten Vorpruefung kann daher unentdeckt bleiben; ohne anschliessende autoritative Beobachtung ist keine sichere Kompensation moeglich. Die sichtbare TUI-Anzeige bleibt in diesem engen Handoff-Fenster best effort, waehrend die bereits gesetzten Provider-Optionen korrekt und davon unabhaengig bleiben.

## Fallbacks, Diagnosen und Benachrichtigungen

Eine Score-Antwort wird nur akzeptiert, wenn Wahrscheinlichkeiten, Score, Legend und Confidence vollstaendig und formal gueltig sind und die gewaehlte Variante im erneut validierten aktuellen Katalog liegt. Jede gueltige Antwort verwendet die Argmax-Auswahl ohne Confidence-Gate. Bei einer technischen oder ungueltigen Antwort wird die konfigurierte Fallback-Variante nur dann angewandt, wenn auch sie aktuell gueltig ist; andernfalls bleiben OpenCodes Optionen unveraendert. Der feldweise Merge erhaelt fremde `output.options`.

Sichere Diagnosecodes sind:

- `missing-api-key`
- `invalid-response`
- `timeout`
- `network-error`
- `auth-error` fuer HTTP 401/403
- `rate-limited` fuer HTTP 429
- `server-error` fuer HTTP 5xx
- `client-error` fuer sonstige Fehler

Diagnosen enthalten nur `code`, `modelID`, `status` (`fallback` oder `skipped`) und bei `invalid-response` optional ein sicheres `detail`. Die Details `request`, `type`, `probabilities`, `score`, `confidence`, `legend` und `variant` benennen ausschliesslich die verletzte Invariantengruppe und enthalten keine Antwortwerte. Der Router ruft den injizierbaren `onDiagnostic`-Callback fuer jede technische oder ungueltige Routing-Entscheidung auf; identische sichere Diagnose-Logs werden pro Modell, Code, Detail und Status dedupliziert. Benutzerbenachrichtigungen stammen dagegen ausschliesslich aus `onAppliedVariant`, nachdem `chat.params` die validierten Optionen tatsaechlich uebernommen hat. Der Callback enthaelt nur `modelID`, angewandte `variant`, `status` (`selected`, `manual` oder `fallback`), `reason` und optional dasselbe sichere `detail`. `notify=off` unterdrueckt alle Meldungen, `fallback` meldet nur angewandte Fallbacks und `always` zusaetzlich TypeSafe- und manuelle Auswahlen. Damit entsteht pro korreliertem routbaren Turn mit angewandter Variante genau eine Meldung; der aeussere Deadline-Fallback wird als `timeout` klassifiziert, und technische Router-Fallbacks behalten ihren Grund. Ein feldbezogener Fehler erscheint beispielsweise als `fallback:invalid-response/score`. Fehlende oder modellfremde Store-Eintraege erhalten zwar weiterhin nur aktuelle Fallback-Optionen, erzeugen ohne sicher korrelierten routbaren Prompt aber keine Meldung. Keine Meldung enthaelt Prompt, Verlauf, Credential, Fehlerinhalt oder sonstige Rohdaten.

## Datenschutz und Datenminimierung

Extern uebertragen werden nur der bereinigte und gekuerzte aktuelle Prompt, die Modell-ID und der durch Modus, Rollenfilter, Blockfilter, `maxMessages` und `maxChars` begrenzte Textverlauf. Der dynamische Score enthaelt ausschliesslich den aktuell validierten, geordneten Variantenkatalog und seine Kriterien. Der SDK-Logger ist deaktiviert.

Folgende Inhalte duerfen **weder geloggt noch im Decision Store persistiert** werden:

- aktueller Prompt;
- Chat-Verlauf;
- `TYPESAFE_API_KEY` oder andere Credentials;
- TypeSafe-Request-State;
- TypeSafe-Rohantwort einschliesslich ungefilterter Payload;
- Fehler-Response-Body.

Die beobachtbare Store-Metadatenoberflaeche behaelt nur Message-, Session- und Modell-ID, `turnOrder` sowie Deadline-/TTL-Zeitpunkte; Timer, Abbruchcontroller, Nebenwirkungs-Claims, Prompt und History sind nicht ueber `inspect()` oder Logs erreichbar. Die interne, pro Message-ID begrenzte Routing-Closure muss Prompt und History-Promise bis Abschluss, Abbruch oder aktiver TTL-Entfernung voruebergehend halten. Session-Loeschung und Dispose abortieren sie sofort. Der AbortSignal wird sowohl bis zum TypeSafe-SDK als auch als derselbe per-Message-Signalwert an OpenCodes `session.messages` transportiert. Session-Loeschung, Dispose und aktive Ablaufbereinigung abortieren damit auch den produktiven History-Request; falls ein Transport Abort dennoch ignoriert, beendet das Plugin sein lokales Warten sicher und verwirft eine eventuell spaeter eintreffende Antwort. Die normalisierte Entscheidung kann Status, Variantennamen, Grundcode, Zeitpunkt, Confidence und validierte Wahrscheinlichkeiten enthalten, aber kein Credential, Request-State, keine Rohantwort und keinen Fehler-Body.

## Deterministische Offline-Evaluation

Das nicht sensible Korpus liegt in [`.opencode/evaluation/corpus.json`](../.opencode/evaluation/corpus.json). Es enthaelt je mindestens zwei gelabelte Beispiele fuer `simple`, `medium`, `complex`, `ambiguous` und `adversarial`. Die Prompts sind synthetisch und enthalten keine realen Nutzer-, Projekt- oder Credential-Daten.

Der Harness [`.opencode/evaluation/evaluation-harness.ts`](../.opencode/evaluation/evaluation-harness.ts) verwendet ausschliesslich einen injizierten Fixture-Client. Er wertet deterministisch aus:

- Uebereinstimmung von erwarteter und angewandter Variante;
- Variantenverteilung pro Modell;
- Fallback-Quote;
- Quote ungueltiger Score-Antworten und technischer Fallbacks;
- simulierte p50/p95-Zusatzlatenz;
- hochwirksame Fehlklassifikationen mit erwarteter und tatsaechlicher Variante.

Ausfuehrung:

```sh
npm --prefix .opencode run test:evaluation
npm --prefix .opencode run test:docs
```

Der Harness importiert keinen Live-SDK-Client und fuehrt weder TypeSafe- noch OpenAI-Netzwerkaufrufe aus. Fixture-Antworten enthalten nur deterministische Score-, Legend-, Confidence- und Wahrscheinlichkeitswerte; Confidence wird dabei nicht als Gate ausgewertet.

## Separate Freigabegates

Eine **Live-Evaluation gegen TypeSafe ist nicht autorisiert** und benoetigt eine separate spaetere Freigabe wegen externer Datenuebertragung und Kosten. Ebenso sind **Build, Bundle, Packaging und npm-Publishing nicht autorisiert**; eine npm-Veroeffentlichung ist ein eigenes spaeteres Gate. Aus dem Offline-Ergebnis darf keine Publikationsfreigabe abgeleitet werden.

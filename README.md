# OpenCode TypeSafe Variant Router

Dieses Repository enthaelt ein lokales OpenCode-Plugin, das fuer OpenAI-Modelle eine validierte Reasoning-Variante ueber TypeSafe auswaehlt und bei Fehlern deterministisch zurueckfaellt.

## Routing-Verhalten

Der Router verwendet TypeSafe [`Score`](https://docs.typesafe.ai/primitives/score.md) ueber den validierten Variantenkatalog in dessen Runtime-Reihenfolge. `chat.message` liefert dabei vertragsgemaess nur Provider- und Modell-ID; der vollstaendige Runtime-Katalog wird erst aus dem vollen Modell von `chat.params` validiert und fuer denselben Message-Turn an das vorbereitete Routing uebergeben. Die eingebauten Profile folgen den offiziellen OpenAI-Semantiken fuer [`none`, `low`, `medium`, `high`, `xhigh` und `max`](https://platform.openai.com/docs/guides/reasoning): von keiner beziehungsweise effizienter Reasoning-Arbeit bis zur maximal verfuegbaren Denktiefe. Aus einer gueltigen Score-Antwort wird immer die Variante mit der hoechsten Wahrscheinlichkeit gewaehlt; bei einem exakten Gleichstand gewinnt die niedrigere, frueher im Katalog stehende Reasoning-Stufe. Es gibt weder `confidenceThreshold` noch einen Low-Confidence-Fallback. Confidence bleibt, sofern vorhanden, reine Diagnosemetadaten.

`recent-messages` ist weiterhin der Kontextdefault. Vollstaendige, bekannte `## Gortex Session Orientation`-Bloecke werden aus dem aktuellen Prompt sowie aus historischen User-/Assistant-Texten entfernt; Text davor und danach bleibt erhalten. Ein Prompt, der exakt nur aus diesem Block besteht, bleibt ein routbarer Turn: Sein bereinigter aktueller Text ist leer, erlaubter Verlauf kann weiterhin Kontext liefern, und die tatsaechlich angewandte Variante erzeugt gemaess `notify` genau eine Benachrichtigung. Technische Fehler und ungueltige Antworten verwenden weiterhin den validierten deterministischen Fallback. Prompts, Verlauf, Credentials, Rohantworten und Fehler-Bodies werden weder geloggt noch persistiert. Benachrichtigungen entstehen erst nach der Anwendung in `chat.params`, nennen die angewandte Variante und werden nicht aus fruehen Auswahl- oder Diagnoseereignissen dupliziert; identische sichere Diagnose-Logs bleiben dedupliziert. Wiederholte oder parallele `chat.params`-Aufrufe desselben Turns verwenden dasselbe begrenzte Ergebnis und wenden identische Optionen an, waehrend Benachrichtigung und TUI-Synchronisation genau einmal ausgeloest werden. Session-Loeschung, Plugin-Dispose und aktive TTL-Ablauf-Timer brechen vorbereitete History-/TypeSafe-Arbeit best effort ab.

Nachdem die tatsaechlich ausgewaehlte, manuell beibehaltene oder als Fallback angewandte Variante in die Modelloptionen uebernommen wurde, versucht das Plugin fuer OpenCode 1.18.31 die sichtbare TUI-Variante best effort ueber `client.tui.publish` nachzufuehren. Es publiziert dafuer direkt das Ereignis `{ type: "tui.command.execute", properties: { command: "variant.cycle" } }`. Der Legacy-Endpunkt `executeCommand` wird bewusst nicht verwendet: Dessen Alias-Tabelle enthaelt `variant.cycle` in 1.18.31 nicht, sodass der Endpunkt trotz wirkungslosem `undefined`-Dispatch `data: true` liefern kann. Provider-Routing darf den Runtime-Katalog weiterhin um konfigurierte Varianten erweitern; fuer TUI-Zyklen verwendet das Plugin jedoch ausschliesslich die Runtime-Varianten. Ein konfiguriertes Ziel ohne Runtime-Position wird nicht in der TUI synchronisiert. Stimmt die Variante bereits ueberein, bleibt der Sync ein No-op. Die Turn-Reihenfolge wird bereits bei `chat.message` vergeben, sodass spaet abgeschlossene aeltere Turns keine neuere TUI-Projektion ueberschreiben. Vor dem Versand wird veraltete Arbeit zugunsten der neuesten Beobachtung verworfen; Publish-Antworten mit `error`, fehlendem oder falschem `data` sowie Exceptions gelten als Fehlschlag und schreiben keinen spekulativen Variantenstand fort. Wechselt die beobachtete Modell-/Session-Eigentuemerschaft waehrend eines laufenden Befehls, wird der mehrdeutige Stand invalidiert; erst eine neue autoritative Beobachtung kann sicher erneut synchronisieren. Ein fehlendes TUI-Publish im Headless-Betrieb oder ein Publish-Fehler beeinflusst weder Provider-Routing noch angewandte Modelloptionen.

Die OpenCode-API bietet dabei nur ein globales `variant.cycle`: Der Befehl wirkt auf das Modell, das bei der Verarbeitung im TUI sichtbar ist, und liefert weder Modellidentitaet, exakten Setter noch Verarbeitungsbestaetigung. Ein Modellwechsel nach der letzten Vorpruefung kann deshalb nicht rennbedingungsfrei verhindert oder exakt korrigiert werden. Die sichtbare Anzeige ist ueber Modell-/Session-Wechsel hinweg folglich nur best effort; Provider-Routing und angewandte Modelloptionen bleiben davon unabhaengig korrekt.

## Linux-/KDE-Prototyp einrichten

Der Prototyp liest `TYPESAFE_API_KEY` beim Start von OpenCode zuerst aus der Prozessumgebung. Fehlt die Variable, fragt er einmalig den Linux Secret Service mit `secret-tool` ab. Unter KDE setzt das eine aktive Secret-Service-Integration von KWallet voraus.

`secret-tool` wird je nach Distribution beispielsweise durch das Paket `libsecret-tools` bereitgestellt. Den Key einmalig unter den vom Plugin erwarteten Attributen speichern:

```sh
secret-tool store --label="TypeSafe API Key" service typesafe credential api-key
```

Der Befehl fragt den geheimen Wert interaktiv ab; der Key gehoert nicht in die Kommandozeile, Konfiguration oder eine Datei. Danach OpenCode neu starten. Das Plugin verwendet intern genau diesen Lookup:

```sh
secret-tool lookup service typesafe credential api-key
```

Der Lookup erfolgt ohne Shell, mit fuenf Sekunden Timeout und begrenzter Ausgabe. Key, stdout, stderr und Fehlerdetails werden nicht geloggt. Wenn `secret-tool`, Secret Service oder der Eintrag fehlt, startet OpenCode normal und der Router verwendet seinen bestehenden deterministischen Fallback.

Dieser Credential-Pfad ist fuer die Prototypversion bewusst Linux-/KDE-spezifisch. Ausfuehrliche Konfiguration, Datenschutzgrenzen und Betriebshinweise stehen in [`docs/typesafe-variant-router.md`](docs/typesafe-variant-router.md).

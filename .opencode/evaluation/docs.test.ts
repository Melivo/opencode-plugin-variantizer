import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseRouterConfig } from "../plugins/typesafe-variant-router/config.ts";

const runbookUrl = new URL("../../docs/typesafe-variant-router.md", import.meta.url);
const designUrl = new URL("../../docs/plans/designs/001-typesafe-openai-variant-router.md", import.meta.url);
const runbook = readFileSync(runbookUrl, "utf8");
const historicalDesign = readFileSync(designUrl, "utf8");
const defaults = parseRouterConfig({ fallbackVariant: "medium" });

describe("TypeSafe variant router operations documentation", () => {
  test("documents the complete live configuration defaults and hard limits", () => {
    expect(runbook).toContain("`fallbackVariant` ist Pflicht");
    expect(runbook).toContain(`\`${defaults.timeoutMs}\``);
    expect(runbook).toContain(`\`${defaults.manualVariantPolicy}\``);
    expect(runbook).toContain(`\`${defaults.context.mode}\``);
    expect(runbook).toContain(`\`${defaults.context.maxMessages}\``);
    expect(runbook).toContain(`\`${defaults.context.maxChars}\``);
    expect(runbook).toContain("maximal `30000`");
    expect(runbook).toContain("maximal `100`");
    expect(runbook).toContain("maximal `100000`");
    expect(runbook).toContain("Unbekannte Felder werden abgewiesen");
    expect(runbook).toContain("`typesafe-first`");
    expect(runbook).toContain("`manual-first`");
    expect(runbook).toContain("absolutes Gesamtbudget");
    expect(runbook).toContain("Benutzerbenachrichtigung");
    expect(runbook).toContain("`missing-api-key`");
    expect(runbook).toContain("`server-error`");
    expect(runbook).toContain("https://platform.openai.com/docs/guides/reasoning");
    expect(runbook).toContain("https://docs.typesafe.ai/primitives/score.md");
    expect(runbook).toContain("`argmax(probabilities)`");
    expect(runbook).toContain("Bei exakt gleichen Wahrscheinlichkeiten gewinnt die niedrigere Reasoning-Stufe");
    expect(runbook).toContain("**`recent-messages`**: Ist der Default");
    expect(runbook).toContain("`## Gortex Session Orientation`");
    expect(runbook).toContain("Text vor und nach dem Block bleibt erhalten");
    expect(runbook).toContain("OpenCode 1.18.31");
    expect(runbook).toContain("`variant.cycle`");
    expect(runbook).toContain("bereits der Zielvariante");
    expect(runbook).toContain("Headless-Betrieb");
    expect(runbook).toContain("Als `skipped` entschiedene oder vollstaendig umgangene Arbeit");
    expect(runbook).toContain("`client.tui.publish`");
    expect(runbook).toContain("\"type\": \"tui.command.execute\"");
    expect(runbook).toContain("`/tui/execute-command`");
    expect(runbook).toContain("`commandAliases`");
    expect(runbook).toContain("bekannten False-Positive-No-op");
    expect(runbook).toContain("Der Katalog fuer Provider-Routing bleibt die Zusammenfuehrung");
    expect(runbook).toContain("nur die Namen aus dem Runtime-Modell");
    expect(runbook).toContain("TUI-Synchronisierung wird uebersprungen");
    expect(runbook).toContain("bei `chat.message` eine monotone Reihenfolge");
    expect(runbook).toContain("veraltete Beobachtung ignoriert");
    expect(runbook).toContain("Nur eine Publish-Antwort mit `data: true` ohne `error`");
    expect(runbook).toContain("weder Modellidentitaet noch exakten Variantensetter oder Verarbeitungsbestaetigung");
    expect(runbook).toContain("keine rennbedingungsfreie exakte TUI-Konvergenz");
    expect(runbook).toContain("Provider-Optionen korrekt und davon unabhaengig");
    expect(runbook).not.toContain("confidenceThreshold");
    expect(runbook).not.toContain("dynamische Choice");
    expect(runbook).not.toContain("`low-confidence`");
  });

  test("marks the retired Choice design as a non-normative historical snapshot", () => {
    expect(historicalDesign).toContain("- Status: Superseded");
    expect(historicalDesign).toContain("[TypeSafe Score Routing](../work/002-typesafe-score-routing.md)");
    expect(historicalDesign).toContain("Historischer Design-Snapshot — keine aktuelle normative Anleitung");
    expect(historicalDesign).toContain("`argmax(probabilities)` ohne Confidence-Schwellwert");
    expect(historicalDesign).toContain("die niedrigere Katalogposition");
    expect(historicalDesign).toContain("Fallbacks nur bei technischen Fehlern oder ungueltigen Antworten");
    expect(historicalDesign).toContain("best-effort Synchronisierung der sichtbaren OpenCode-UI-Variante");
    expect(historicalDesign).toContain("Alle folgenden Abschnitte beschreiben ausschliesslich den damaligen, abgeloesten Entwurf");
    expect(historicalDesign).toContain("HTML/JSON-Snapshot bleibt absichtlich unveraendert");
  });

  test("states external transfer, minimization, forbidden data, and future gates", () => {
    for (const requiredStatement of [
      "an TypeSafe uebertragen",
      "aktueller Prompt",
      "Chat-Verlauf",
      "`TYPESAFE_API_KEY`",
      "TypeSafe-Request-State",
      "TypeSafe-Rohantwort",
      "Fehler-Response-Body",
      "Live-Evaluation gegen TypeSafe ist nicht autorisiert",
      "npm-Publishing nicht autorisiert",
      "Es gibt keinen Confidence-Schwellwert",
    ]) {
      expect(runbook).toContain(requiredStatement);
    }
  });
});

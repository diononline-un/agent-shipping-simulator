---
status: in-development
progress: 70
version: "0.1.0"
tags: [chrome-extension, optimizer, csv-export, scraper]
scope: "Chrome-Extension, die Pakete im gtbuy.com-Warenlager gruppiert und simuliert, um Versandkosten zu minimieren"
last_updated: "2026-08-13"
next_steps:
  - Live-Test mit echtem gtbuy.com-Konto: Simulation gegen reale Versandtarife validieren
  - Versandkosten-Bewertung (Pre-Scoring) an echten Tarifdaten kalibrieren
  - Build-/Packaging-Skript ergänzen (aktuell kein package.json, Laden nur via Unpacked)
  - Fehler-Recovery bei SPA-Navigation und Tab-Orchestrierung härten
  - UI-Feinschliff: Popup-Debug-Panel und Overlay-Zustände konsolidieren
---

# Aktueller Stand
- Optimizer-Engine mit Depth-Modi (Schnell/Normal/Genau), k=2-4 Splits und Volumengewicht funktioniert
- DOM-Simulation gruppiert Pakete in Tabs, inkl. Vue-Checkbox-Handling und Sequenzialisierung
- Orders-Scraper liest Bestellseiten paginiert, CSV-Export kombiniert Orders mit Warenlager-Daten
- Warehouse-Items persistieren in chrome.storage, Export springt automatisch zur Orders-Seite
- Noch offen: kein Live-Test gegen echte Kontodaten, keine Versionierung/Build-Pipeline, Fehlerrecovery teils ungetestet

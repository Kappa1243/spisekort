# Spisekort

Et personligt kort over gode restauranter i København.

- **Appen:** `index.html` (vises via GitHub Pages). Den henter `places.json`, hver gang den åbnes.
- **Listen:** `places.json`. Claude holder den opdateret: skriv til Claude, hvilke restauranter der skal med.

## Format for `places.json`

```json
{
  "updated": "2026-10-29",
  "places": [
    {
      "id": "masseria",
      "name": "Masseria",
      "type": "Italiensk",
      "address": "Flæsketorvet 50, 1711 København V",
      "note": "Syditaliensk pastatrattoria i Kødbyen.",
      "lat": 55.669,
      "lon": 12.5592,
      "approx": true
    }
  ]
}
```

- `id`: kort, unikt, med små bogstaver og bindestreger. Skift det aldrig for et eksisterende sted.
- `type`: madtype på dansk med stort forbogstav (fx Italiensk, Fransk, Nordisk, Bar). Bliver til filtrene i appen.
- `lat`/`lon`: koordinater. `approx: true` betyder omtrentlige; appen slår så adressen op og gør positionen præcis.
- Fjern et sted ved at slette det fra listen.

## Filmliste

Mappen `film/` er en separat app: en Netflix-agtig oversigt over film og hvor de kan streames i Danmark (https://kappa1243.github.io/spisekort/film/). Se `film/README.md`.

# Fiskekort

Kort over den danske kyst (ingen søer), hvor hver kyststrækning på ca. 500 m farves grøn, gul eller rød efter, hvor gode forholdene er på et valgt tidspunkt. Fredningsbælter vises lilla.

Siden: https://kappa1243.github.io/spisekort/fiskekort/

## Sådan virker det

- **Kysten** (OpenStreetMap) er delt op i stykker. Hvert stykke kender sin retning ud mod vandet. OSM tegner kystlinjen med land til venstre og vand til højre, og den regel bruger pipelinen.
- **Vinden** hentes i browseren fra Open-Meteo (DMI HARMONIE de første ~2,5 døgn, derefter ECMWF). Prognosen rækker 16 dage frem. Kortet sammenligner vindens retning med kystens: pålandsvind, sidevind eller fralandsvind.
- **Arter** har hver deres ideelle vindstyrke og retningsvægte (se `SPECIES` øverst i `app.js`). "Generelt" har skydeknapper.
- **Fredningsbælter** hentes fra Fiskeristyrelsens kort over fredningsbælter i hele Danmark. Helårlige gælder altid, halvårlige 16/9–15/3.

Scoren er en hypotese, der endnu ikke er kalibreret mod rigtige fangster.

## Filer

| Fil | Indhold |
|---|---|
| `index.html`, `app.js` | Selve kortet (MapLibre GL) |
| `data/coast.geojson` | Kyststrækninger. `i` = id, `b` = retning ud mod vandet i grader (-1 = uklar), `g` = vindpunkt, `f` = fredningszoner |
| `data/fredning.geojson` | Fredningszoner. `t` = `hel` / `halv` / `saer` |
| `data/windpoints.json` | Punkter `[lon, lat]`, som vinden hentes for |
| `data/meta.json` | Byggetidspunkt og antal |
| `data/_build_log.json` | Log og fund fra datakilderne (til fejlfinding) |
| `pipeline/build.py` | Bygger data-filerne |

## Opdatering af data

Data bygges af GitHub Actions (`.github/workflows/fiskekort-data.yml`), fordi kilderne skal hentes fra internettet:

- automatisk, når `pipeline/` ændres,
- den 1. i hver måned,
- manuelt: GitHub → Actions → "Fiskekort data" → "Run workflow".

## Næste trin

1. Vandkvalitet fra vandområdeplanerne (VP3) som loft over scoren.
2. Iltsvind (DCE-rapporter), havtemperatur, dybde og bundforhold.
3. Fangstlog til kalibrering af grænserne.

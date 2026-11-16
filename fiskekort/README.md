# Fiskekort

Kort over den danske kyst (ingen søer), hvor hver kyststrækning på ca. 500 m farves grøn, gul eller rød efter, hvor gode forholdene er på et valgt tidspunkt. Fredningsbælter vises lilla.

Siden: https://kappa1243.github.io/spisekort/fiskekort/

## Sådan virker det

- **Kysten** (OpenStreetMap) er delt op i stykker. Hvert stykke kender sin retning ud mod vandet (tjekkes mod Miljøstyrelsens vandpolygoner ved hvert build).
- **Vind** hentes i browseren fra Open-Meteo (DMI HARMONIE de første ~2,5 døgn, derefter ECMWF): 2 døgn bagud og 12 frem. Gemmes 45 min i browseren.
- **Uklart vand:** mindst 8 timer med kraftig pålandsvind (≥ 9 m/s) eller hård vind (≥ 13 m/s) de seneste 36 timer → højst gul for havørred og hornfisk.
- **Havtemperatur** fra Open-Meteo Marine, **lys** (sol op/ned beregnes lokalt), **dybde** (EMODnet Bathymetry) og **bundtype** (EMODnet Geology) giver plus eller minus pr. art.
- **Arter** har hver deres grænser (se `SPECIES` øverst i `app.js`). "Generelt" har skydeknapper.
- **Fredningsbælter** hentes fra Fiskeristyrelsens ArcGIS-lag. Zoner, hvor lagets periode er forkert eller uklar, er håndkontrolleret mod bekendtgørelserne i `pipeline/fredning_overrides.json`.

Scoren er en hypotese, der endnu ikke er kalibreret mod rigtige fangster.

## Filer

| Fil | Indhold |
|---|---|
| `index.html`, `app.js` | Selve kortet (MapLibre GL) |
| `data/coast.geojson` | Kyststrækninger. `i` = id, `b` = retning ud mod vandet i grader (-1 = uklar), `g` = vindpunkt, `f` = fredningszoner, `w` = kystvand, `d1`/`d2` = dybde 150/400 m ude, `s` = bundtype |
| `data/fredning.geojson` | Fredningszoner. `t` = `hel` / `per` (perioder i `p`) / `omr` (særlige regler) / `ukendt`; `stang` = stangfiskeri tilladt; `v` = kontrolleret |
| `data/windpoints.json` | Punkter `[lon, lat]`, som vinden hentes for |
| `data/meta.json` | Byggetidspunkt og antal |
| `data/_build_log.json` | Log og fund fra datakilderne (til fejlfinding) |
| `data/vand.geojson` | Økologisk tilstand pr. kystvand (VP3) |
| `pipeline/build.py` | Bygger data-filerne |
| `pipeline/fredning_overrides.json` | Håndkontrollerede rettelser til fredningszoner |

## Opdatering af data

Data bygges af GitHub Actions (`.github/workflows/fiskekort-data.yml`), fordi kilderne skal hentes fra internettet:

- automatisk, når `pipeline/` ændres,
- den 1. i hver måned,
- manuelt: GitHub → Actions → "Fiskekort data" → "Run workflow".

Builden skriver alt eller intet: fejler en kilde, eller falder antallet af zoner/strækninger markant, bliver data ikke opdateret, og kun `data/_build_log.json` committes med fejlen.

## Næste trin

1. Gennemgå de resterende ukontrollerede zoner over 1 km² (fx Hjarbæk Fjord, Vejle Amt-særfredninger).
2. Iltsvind (DCE-rapporter).

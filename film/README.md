# Filmliste

En Netflix-agtig oversigt over Markus' film og hvor de kan streames i Danmark.

- **Appen:** `index.html` – vises på https://kappa1243.github.io/spisekort/film/. Den henter `films.json`, hver gang den åbnes.
- **Listen:** `films.json`. Claude holder den opdateret: skriv til Claude, hvilke film der skal med.
- **Mine tjenester** (knappen øverst til højre) gemmes kun i browseren på den enkelte enhed.

## Format for `films.json`

```json
{
  "updated": "2026-10-29",
  "country": "DK",
  "films": [
    {
      "id": "dune-part-two",
      "title": "Dune: Part Two",
      "danishTitle": "",
      "originalTitle": "",
      "year": 2024,
      "runtime": 167,
      "genres": ["Sci-fi", "Eventyr", "Action"],
      "note": "Kort, faktuel sætning på dansk.",
      "poster": "https://images.justwatch.com/poster/312362420/s332/dune-part-two.jpg",
      "wiki": "Dune: Part Two",
      "justwatch": "https://www.justwatch.com/dk/movie/dune-part-two",
      "stream": ["HBO Max"],
      "free": [],
      "rent": ["Apple TV", "Amazon Video"],
      "buy": ["Apple TV"],
      "checked": "2026-10-29",
      "added": "2026-10-29"
    }
  ]
}
```

- `id`: små bogstaver, tal og bindestreger. Skift det aldrig for en eksisterende film.
- `danishTitle`: dansk titel, hvis filmen har en (vises i stedet for `title`). `originalTitle`: fx den engelske titel på en dansk film.
- `genres`: på dansk med stort forbogstav. Brug helst: Action, Animation, Biografi, Dokumentar, Drama, Eventyr, Familie, Fantasy, Gyser, Historie, Komedie, Krimi, Musical, Mysterie, Romantik, Sci-fi, Thriller, Krig, Western. Den første er filmens hovedgenre.
- `stream`: tjenester med abonnement. Brug disse navne: Netflix, HBO Max, Disney+, Viaplay, TV 2 Play, DRTV, Prime Video, SkyShowtime, Apple TV+, Nordisk Film+, Allente, Paramount+, MUBI, Filmstriben.
- `free`: gratis (fx DRTV-film uden login, Filmstriben via bibliotek).
- `rent` / `buy`: Apple TV, Amazon Video, Rakuten TV, SF Anytime, Viaplay, Google Play, Blockbuster.
- `poster`: plakat fra JustWatch (`images.justwatch.com/poster/<id>/s332/<slug>.jpg`). Hvis den ikke kan hentes, prøver appen Wikipedia-artiklen i `wiki` (engelsk titel), og ellers vises et farvet titelkort.
- `checked`: datoen, hvor streaming-udbuddet sidst blev tjekket.

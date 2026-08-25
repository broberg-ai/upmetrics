# F027 — Vi taber stakken for Safari- og Firefox-brugere

> **Status:** foreslået 2026-08-25 · rejst af **Christian** som modspørgsmål

## Hvordan det kom frem

cms bad om stack + kontekst på et issue for at kunne afgøre om det var ægte. Jeg hentede eventet fra prod og svarede at der ingen stack var, og anbefalede dem at opdatere SDK'et og lukke issuet som støj.

Christian: *«Men er det ikke en reel fejl i din pakke der skal opdateres?»*

Jo. Jeg havde bedt en forbruger arbejde uden om vores egen defekt — og ikke undersøgt om vi selv tabte det bevis de manglede.

## Fejl 1 — `parseStack` forstår kun V8

`packages/sdk/src/index.ts:144`:

```ts
const m = line.match(/at (.+?) \(?(.+?):(\d+):(\d+)\)?$/);
```

Det forudsætter V8's format (`at fn (fil:linje:kolonne)`). Målt mod ægte formater:

| Format | Frames fanget |
|---|---|
| V8/Node navngivet | 2/2 |
| V8 async | 1/1 |
| Chrome browser | 1/1 |
| **V8 anonym frame** | **0/1 — tabt** |
| **Firefox** (`fn@fil:l:c`) | **0/2 — alt tabt** |
| **Safari** | **0/2 — alt tabt** |
| **Safari `global code`** | **0/1 — tabt** |

Firefox og Safari skriver `fn@fil:l:c` uden `at`, så **intet** matcher og hele stakken kastes væk. Fejlen rapporteres stadig — bare uden nogen oplysning om hvor den skete.

Det er ikke en kant-sag. Brugerne er danske, og Safari på iPhone er en stor andel af enhver dansk brugerflade.

## Fejl 2 — serveren gør de bevisløse ens

`apps/server/src/ingest/grouping.ts:10-23`:

```ts
const frame = top ? `${top.function ?? ''}@${top.filename ?? ''}` : '';
key = `${exc.type ?? 'Error'}|${frame}`;
```

Uden frames bliver nøglen bogstaveligt `TimeoutError|`. **Alle stakløse fejl af samme type i et projekt lander derfor i ét issue.**

cms' issue `81634769` bærer 18 events over 86 dage som kan stamme fra 18 forskellige steder — og præsenterer sig som ét hyppigt problem.

## Hvorfor de to hører sammen

**Den første fjerner beviset. Den anden gør de bevisløse ens.** Hver for sig er de irriterende; sammen producerer de et dashboard der ser ud som dækning og ikke er det.

cms, #22394: *«en spand med 18 hændelser fra 18 steder præsenterer sig som ét problem med høj frekvens, og det er den forkerte prioritering i begge retninger.»* Begge retninger er pointen: et sjældent problem ser presserende ud, og et hyppigt drukner.

## Scope

1. **`parseStack` skal forstå Safari/Firefox-formatet og anonyme V8-frames** (F027.1).
2. **Et stakløst event må ikke få en nøgle der kan kollidere** (F027.2). cms' forslag: behandl det som *ukendt oprindelse* frem for at give det en delt nøgle — fx tag `exc.value` med i nøglen når frames mangler, så stakløse fejl grupperes på deres besked i stedet for alle sammen.

## Non-goals

- **Ikke omgruppering af historikken.** Eksisterende issues behøver ikke splittes bagud; en ændret nøgle gælder fremad. At omskrive historik er en anden beslutning med sin egen risiko.
- **Ikke source-maps.** Minificerede frames er et separat problem; her handler det om at fange dem overhovedet.
- **Ikke at holde op med at rapportere stakløse fejl.** De skal bare kunne skelnes.

## Harness (obligatorisk)

- **Tabel-test af `parseStack`** med ét ægte eksempel pr. motor (V8 navngivet, V8 anonym, V8 async, Chrome, Firefox, Safari, Safari `global code`) og et forventet antal frames for hver. **Mutations-bevist:** smæk regexet tilbage til den gamle V8-only udgave → mindst tre rækker skal gå røde.
- **NEGATIV KONTROL:** en ægte stakløs `DOMException` skal stadig give `frames: []`. Uden den kan «vi fanger nu alt» ikke skelnes fra «vi finder på frames».
- **Fingerprint-test:** to stakløse fejl af samme type med FORSKELLIG besked skal få forskellige fingerprints; to med samme besked skal dele. Begge retninger, ellers beviser testen kun den ene halvdel.

## Rollout

SDK-ændringen kræver et `sdk-v*`-tag → `publish-sdk.yml` (OIDC). **Aldrig lokal `npm publish`.** Når den er ude: meld til de forbrugende repos så de bumper — og særligt til cms, som netop har bumpet til 0.4.0 og vil skulle igen.

## Reuse

Discovery-tjek 2026-08-25 for "stack parse", "error grouping", "fingerprint": ingen `@broberg/*`-pakke ejer stack-parsing. Arbejdet er vores eget. (Sentrys egen parser er et muligt forbillede, men vi trækker ikke deres afhængighed ind for syv linjer regex.)

## Kilde

Christians modspørgsmål 2026-08-25. Målingen af `parseStack` kørt samme dag mod syv formater. cms' observationer i #22391 og #22394. Afløser idé `019fd783` (beacons oprindelige fund af kollapset).

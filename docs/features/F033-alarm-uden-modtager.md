# F033 — En alarm der ikke når nogen er ikke en alarm

**Status:** fundet og målt, IKKE bygget — afventer ejerens beslutning om omfang
**Fundet af:** broberg-id, 20/9 2026

> **RETTELSE, samme dag.** Første udgave af denne plan sagde «17 af 25». Det var
> forkert: jeg talte min egen liste forkert og læste et AFKORTET forespørgsels-
> output som om det var fuldstændigt. Det rigtige tal er **15 af 24**, og
> `buddy` HAR en regel — hvilket jeg påstod uden at have målt det, og buddy
> fangede det. Tallet stod i tre intercom-beskeder og i denne fil før det blev
> rettet. Substansen er uændret; tallet var ikke.

## Hvordan det kom frem

broberg-id ville lukke et acceptkriterium der krævede at de havde SET en alarm
nå frem. De fremkaldte en ægte alarm på projekt `bid` med en midlertidig probe
mod en 404-adresse — ingen nedetid:

```
10:36:00Z  fejl=1  degraded
10:37:00Z  fejl=2  degraded
10:38:00Z  fejl=3  DOWN → incident 71a9ef80 (probe_down, high, open)
```

Kæden probe → incident virkede perfekt. Så spurgte de Christian direkte:

> «Jeg fik ingenting nogen steder.»

Ikke Discord, ikke mail, ikke telefon.

## Hvad der er målt (præcist, anden gang)

```
projekter i alt        24
har mindst én regel     9   (alle aktive)
UDEN regel             15
```

| | |
|---|---|
| **har regel (9)** | buddy · cardmem · cms · cms-mobile · fysiodk · sanneandersen · trail · upmetrics · xrt81 |
| **INGEN regel (15)** | **bid** · **components** · helpdesk · fd-sundhed · storeform · autodoc · beacon · broberg-services · buddy-mobile · contentpush · coverletter · happy-little-place · swiftsdktest · trail-ambient · voice-engine |

`bid` er flådens centrale login. Nedetid dér lukker alt på én gang, og den har
lige nu en alarm der rejses korrekt og aldrig når nogen.

**Bemærk at `buddy` har en regel mens `buddy-mobile` ikke har.** To projekter,
samme ejer, kun det ene dækket — netop den slags forskel ingen opdager før den
dag det udækkede går ned.

## MASKINERIET VIRKER — det er ikke det der er galt

Det er vigtigt at sige, for ellers bliver remedien den forkerte. `alert_history`
bærer ægte leveringer:

```
channels_sent: ["discord"]   errors: null   kind: deploy_regression
channels_sent: ["discord"]   errors: null   kind: error_spike
```

Intet projekt har sin EGEN `alert_discord_webhook` sat — de 9 der virker, falder
alle tilbage på den ene fleet-webhook, hvilket er den rigtige «én kilde»-opførsel.

## Rodsagen

`runAlerts` løber projektets **aktiverede `alert_rules`** igennem og leverer på
reglens kanaler. Ingen regel ⇒ ingen kanal ⇒ ingen besked. Og **optagelsen af et
projekt har aldrig oprettet en regel** — hverken den manuelle vej (`fly ssh` +
INSERT) eller den self-enrollment der blev bygget 17/9 (F032).

Så et repo får DSN, nøgle og overvågning — og lydløst ingen alarm. Det er min
fejl, og det er den værste form: alt ser rigtigt ud lige indtil noget går ned.

**Fejlen er anti-korreleret med opmærksomhed:** de 9 der virker, er de projekter
nogen engang satte en regel på i hånden. De 15 er dem ingen har rørt — altså
præcis dem hvor en stille nedetid ville vare længst.

## Reuse

Genbrugstjek mod `discovery.broberg.ai` før planen:

| kapabilitet | fundet | beslutning |
|---|---|---|
| besked-levering (Discord/mail) | `@broberg/mail` er allerede i brug til mail-kanalen | **genbrugt** — ingen ændring |
| alarm-/regel-motor | intet i `@broberg/*` | **findes her** — `incidents/alerts.ts` er vores egen kerne |
| webpush som ekstra kanal | `@broberg/webpush` 0.5.0, ikke adopteret her | **ikke nu** — en ny KANAL er en anden beslutning end en manglende REGEL; blandes de, løser vi ingen af dem |

## Beslutningen der IKKE er min

Skal alle 15 begynde at ringe til Christians Discord? Det ændrer hvad der lander
på hans telefon, og det er hans kald. Tre muligheder:

1. **Alle 15 på én gang.** Fuld dækning straks; risiko for et pludseligt
   støj-spring fra projekter der har været tavse.
2. **De vigtigste først** (bid, components, helpdesk, fd-sundhed, storeform).
   Mindre støj, men de øvrige 10 bliver ved med at være tavse — og en delvis
   dækning der ligner fuld er sin egen fejlklasse.
3. **Alle 15, men kun `high`+`critical`** til at starte med. Mit forslag: det
   dækker nedetid og lader støjen fra `medium` vente til vi har set mængden.

Intet bygges før han har svaret.

## Stories

- **F033.1** — hvert projekt får en alarm ved optagelse, og de 15 får én med tilbagevirkende kraft
- **F033.2** — en alarm på FRAVÆRET af overvågning (broberg-ids forslag)

## Non-goals

- Ingen ny kanal (webpush, SMS). Det er en anden beslutning.
- Ingen selvbetjenings-rute til at konfigurere modtagere endnu. broberg-id målte
  ti 404'er og konkluderede rimeligt at fladen ikke fandtes; den mangler, men
  den er ikke dét der gør flåden tavs i dag.

## Den metodefejl der hører med

Jeg læste et forespørgsels-output der var afkortet i toppen, og talte listen i
hovedet. Begge dele gav forkerte tal, og jeg sagde dem videre som målte. Den
rigtige form er den der står øverst i denne fil nu: lad databasen tælle, og
udskriv tallet ved siden af listen — så kan en afkortet visning ikke læses som
et resultat.

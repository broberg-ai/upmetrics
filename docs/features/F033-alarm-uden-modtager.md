# F033 — En alarm der ikke når nogen er ikke en alarm

**Status:** fundet og målt, IKKE bygget — afventer ejerens beslutning om omfang
**Fundet af:** broberg-id, 20/9 2026

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

## Hvad jeg målte bagefter

**17 af 25 projekter har INGEN `alert_rules`-række.**

| | |
|---|---|
| **har regel (8)** | cardmem · cms · cms-mobile · fysiodk · sanneandersen · trail · upmetrics · xrt81 |
| **INGEN regel (17)** | **bid** · **components** · helpdesk · fd-sundhed · storeform · autodoc · beacon · broberg-services · buddy-mobile · contentpush · coverletter · happy-little-place · swiftsdktest · trail-ambient · voice-engine |

`bid` er flådens centrale login. Nedetid dér lukker alt på én gang, og den har
lige nu en alarm der rejses korrekt og aldrig når nogen.

## MASKINERIET VIRKER — det er ikke det der er galt

Det er vigtigt at sige, for ellers bliver remedien den forkerte. `alert_history`
bærer ægte leveringer:

```
channels_sent: ["discord"]   errors: null   kind: deploy_regression
channels_sent: ["discord"]   errors: null   kind: error_spike
```

Ingen af de 25 projekter har sin EGEN `alert_discord_webhook` sat — de 8 der
virker, falder alle tilbage på den éne flåde-webhook, hvilket er den rigtige
«én kilde»-opførsel.

## Rodsågen

`runAlerts` løber projektets **aktiverede `alert_rules`** igennem og leverer på
reglens kanaler. Ingen regel ⇒ ingen kanal ⇒ ingen besked. Og **optagelsen af et
projekt har aldrig oprettet en regel** — hverken den manuelle vej (`fly ssh` +
INSERT) eller den self-enrollment der blev bygget 17/9 (F032).

Så et repo får DSN, nøgle og overvågning — og lydløst ingen alarm. Det er min
fejl, og det er den værste form: alt ser rigtigt ud lige indtil noget går ned.

**Fejlen er anti-korreleret med opmærksomhed:** de 8 der virker, er de
projekter nogen engang satte en regel på i hånden. De 17 er dem ingen har rørt —
altså præcis dem hvor en stille nedetid ville vare længst.

## Reuse

Genbrugstjek mod `discovery.broberg.ai` før planen:

| kapabilitet | fundet | beslutning |
|---|---|---|
| besked-levering (Discord/mail) | `@broberg/mail` er allerede i brug til mail-kanalen | **genbrugt** — ingen ændring |
| alarm-/regel-motor | intet i `@broberg/*` | **findes her** — `incidents/alerts.ts` er vores egen kerne, ikke en kandidat til at flytte |
| webpush som ekstra kanal | `@broberg/webpush` 0.5.0, ikke adopteret her | **ikke nu** — en ny KANAL er en anden beslutning end en manglende REGEL; blandes de, løser vi ingen af dem |

## Beslutningen der IKKE er min

Skal alle 17 begynde at ringe til Christians Discord? Det ændrer hvad der lander
på hans telefon, og det er hans kald. Tre muligheder:

1. **Alle 17 på én gang.** Fuld dækning straks; risiko for et pludseligt
   støj-spring fra projekter der har været tavse.
2. **De vigtigste først** (bid, components, helpdesk, fd-sundhed, storeform).
   Mindre støj, men de øvrige 12 bliver ved med at være tavse — og en delvis
   dækning der ligner fuld er sin egen fejlklasse.
3. **Alle 17, men kun `high`+`critical`** til at starte med. Mit forslag: det
   dækker nedetid og lader støjen fra `medium` vente til vi har set mængden.

Intet bygges før han har svaret.

## Stories

- **F033.1** — hvert projekt får en alarm ved optagelse, og de 17 får én med tilbagevirkende kraft
- **F033.2** — en alarm på FRAVÆRET af overvågning (broberg-ids forslag)

## Non-goals

- Ingen ny kanal (webpush, SMS). Det er en anden beslutning.
- Ingen selvbetjenings-rute til at konfigurere modtagere endnu. broberg-id målte
  ti 404'er og konkluderede rimeligt at fladen ikke fandtes; den mangler, men
  den er ikke dét der gør flåden tavs i dag.

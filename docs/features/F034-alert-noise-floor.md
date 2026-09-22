# F034 — Alarmer skal være blodrøde

**Status:** i gang · **Ejer-rapporteret defekt** · 22. september 2026

## Hvad der er galt

Christian får nu løbende alarm-mails om ting der ikke kan handles på:

```
MEDIUM incident on Trail
Error spike — 14 errors in window
kind: error_spike
```

Hans ord, i rækkefølge: «Det orker jeg altså ikke at se på» · «Stop med mails helt» ·
«Og find et niveau på Discord der er passende. Jeg vil have blod røde alerts ikke
ubetydelige warnings».

**Det er vores egen regning fra F033.** Indtil 20/9 havde 15 af 24 projekter slet ingen
alarm-regel, så de larmede ikke. F033 gav alle 24 en regel med `kind='*'` og satte
`FLEET_ALERT_EMAIL=cb@webhouse.dk` som fælles modtager. Mail-benet blev dengang
rapporteret som «konfigureret og uprøvet». Det er nu prøvet: det virker, og det leverer støj.

## Mekanismen, målt i koden

| led | hvad koden gør | fil |
|---|---|---|
| tærskel | `error_spike` rejses ved **≥10 fejl-events på 5 minutter** | `config.ts:102-103` |
| severity | `medium`, og først `high` ved 3× tærsklen (≥30) | `incidents/correlation.ts:86` |
| regel | F033's standardrække er `kind='*'` → matcher **enhver** incident-art | `incidents/alerts.ts:92` |
| modtager | projektets egen adresse, ellers `FLEET_ALERT_EMAIL` → alle 24 lander hos ham | `incidents/alerts.ts:135` |
| gentagelse | dedup nøgler på **incident-id**, ikke på art | `incidents/alerts.ts:99-115` |

Det sidste led er det der gør det til en strøm frem for en enkelt mail: falder fejltallet
under 10, lukkes incidenten (`resolveOpen`); krydser det 10 igen, åbnes en **ny** incident
med et **nyt id**. Dedup-vinduet på en time ser et nyt id og tier ikke. Et projekt der
vipper omkring tærsklen sender derfor en mail pr. vip.

Præcedensen står allerede i vores egen kode: `incidents/cardmem-push.ts:12-14` og
`incidents/relay.ts:15-16` beskriver hvordan en reload-storm i juni gav **993 distinkte
error_spike-incidents → ~4200 kort** i cardmems Inbox, og konklusionen dengang var at
auto-udledte spikes er for støjende til en varig flade. En indbakke er en varig flade.
Vurderingen fandtes; den var bare ikke anvendt på mail.

## Hvad vi gør

To spærrer, begge i leveringsleddet — ikke i detektionen. Incidents skal blive ved med at
blive rejst og stå i dashboardet; det er **leveringen** der skal være blodrød.

1. **Mail slukkes helt.** `ALERT_EMAIL_ENABLED` (default `false`). E-mail-kanalen frafiltreres
   før levering. Discord bærer alarmen for alle 24 projekter, så F033's dækning holder.
2. **Severity-gulv.** `ALERT_MIN_SEVERITY` (default `high`). En `low`/`medium` incident
   leveres ikke på nogen kanal. 14 fejl på 5 minutter er `medium` → tavs. 30+ er `high` → den ringer.

**Login-mails er urørte.** Der findes præcis to `mailer.send`-kaldesteder i serveren
(`auth/email.ts:8` og `incidents/alerts.ts:161`); kun det sidste rører alarmer.

## Konsekvens vi selv skal sige højt

Et projekt hvis eneste kanal er e-mail leverer nu ingenting. Alle 24 har i dag
`["email","discord"]`, så ingen står uden — men dæknings-vagten (F033.2) tæller
**aktiverede regler**, ikke leveringsdygtige kanaler, så den vil ikke opdage det hvis nogen
senere fjerner Discord. Det er en kendt, ikke-lukket kant, og den hører til et eget kort
frem for en linje skrevet i forbifarten her.

## Afvist

- **Hæve `ERROR_SPIKE_THRESHOLD` fra 10 til fx 50.** Udskyder den samme mail i stedet for at
  afgøre hvad der fortjener en. Et projekt med meget trafik vipper bare om tærsklen længere oppe.
- **Slå `error_spike` fra som art.** For groft: 300 fejl på 5 minutter ER en alarm. Det er
  niveauet der mangler, ikke arten.
- **Kun fjerne `error_spike` fra mail.** Hans ord var «stop med mails helt», ikke «stop med
  spike-mails». En halv efterlevelse af en ordre er den slags der koster en runde mere.
- **Flippe `FLEET_ALERT_EMAIL` til tom i Fly-secrets.** Hurtigst, men et env-flip kræver hans
  egne ord om netop dét, det er usynligt i koden, og denne checkout har intet Fly-login.
  En kodeændring med en port er både reversibel og synlig.
- **Nøgle dedup på ART frem for incident-id.** Ville dæmpe vippen, men skjuler også en ægte
  ny hændelse bag en gammel. Gulvet løser hans problem uden at gøre dedup mindre ærlig.

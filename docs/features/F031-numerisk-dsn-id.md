# F031 — et numerisk projekt-id i DSN'en

> Målt af `voice-engine` 15. september 2026. De foreslog selv at springe en
> Python-SDK over, målte deres eget førslag, og fandt at det ikke holdt.

## Fundet

```
sentry_sdk.utils.BadDsn: Invalid project in DSN ('voice-engine')
  transport.py -> Dsn(options["dsn"]) -> utils.py:347
```

Sentrys egen DSN-parser kræver at projekt-delen i stien er et **heltal**. Vores
er en slug.

Så *«same Sentry-envelope contract»* er **rigtigt om kroppen og forkert om
adressen**. Kontrakten holder fra og med envelopen; det er DSN-formen der ikke
passer. Og den fejler **højlydt ved opstart** frem for tavst ved afsendelse —
havde den fejlet stille, var fejl landet i et sort hul i månedsvis.

## Hvad der ALLEREDE virker, målt

Den rå envelope går igennem. voice-engine beviste det i begge retninger:

```
POST https://upmetrics.org/api/voice-engine/envelope/
  X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<public>
-> 200 {"accepted":1,"dropped":0}

GET /api/issues (uk_)   <- en ANDEN vej ind
-> RuntimeError: bevidst probe … voice-engine-probe-263be1e49978
   culprit <module> (probe.py) · level error · event_count 1
```

Markøren var et engangs-uuid, så en gammel række ikke kunne få en brudt
indsendelse til at se grøn ud.

**Og målt hos os efter deres melding:** `ingest/routes.ts:88` dropper ukendte
envelope-typer (`!STORED.has(item.type)` -> `dropped++`) frem for at fejle. Så
sentry-sdk's `session`, `transaction` og `client_report` bliver talt som dropped
og ignoreret — og svaret siger det ærligt i `{"accepted":N,"dropped":M}`. **Der
er intet andet der spærrer end DSN-formen.**

## Løsning

Hvert projekt får et **numerisk alias** ved siden af sin slug, og
envelope-ruten accepterer begge i stien. Den nuværende slug-form bliver ved med
at virke uændret — intet eksisterende repo skal røre noget.

**Sluggen slås op FØRST.** Et projekt hvis slug tilfældigvis er numerisk må
aldrig kunne kapre et andet projekts alias, og den rækkefølge bevarer al
eksisterende adfærd som den er.

## Non-goals

**En Python-SDK.** Det er hele pointen: vi bygger ikke et bibliotek, vi gør det
eksisterende brugbart. `sentry-sdk` er vedligeholdt af andre, bredt brugt, og
følger med økosystemet uden at koste os noget.

**At understøtte sessions/transactions.** De droppes i dag, ansvarligt og
synligt. Upmetrics er fejl- og incident-sporing, ikke APM.

## Reuse

Dette ER reuse-reglen anvendt på os selv: i stedet for at skrive en
klient-pakke, tilpasser vi vores adresse så flokkens eksisterende klient passer.
Alternativet — ~25 linjer rå envelope-kode kopieret ind i hver Python-tjeneste —
er præcis den drift reglen findes for at forhindre.

## Harness

Den negative kontrol er den bærende: **et ukendt numerisk id må svare 404, ikke
ramme et tilfældigt projekt.** Uden den kan «alias virker» ikke skelnes fra
«ruten tager imod hvad som helst», og det sidste ville lade ét repos fejl lande
på et andets board — samme skade helpdesk netop har målt fra den anden side.

Og sluggen skal stadig virke, prøvet i samme runde. En ny vej ind må ikke lukke
den gamle.

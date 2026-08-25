# F026 — En alarm må ikke overleve det den handler om

> **Status:** foreslået 2026-08-25 · rejst af **cms** med måling

## Motivation

cms' egen formulering, og den er hele begrundelsen:

> *«En alarm der overlever den release den handler om, bliver til baggrundsstøj på Christians telefon, og så er den næste ægte alarm den han scroller forbi.»*

Det er ikke en skønhedsfejl. En alarm der bliver ved med at fyre om noget der er overstået, nedbryder aktivt værdien af alle de andre alarmer i samme kanal. Vi har set nøjagtig samme skade den anden vej rundt i F025.1, hvor en ØVELSES-alarm blev læst som en nødsituation.

## Målt, ikke formodet

**Den konkrete hændelse:** `webhouse.app deploy regressed (8df7071)` har fyret hver time siden 16:33 og peger stadig på en release der blev afløst kl. 10:31. Maskinen kører 602 (`49aad9b`), 1/1 checks passing, `/admin/login` og `/` svarer 200 på ~0,2s.

**Hvorfor den aldrig lukker** — `apps/server/src/incidents/correlation.ts:188`:

```ts
function resolveOpen(db, projectId, kind: 'error_spike' | 'agent_failure_spike', now) { … }
```

Auto-resolve findes, men kun for to slags. `deploy_regression` står ikke på listen. Den åbnes idempotent pr. deploy (`deploys/regression.ts:124`) og bliver stående til et menneske lukker den.

**Og det repo alarmen handler om kan ikke lukke den selv.** Self-service-API'et (`GET /api/issues`, `POST /api/issues/:id/resolve`, `resolve-all`) dækker **kun issues**. En incident har ingen tilsvarende rute.

**De kan heller ikke se hvad fejlen ER.** `GET /api/issues/:id` og `/api/issues/:id/events` findes ikke. cms kunne se at der var en fejl, og måtte bede os hente event-detaljerne manuelt ud af prod-databasen.

## Den fælles form

**Self-service-kontrakten er halvt bygget.** CLAUDE.md gør det til en UFRAVIGELIG regel at hvert repo lukker sine egne fejl — men vi har givet dem adgang til den ene halvdel af signalet og beholdt den anden.

**Ansvar uden adgang bliver til støj hos ejeren.** Det er den generelle version, og den er værd at holde fast i når vi bygger næste selvbetjenings-flade.

## Scope

1. **`deploy_regression` auto-resolver når en NYERE release er sund** (F026.1).
2. **Self-service på incidents** — list + resolve med projektets `uk_` (F026.2).
3. **Læse-siden af self-service** — `GET /api/issues/:id` + `/events`, så et repo kan se sin egen stack uden at spørge os (F026.3).

## Non-goals

- **Ikke auto-rollback.** `deploys/regression.ts:5` siger det eksplicit: OBSERVE/REPORT only. Det står ved magt.
- **Ikke fingerprint-kollapset.** Stakløse fejl deler nøglen `Type|` og lander i ét issue (beacons fund, idé `019fd783`). Ægte og beslægtet, men en anden fejl — og den skal ikke gemme sig inde i dette kort.
- **Ikke at slukke for deploy_regression.** Alarmen er rigtig; det er dens levetid der er forkert.

## Designnote — hvad "sund igen" betyder

Fristelsen er at lukke incidenten når *en* nyere deploy dukker op. Det er forkert: en ny deploy kan være lige så syg. Betingelsen skal være at en **nyere release har fået sin egen `ok`-dom** af den eksisterende regressions-evaluering — altså samme måling, ikke en antagelse om at tid læger.

Og lukningen skal kunne **skelnes** fra en menneskelig lukning når man kigger bagud. "Lukket fordi 602 blev målt sund" og "lukket fordi nogen trykkede" er to forskellige historier, og den første er den der beviser at mekanikken virker.

## Harness (obligatorisk — load-bearing)

Alarm-levetid er load-bearing: fejler den, forsvinder tilliden til hele kanalen, og det opdages ikke af en test men af at ejeren holder op med at kigge.

- **RØD test:** åbn en `deploy_regression`, registrer en nyere release med `ok`-dom, kør ticket → incidenten er `resolved`. Mutations-bevist: fjern den nye gren → testen skal gå rød.
- **Negativ kontrol i samme runde:** en nyere release der også er `regressed` må **ikke** lukke den gamle. Uden den kan "lukker korrekt" ikke skelnes fra "lukker altid".
- **Self-service-testen skal læse tilbage:** resolve via `uk_` → hent listen igen → incidenten er væk fra de åbne. Aldrig kun at ruten svarede 200.

## Reuse

Discovery-tjek 2026-08-25 for "incident", "alert lifecycle", "self-service api": ingen `@broberg/*`-pakke ejer incident-livscyklus. `@broberg/apikey` (0.3.1) er allerede den kanoniske nøgle-middleware og bør bruges til `uk_`-gaten på de nye ruter frem for endnu en håndrullet tjek — dette repo har den ikke adopteret endnu, så F026.2 er den naturlige anledning.

## Kilde

cms via intercom #22391, besvaret i #22393. Alle kodehenvisninger målt i vores eget repo samme dag.

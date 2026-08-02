# F025 — Data-retention + disk-guard

**Status:** planned · **Prioritet:** critical · **Oprettet:** 2026-08-02 (af buddy-sessionen efter incident)

## Motivation — det faktiske nedbrud

Upmetrics skrev sin egen disk fuld og tog dermed hele flådens fejlovervågning ned i tre døgn.

**Målt 2026-08-02 08:00 (`fly ssh -a upmetrics`):**

```
/dev/vdc  974M size · 958M used · 0 avail · 100% /data
upmetrics.db      742M   (sidst skrevet 30. jul 09:15)
upmetrics.db-wal  216M   (stadig skrevet 2. aug 08:00)
upmetrics.db-shm  448K
```

**Symptom udadtil:** alle 13 `upmetrics-probe`-cronjobs fejlede hvert 5. minut. Reproduceret direkte:

```
GET /api/probes/113b4566-.../run
→ 500 {"error":"internal_error","message":"database or disk is full"}
```

Det var altså ikke 13 overvågede sites der var nede — det var vores egen skrive-sti der fejlede. Probe'n der overvåger `upmetrics.org` selv fejlede også, hvilket er den tydeligste indikator på at fejlen var intern.

**Konsekvens:** cronjobs.webhouse.net sendte en `❌ Job Failed`-Discord-alarm pr. fejlet kørsel — ca. 148 i timen, ~10.500 over tre døgn — mens ingen fejl fra noget repo blev registreret. Upmetrics var både blind og larmende på én gang.

## Deadlock'et der gør at det ikke løser sig selv

SQLite kan ikke checkpointe WAL'en tilbage i hoved-databasen uden fri plads, og kan heller ikke slette rækker uden fri plads (en `DELETE` skriver først til WAL'en). Når disken rammer 0 avail, er databasen derfor låst i en tilstand hvor den hverken kan rydde op eller skrive videre. Signaturen ses tydeligt i tidsstemplerne ovenfor: hoved-db-filen er ikke ændret siden 30. juli, mens WAL'en er skrevet så sent som i dag.

**Læren: en disk-guard skal gribe ind LÆNGE før 100%, fordi der ved 100% ikke længere findes en billig vej ud.**

## Akut afhjælpning (allerede udført)

- Volumen `vol_re1nd51pwd21jqd4` udvidet **1 GB → 3 GB** (2026-08-02, på Christians direkte ordre). Online, uden restart.
- Efter udvidelse: `3.0G size · 1.4G used · 1.5G avail · 49%`.
- Probe-endpoint verificeret rask igen: `200 {"ok":true,"status_code":200,"response_ms":38}`.
- De 13 probe-jobs blev pauset under nedbruddet for at stoppe alarm-flodet, og er tændt igen efter verifikationen (verificeret: 13 tændt, 0 pausede).

Det er plaster, ikke behandling. 742 MB er akkumuleret uden nogen form for oprydning; mere disk udskyder blot næste nedbrud.

## Scope

1. **Retention-politik pr. datatype.** Fastlæg og håndhæv hvor længe hver slags data lever. Kandidater (skal verificeres mod faktisk tabelstørrelse først):
   - probe-resultater / uptime-checks — den store synder: 13 probes × 12 kørsler/time × måneder
   - events/fejl-forekomster bag issues
   - AI-cost-telemetri
   - deploy- og heartbeat-historik
2. **Automatisk pruning-job.** Kører periodisk, sletter forfaldne rækker, og kører `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM` (eller `incremental_vacuum` hvis auto_vacuum er slået til) så pladsen faktisk frigives til filsystemet — en `DELETE` alene krymper ikke filen.
3. **Disk-guard med alarm.** Overvåg `/data`-forbrug og alarmér ved en tærskel der efterlader manøvrerum (forslag: advarsel ved 70%, kritisk ved 85%). Alarmen må IKKE gå gennem den database der er ved at løbe fuld — den skal kunne sende selvom skrivning fejler.
4. **Aggregering frem for rå opbevaring.** Probe-resultater ældre end N dage bør foldes til timevise/daglige opsummeringer i stedet for at blive slettet, så oppetids-historikken bevares uden at fylde.

## Non-goals

- Skift væk fra SQLite. Databasen er ikke problemet; manglende oprydning er.
- Ændring af probe-frekvensen (*/5) — den er et bevidst valg.
- Ændring af hvordan cronjobs.webhouse.net alarmerer. Den opførte sig korrekt: jobs fejlede reelt.

## Afhængigheder

- Fly-volumen `vol_re1nd51pwd21jqd4` (app `upmetrics`, region arn), nu 3 GB.
- cronjobs.webhouse.net driver de 13 probe-jobs. Ændres probe-skemaet, skal jobbene følge med.

## Reuse

Tjekket mod Discovery (`discovery.broberg.ai/api/search`) inden planen blev skrevet: der findes ingen delt `@broberg/*`-pakke til retention/pruning eller disk-guard. Bygges lokalt i dette repo.

**Men disk-guard er et generisk flåde-behov** — cardmem, trail og buddy har alle voksende SQLite-lagre på Fly-volumener med præcis samme fejlmulighed. Når mønsteret er bevist her, bør det rejses over for `components` som kandidat til en delt primitiv, i stedet for at hvert repo genopfinder det (og opdager manglen på samme dyre måde).

## Rollout

1. Mål først: opgør faktisk rækketal + bytes pr. tabel, så retention-vinduerne bygger på tal og ikke på gæt.
2. Disk-guard + alarm FØRST (billigst, og fanger næste hændelse uanset om pruningen er færdig).
3. Pruning-job ship-dark bag et env-flag; kør én gang manuelt og mål den frigjorte plads før det sættes på skema.
4. Verificér: `df -h /data` skal falde målbart, og probe-endpointet skal fortsat svare 200.

## Harness (obligatorisk — dette er en load-bearing kæde)

Skrive-stien til upmetrics ER load-bearing: når den fejler, er hele flåden blind. Per harness-kontrakten skal den forsegles begge veje:

- **RØD test i CI:** en test der fejler hvis pruning-jobbet ikke frigiver plads, eller hvis disk-guarden ikke fyrer over tærsklen. Skal blokere deploy.
- **Runtime-probe:** disk-guarden er selv probén — men den skal kunne alarmere UDEN at skrive til den database den overvåger. Ellers fejler den præcis når den behøves.

## Kilde

Diagnosticeret af buddy-sessionen 2026-08-02 efter Christian rapporterede vedvarende alarmer. Fuld rå-måling i intercom til upmetrics samme dag.

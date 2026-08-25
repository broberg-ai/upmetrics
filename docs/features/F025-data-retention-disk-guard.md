# F025 — Data-retention + disk-guard

**Status:** planned · **Prioritet:** critical · **Oprettet:** 2026-08-02 (af buddy-sessionen efter incident)
**Revideret:** 2026-08-02 af upmetrics-sessionen — root cause målt og **korrigeret**, se nedenfor.

## Motivation — det faktiske nedbrud

Upmetrics skrev sin egen disk fuld og tog dermed hele flådens fejlovervågning ned i tre døgn.

**Målt 2026-08-02 08:00 (`fly ssh -a upmetrics`):**

```
/dev/vdc  974M size · 958M used · 0 avail · 100% /data
upmetrics.db      742M   (sidst skrevet 30. jul 09:15)
upmetrics.db-wal  216M   (stadig skrevet 2. aug 08:00)
```

**Symptom udadtil:** alle 13 `upmetrics-probe`-cronjobs fejlede hvert 5. minut — `500 {"error":"internal_error","message":"database or disk is full"}`. Det var ikke 13 overvågede sites der var nede; det var vores egen skrive-sti. Probe'n der overvåger `upmetrics.org` selv fejlede også.

**Konsekvens:** ~148 falske `❌ Job Failed`-alarmer i timen, ~10.500 over tre døgn, mens ingen fejl fra noget repo blev registreret. Upmetrics var både blind og larmende på én gang.

## ⚠️ Root cause — KORRIGERET

> Den oprindelige udgave af denne plan antog *"742 MB akkumuleret uden nogen form for oprydning"* og gjorde pruning til hovedfixet. **Den præmis er målt forkert.** Pruning alene ville hverken have forhindret nedbruddet eller forhindre gentagelse. Rettet her, så fixet rammer den rigtige mekanisme.

### Retention KØRTE — og holdt

| Måling (2026-08-02) | Værdi | Betyder |
|---|---|---|
| `events` tidsspænd | 2026-06-29 → 08-02 = **34 dage** | mod et 30-dages vindue → retention kører |
| `freelist_count` | 5.059 sider = **20 MB** | næsten ingen død plads at vinde |
| Levende data | **721 MB** af 741 MB | dataene er reelt i brug, ikke slam |

En `VACUUM` ville have givet 20 MB tilbage — ikke 700. Der var intet ophobet affald.

### Det der FAKTISK skete: et checkpoint-deadlock

1. **2026-06-02** satte vi `PRAGMA wal_autocheckpoint = 0` (`apps/server/src/db/index.ts`) for at stoppe event-loop-freeze fra inline checkpoints (se ADR 0001). Dermed blev **Litestream den eneste checkpointer**.
2. Litestream checkpointer ved først at kopiere WAL'en til en **shadow-WAL på samme volumen**. Den skal altså bruge fri plads for at kunne frigøre plads.
3. Steady-state DB ≈ 740 MB på en 1 GB volumen = kun ~250 MB luft.
4. WAL'en voksede ind i den luft → `/data` 100 %.
5. **Deadlock:** disk fuld → Litestream kan ikke skrive shadow-WAL → kan ikke checkpointe → WAL kan ikke krympe → disken forbliver fuld. SQLite kan samtidig hverken checkpointe eller slette (en `DELETE` skriver først til WAL'en). **Ingen selvhelbredelse mulig — kun manuel infra.**

**Log-beviset (samme maskine):**

```
08:05:58 ERROR sync error ... cannot copy to shadow wal:
         write /data/.upmetrics.db-litestream/.../000095c6.wal.tmp: no space left on device
08:06:25 INFO  wal segment written ... elapsed=5.03s sz=226323960   ← 226 MB skyllet
                                                                      straks efter extend
```

Litestream kom sig i samme sekund pladsen kom, og faldt tilbage til normale 4 KB–325 KB segmenter.

**Læren, præcist formuleret:** 2026-06-02-fixet fjernede event-loop-stallet, men efterlod WAL'en **ubegrænset** og satte sin lid til at en ekstern proces (Litestream) altid ville kunne checkpointe. Den antagelse holder ikke, når checkpointing selv kræver den ressource der er ved at slippe op. Og en guard skal gribe ind **længe før 100 %**, fordi der ved 100 % ikke længere findes en billig vej ud.

## Akut afhjælpning (allerede udført)

- Volumen `vol_re1nd51pwd21jqd4` udvidet **1 GB → 3 GB** (2026-08-02, på Christians direkte ordre). Online, uden restart.
- **Verificeret rask 2026-08-02:** `/data` 3.0G · 958M brugt · 1.9G fri · **34 %**; 13/13 probes `status='up'` med `consecutive_failures=0`; 13 nye `probe_results` skrevet den seneste time; `/health` 200 med event-loop-lag 2 ms.

Det er plaster, ikke behandling: mere disk udskyder blot det næste deadlock.

## Hvad der driver størrelsen (målt, til kapacitetsvalg)

| Post | Måling | Andel |
|---|---|---|
| `events.payload` | **573,8 MB** | 77 % af hele basen |
| `events` rækker | 181.004 | — |
| heraf projekt **buddy** | **165.264** | **91 %** |
| gennemsnitlig payload | ~3,2 KB/event | — |
| `probe_results` | 44.088 rækker, ~1,5 MB nøgler | lille |
| `agent_runs` | 30.013 rækker | lille |

Probe-resultater var altså **ikke** hovedmistænkte, som først antaget. Ét enkelt projekts ingest sætter reelt vores steady-state størrelse.

## Scope

1. **WAL-sikkerhedsventil (F025.3) — lukker den ægte årsag.** Baggrunds-worker måler WAL-størrelse; over et loft tages ét `wal_checkpoint(TRUNCATE)`. Aldrig inline i en request-sti (det ville genindføre 2026-06-02-freezen).
2. **Disk-guard med alarm (F025.1).** Overvåg `/data` og alarmér ved 70 % / 85 %. Alarmen må **ikke** gå gennem den database der er ved at løbe fuld — den skal virke selvom skrivning fejler.
3. **Retention + reel pladsfrigivelse (F025.2).** Retention skal køre ved boot (ikke først efter 24 t), og prune skal følges af checkpoint + vacuum, ellers falder `df` ikke.
4. **Kapacitets-invariant.** Volumen-headroom som eksplicit, overvåget krav — ikke tilfældighed.

## Non-goals

- Skift væk fra SQLite. Databasen er ikke problemet.
- Ændring af probe-frekvensen (*/5) — bevidst valg.
- Ændring af hvordan cronjobs.webhouse.net alarmerer. Den opførte sig korrekt: jobbene fejlede reelt.
- At fjerne `wal_autocheckpoint = 0`. Den står ved magt; ventilen supplerer den.

## Afhængigheder

- Fly-volumen `vol_re1nd51pwd21jqd4` (app `upmetrics`, arn), nu 3 GB.
- Litestream 0.3.13 replikerer til Tigris (`sync-interval: 1s`, ingen eksplicitte checkpoint-grænser sat).
- cronjobs.webhouse.net driver de 13 probe-jobs.

## Reuse

Tjekket mod Discovery inden planen: ingen delt `@broberg/*`-pakke til retention/pruning eller disk-guard. Bygges lokalt.

**Men mønsteret er generisk:** cardmem, trail og buddy kører alle voksende SQLite-lagre på Fly-volumener — og flere af dem bruger samme Litestream-opsætning. **WAL-deadlock'et kan ramme dem præcis som det ramte os.** Når ventilen er bevist her, rejses den for `components` som kandidat til en delt primitiv, og de berørte repos advares direkte.

## Rollout

1. WAL-ventil + disk-guard FØRST — de forhindrer gentagelse uanset retention.
2. Retention-tuning derefter, som kapacitetsarbejde, på de målte tal ovenfor.
3. Verificér: `df -h /data` og WAL-størrelse skal være målbart stabile over tid, og probe-endpointet skal fortsat svare 200.

## Harness (obligatorisk — load-bearing kæde)

Skrive-stien til upmetrics ER load-bearing: fejler den, er hele flåden blind.

- **RØD test i CI:** fejler hvis WAL-ventilen ikke fyrer over sit loft, eller hvis disk-guarden ikke fyrer over tærsklen. Skal blokere deploy.
- **Runtime-probe:** disk-guarden er selv probén — men skal kunne alarmere UDEN at skrive til den database den overvåger, ellers fejler den præcis når den behøves.

## Oprydningen vidste ikke om den virkede (tilføjet 2026-08-25)

Målt 2026-08-25: `.changes` blev læst **nul steder** i hele serveren. Værre end
det — de tal retention loggede kom fra den SELECT der udvalgte rækkerne, ikke
fra den DELETE der skulle fjerne dem:

| Sted | Talte | Skulle have talt |
|---|---|---|
| `batchedDelete` | `ids.length` (udvælgelsen) | slettede rækker |
| `capProjectEvents` | `ids.length` | slettede rækker |
| `compactProbeResults` | `deleteIds.length` | slettede rækker |

Konsekvensen er ikke et upræcist tal. En sletning der holdt op med at virke
ville logge et **selvsikkert** "1000 slettet" mens disken voksede — og
`batchedDelete` ville genudvælge de samme rækker i en uendelig løkke. På en
synkron driver er det ikke et langsomt job, det er en frossen server.

Samme fejlform fandt buddy hos sig selv samme dag (deres gc talte også fra
udvælgelsen). Formen på hjælperen er deres: svaret er `number | null`, **aldrig
et gæt på 0 eller 1** — et gættet 0 ville få oprydningen til at melde "intet at
gøre" i al evighed, hvilket er præcis den fejl kontrollen findes for.

Bevist mod en ÆGTE database, ikke en attrap: en `BEFORE DELETE`-trigger med
`RAISE(IGNORE)` giver en tavs sletning uden fejl — samme form som den ægte
svigt. Negativ kontrol begge veje: en sund kørsel må ikke rejse en anmærkning,
og en tom database må heller ikke. `.run()` er TYPET `void` af driveren men
returnerer et RunResult, så korrektheden hviler på udokumenteret runtime-adfærd
— derfor har `db/changes.test.ts` sin egen prøve, så en drizzle-opgradering der
ændrer formen bliver RØD i stedet for at returnere `null` for evigt.

En ubekræftet sletning logges som fejl **også på en ellers tavs kørsel** (den
tavshed ER symptomet) og sendes til vores eget fejl-board via `captureSelf` —
en log-linje på én maskine er ikke noget nogen læser før disken er fuld. Det tog
tre døgn sidste gang.

## Kilde

Første anmeldelse + rå måling: buddy-sessionen 2026-08-02 (intercom #18429) efter Christian rapporterede vedvarende alarmer. Root cause målt, korrigeret og log-verificeret af upmetrics-sessionen samme dag (intercom #18430).

# F029 — et telemetri-kald der fejler er tavst og endeligt

> Christians ordre 8. september 2026: **«ja byg retry»**.

## Motivation

Trail vendte sagen om, og deres formulering er hele begrundelsen:

> *et tal der mangler, ser ud som et tal der ikke skulle være der.*

Vi brugte dagen på at frygte **dobbelt-tælling** (F028.2 — dubletnøglen der
ankom og aldrig blev læst). Den risiko der kan påvises er den modsatte: vi
tæller **for lidt**, og vi kan ikke se hvor meget.

## Målt 8. september 2026, i begge afsendere

| Afsender | Adfærd ved fejl | Ejer |
|---|---|---|
| `@broberg/ai-sdk` 0.38.0, cost-sink | ét `doFetch`, ingen retry, ingen backoff; `onError`-hook | components |
| `@upmetrics/sdk` 0.4.1 (`src/index.ts:279`) | `void fetch(…).catch(() => {})` — **ingen retry, ingen tæller, `res.ok` læses aldrig** | **os** |

**Vores egen er den værste, og det er hele pointen.** Den bærer fejl-events for
hele flåden, og den fejler præcis når upmetrics er nede eller langsom. Altså er
de events vi taber nøjagtig dem fra det vindue hvor der var noget galt.
Fejlovervågningen er blind i sit eget nedbrud — og vi har haft præcis det
(30/7–2/8, `/data` 100 % fuld, tre døgn).

At `res.ok` aldrig læses er sin egen fejl: et **500 fra os** og en vellykket
levering giver samme resultat hos afsenderen. Ingen af delene kaster.

## Hvorfor kortet kan bygges NU og ikke før

Retry uden idempotens bytter *«vi taber målinger»* for *«vi tæller dobbelt»*.
Det er ikke en forbedring. Begge ender er først på plads i dag:

- **Fejl-events:** `events.id` **er** afsenderens `event_id`, primærnøgle, og
  insertet er `.onConflictDoNothing()` (`ingest/routes.ts:103-116`). En
  genleveret fejl kan ikke blive til to. Det har været sandt hele tiden — det
  er efterprøvet, ikke antaget.
- **Omkostninger:** `agent_runs` dedupliker nu på `tags.idempotencyKey`
  (F028.2, live samme dag).

## Scope

**F029.1 (vores):** retry + tabstæller i `@upmetrics/sdk`.

**Non-goal, og det er en beslutning:** retry i `@broberg/ai-sdk`'s cost-sink.
Den ejes af `components` og skal bygges **ét sted for hele flåden**, ikke lappes
lokalt (reuse-reglen: *exténd it, never work around it*). Sendes til dem som en
udvidelse, med målingen.

**Non-goal:** en kø der overlever en genstart (disk/`localStorage`). En tabel
til et tal der forhåbentlig er nul er arbejde før målingen siger at det er
nødvendigt — trails egen afvejning, og den er rigtig her også. Tælleren
kommer først; holdbarhed hvis tallet ikke er nul.

## Design

En telemetri-klient må **aldrig** blive det der vælter værts-appen. Det binder
hver eneste beslutning:

1. **Loftet er ikke til forhandling.** Køen er lille og fast. Løber den fuld,
   smides den ÆLDSTE ud og tælles som tabt. En ubegrænset kø i en proces der
   ikke kan nå sin server er en hukommelseslækage der venter på et udfald.
2. **Få forsøg, voksende pause.** Nok til at overleve en genstart eller et
   netværkshik, ikke nok til at hamre en server der allerede har det skævt.
3. **`res.ok` læses.** En 4xx er afsenderens egen fejl og må **ikke** gen-sendes
   — den vil fejle igen for evigt. Kun netværksfejl og 5xx prøves igen.
4. **Opgiver den, tæller den.** `lostEvents` er hele forskellen på «vi tabte
   ingenting» og «vi ved ikke om vi tabte noget».
5. **Intet kastes nogensinde ind i værts-appen.**

## Reuse

Discovery-tjek 8. september 2026 (`discovery.broberg.ai/api/search?q=retry backoff
queue delivery`):

| Kapabilitet | Fandtes? | Beslutning |
|---|---|---|
| Generel HTTP-retry / afleveringskø | **Nej** — flåden har ingen delt transport-primitiv | **Byg lokalt.** Retry ligger indlejret i domænepakker (`@broberg/sms`, `@broberg/chat`), ikke som noget der kan importeres. |
| Klassificering retryable vs permanent | **Ja, som MØNSTER** — `@broberg/sms` 0.10.0 | **Lånt.** Koden kan ikke genbruges (SMS-specifik), reglen kan. |

**Og tjekket fandt en ægte fejl frem for at bekræfte os.** `@broberg/sms` skelner
retryable (**429**, 5xx) fra permanent (400/401/403/404/422). Vores første udgave
sagde `status >= 500` — altså **ingen gensendelse ved 429**.

Det er ikke akademisk: **vores egen ingest svarer 429** når et projekt rammer sit
rullende minut-loft (`guardIngest` → `ingest/routes.ts:76`). En 429 er midlertidig
per konstruktion — vinduet ruller — og den udløses under en byge, altså præcis når
begivenhederne betyder noget. Vi ville have kasseret netop den flod vi forsøgte at
fange. Rettet i 0.5.1; 408 (transport-timeout) kom med af samme grund.

**Værd at holde fast i:** fejlen blev fundet af genbrugs-tjekket, ikke af en prøve.
Prøverne var grønne, fordi de afprøvede den regel jeg selv havde skrevet.

**Gap meldt til `components`:** flåden mangler en delt retry/transport-primitiv.
Cost-sinken i `@broberg/ai-sdk` har samme problem og skal rettes ét sted for alle
— sendt til dem med målingen (#26600), ikke lappet lokalt.

## Harness

Problemet med at prøve en retry er at man let kommer til at prøve **sin egen
model** af den. Trail ramte præcis det i dag: deres første prøve byggede sin
egen sink med sin egen tæller og bestod, da de fjernede den ægte tæller.

Derfor: prøverne kører mod SDK'ets rigtige sende-sti med en indsprojtet
`fetch`, og **mutations-kravet er skrevet ind i acceptkravene** — fjernes
retry-løkken, skal prøverne gå røde.

Den negative kontrol der afgør det hele: **en 4xx må IKKE gen-sendes.** Uden
den kan «retry virker» ikke skelnes fra «retry prøver altid igen», og den
sidste er værre end ingen retry.

## Rollout

SDK-udgivelse sker **kun via CI** (tag `sdk-v*` → `publish-sdk.yml`, OIDC).
Aldrig lokal `npm publish`. Når versionen er ude, skal de forbrugende repoer
have besked om at bumpe — stående instruks.


---

# F029.2 — flush()

## Motivation, og den er vores egen fejl

fd-sundhed opgraderede til 0.5.0 og målte hvad vores udgivelse gjorde ved dem:

```
deres AFSENDELSES_FRIST_MS = 2_000
0.4.1  ét forsøg                       → 2 s var rigeligt
0.5.0  RETRY_DELAYS_MS = [1000, 5000]  → op til 6 s
```

**Vores retry gjorde deres konstant forkert.** Maskinen — en Fly-maskine der
suspenderer så snart cron-ruten har svaret — døde inden TREDJE forsøg, altså
netop det forsøg der findes til når vi er nede. Ingen prøve gik rød. Ingen linje
ændrede sig hos dem.

Det er sessionens gennemgående fejlform én gang til: **en ændring der gør en
eksisterende korrekt værdi forkert, tavst, i den grønne retning.**

## Hvorfor en lappeløsning ikke er nok

De hævede fristen til 6.500 ms og skrev en vagt der **læser** vores
`RETRY_DELAYS_MS` frem for at gentage tallet. Det er den rigtige lokale
rettelse — men den er en kobling til vores **private** konstanter, og den brød
ved allerførste retry-udgivelse. Uden `flush()` skal hver forbruger holde på et
magisk tal der matcher en tidsplan de ikke kan se.

## Design

`flush(timeoutMs)`:

1. **Springer resterende backoff over.** At vente 5 sekunder på en pause er
   meningsløst når processen er ved at lukke ned — en nedluknings-tømning skal
   forsøge NU. Det er samtidig dét der fjerner koblingen til `RETRY_DELAYS_MS`
   helt: fristen bliver forbrugerens eget valg om hvor længe de vil vente.
2. **Returnerer tre tal, ikke to:** `delivered`, `lost`, `pending`.
   `pending > 0` betyder *«fristen løb ud før vi blev færdige»* og må aldrig
   kunne forveksles med `lost` — det ene er **ukendt**, det andet er **opgivet**.
   Kollapses de, forsvinder netop den skelnen tælleren findes for.
3. **Kaster aldrig, og hænger aldrig.** En nedluknings-tømning der selv blokerer
   er værre end ingen.

## Den anden halvdel, som flush() også løser

`lostEvents()` nulstilles ved genstart. På en maskine der suspenderer mellem
cron-kørsler er tælleren derfor så godt som altid 0 — **ubrugelig præcis i den
driftsform**. Kan man AFVENTE tømningen, kan man læse tallet mens processen
stadig lever, og så betyder det noget.

## Harness

Prøven for backoff-overspringet bruger en scheduler der **aldrig fyrer**. Uden
overspringet hænger den — hvilket er nøjagtig det en døende proces oplever.

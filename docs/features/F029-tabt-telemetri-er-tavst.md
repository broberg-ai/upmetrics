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

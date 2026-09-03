# F028 — En manglende pris er ikke nul

**Status:** F028.1 bygget 2026-09-03, samme tur som kortet (F180.6 — ejeren fandt hullet og bestilte rettelsen).

## Motivation

Christian spurgte: *«Anvender du @broberg/ai-sdk/pricing til dine AI priser og kalkulationer?»*

Svaret var nej. Vi beregner ikke priser — vi modtager en færdig USD-pris fra ai-sdk's afsender, lægger dem sammen og omregner til kroner. Det er rigtigt så længe afsenderen sender en pris.

Spørgsmålet afdækkede hvad der sker når den ikke gør.

## Målt før noget blev bygget

Prod-databasen, 2026-09-03:

| | |
|---|---|
| `agent_runs` i alt | 36.048 |
| pris = 0 eller NULL | 289 (0,8 %) |
| **...og med tokens > 0** | **229** |
| samlet registreret forbrug | $246,17 |

De 229 er ikke gratis kald. Det er kald hvor afsenderen ikke sendte en pris, og hvor `cost_usd: finiteNum.default(0)` gjorde tavsheden til et nul.

Fordelt (de største):

```
buddy   mistral     mistral-small-latest    84 kald   in=112.542.231  out=3.831.672
buddy   mistral     mistral-large-latest    53 kald   in=2.511.155    out=356.594
cms     anthropic   claude-sonnet-4-2025…   34 kald   in=31.427       out=6.750
buddy   openrouter  deepseek-v4-…           34 kald   in=4.871.212    out=1.439.746
buddy   anthropic   unknown                 17 kald   in=2.161.575    out=81.379
cms     mistral     pixtral-large-latest     6 kald   in=7.950        out=754
```

**112 millioner input-tokens registreret til nul kroner** i den øverste række alene.

## Fejlformen

Den er husets gennemgående: **en manglende værdi degraderer tavst til et beroligende resultat.** «Dette kald var gratis» og «vi ved ikke hvad det kostede» er samme tal, og tallet peger den forkerte vej — regningen ser *mindre* ud end den er.

## Løsning (F028.1)

`resolveCost()` i `apps/server/src/cost/price.ts`, kaldt fra `metrics()` i `ingest/agent.ts` — det ene sted hvor både finish- og record-vejen samles.

**Satserne er flådens, ikke vores.** `@broberg/ai-sdk/pricing`. Vi holder ikke vores egen tabel: en anden kopi bliver forældet i stilhed, og hele pointen ved at være cost-sink er at tallet kan stoles på.

### Fire tilstande, ikke to

`0` har tre forskellige betydninger. Kun én af dem er «gratis».

| `tags.cost_source` | betyder |
|---|---|
| `reported` | afsenderen prissatte det — vi rørte intet |
| `computed` | afsenderen sendte 0, vi udledte prisen fra flådens liste |
| `unpriced` | ægte tokens, men prislisten kender ikke modellen. **0 OG mærket** |
| `untokened` | 0 tokens og 0 pris — der er intet at prissætte |

`unpriced` er den bærende. Uden den ville rettelsen bare have gjort løgnen smallere: 137 rækker bliver rigtige, og de 92 andre ville stadig stå som gratis uden at nogen kunne se det.

### Afsenderen vinder altid

En pris fra afsenderen overskrives aldrig. Den ved ting vi ikke kan: en forhandlet rate, en cache-rabat, et udbyder-tillæg.

## Dækning — målt, ikke antaget

Prislisten (snapshot 2026-08-27) slået op mod vores EGNE model-strenge:

```
mistral/mistral-small-latest    $0,10/M in  $0,30/M out   (curated)
mistral/mistral-large-latest    $0,50/M in  $1,50/M out   (curated)
claude-sonnet-4-20250514        UKENDT
openrouter/deepseek/deepseek-…  UKENDT
pixtral-large-latest            UKENDT
```

**137 af 229 rækker får en pris. 92 forbliver ukendte.** Rettelsen er altså delvis, og `unpriced` er den mekanisme der gør delvisheden læsbar frem for usynlig.

Intet er BAGUDRETTET rettet — de 229 eksisterende rækker står som de står. Nye kald prissættes fra udrulningen.

## Non-goals

- **Ingen bagudrettet omregning** af de 229 eksisterende rækker. En bulk-UPDATE af historiske omkostningstal er ejerens beslutning, ikke et sidespring i en rettelse.
- **Ingen self-service cost-rute.** cms bad 27/8 om at kunne bevise at prompt-caching virkede og kunne ikke — der findes intet endpoint. Ægte mangel, eget kort.
- **Ingen egen pris-tabel.** Mangler en model, hører den i `@broberg/ai-sdk/pricing`, ikke her.

## Reuse

| Kapabilitet | Fandtes? | Beslutning |
|---|---|---|
| Model-priser pr. token | **Ja** — `@broberg/ai-sdk/pricing` (0.36.7) | **Genbrugt.** `priceCall()`. Hele kortet findes fordi vi IKKE havde den. |
| USD→DKK-kurs | Ja — vores egen `fx/rate.ts` (F023) | Uændret. Valutakurs er ikke model-pris. |

Discovery-tjek: `@broberg/ai-sdk` stod på repoets ikke-adopterede liste. Nu adopteret (0.36.7) — kun for `pricing`-subpath'en; vi laver ingen LLM-kald selv.

## Harness

Prøverne kører mod den ÆGTE pakke. En attrap ville bevise vores egen aritmetik og intet om satserne.

Mutations-verificeret, to bærende grene hver for sig:

```
ukendt model → 0 uden etiket        3 røde
afsenderens pris overskrives        2 røde
```

Negativ kontrol: de fire tilstande skal være indbyrdes forskellige fra samme funktion. Kollapser to, er feltet dekoration.

## Åbent

**De 92 ukendte modeller.** Rigtige vej er at melde dem til `ai-sdk`, så prislisten vokser for hele flåden frem for at vi lapper lokalt. Ikke gjort endnu.

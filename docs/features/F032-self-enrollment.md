# F032 — Self-enrollment: et repo optager sig selv, uden en agent i loopet

**Status:** planlagt · **Ejer-ordre:** Christian, 17/9 2026

> «Du skal lave det sådan at nye tools og platforme/applikationer kan self-enroll
> i upmetrics uden at du som agent skal være aktiv. Det er simpelthen for dumt.»
> … «Det skal være tosset secure :)»

## Motivation

I dag optages et repo ved at **en agent er vågen**: peer-sessionen beder upmetrics-
sessionen om en DSN, upmetrics-sessionen SSH'er ind på Fly-maskinen, indsætter en
række i `projects` i hånden, og afleverer `uk_`-nøglen i modtagerens gitignorerede
`.env`. Konsekvenserne er målt, ikke formodede:

| målt 17/9 2026 | |
|---|---|
| `components` — ejer hele det delte `@broberg/*`-inventar | **ingen DSN, ingen `uk_`** — kan ikke lukke sine egne fejl |
| `broberg-ai/bid` — flådens centrale login | beder om optagelse, venter |
| `voice-engine`, `broberg-services` | har bedt om optagelse siden 15/9 |

Fire repos i kø, og køen er lang præcis fordi den kræver at to sessioner er vågne
samtidig. Det er den flaskehals ordren afskaffer.

## Beslutningen: identiteten skal komme fra GitHub, ikke fra kalderen

Mit **første** forslag var samme model som Discoverys `POST /api/enroll`: repoet
laver sin egen nøgle (`openssl rand -hex 32`) og første kald binder nøglen til
navnet — trust-on-first-use. Det er en god model for et **læse**-register.

**Den falder her, og jeg pegede selv på hullet før ejeren gjorde:** den første der
spørger, får navnet. En hvilken som helst kaldende part kunne reservere `cms` eller
`bid` før repoet selv nåede frem. Skaden er ikke datatyveri — vi har målt at
kryds-projekt-læsning og -lukning begge svarer **404** — men navne-kapring, og et
repo der ikke kan optage sig selv er tilbage ved udgangspunktet.

**Derfor: GitHub Actions OIDC.** Repoets egen byggeproces beder GitHub om et
kortlivet, signeret identitetsbevis. GitHub skriver selv `repository` ind i
beviset. Vi verificerer signaturen mod GitHubs offentlige nøgler (JWKS) og
**udleder projektnavnet af beviset, aldrig af request-body**.

**Navnet kan ikke forfalskes, og der findes ingen delt hemmelighed at stjæle.**
Der er ingen enroll-nøgle at lække, ingen fleet-key i en `.env`, intet at rotere.

**Præcedensen er vores egen:** `.github/workflows/publish-sdk.yml` udgiver allerede
`@upmetrics/sdk` til npm via præcis denne mekanisme (Trusted Publishing,
`id-token: write`, nul tokens). Vi indfører ikke en ny tillidsvej — vi bruger den
der allerede er bevist i dette repo.

Verificeret live før beslutningen (ikke antaget):

```
issuer   https://token.actions.githubusercontent.com
jwks     https://token.actions.githubusercontent.com/.well-known/jwks
algs     ['RS256']
claims   repository · repository_id · repository_owner · sub · aud · ref · sha · run_id · jti
```

## Reuse

Påkrævet genbrugstjek (F217) kørt mod `discovery.broberg.ai/api/search` før planen:

| kapabilitet | søgt | fundet | beslutning |
|---|---|---|---|
| OIDC-/JWT-verifikation | `?q=oidc`, `?q=jwt` | **intet** — `@broberg/config` nævner OIDC i sin egen udgivelsesnote, `@broberg/lens` *udsteder* en session men verificerer ikke en fremmed udsteder | **byg her** |
| self-enrollment-mønster | `?q=enrollment` | Discoverys egen TOFU-model (`x-enroll-key`) + contract-managers | **mønster lånt, model forkastet** (se ovenfor) |
| konfiguration | — | `@broberg/config` | **genbrug** — `coerceInt`/env-læsning som resten af `config.ts` |

**Signaturverifikationen håndrulles ikke.** `jose` (6.2.12, nul afhængigheder)
gør JWKS-hentning, algoritme-fastlåsning og claim-tjek. Håndrullet JWT-verifikation
er stedet hvor alg-forvirring og glemte `exp`-tjek lever; det er ikke det sted at
spare en afhængighed på en feature hvis hele formål er at være sikker.

**Til `components`:** hvis et andet repo får brug for at verificere GitHub-OIDC,
er dette kandidaten til at flytte op i `@broberg/*`. Vi bygger den her først (ét
forbrugssted), og siger til.

## Hvad «tosset secure» konkret betyder

Otte spærrer, hver med en negativ kontrol der beviser at den kan gå rød:

1. **Signatur.** RS256 mod GitHubs JWKS. Algoritmen er låst til `RS256` — en
   token med `alg: none` eller HS256 signeret med en kendt streng afvises på
   algoritmen, ikke på signaturen.
2. **Udsteder.** `iss` skal være `https://token.actions.githubusercontent.com`.
3. **Modtager — den vigtigste, og den der oftest springes over.** `aud` skal være
   vores egen base-URL. Vores npm-publish-workflow minter allerede OIDC-tokens;
   uden `aud`-binding ville sådan et token kunne **genbruges** mod os. Workflowet
   skal eksplicit bede om et token til os.
4. **Levetid.** `exp`/`nbf` håndhæves (GitHubs tokens lever minutter).
5. **Org-hegn.** `repository_owner` skal stå på listen (`broberg-ai` som default,
   env-overskrivelig — én kilde, ingen hardkodet organisation i koden).
6. **Engangsbrug.** `jti` gemmes; et token der bruges to gange afvises. Uden det
   ville et token der havner i en log kunne afspilles indtil det udløber.
7. **Binding på repo-ID, ikke navn.** `repository_id` er GitHubs stabile tal:
   det overlever en omdøbning, og et slettet-og-genskabt repo får et **nyt** id og
   arver derfor ikke det gamle projekts nøgler i stilhed. Er projektet allerede
   bundet til et andet id → **409**, aldrig en overtagelse.
8. **Revision.** Hvert forsøg skrives ned — også de afviste, med grunden. Det er
   dér et angreb bliver synligt. Svarer direkte på Decision Registerets
   «intet må handle autonomt uden at det bagefter kan aflæses hvem der udløste det».

### Hvad vi bevidst IKKE gør

- **Vi roterer ikke ved gen-optagelse.** Et repo der kører sit workflow igen får
  **samme** DSN og **samme** `uk_` tilbage. En rotation ved hver CI-kørsel ville
  slå nøglen i den kørende tjeneste ihjel.
- **Vi læser ikke `ref`/`sha` som en spærre.** De skrives i revisionssporet, men
  en gren er ikke en adgangskontrol.
- **Vi udsteder ikke noget til et repo uden for org-hegnet**, uanset hvor gyldigt
  dets bevis er.

## Grænsen, sagt ligeud

**Det virker kun hvor der er GitHub Actions.** Hele flådens repos har det, men et
rent lokalt projekt uden CI kan ikke bruge denne dør. Den bliver ikke bygget nu —
en svagere andendør ville være den eneste dør et angreb gik efter.

**Enhver der kan køre et workflow i et repo, kan hente dét repos nøgle.** Det er
med vilje: den person kan i forvejen udrulle repoets kode. Det er ikke en ny
rettighed, og det er værd at sige højt frem for at lade det se stærkere ud.

## Arkitektur

```
repo .github/workflows/upmetrics-enroll.yml
  permissions: id-token: write
  → core.getIDToken('https://upmetrics.org')      # aud bindes HER
  → POST https://upmetrics.org/api/enroll
        Authorization: Bearer <oidc-jwt>
        body: { platform?: 'node'|'web'|'capacitor'|'native' }
  ← { project, dsn, dsn_numeric, api_key, created }
  → ::add-mask:: + gh secret set UPMETRICS_DSN / UPMETRICS_API_KEY
```

Serveren, i rækkefølge — hvert trin kan afvise:

```
signatur+iss+aud+exp  → 401 invalid_token      (revision uden jti: vi stoler ikke på den)
jti allerede brugt    → 401 token_replayed
owner uden for hegn   → 403 owner_not_allowed
slug taget af andet   → 409 slug_taken
                      → 200 (fandtes) / 201 (oprettet)
```

**Slug udledes af `repository`** (`broberg-ai/voice-engine` → `voice-engine`) og
skal passe `SLUG_RE`. Body kan ikke påvirke navnet — det er hele pointen.

### Data

`projects` får tre kolonner (rent additivt — ingen `DROP`, ingen omdøbning):
`enroll_repository`, `enroll_repository_id` (unik når sat), `enrolled_at`.

Ny tabel `enroll_attempts`: tidspunkt, repository, repository_id, owner, ref, sha,
run_id, workflow, jti (unik når sat), udfald, grund, project_id.

## Stories

- **F032.1** — verifikation + `POST /api/enroll` med alle otte spærrer
- **F032.2** — revisionsspor + afspilningsspærre, aflæselig for ejeren
- **F032.3** — den genbrugelige workflow-fil + levering til `components` og `helpdesk`

## Rollout

1. Byg, grøn port, udrul i baggrunden (F302).
2. **Bevis på produktionen** med et rigtigt CI-kald fra et rigtigt repo, ikke kun
   fra en test.
3. Lever til `components` og `helpdesk` (ejerens eksplicitte ordre).
4. `components` og `bid` optages **manuelt nu** — de venter allerede, og ingen af
   dem skal vente på en udrulning for at kunne lukke deres egne fejl.

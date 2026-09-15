# F030 — byggeriet kørte utestede afhængigheder

> Ejer-rapporteret 15. september 2026 med skærmbillede: **han kunne ikke logge ind.**
> Christians ordre samme dag: *«ja fjern kolonnen og lås byggeriet».*

## Hvad der skete

Login-skærmen svarede:

> *Database schema mismatch. Required columns Better Auth never writes:
> `account.issuer`. Inserts into account will fail.*

Tidslinjen forklarer det hele, målt mod npm:

| version | dato | hvad den gjorde |
|---|---|---|
| 1.6.11 | 12/5 | det vores låsefil sagde |
| **1.7.0** | 18/8 | tilføjer en **påkrævet** `issuer`-kolonne + unikt indeks |
| 1.7.2 | 26/8 | stadig påkrævet |
| **1.7.3** | 6/9 | **fortryder** — skemaet er tilbage som 1.6, kolonnen udfyldes ikke |
| 1.7.5 | 14/9 | nyeste |

`package.json` sagde `^1.6.11`, og caret på et 1.x tillader hele 1.7-serien.
Låsefilen sagde 1.6.11 — men **byggeriet kopierede den aldrig**
(`Dockerfile:12` og `:22`: `COPY package.json` efterfulgt af et bart
`bun install`).

Så: en udrulning mellem 18/8 og 6/9 hentede 1.7.0–1.7.2, hvis migrering lagde
kolonnen på NOT NULL. En udrulning efter 6/9 hentede 1.7.3+, som ikke længere
skriver i den. Kolonnen står tilbage, påkrævet, og ingen udfylder den — altså
fejler hver `INSERT` i `account`, og der kan ikke oprettes login.

**Det rammer ALLE pakker, ikke kun denne.** Uden låsefil i byggeriet har
produktionen aldrig kørt de versioner nogen har testet. Denne gang fangede vi
det fordi det låste ejeren ude; et tavsere brud havde stået uset.

## Løsning

1. **Låsefilen kommer med, og installationen er FROSSET.** En frossen
   installation **fejler højlydt** når manifest og låsefil er uenige — det er
   hele pointen. Uden begge dele gen-opløses hvert interval ved hver udrulning.
2. **better-auth pinnes EKSAKT.** Låsefilen er mekanismen for alt; en eksakt pin
   oveni er ikke seler-og-livrem her, men en erkendelse af at netop denne pakke
   **migrerer vores database** ved versionsskift. En afhængighed der ændrer skema
   må aldrig flyde.
3. **Kolonnen fjernes fra produktionen.** Nødvendig uanset version — hverken den
   gamle eller den nye udfylder den. SQLite kræver indekset først, så kolonnen.

## Non-goals

**At flytte byggeriet til pnpm.** Repoet er et pnpm-workspace, men Docker-billedet
installerer pr. app med bun, og de to apps har **nul** workspace-links (14 og 10
almindelige afhængigheder). At omlægge byggeriet ville være en større ændring end
problemet kræver. Uenigheden mellem de to opløsere er værd at rydde op i — som
sit eget kort, ikke midt i et login-nedbrud.

## Reuse

Discovery-tjek: ingen `@broberg/*`-pakke ejer afhængigheds-låsning — det er en
egenskab ved byggeriet, ikke en kapabilitet man importerer. `@broberg/auth` er
flådens auth-primitiv og er **ikke** relevant her: vi bruger better-auth direkte
med magic-link, og kortet handler om versionsstyring, ikke om at skifte
auth-lag.

## Harness

**Den negative kontrol er hele beviset.** En grøn build viser kun at der blev
installeret *noget*; den kan ikke skelne en låst installation fra en fri. Så
låsen prøves i begge retninger:

```
uaendret manifest + laasefil   -> install koerer
manifest aendret, laasefil ej  -> exit 1, «lockfile had changes, but lockfile is frozen»
```

Og `.dockerignore` tjekkes mod sine **faktiske mønstre** — en låsefil der aldrig
når byggekonteksten giver enten en fejlende `COPY` eller, værre, et build der ser
rigtigt ud.

## Et fund undervejs, værd at holde fast i

Jeg meldte først at vi **ikke** bruger nogen af 1.7's brydende API'er — baseret
på en søgning efter de navne opgraderings-guiden nævner. Typetjekket fandt ét
alligevel: `createUser` kræver nu et andet argument (hvem der oprettede
brugeren). **Søgningen var for snæver; oversætteren var det eneste der målte hele
fladen.**

Og jeg var ved at rette det forkerte kald: fejlen pegede på en linje hvor to
funktioner står sammen, og jeg læste den øverste. Værdien der nu sendes med er
valgt fordi den er **sand** (brugeren oprettes af vores eget endepunkt, ikke af
et login-fløw), ikke fordi den tavsgjorde oversætteren — feltet læses ikke af
noget i dag, og det er netop derfor det skal være ærligt nu.

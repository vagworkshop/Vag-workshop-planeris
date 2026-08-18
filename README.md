# AutoServisas Kalendorius — serverio versija

Tas pats kalendorius (vilkite darbus tarp darbuotojų/dienų, tempkite viršutinį/apatinį kraštą trukmei keisti), bet dabar su bendra duomenų baze ir atskirais prisijungimais Alanui, Sigitui ir Dariui — visi įrenginiai (telefonas, kompiuteris) mato tuos pačius įrašus.

Serveris parašytas naudojant **tik** Node.js integruotus modulius — jokių `npm install` priklausomybių, todėl diegimas niekada nesugrius dėl paketų problemų.

## Failų struktūra

```
server.js            – serveris (HTTP + API + statinių failų patiekimas)
lib/                  – serverio logika (autentifikacija, duomenų bazė, validacija)
public/index.html     – kalendorius (frontend)
public/login.html     – prisijungimo langas
data/db.json          – duomenų failas (sukuriamas automatiškai; jame - darbuotojai ir įrašai)
scripts/set-password.js – slaptažodžio keitimo įrankis
render.yaml            – Render diegimo konfigūracija ("Blueprint")
```

## 1. Paleidimas savo kompiuteryje (patikrinimui)

Reikalinga tik Node.js (18 ar naujesnė versija — https://nodejs.org).

```bash
cd server-app
JWT_SECRET=bet-koks-ilgas-tekstas node server.js
```

Atidarykite naršyklėje `http://localhost:3000`. Pirmo paleidimo metu terminale (konsolėje) bus atspausdinti trys automatiškai sugeneruoti slaptažodžiai (po vieną kiekvienam darbuotojui) — juos reikės išsisaugoti, nes daugiau nebus rodomi. Vėliau galite juos pakeisti (žr. skyrių žemiau).

## 2. Diegimas į Render (rekomenduojama)

### A. Kelio žingsniai

1. **Sukurkite paskyrą** [render.com](https://render.com), jei dar neturite.
2. **Įkelkite šį kodą į GitHub** (Render diegia iš Git saugyklos):
   - Sukurkite naują tuščią saugyklą (repository) savo GitHub paskyroje, pvz. `autoservisas-kalendorius`.
   - Šiame aplanke paleiskite:
     ```bash
     git init
     git add .
     git commit -m "Pradinis diegimas"
     git branch -M main
     git remote add origin https://github.com/<jusu-vartotojas>/autoservisas-kalendorius.git
     git push -u origin main
     ```
3. Render dashboard'e spauskite **New +** → **Blueprint**, pasirinkite ką tik sukurtą GitHub saugyklą. Render automatiškai perskaitys `render.yaml` failą ir sukurs:
   - Web servisą (Node.js, paleidimo komanda `node server.js`);
   - Nuolatinį diską (`/var/data`), kad duomenys išliktų po perkrovimų ir naujų diegimų;
   - `JWT_SECRET` kintamąjį (sugeneruos automatiškai, saugiai).
4. Patvirtinkite plano kainą (Blueprint faile nurodytas `starter` planas — pigiausias, palaikantis nuolatinį diską; kaina priklauso nuo dabartinių Render įkainių, žr. render.com/pricing).
5. Palaukite, kol įvyks diegimas (build + deploy). Render suteiks jums nuolatinį adresą, pvz. `https://autoservisas-kalendorius.onrender.com`.
6. Atidarykite tą adresą, spauskite **Logs** skiltyje Render dashboard'e ir susiraskite pirmo paleidimo pranešimus su sugeneruotais trijų darbuotojų slaptažodžiais — juos išsisaugokite ir išsiųskite kiekvienam darbuotojui atskirai.

### B. Jei norite iš anksto nustatyti slaptažodžius (ne atsitiktinius)

Prieš pirmą diegimą, Render dashboard'e servisą sukūrus (arba Blueprint faile prieš `git push`), pridėkite aplinkos kintamuosius **Environment** skiltyje:

```
ALANAS_PASSWORD=jusu_pasirinktas_slaptazodis
SIGITAS_PASSWORD=jusu_pasirinktas_slaptazodis
DARIUS_PASSWORD=jusu_pasirinktas_slaptazodis
```

Šie kintamieji naudojami **tik pirmo paleidimo metu**, kol vartotojai dar nesukurti duomenų bazėje. Po to juos galima pašalinti iš Environment nustatymų — jie serverio veikimui daugiau nereikalingi.

## 3. Slaptažodžio keitimas vėliau

Render dashboard'e atidarykite servisą → **Shell** skiltį (terminalą naršyklėje) ir paleiskite:

```bash
node scripts/set-password.js alanas naujas_slaptazodis
```

(pakeiskite `alanas` į `sigitas` arba `darius`, jei reikia).

## 4. Kaip patogiai naudoti iPhone

1. Atidarykite kalendoriaus adresą Safari naršyklėje telefone.
2. Prisijunkite savo vardu.
3. Paspauskite **Dalintis** (kvadratėlis su rodykle) → **Add to Home Screen** (Pridėti į pagrindinį ekraną).
4. Atsiras piktograma, kuri atidaro kalendorių per visą ekraną, be adreso juostos — kaip atskira programėlė.

**Svarbu:** šioje versijoje darbo vilkimas pele (perkėlimas ir trukmės keitimas) kol kas veikia tik su pele/kompiuteriu. Prisilietimu (pirštu) veikia paprastas bakstelėjimas, kuris atidaro redagavimo langą — ten galite pakeisti darbuotoją, datą ir laiką rankiniu būdu. Jei norėsite, kad vilkimas pirštu telefone veiktų taip pat, kaip pele kompiuteryje, tai galima papildomai pridėti — tereikia paprašyti.

## 5. Atsarginės duomenų kopijos

Visi įrašai laikomi faile `data/db.json` (Render diegime — nuolatiniame diske). Rekomenduojama retkarčiais pasidaryti atsarginę kopiją: Render dashboard'e → Shell → `cat data/db.json` (arba atsisiųskite failą per Render Shell/SCP). Jei norite, galiu pridėti automatinį periodinį atsarginių kopijų siuntimą (pvz. el. paštu) — tai atskira, nedidelė papildoma funkcija.

## 6. Aplinkos kintamieji (santrauka)

| Kintamasis | Privalomas | Paskirtis |
|---|---|---|
| `JWT_SECRET` | Taip (Render Blueprint sugeneruoja automatiškai) | Prisijungimo sesijų pasirašymui. Be jo — visi atsijungia po kiekvieno perkrovimo. |
| `DATA_DIR` | Taip (Render diegime) | Kelias iki nuolatinio disko, kuriame laikomas `db.json`. |
| `ALANAS_PASSWORD`, `SIGITAS_PASSWORD`, `DARIUS_PASSWORD` | Ne | Pradiniai slaptažodžiai (tik pirmam paleidimui). |
| `NODE_ENV=production` | Rekomenduojama | Įjungia saugius (`Secure`) prisijungimo slapukus per HTTPS. |

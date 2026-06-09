# CLAUDE.md — Jeu de Mus (règlement officiel janvier 2011)

## Ce qu'est ce projet

Jeu de Mus (cartes basque/espagnol, 4 joueurs en 2 équipes) en React + Vite.
Un humain (siège 0) joue contre/avec 3 bots. Moteur de règles conforme au
règlement officiel de janvier 2011, validé par **121 tests**.

Déployé sur Vercel : chaque `git push` sur `main` redéploie automatiquement.

## Structure

```
index.html               Entrée HTML (viewport mobile configuré)
src/main.jsx             Bootstrap React
src/MusGame.jsx          TOUT le jeu dans un seul fichier (~6200 lignes) :
                         ├── sections 1-9 : MOTEUR (JS pur, sans React)
                         │   constantes, deck, évaluateurs, comparateurs,
                         │   enchères, scoring, sanctions art.13-16, reducer,
                         │   bots, runTests() = les 121 tests
                         └── à partir du marqueur "UI v2 — Refonte" : UI React
                             (design tokens CSS, composants, responsive)
public/cards/basque/     40 cartes + dos en WebP (CC BY-SA 3.0, voir ATTRIBUTION.md)
scripts/test-engine.mjs  Lance les 121 tests du moteur sans navigateur
```

## Règles d'or — à respecter absolument

1. **Ne jamais modifier le moteur de règles** (sections 1-9 de MusGame.jsx)
   sans demande explicite. Les règles du Mus y sont implémentées article par
   article ; toute « simplification » casse la conformité au règlement.
2. **Après TOUTE modification de src/MusGame.jsx, lancer :**
   ```
   npm run test:engine
   ```
   Les 121 tests doivent passer (121 passed, 0 failed). Si un test échoue,
   ne pas le supprimer ni l'adapter : corriger le code ou demander à Lucas.
3. **Avant un commit, vérifier que le build passe :**
   ```
   npm run build
   ```
4. **Ne pas renommer/déplacer les fichiers de public/cards/basque/** : le
   nommage `{suit}-{rank}.webp` est attendu par le résolveur d'assets.
   Conserver ATTRIBUTION.md (obligation de licence CC BY-SA 3.0).

## Conventions UI

- Design tokens en variables CSS dans `:root` (GLOBAL_STYLES, début de l'UI) :
  palette vert profond / parchemin / rouge basque / or vieilli. S'y tenir.
- Pas de Tailwind, pas de lib UI : CSS-in-JS via une seule balise <style>.
- Polices : serif système (Iowan Old Style/Palatino) pour le display,
  Optima/Avenir pour l'UI. Pas de Google Fonts.
- Responsive : desktop > 1100px (sidebar fixe), 720-1100px (sidebar en drawer),
  < 720px (mobile : table carrée, main + actions fixées en bas). Les media
  queries mobiles écrasent volontairement les valeurs desktop — ne pas
  « factoriser ».
- Tailles fluides desktop via clamp() (cartes, scores, boutons) pour les
  grands écrans (4K). Ne pas remettre de px fixes.
- Thèmes de cartes : 'fallback' (SVG procédural), 'basque' (WebP locaux,
  défaut), 'basque-web' (GitHub distant). Résolution webp→svg→png→SVG
  procédural, par carte, sans erreur visible.

## Vocabulaire du Mus (pour comprendre le code)

- **Manche** : jeu à 40 points (tantto). **Match** : 3 manches gagnées.
- **Coup (hand)** : un cycle Mus → défausse → enchères → révélation.
- **Esku** : premier en ordre de jeu (avantage aux égalités). **Donneur** tourne.
- **Phases d'enchères** : Grande, Chica, Pares, Juego (ou Punto si personne
  n'a 31+).
- **Actions** : Paso, Embido (+2), Hiru Embido (+3), Gehiago (relance),
  Tira (refus), Iduki (accepte), Hordago (tout ou rien), Tira-for-me
  (délègue au partenaire).
- **Sanctions art. 13-16** : fausses déclarations de paires/jeu, gérées par
  une matrice dans applyDeclarationSanctions.

## Workflow de livraison

```
npm run test:engine   # 121/121 obligatoire
npm run build         # doit passer
git add . && git commit -m "..." && git push   # Vercel redéploie tout seul
```

## Ce qui est volontairement hors périmètre

- Multijoueur en ligne (le jeu est local : 1 humain + 3 bots)
- Articles 4-6 du règlement (anomalies physiques de distribution)
- Cas stricts 14 (Tira au partenaire) et 15d : documentés comme limites,
  voir les commentaires dans applyDeclarationSanctions

# Mus — jeu en ligne (règlement officiel janvier 2011)

Jeu de Mus complet en React : moteur de règles conforme au règlement officiel
(121 tests), 3 bots, signes réglementaires, sanctions automatiques articles
13-16, et vraies cartes espagnoles incluses.

## Lancer en local (2 minutes)

Prérequis : Node.js 18+ (https://nodejs.org)

```bash
npm install
npm run dev
```

Ouvre http://localhost:5173 — le jeu tourne avec les **vraies cartes** déjà
incluses dans `public/cards/basque/`.

Pour choisir le visuel des cartes : bouton **Bots** (en haut à droite) →
section **Cartes** :

- **SVG sobre** : rendu vectoriel généré par le code (aucun fichier requis)
- **Basque (en ligne)** : cartes chargées depuis GitHub (nécessite internet)
- **Basque (fichiers locaux)** : les WebP de `public/cards/basque/` ← *recommandé ici*

## Tester le moteur

```bash
npm run build        # vérifie que tout compile
```

Dans le jeu, bouton **Tests** (en haut à droite) : lance les 121 tests du
moteur directement dans le navigateur.

## Mettre en ligne (optionnel)

Même workflow que n'importe quel projet Vercel :

```bash
git init && git add . && git commit -m "Mus v1"
# Crée un repo sur GitHub puis :
git remote add origin https://github.com/TON_USER/mus-basque.git
git push -u origin main
```

Puis sur vercel.com : **Add New Project** → importe le repo → Deploy.
Vite est détecté automatiquement, aucune config nécessaire.

## Licence des cartes

Les images de cartes (`public/cards/basque/`) sont l'œuvre de **Basquetteur**
(Wikimedia Commons), licence **CC BY-SA 3.0**. Voir
`public/cards/basque/ATTRIBUTION.md` — ce fichier doit être conservé.

## Structure

```
index.html              Point d'entrée HTML (viewport mobile configuré)
src/main.jsx            Bootstrap React
src/MusGame.jsx         Le jeu complet : moteur + bots + tests + UI
public/cards/basque/    40 cartes + dos en WebP (~450 KB)
```

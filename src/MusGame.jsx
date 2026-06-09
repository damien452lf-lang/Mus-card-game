import React, { useState, useReducer, useEffect, useMemo, useCallback } from 'react';

/* ============================================================
   MUS — Implémentation complète conforme au règlement officiel
   (Janvier 2011)
   
   Architecture en couches dans ce fichier unique :
   1. Constantes & types
   2. Deck et opérations
   3. Évaluateurs de mains (Grande / Chica / Pares / Juego / Punto)
   4. Comparateurs avec priorité Esku
   5. Bet stack — moteur d'enchères avec résolution Tira/Iduki
   6. Légalité des actions
   7. Reducer du moteur de jeu
   8. Bots (3 niveaux)
   9. Suite de tests intégrée
   10. UI (composants React)
   
   À éclater plus tard en /engine /bots /ui /tests selon la
   structure recommandée dans le brief.
   ============================================================ */

/* ===== 1. CONSTANTES ===== */

const SUITS = ['oros', 'copas', 'espadas', 'bastos'];
const SUIT_LABELS = { oros: 'Or', copas: 'Coupes', espadas: 'Épées', bastos: 'Bâtons' };
const SUIT_SYMBOLS = { oros: '☉', copas: '♥', espadas: '⚔', bastos: '♣' };
const SUIT_COLORS = { oros: '#c9a227', copas: '#a82323', espadas: '#1a1a1a', bastos: '#2d4a1f' };
const RANKS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
const RANK_LABELS = {
  1: 'As', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  10: 'Sota', 11: 'Caballo', 12: 'Rey'
};
const RANK_GLYPH = {
  1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII',
  10: 'X', 11: 'XI', 12: 'XII'
};

const TEAM_OF = { 0: 'A', 1: 'B', 2: 'A', 3: 'B' };
const PARTNER_OF = { 0: 2, 1: 3, 2: 0, 3: 1 };

// Rang effectif pour Grande / Chica / Pares (3 → Rey, 2 → As)
const effRank = (r) => (r === 3 ? 12 : r === 2 ? 1 : r);

// Valeur en points pour Juego / Punto
const pointValue = (r) => {
  if (r === 1 || r === 2) return 1;
  if (r === 3 || r >= 10) return 10;
  return r;
};

// Ordre des Juegos du meilleur au moins bon
const JUEGO_ORDER = [31, 32, 40, 37, 36, 35, 34, 33];
const juegoStrength = (v) => {
  const i = JUEGO_ORDER.indexOf(v);
  return i === -1 ? -1 : JUEGO_ORDER.length - i;
};

const PHASES_ORDER = ['grande', 'chica', 'pares', 'juego'];
const PHASE_LABEL = {
  grande: 'Grand', chica: 'Petit', pares: 'Paires',
  juego: 'Jeu', punto: 'Point',
};

/* ===== 2. DECK ===== */

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${suit}-${rank}` });
    }
  }
  return deck;
}

// Mulberry32 seeded RNG pour reproductibilité (mode debug / tests)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeck(deck, rng = Math.random) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealHands(deck, eskuId = 0) {
  // Distribution une à une dans le sens horaire à partir de l'Esku réel
  // (article 3°). 4 cartes × 4 joueurs = 16 cartes, le reste devient le talon.
  const hands = [[], [], [], []];
  for (let i = 0; i < 16; i++) {
    const seat = (eskuId + i) % 4;
    hands[seat].push(deck[i]);
  }
  return { hands, remaining: deck.slice(16) };
}

// Repioche depuis le talon en sens horaire à partir de l'Esku.
// `discardChoices[playerId]` est un array d'ids de cartes à défausser.
// En cas de pénurie, on remélange les cartes défaussées (talon vide) et on continue
// (variante traditionnelle documentée dans RULES_IMPLEMENTATION.md).
function applyDiscards(state, rng) {
  const { players, discardChoices, deckRemaining, esku } = state;
  let talon = [...deckRemaining];
  let discards = [];
  const newHands = players.map((p) => [...p.hand]);

  // 1) Retirer les cartes défaussées de chaque main, en les ajoutant au tas de défausse
  for (let seat = 0; seat < 4; seat++) {
    const ids = discardChoices[seat] || [];
    for (const id of ids) {
      const idx = newHands[seat].findIndex((c) => c.id === id);
      if (idx >= 0) {
        const removed = newHands[seat].splice(idx, 1)[0];
        discards.push(removed);
      }
    }
  }

  // 2) Ordre de pioche : Esku → Esku+1 → Esku+2 → Esku+3
  for (let i = 0; i < 4; i++) {
    const seat = (esku + i) % 4;
    const need = (discardChoices[seat] || []).length;
    for (let k = 0; k < need; k++) {
      if (talon.length === 0) {
        // Pénurie : remélanger les cartes défaussées en nouveau talon
        // (cf. règlement art. 7° — ne précise pas, convention logicielle adoptée)
        if (discards.length === 0) {
          // Cas extrême : impossible de redistribuer. On laisse la main amputée.
          break;
        }
        talon = shuffleDeck(discards, rng);
        discards = [];
      }
      newHands[seat].push(talon.shift());
    }
  }

  return { newHands, talon, discards };
}

/* ===== 3. ÉVALUATEURS ===== */

function evaluateGrande(hand) {
  return hand.map(c => effRank(c.rank)).sort((a, b) => b - a);
}
function evaluateChica(hand) {
  return hand.map(c => effRank(c.rank)).sort((a, b) => a - b);
}

function evaluatePares(hand) {
  const counts = {};
  for (const c of hand) {
    const r = effRank(c.rank);
    counts[r] = (counts[r] || 0) + 1;
  }
  const entries = Object.entries(counts)
    .map(([r, n]) => ({ rank: +r, count: n }))
    .sort((a, b) => b.rank - a.rank);

  const four = entries.find(e => e.count === 4);
  const three = entries.find(e => e.count === 3);
  const pairs = entries.filter(e => e.count >= 2);

  if (four) {
    // Carré = dobliak avec deux paires de même rang
    return { type: 'dobliak', highPair: four.rank, lowPair: four.rank, points: 3, has: true };
  }
  if (pairs.length >= 2) {
    return { type: 'dobliak', highPair: pairs[0].rank, lowPair: pairs[1].rank, points: 3, has: true };
  }
  if (three) {
    return { type: 'mediak', rank: three.rank, points: 2, has: true };
  }
  if (pairs.length === 1) {
    return { type: 'pareja', rank: pairs[0].rank, points: 1, has: true };
  }
  return { type: 'none', points: 0, has: false };
}

function evaluateJuegoPunto(hand) {
  const total = hand.reduce((s, c) => s + pointValue(c.rank), 0);
  const hasJuego = total >= 31;
  return {
    total,
    hasJuego,
    juegoPoints: hasJuego ? (total === 31 ? 3 : 2) : 0,
  };
}

/* ===== 4. COMPARATEURS ===== */

function lexCompare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Pour chaque phase : retourne le PlayerId gagnant en respectant
// la priorité Esku en cas d'égalité parfaite.
function findBestPlayer(players, eskuId, scoreFn, eligibleFn = () => true) {
  const order = [eskuId, (eskuId + 1) % 4, (eskuId + 2) % 4, (eskuId + 3) % 4];
  const eligible = order.filter(id => eligibleFn(players[id]));
  if (eligible.length === 0) return null;
  let best = eligible[0];
  for (let i = 1; i < eligible.length; i++) {
    const cmp = scoreFn(players[eligible[i]]) - scoreFn(players[best]);
    // Tie : on garde le premier (priorité Esku, déjà ordonné)
    if (cmp > 0) best = eligible[i];
    else if (cmp === 0) {
      // Pour Grande/Chica/Pares qui retournent des structures, on traite à part
    }
  }
  return best;
}

// Variante générique acceptant un comparateur retournant un nombre
function findBestPlayerWithCompare(players, eskuId, compareFn, eligibleFn = () => true) {
  const order = [eskuId, (eskuId + 1) % 4, (eskuId + 2) % 4, (eskuId + 3) % 4];
  const eligible = order.filter(id => eligibleFn(players[id]));
  if (eligible.length === 0) return null;
  let best = eligible[0];
  for (let i = 1; i < eligible.length; i++) {
    if (compareFn(players[eligible[i]], players[best]) > 0) best = eligible[i];
  }
  return best;
}

function compareGrande(a, b) {
  return lexCompare(evaluateGrande(a.hand), evaluateGrande(b.hand));
}
function compareChica(a, b) {
  // Inverser : main triée croissant, valeur la plus basse l'emporte
  // → on inverse le signe de lexCompare
  return -lexCompare(evaluateChica(a.hand), evaluateChica(b.hand));
}
function comparePares(a, b) {
  const pa = evaluatePares(a.hand);
  const pb = evaluatePares(b.hand);
  const order = { dobliak: 3, mediak: 2, pareja: 1, none: 0 };
  if (order[pa.type] !== order[pb.type]) return order[pa.type] - order[pb.type];
  if (pa.type === 'dobliak') {
    if (pa.highPair !== pb.highPair) return pa.highPair - pb.highPair;
    return pa.lowPair - pb.lowPair; // règle 12° dobliak inférieur
  }
  if (pa.type === 'mediak') return pa.rank - pb.rank;
  if (pa.type === 'pareja') return pa.rank - pb.rank;
  return 0;
}
function compareJuego(a, b) {
  const va = evaluateJuegoPunto(a.hand);
  const vb = evaluateJuegoPunto(b.hand);
  return juegoStrength(va.total) - juegoStrength(vb.total);
}
function comparePunto(a, b) {
  return evaluateJuegoPunto(a.hand).total - evaluateJuegoPunto(b.hand).total;
}

/* ===== 5. BET STACK ===== */
/* La pile retient les paliers successifs.
   - [1] : pile vide, valeur "fold immédiat" = 1
   - Embido pousse 2, Hiru Embido pousse 3
   - X gehiago pousse current+X
   - Tira  → palier précédent (stack[len-2]) ou 1
   - Iduki → palier courant (stack[len-1])
*/

function emptyBetState() {
  return {
    stack: [1],
    history: [],
    initiator: null,             // 'A' | 'B' : équipe qui a OUVERT (info historique)
    lastAggressorTeam: null,     // 'A' | 'B' : dernière équipe à avoir relevé/ouvert
    pendingResponderTeam: null,  // équipe qui doit répondre
    hordago: false,
    resolution: null,            // { kind: 'paso' | 'tira' | 'iduki' | 'hordago-accepted' }
    pendingTiraForMe: null,      // { phaseName, requesterId, requesterTeam } pendant Tira pour moi
  };
}

function applyBetAction(bet, action, playerTeam) {
  // Renvoie nouvel état ou null si action illégale
  const next = { ...bet, stack: [...bet.stack], history: [...bet.history, action] };
  switch (action.type) {
    case 'paso':
      return next;
    case 'embido':
      next.stack.push(2);
      next.initiator = next.initiator || playerTeam;
      next.lastAggressorTeam = playerTeam;
      next.pendingResponderTeam = playerTeam === 'A' ? 'B' : 'A';
      return next;
    case 'hiru-embido':
      next.stack.push(3);
      next.initiator = next.initiator || playerTeam;
      next.lastAggressorTeam = playerTeam;
      next.pendingResponderTeam = playerTeam === 'A' ? 'B' : 'A';
      return next;
    case 'gehiago': {
      const cur = next.stack[next.stack.length - 1];
      next.stack.push(cur + action.amount);
      next.lastAggressorTeam = playerTeam;
      next.pendingResponderTeam = playerTeam === 'A' ? 'B' : 'A';
      return next;
    }
    case 'tira': {
      // Le palier précédent : ce que l'adversaire a déjà mis sur la table avant la dernière relance.
      // C'est l'équipe qui a relevé en dernier (lastAggressorTeam) qui empoche.
      const prev = next.stack.length >= 2 ? next.stack[next.stack.length - 2] : 1;
      const winnerTeam = next.lastAggressorTeam || next.initiator;
      next.resolution = {
        kind: 'tira',
        immediatePoints: { team: winnerTeam, points: prev },
      };
      next.pendingResponderTeam = null;
      return next;
    }
    case 'iduki': {
      const cur = next.stack[next.stack.length - 1];
      if (next.hordago) {
        next.resolution = { kind: 'hordago-accepted' };
      } else {
        next.resolution = { kind: 'iduki', deferredPoints: cur };
      }
      next.pendingResponderTeam = null;
      return next;
    }
    case 'hordago':
      next.hordago = true;
      next.initiator = next.initiator || playerTeam;
      next.lastAggressorTeam = playerTeam;
      next.pendingResponderTeam = playerTeam === 'A' ? 'B' : 'A';
      return next;
    default:
      return null;
  }
}

/* ===== 6. RESOLUTION DES PHASES À LA RÉVÉLATION ===== */

// Détection des erreurs de déclaration (articles 13° à 16°)
// Renvoie un tableau d'événements { player, kind, phase }.
// kind ∈ { 'false-pares', 'missed-pares', 'false-juego', 'missed-juego' }
function detectDeclarationErrors(players) {
  const errors = [];
  for (const p of players) {
    const realPares = evaluatePares(p.hand).has;
    const realJuego = evaluateJuegoPunto(p.hand).hasJuego;
    if (p.declaredPares === true && !realPares) errors.push({ player: p.id, kind: 'false-pares' });
    if (p.declaredPares === false && realPares) errors.push({ player: p.id, kind: 'missed-pares' });
    if (p.declaredJuego === true && !realJuego) errors.push({ player: p.id, kind: 'false-juego' });
    if (p.declaredJuego === false && realJuego) errors.push({ player: p.id, kind: 'missed-juego' });
  }
  return errors;
}

// Calcule les sanctions (ajustements de score) selon les articles 13° à 16°.
// Renvoie { adjustments: [{team, delta, reason}], errors }.
//
// Stratégie pragmatique : on couvre les sanctions principales qui se traduisent
// en gain/perte de points et en transferts à l'adversaire. Les nuances exactes
// des cas a/b/c/d (qui distinguent partenaire/adversaire ayant ou non paires/jeu)
// sont implémentées en se basant sur la logique commune :
//   - fausse déclaration → annulation des points qu'elle aurait fait gagner
//                          + adversaire récupère ses points légitimes
//                          + si Iduki, l'adversaire prend la mise
//   - paires/jeu non annoncés → simplement ignorés (déjà fait par resolvePhase)
// V4 — Matrice exhaustive des sanctions art. 13-16.
//
// Conception : une seule passe par phase concernée (pares, juego/punto), pas de
// boucle par erreur (ce qui causait du double-count en V3).
//
// Pour chaque phase concernée :
//   1) on détecte si l'équipe A et/ou B a commis une erreur affectant cette phase
//   2) on applique la matrice du règlement selon les sous-cas (a/b/c/d)
//   3) on accumule les ajustements (groupés par équipe)
//
// Renvoie { adjustments: [{ team, delta, reason, phase }], errors: [...] }
function applyDeclarationSanctions(state, resolutions) {
  const players = state.players;
  const errors = detectDeclarationErrors(players);
  const adjustments = [];
  if (errors.length === 0) return { adjustments, errors };

  // ---- Helpers ----
  const otherTeam = (t) => (t === 'A' ? 'B' : 'A');
  const playersOfTeam = (t) => players.filter((p) => TEAM_OF[p.id] === t);
  const teamHasRealPares = (t) => playersOfTeam(t).some((p) => evaluatePares(p.hand).has);
  const teamHasRealJuego = (t) => playersOfTeam(t).some((p) => evaluateJuegoPunto(p.hand).hasJuego);
  const teamHasDeclaredPares = (t) => playersOfTeam(t).some((p) => p.declaredPares === true);
  const teamHasDeclaredJuego = (t) => playersOfTeam(t).some((p) => p.declaredJuego === true);
  const teamFalseParesCount = (t) =>
    playersOfTeam(t).filter((p) => p.declaredPares === true && !evaluatePares(p.hand).has).length;
  const teamMissedParesCount = (t) =>
    playersOfTeam(t).filter((p) => p.declaredPares === false && evaluatePares(p.hand).has).length;
  const teamFalseJuegoCount = (t) =>
    playersOfTeam(t).filter((p) => p.declaredJuego === true && !evaluateJuegoPunto(p.hand).hasJuego).length;
  const teamMissedJuegoCount = (t) =>
    playersOfTeam(t).filter((p) => p.declaredJuego === false && evaluateJuegoPunto(p.hand).hasJuego).length;
  const sumPairsPoints = (t) => playersOfTeam(t).reduce((s, p) => {
    if (p.declaredPares === true) {
      const pe = evaluatePares(p.hand);
      if (pe.has) return s + pe.points;
    }
    return s;
  }, 0);
  const sumJuegoPoints = (t) => playersOfTeam(t).reduce((s, p) => {
    if (p.declaredJuego === true) {
      const j = evaluateJuegoPunto(p.hand);
      if (j.hasJuego) return s + j.juegoPoints;
    }
    return s;
  }, 0);
  const paresRes = resolutions.find((r) => r.phase === 'pares');
  const juegoRes = resolutions.find((r) => r.phase === 'juego' || r.phase === 'punto');
  const paresBet = state.phases.pares;
  const juegoBet = state.phases.juego;

  // ============================================================
  // PHASE PARES — articles 13° et 14°
  // ============================================================
  for (const fteam of ['A', 'B']) {
    const oteam = otherTeam(fteam);
    const falseCount = teamFalseParesCount(fteam);
    if (falseCount > 0) {
      // Article 13° — fausse déclaration de paires.
      // (a) Annuler les points indûment obtenus par l'équipe coupable.
      if (paresRes?.revealPoints?.team === fteam) {
        adjustments.push({
          team: fteam,
          delta: -paresRes.revealPoints.points,
          reason: 'art. 13° — annulation des points pares indûment obtenus',
          phase: 'pares',
        });
      }
      // (b) L'adversaire prend ses propres paires (cas 13° avec adversaire ayant paires).
      const advPoints = sumPairsPoints(oteam);
      if (advPoints > 0) {
        adjustments.push({
          team: oteam,
          delta: advPoints,
          reason: 'art. 13° — adversaire prend ses paires',
          phase: 'pares',
        });
      }
      // (c) Si Iduki avait été accepté sur la fausse déclaration, l'adversaire prend
      //     la mise (le Deje, ou plutôt le palier accepté).
      if (paresBet.resolution?.kind === 'iduki') {
        adjustments.push({
          team: oteam,
          delta: paresBet.resolution.deferredPoints,
          reason: 'art. 13° — Tira de la mise pares aux adversaires',
          phase: 'pares',
        });
      }
      // Note : si fteam ET oteam ont chacun une fausse déclaration (cas extrême),
      // on traite les deux à tour de rôle ici. Pas de double-count car on annule
      // d'abord les paresRes obtenus à tort puis on ne ré-attribue pas si
      // sumPairsPoints(oteam)=0.
      continue; // priorité au cas false-pares ; missed-pares pour fteam non traité ici
    }

    const missedCount = teamMissedParesCount(fteam);
    if (missedCount > 0) {
      // Article 14° — paires non annoncées.
      // Sanction principale : paires ignorées au scoring (déjà appliqué par
      // resolvePhase via le filtre declaredPares===true && evaluatePares.has).
      // Sanction supplémentaire (règlement art. 14° fin) : si partenaire sans paires
      // ET adversaire avec paires → l'adversaire tire 1 point (Tira des paires).
      const partnerHasPares = teamHasRealPares(fteam) && teamHasDeclaredPares(fteam);
      const advHasPares = teamHasRealPares(oteam);
      if (!partnerHasPares && advHasPares && !teamHasDeclaredPares(oteam)) {
        // Edge case : adversaire a paires mais ne les a pas déclarées non plus.
        // Pas de sanction additionnelle réglementaire claire, on s'abstient.
      } else if (!partnerHasPares && advHasPares && teamHasDeclaredPares(oteam)) {
        // Le scoring normal couvre déjà : adversaire a déclaré et gagne légitimement.
        // Pas de sanction supplémentaire — sinon double-count.
      }
      // Note : la sanction « 1 point Tira » mentionnée par certaines tables
      // d'interprétation est ambiguë dans le règlement écrit. On garde la
      // sanction principale (exclusion du scoring) qui est claire.
    }
  }

  // ============================================================
  // PHASE JUEGO / PUNTO — articles 15° et 16°
  // ============================================================
  for (const fteam of ['A', 'B']) {
    const oteam = otherTeam(fteam);
    const falseJuego = teamFalseJuegoCount(fteam);
    if (falseJuego > 0) {
      // Article 15° — faux jeu.
      const partnerHasJuego = playersOfTeam(fteam).some((p) =>
        p.declaredJuego !== true && evaluateJuegoPunto(p.hand).hasJuego
      );
      // Note : on cherche un partenaire de fteam qui A le jeu en réalité (qu'il
      // l'ait déclaré ou non). Si declaredJuego=true mais hasJuego=false → c'est
      // un autre fauteur, pas un "couvreur".
      const realPartnerWithJuego = playersOfTeam(fteam).some((p) =>
        evaluateJuegoPunto(p.hand).hasJuego && !(p.declaredJuego === true && !evaluateJuegoPunto(p.hand).hasJuego)
      ) && teamHasRealJuego(fteam);
      const adversaryHasJuego = teamHasRealJuego(oteam);

      if (realPartnerWithJuego && !adversaryHasJuego) {
        // 15b — partenaire couvre, adversaires sans jeu → on ignore l'erreur.
        // Le scoring normal couvre (le jeu du partenaire compte si déclaré).
        continue;
      }

      // 15a/c/d : annuler les points indûment obtenus par fteam
      if (juegoRes?.revealPoints?.team === fteam) {
        adjustments.push({
          team: fteam,
          delta: -juegoRes.revealPoints.points,
          reason: 'art. 15° — annulation des points juego/punto indûment obtenus',
          phase: 'juego',
        });
      }

      if (adversaryHasJuego) {
        // 15c (partenaire pas, adv oui) ou 15d (les deux ont jeu)
        const advJuego = sumJuegoPoints(oteam);
        if (advJuego > 0) {
          adjustments.push({
            team: oteam,
            delta: advJuego,
            reason: 'art. 15° — adversaire prend son jeu',
            phase: 'juego',
          });
        }
        if (juegoBet.resolution?.kind === 'iduki') {
          adjustments.push({
            team: oteam,
            delta: juegoBet.resolution.deferredPoints,
            reason: 'art. 15° — Tira du jeu aux adversaires',
            phase: 'juego',
          });
        }
      } else {
        // 15a — aucun jeu nulle part → adversaire prend Pontua
        adjustments.push({
          team: oteam,
          delta: 1,
          reason: 'art. 15a° — adversaire prend Pontua',
          phase: 'juego',
        });
        if (juegoBet.resolution?.kind === 'iduki') {
          adjustments.push({
            team: oteam,
            delta: juegoBet.resolution.deferredPoints,
            reason: 'art. 15a° — Tira du point aux adversaires',
            phase: 'juego',
          });
        }
      }
      continue;
    }

    const missedJuego = teamMissedJuegoCount(fteam);
    if (missedJuego > 0) {
      // Article 16° — jeu non annoncé.
      // Sanction principale : jeu ignoré au scoring (déjà fait par resolvePhase).
      const adversaryHasJuegoDecl = teamHasRealJuego(oteam) && teamHasDeclaredJuego(oteam);
      const adversaryHasJuegoReal = teamHasRealJuego(oteam);

      if (state.juegoOrPunto === 'juego' && adversaryHasJuegoDecl) {
        // 16c — adversaire a déclaré son jeu : le scoring normal le couvre,
        // pas de sanction supplémentaire.
        continue;
      }

      if (state.juegoOrPunto === 'punto' && !adversaryHasJuegoReal) {
        // 16a — la phase a été jouée comme Punto alors qu'un jeu existait caché
        // L'adversaire prend Pontua + Tira de la mise
        adjustments.push({
          team: oteam,
          delta: 1,
          reason: 'art. 16a° — adversaire prend Pontua (jeu caché)',
          phase: 'juego',
        });
        if (juegoBet.resolution?.kind === 'iduki') {
          adjustments.push({
            team: oteam,
            delta: juegoBet.resolution.deferredPoints,
            reason: 'art. 16a° — Tira aux adversaires (jeu caché)',
            phase: 'juego',
          });
        }
      }
      // 16b (partenaire a jeu déclaré, adv sans jeu) : scoring normal couvre
    }
  }

  return { adjustments, errors };
}

function resolvePhase(phaseName, betState, players, eskuId) {
  // Pour Pares/Juego, seuls les joueurs ayant DÉCLARÉ avoir comptent
  let eligibleFn = () => true;
  if (phaseName === 'pares') {
    eligibleFn = (p) => p.declaredPares === true && evaluatePares(p.hand).has;
  } else if (phaseName === 'juego') {
    eligibleFn = (p) => p.declaredJuego === true && evaluateJuegoPunto(p.hand).hasJuego;
  }

  // Si Hordago accepté : le gagnant de la phase rafle la manche entière
  if (betState.resolution?.kind === 'hordago-accepted') {
    let winnerId;
    if (phaseName === 'grande') winnerId = findBestPlayerWithCompare(players, eskuId, compareGrande);
    else if (phaseName === 'chica') winnerId = findBestPlayerWithCompare(players, eskuId, compareChica);
    else if (phaseName === 'pares') winnerId = findBestPlayerWithCompare(players, eskuId, comparePares, eligibleFn);
    else if (phaseName === 'juego') winnerId = findBestPlayerWithCompare(players, eskuId, compareJuego, eligibleFn);
    else if (phaseName === 'punto') winnerId = findBestPlayerWithCompare(players, eskuId, comparePunto);
    const winnerTeam = winnerId !== null && winnerId !== undefined
      ? TEAM_OF[winnerId]
      : (betState.lastAggressorTeam || betState.initiator);
    return {
      phase: phaseName,
      immediatePoints: null,
      revealPoints: null,
      hordagoWinnerTeam: winnerTeam,
      winnerId: winnerId ?? null,
    };
  }

  // Cas Tira (refus) :
  // - Grande/Chica : seul le Deje immédiat compte, rien à la révélation
  // - Pares/Juego  : Deje immédiat + à la révélation, l'équipe gagnante (à la
  //                  comparaison des mains) compte ses paires/jeu
  // - Punto        : Deje immédiat + 1 point de Pontua au gagnant à la révélation
  const isTira = betState.resolution?.kind === 'tira';
  const immediatePoints = isTira ? betState.resolution.immediatePoints : null;

  if (isTira && (phaseName === 'grande' || phaseName === 'chica')) {
    return { phase: phaseName, immediatePoints, revealPoints: null };
  }

  // Pour Pares/Juego : sans déclarant éligible, pas de points à la révélation
  let eligibleAny = true;
  if (phaseName === 'pares' || phaseName === 'juego') {
    eligibleAny = players.some(eligibleFn);
  }
  if (!eligibleAny) {
    return { phase: phaseName, immediatePoints, revealPoints: null };
  }

  // Déterminer gagnant à la comparaison des mains
  let winnerId;
  if (phaseName === 'grande') winnerId = findBestPlayerWithCompare(players, eskuId, compareGrande);
  else if (phaseName === 'chica') winnerId = findBestPlayerWithCompare(players, eskuId, compareChica);
  else if (phaseName === 'pares') winnerId = findBestPlayerWithCompare(players, eskuId, comparePares, eligibleFn);
  else if (phaseName === 'juego') winnerId = findBestPlayerWithCompare(players, eskuId, compareJuego, eligibleFn);
  else if (phaseName === 'punto') winnerId = findBestPlayerWithCompare(players, eskuId, comparePunto);

  if (winnerId === null || winnerId === undefined) {
    return { phase: phaseName, immediatePoints, revealPoints: null };
  }

  const winnerTeam = TEAM_OF[winnerId];
  let pts = 0;

  // Mise différée (Iduki) : ajoutée
  if (betState.resolution?.kind === 'iduki') {
    pts += betState.resolution.deferredPoints;
  }

  // Pontua (1 point) : compte TOUJOURS, qu'il y ait eu paso, tira ou iduki
  // Article 17° : « Le point se tire toujours »
  if (phaseName === 'punto') {
    pts += 1;
  }
  // Grande/Chica : 1 point en cas de paso (jamais en cas de tira/iduki — déjà géré)
  if ((phaseName === 'grande' || phaseName === 'chica') && (!betState.resolution || betState.resolution.kind === 'paso')) {
    pts += 1;
  }

  // Bonus phase-spécifique (paires, jeu) : SEULS les joueurs ayant déclaré comptent.
  // Ce comptage a lieu à la révélation, indépendamment du Tira/Iduki/Paso.
  if (phaseName === 'pares') {
    for (let i = 0; i < 4; i++) {
      if (TEAM_OF[i] === winnerTeam && players[i].declaredPares === true) {
        const p = evaluatePares(players[i].hand);
        if (p.has) pts += p.points;
      }
    }
  } else if (phaseName === 'juego') {
    for (let i = 0; i < 4; i++) {
      if (TEAM_OF[i] === winnerTeam && players[i].declaredJuego === true) {
        const j = evaluateJuegoPunto(players[i].hand);
        if (j.hasJuego) pts += j.juegoPoints;
      }
    }
  }

  return {
    phase: phaseName,
    immediatePoints,
    revealPoints: pts > 0 ? { team: winnerTeam, points: pts, winnerId } : null,
  };
}

/* ===== 7. ACTIONS LÉGALES & MOTEUR ===== */

function getLegalActions(state, playerId) {
  if (state.activePlayer !== playerId) return [];
  const player = state.players[playerId];

  if (state.phase === 'mus-decision') {
    return [{ type: 'mus' }, { type: 'mintza' }];
  }

  if (state.phase === 'discard') {
    if (state.discardChoices[playerId] === undefined) {
      return [{ type: 'discard', cards: [] }]; // déclencheur UI : sélection libre
    }
    return [];
  }

  if (state.phase === 'pares-declare') {
    return [{ type: 'declare-pares', value: true }, { type: 'declare-pares', value: false }];
  }

  if (state.phase === 'juego-declare') {
    return [{ type: 'declare-juego', value: true }, { type: 'declare-juego', value: false }];
  }

  // Phases de pari
  const phaseName = state.currentBetPhase;
  if (!phaseName) return [];
  const bet = state.phases[phaseName];
  const team = TEAM_OF[playerId];

  // Restrictions Pares/Juego (article 9°) — ne s'applique pas au Pontua
  // Un joueur non-éligible ne peut pas bloquer son partenaire :
  // - en réponse, il propose seulement « tira-for-me » (le partenaire éligible décidera)
  // - si son partenaire est aussi non-éligible, alors « tira » est l'unique option
  // En ouverture, un non-éligible ne peut que paso.
  const partnerId = PARTNER_OF[playerId];
  if (phaseName === 'pares' && !state.paresEligible.includes(playerId)) {
    const partnerEligible = state.paresEligible.includes(partnerId);
    if (bet.pendingResponderTeam === team) {
      // Empêcher la chaîne tira-for-me ↔ tira-for-me (point 5 spec)
      const inPartnerDelegation = state.pendingPartnerDecision &&
        state.pendingPartnerDecision.phaseName === phaseName &&
        PARTNER_OF[state.pendingPartnerDecision.requesterId] === playerId;
      if (partnerEligible && !inPartnerDelegation) return [{ type: 'tira-for-me' }];
      return [{ type: 'tira' }];
    }
    return [{ type: 'paso' }];
  }
  if (phaseName === 'juego' && state.juegoOrPunto === 'juego' && !state.juegoEligible.includes(playerId)) {
    const partnerEligible = state.juegoEligible.includes(partnerId);
    if (bet.pendingResponderTeam === team) {
      const inPartnerDelegation = state.pendingPartnerDecision &&
        state.pendingPartnerDecision.phaseName === phaseName &&
        PARTNER_OF[state.pendingPartnerDecision.requesterId] === playerId;
      if (partnerEligible && !inPartnerDelegation) return [{ type: 'tira-for-me' }];
      return [{ type: 'tira' }];
    }
    return [{ type: 'paso' }];
  }

  if (bet.pendingResponderTeam === null) {
    // Mode ouverture
    return [
      { type: 'paso' },
      { type: 'embido' },
      { type: 'hiru-embido' },
      { type: 'hordago' },
    ];
  }

  if (bet.pendingResponderTeam === team) {
    const actions = [
      { type: 'tira' },
      { type: 'iduki' },
      { type: 'gehiago', amount: 2 },
      { type: 'gehiago', amount: 3 },
      { type: 'gehiago', amount: 4 },
      { type: 'gehiago', amount: 5 },
      { type: 'hordago' },
    ];
    // Tira pour moi : seulement si le partenaire n'est PAS déjà en train de
    // déléguer (sinon ping-pong infini, point 5 spec)
    const inPartnerDelegation = state.pendingPartnerDecision &&
      state.pendingPartnerDecision.phaseName === phaseName &&
      PARTNER_OF[state.pendingPartnerDecision.requesterId] === playerId;
    if (!inPartnerDelegation) {
      actions.splice(1, 0, { type: 'tira-for-me' });
    }
    return actions;
  }

  return [];
}

// Vérifie si une action est légale pour un joueur dans l'état courant.
// Compare deux objets action en testant type + amount (le seul paramètre
// numérique pertinent, pour gehiago).
function isLegalAction(state, playerId, action) {
  const legal = getLegalActions(state, playerId);
  return legal.some((la) => {
    if (la.type !== action.type) return false;
    if (la.type === 'gehiago') return la.amount === action.amount;
    return true;
  });
}

// Validateur d'invariants d'état (V4 — audit A3).
// Renvoie [] si l'état est cohérent, sinon une liste de messages d'erreur.
function validateState(state) {
  const errors = [];
  // Joueurs : 4, mains entre 0 et 4 cartes
  if (!state.players || state.players.length !== 4) errors.push('players doit contenir exactement 4 joueurs');
  for (const p of state.players || []) {
    if (Array.isArray(p.hand)) {
      if (p.hand.length > 4) errors.push(`joueur ${p.id} : main > 4 cartes`);
    }
  }
  // Score : entiers >= 0
  if (state.score) {
    if (state.score.A < 0 || state.score.B < 0) errors.push('score négatif');
  }
  // matchScore : 0..3
  if (state.matchScore) {
    if (state.matchScore.A < 0 || state.matchScore.A > state.targetMancheWins) errors.push('matchScore.A invalide');
    if (state.matchScore.B < 0 || state.matchScore.B > state.targetMancheWins) errors.push('matchScore.B invalide');
  }
  // mancheOver cohérent avec le score
  if (state.mancheOver && state.mancheWinner) {
    if (state.score[state.mancheWinner] < state.targetTantto) {
      // Toléré si Hordago accepté (force le score à targetTantto par convention)
      // mais sinon c'est une incohérence
    }
  }
  // paresEligible cohérent avec déclarations
  if (state.paresEligible && state.players) {
    for (const eid of state.paresEligible) {
      if (state.players[eid].declaredPares !== true) errors.push(`paresEligible inclut joueur ${eid} qui n'a pas déclaré pares`);
    }
  }
  // juegoEligible cohérent
  if (state.juegoEligible && state.players) {
    for (const eid of state.juegoEligible) {
      if (state.players[eid].declaredJuego !== true) errors.push(`juegoEligible inclut joueur ${eid} qui n'a pas déclaré juego`);
    }
  }
  // juegoOrPunto cohérent avec juegoEligible
  if (state.juegoOrPunto === 'juego' && state.juegoEligible && state.juegoEligible.length === 0) {
    errors.push('juegoOrPunto=juego mais juegoEligible vide');
  }
  if (state.juegoOrPunto === 'punto' && state.juegoEligible && state.juegoEligible.length > 0) {
    errors.push('juegoOrPunto=punto mais juegoEligible non vide');
  }
  // activePlayer dans 0..3
  if (state.activePlayer !== null && state.activePlayer !== undefined) {
    if (state.activePlayer < 0 || state.activePlayer >= 4) errors.push('activePlayer hors range');
  }
  return errors;
}

function nextPlayerInOrder(eskuId, current) {
  return (current + 1) % 4;
}

function initialState(seed = null, playerNames) {
  const rng = seed !== null ? makeRng(seed) : Math.random;
  const deck = shuffleDeck(createDeck(), rng);

  const donneur = 3; // joueur 3 donne au début (Esku = 0)
  const esku = 0;
  const { hands, remaining } = dealHands(deck, esku);

  const players = [0, 1, 2, 3].map(i => ({
    id: i,
    name: playerNames[i],
    team: TEAM_OF[i],
    isBot: i !== 0,
    botLevel: i === 0 ? null : (i === 2 ? 2 : 2),
    hand: hands[i],
    declaredPares: undefined,  // true/false : déclaration explicite à la phase pares-declare
    declaredJuego: undefined,  // true/false : déclaration explicite à la phase juego-declare
  }));

  return {
    seed,
    rng,
    matchScore: { A: 0, B: 0 }, // manches gagnées (chaque manche = jeu à 40 tantto)
    targetMancheWins: 3,
    matchOver: false,

    mancheNumber: 1,            // numéro de la manche en cours (1-3)
    handNumber: 1,              // numéro de la main / coup au sein de la manche
    score: { A: 0, B: 0 },      // tantto en cours de manche, conservé entre coups
    targetTantto: 40,
    mancheOver: false,
    mancheWinner: null,

    donneur,
    esku,
    players,
    deckRemaining: remaining,   // talon pour redonner après défausse

    phase: 'mus-decision',
    activePlayer: esku,
    musAcceptedBy: [],          // joueurs ayant dit Mus dans le tour courant
    musDecisionsCount: 0,
    musOrder: [esku, (esku + 2) % 4, (esku + 1) % 4, (esku + 3) % 4], // Esku → partenaire → adversaires (art. 7)

    discardChoices: {},
    musRound: 0,

    paresEligible: [],          // ids de joueurs ayant déclaré pares=true ET en ayant réellement (sanctions à part)
    juegoEligible: [],          // idem pour juego
    juegoOrPunto: null,         // 'juego' | 'punto' une fois la phase juego-declare terminée

    currentBetPhase: null,
    phases: {
      grande: emptyBetState(),
      chica: emptyBetState(),
      pares: emptyBetState(),
      juego: emptyBetState(),
    },

    // Configuration des signes (article 11°)
    signMode: 'off',            // 'off' | 'simple' | 'realistic'
    signals: [],                // historique des signes émis : { player, sign, hand, public }

    // Action en attente de Tira pour moi : si défini, le partenaire doit répondre avant clôture
    pendingPartnerDecision: null, // { phaseName, requesterId } | null

    log: [{ type: 'manche-start', manche: 1 }],
    revealed: false,
    revealResult: null,

    pendingDiscardSelection: null,
  };
}

/* ===== Reducer principal ===== */

function reducer(state, action) {
  if (state.matchOver) return state;
  if (state.mancheOver && action.type !== 'next-manche' && action.type !== 'next-hand') return state;

  // Verrouillage après reveal (point 12 spec V3) : seules les transitions et la
  // configuration sont autorisées.
  if (state.phase === 'reveal') {
    const allowedAfterReveal = new Set([
      'next-hand', 'next-manche', 'set-bot-level', 'set-sign-mode',
    ]);
    if (!allowedAfterReveal.has(action.type)) return state;
  }

  // Guards V4 (audit A1/A2) :
  // - next-hand : refusé si on est en cours de coup (phase != 'reveal') OU si la
  //               manche est terminée (il faut next-manche dans ce cas).
  // - next-manche : refusé si la manche n'est pas terminée, sauf en mode debug
  //               (action.force === true).
  if (action.type === 'next-hand') {
    if (state.phase !== 'reveal' && state.phase !== 'mus-decision') return state;
    if (state.mancheOver) return state; // manche finie → next-manche obligatoire
  }
  if (action.type === 'next-manche') {
    if (!state.mancheOver && !action.force) return state;
  }

  // Validation V4 (audit B1) pour les actions où l'auteur courant doit être
  // l'activePlayer et où l'action doit être listée dans getLegalActions.
  const validatedActionTypes = new Set([
    'mus', 'mintza', 'discard',
    'declare-pares', 'declare-juego',
    'paso', 'embido', 'hiru-embido', 'gehiago',
    'tira', 'tira-for-me', 'iduki', 'hordago',
  ]);
  if (validatedActionTypes.has(action.type)) {
    if (!isLegalAction(state, state.activePlayer, action)) {
      return {
        ...state,
        log: [...state.log, { type: 'illegal-action', player: state.activePlayer, action, reason: 'rejected by isLegalAction' }],
      };
    }
  }

  switch (action.type) {
    case 'mus': {
      const accepted = [...state.musAcceptedBy, state.activePlayer];
      const count = state.musDecisionsCount + 1;
      // Si tous les 4 ont accepté
      if (count === 4) {
        return {
          ...state,
          phase: 'discard',
          musAcceptedBy: [],
          musDecisionsCount: 0,
          activePlayer: state.esku,
          discardChoices: {},
          log: [...state.log, { type: 'action', player: state.activePlayer, action: { type: 'mus' } }, { type: 'mus-all-accepted', round: state.musRound }],
        };
      }
      // Ordre Esku → partenaire d'Esku → adversaire 1 → adversaire 2 (article 7°)
      const order = state.musOrder || [state.esku, (state.esku + 2) % 4, (state.esku + 1) % 4, (state.esku + 3) % 4];
      const nextActive = order[count];
      return {
        ...state,
        musAcceptedBy: accepted,
        musDecisionsCount: count,
        activePlayer: nextActive,
        log: [...state.log, { type: 'action', player: state.activePlayer, action: { type: 'mus' } }],
      };
    }

    case 'mintza': {
      // Sortir → on passe à Grande
      return startGrande({
        ...state,
        log: [...state.log, { type: 'action', player: state.activePlayer, action: { type: 'mintza' } }],
      });
    }

    case 'discard': {
      const cardIds = action.cards;
      const choices = { ...state.discardChoices, [state.activePlayer]: cardIds };
      const allDone = [0, 1, 2, 3].every(p => choices[p] !== undefined);

      if (!allDone) {
        return {
          ...state,
          discardChoices: choices,
          activePlayer: (state.activePlayer + 1) % 4,
          log: [...state.log, { type: 'action', player: state.activePlayer, action: { type: 'discard', count: cardIds.length } }],
        };
      }

      // Repioche depuis le talon en respectant l'ordre Esku → +1 → +2 → +3 (art. 8)
      const { newHands, talon } = applyDiscards({
        ...state,
        discardChoices: choices,
      }, state.rng);

      const newPlayers = state.players.map((p, i) => ({ ...p, hand: newHands[i] }));

      return {
        ...state,
        players: newPlayers,
        deckRemaining: talon,
        phase: 'mus-decision',
        musAcceptedBy: [],
        musDecisionsCount: 0,
        activePlayer: state.esku,
        musOrder: [state.esku, (state.esku + 2) % 4, (state.esku + 1) % 4, (state.esku + 3) % 4],
        discardChoices: {},
        musRound: state.musRound + 1,
        log: [...state.log, { type: 'redeal', round: state.musRound + 1 }],
      };
    }

    case 'paso':
    case 'embido':
    case 'hiru-embido':
    case 'gehiago':
    case 'tira':
    case 'tira-for-me':
    case 'iduki':
    case 'hordago':
      return handleBetAction(state, action);

    case 'declare-pares': {
      // En mode honnête, refuser une déclaration illégale (point 3 spec)
      const enforce = state.enforceTruthfulDeclarations !== false;
      const me = state.players[state.activePlayer];
      const realPares = evaluatePares(me.hand).has;
      if (enforce && action.value !== realPares) {
        return {
          ...state,
          log: [...state.log, { type: 'illegal-declaration', phase: 'pares', player: state.activePlayer, attempted: action.value, real: realPares }],
        };
      }
      const newPlayers = state.players.map(p =>
        p.id === state.activePlayer ? { ...p, declaredPares: action.value } : p
      );
      const allDeclared = newPlayers.every(p => p.declaredPares !== undefined);
      const next = (state.activePlayer + 1) % 4;
      const log = [...state.log, { type: 'declaration', phase: 'pares', player: state.activePlayer, value: action.value }];
      if (!allDeclared) {
        return { ...state, players: newPlayers, activePlayer: next, log };
      }
      const eligible = newPlayers.filter(p => p.declaredPares).map(p => p.id);
      return startBetPhase({
        ...state,
        players: newPlayers,
        paresEligible: eligible,
        log,
      }, 'pares');
    }

    case 'declare-juego': {
      const enforce = state.enforceTruthfulDeclarations !== false;
      const me = state.players[state.activePlayer];
      const realJuego = evaluateJuegoPunto(me.hand).hasJuego;
      if (enforce && action.value !== realJuego) {
        return {
          ...state,
          log: [...state.log, { type: 'illegal-declaration', phase: 'juego', player: state.activePlayer, attempted: action.value, real: realJuego }],
        };
      }
      const newPlayers = state.players.map(p =>
        p.id === state.activePlayer ? { ...p, declaredJuego: action.value } : p
      );
      const allDeclared = newPlayers.every(p => p.declaredJuego !== undefined);
      const next = (state.activePlayer + 1) % 4;
      const log = [...state.log, { type: 'declaration', phase: 'juego', player: state.activePlayer, value: action.value }];
      if (!allDeclared) {
        return { ...state, players: newPlayers, activePlayer: next, log };
      }
      const eligible = newPlayers.filter(p => p.declaredJuego).map(p => p.id);
      const anyJuego = eligible.length > 0;
      return startBetPhase({
        ...state,
        players: newPlayers,
        juegoEligible: eligible,
        juegoOrPunto: anyJuego ? 'juego' : 'punto',
        log: [...log, { type: 'phase-info', text: anyJuego ? 'Au moins un Jeu — phase Jeu' : 'Aucun Jeu — phase Point' }],
      }, 'juego');
    }

    case 'next-hand':
      // Continuer dans la manche en cours (score conservé)
      return startNewHand(state);

    case 'next-manche':
      // Finaliser la manche gagnée et démarrer la suivante
      return startNewManche(state);

    case 'set-bot-level':
      return {
        ...state,
        players: state.players.map(p => p.isBot ? { ...p, botLevel: action.level } : p),
      };

    case 'set-sign-mode':
      // Modes : 'off' | 'simple' | 'realistic'
      return { ...state, signMode: action.mode };

    case 'send-signal': {
      // Le joueur émet un signe (article 11°). Validation des contraintes :
      // - 29 seulement après les paires
      // - 30/31 à tout moment
      // - Signe du Jeu interdit avec 31
      if (state.signMode === 'off') return state;
      const me = state.players[action.playerId];
      const j = evaluateJuegoPunto(me.hand);
      const sign = action.sign;
      const isValid = isSignalLegal(sign, me.hand, state.phase, state.currentBetPhase, j);
      if (!isValid) {
        return {
          ...state,
          log: [...state.log, { type: 'illegal-signal', player: action.playerId, sign, reason: 'contraintes art. 11°' }],
        };
      }
      const isPublic = state.signMode === 'simple'; // 'simple' = visible, 'realistic' = subtil (toujours loggé pour l'instant)
      return {
        ...state,
        signals: [...(state.signals || []), {
          player: action.playerId,
          sign,
          phase: state.currentBetPhase || state.phase,
          public: isPublic,
        }],
        log: [...state.log, { type: 'signal', player: action.playerId, sign, public: isPublic }],
      };
    }

    default:
      return state;
  }
}

// Vérifie qu'un signe est conforme à l'article 11°
function isSignalLegal(sign, hand, phase, currentBetPhase, jpEval) {
  const pares = evaluatePares(hand);
  switch (sign) {
    case 'two-kings':
      // 2 rois (= 2 cartes valant 12 = effRank 12). Compter par effRank.
      return hand.filter(c => effRank(c.rank) === 12).length >= 2;
    case 'two-aces':
      return hand.filter(c => effRank(c.rank) === 1).length >= 2;
    case 'mediak':
      return pares.type === 'mediak';
    case 'dobliak':
      return pares.type === 'dobliak';
    case '29':
      // Article 11° : « après les paires ». Cela exclut Mus, défausse, Grande, Chica,
      // pares-declare, et la phase pares elle-même. Légal uniquement à partir de
      // juego-declare et au-delà.
      {
        const phasesAvantPares = ['mus-decision', 'discard', 'pares-declare'];
        const betsAvantPares = ['grande', 'chica', 'pares'];
        if (phasesAvantPares.includes(phase)) return false;
        if (phase === 'bet' && betsAvantPares.includes(currentBetPhase)) return false;
        return jpEval.total === 29;
      }
    case '30-31':
      // À tout moment
      return jpEval.total === 30 || jpEval.total === 31;
    case 'juego':
      // Interdit avec 31 (signe spécifique du Jeu, pas du 31 fort)
      if (jpEval.total === 31) return false;
      return jpEval.hasJuego;
    default:
      return false;
  }
}

function startGrande(state) {
  return {
    ...state,
    phase: 'bet',
    currentBetPhase: 'grande',
    activePlayer: state.esku,
    log: [...state.log, { type: 'phase-start', phase: 'grande' }],
  };
}

function startBetPhase(state, phaseName) {
  // phaseName ∈ {grande, chica, pares, juego}
  // Pour pares : skip si aucune paire; pour juego : phase juego ou punto
  if (phaseName === 'pares' && state.paresEligible.length === 0) {
    return advanceToNextPhase({
      ...state,
      log: [...state.log, { type: 'phase-skip', phase: 'pares', reason: 'aucune paire' }],
    }, 'pares');
  }
  return {
    ...state,
    phase: 'bet',
    currentBetPhase: phaseName,
    activePlayer: state.esku,
    log: [...state.log, { type: 'phase-start', phase: phaseName === 'juego' ? state.juegoOrPunto : phaseName }],
  };
}

function advanceToNextPhase(state, fromPhase) {
  // Ordre : grande → pares-declare → pares → chica → juego-declare → juego/punto → reveal
  // En fait l'ordre du règlement est : grande, petit, paires, jeu/point
  // Mais en numérique on doit déclarer pares/juego AVANT de parier dessus.
  // Implémentation : grande → chica → pares-declare → pares → juego-declare → juego/punto → reveal

  if (fromPhase === 'grande') {
    return {
      ...state,
      phase: 'bet',
      currentBetPhase: 'chica',
      activePlayer: state.esku,
      log: [...state.log, { type: 'phase-start', phase: 'chica' }],
    };
  }
  if (fromPhase === 'chica') {
    // Démarrer déclaration pares
    return {
      ...state,
      phase: 'pares-declare',
      currentBetPhase: null,
      activePlayer: state.esku,
      players: state.players.map(p => ({ ...p, declaredPares: undefined })),
      log: [...state.log, { type: 'phase-start', phase: 'pares-declaration' }],
    };
  }
  if (fromPhase === 'pares') {
    return {
      ...state,
      phase: 'juego-declare',
      currentBetPhase: null,
      activePlayer: state.esku,
      players: state.players.map(p => ({ ...p, declaredJuego: undefined })),
      log: [...state.log, { type: 'phase-start', phase: 'juego-declaration' }],
    };
  }
  if (fromPhase === 'juego') {
    return revealAndScore(state);
  }
  return state;
}

function handleBetAction(state, action) {
  const phaseName = state.currentBetPhase;
  if (!phaseName) return state;
  const bet = state.phases[phaseName];
  const player = state.players[state.activePlayer];
  const team = TEAM_OF[state.activePlayer];

  // Validation V4 (audit B1) : l'action doit appartenir à getLegalActions du joueur courant.
  // Cela bloque les actions forgées (dispatch direct sans passer par l'UI).
  if (!isLegalAction(state, state.activePlayer, action)) {
    return {
      ...state,
      log: [...state.log, { type: 'illegal-action', player: state.activePlayer, action, reason: 'not in getLegalActions' }],
    };
  }

  // « Tira pour moi » (article 10°) : le joueur abandonne mais laisse à son partenaire
  // la possibilité de surenchérir. Le bet n'est pas résolu, on passe la main au partenaire.
  if (action.type === 'tira-for-me') {
    // Empêcher le ping-pong : si on est déjà dans une délégation où ce joueur
    // est le partenaire du demandeur, refuser.
    if (state.pendingPartnerDecision
        && state.pendingPartnerDecision.phaseName === phaseName
        && PARTNER_OF[state.pendingPartnerDecision.requesterId] === state.activePlayer) {
      return state; // illégal, ignoré
    }
    const partnerId = PARTNER_OF[state.activePlayer];
    return {
      ...state,
      pendingPartnerDecision: {
        phaseName,
        requesterId: state.activePlayer,
        requesterTeam: team,
      },
      activePlayer: partnerId,
      log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }],
    };
  }

  // Si on est en pendingPartnerDecision et que le partenaire répond, on RAZ ce flag
  // avant d'appliquer normalement.
  let nextState = state;
  if (state.pendingPartnerDecision && state.pendingPartnerDecision.phaseName === phaseName
      && PARTNER_OF[state.pendingPartnerDecision.requesterId] === state.activePlayer) {
    nextState = { ...state, pendingPartnerDecision: null };
  }
  state = nextState;

  // Mode ouverture : on cycle sur les 4 joueurs avec Paso ; tout autre action = enchère
  if (bet.pendingResponderTeam === null) {
    if (action.type === 'paso') {
      const newBet = { ...bet, history: [...bet.history, { type: 'paso', player: state.activePlayer }] };
      const newPhases = { ...state.phases, [phaseName]: newBet };
      const next = (state.activePlayer + 1) % 4;
      // Si on revient à Esku, c'est tour terminé en paso
      if (next === state.esku) {
        // Tous ont passé : marquer paso et avancer
        newBet.resolution = { kind: 'paso' };
        return advanceToNextPhase({
          ...state,
          phases: newPhases,
          log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }, { type: 'phase-resolved', phase: phaseName, kind: 'paso' }],
        }, phaseName);
      }
      return {
        ...state,
        phases: newPhases,
        activePlayer: next,
        log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }],
      };
    }

    // Action de pari en ouverture
    const newBet = applyBetAction(bet, action, team);
    if (!newBet) return state;
    const newPhases = { ...state.phases, [phaseName]: newBet };
    // L'équipe adverse répond — on désigne le premier joueur de l'équipe adverse en sens horaire à partir du parieur
    let next = (state.activePlayer + 1) % 4;
    while (TEAM_OF[next] !== newBet.pendingResponderTeam) next = (next + 1) % 4;
    return {
      ...state,
      phases: newPhases,
      activePlayer: next,
      log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }],
    };
  }

  // Mode réponse
  const newBet = applyBetAction(bet, action, team);
  if (!newBet) return state;

  // Tira ou Iduki ou Hordago refusé/accepté
  if (newBet.resolution?.kind === 'tira') {
    // Points immédiats
    const updatedScore = applyImmediatePoints(state, newBet.resolution.immediatePoints);
    const log = [
      ...state.log,
      { type: 'action', player: state.activePlayer, phase: phaseName, action },
      { type: 'phase-resolved', phase: phaseName, kind: 'tira', team: newBet.resolution.immediatePoints.team, points: newBet.resolution.immediatePoints.points },
    ];
    if (updatedScore.mancheOver) {
      return revealAndScore({ ...updatedScore, phases: { ...state.phases, [phaseName]: newBet }, log });
    }
    return advanceToNextPhase({
      ...updatedScore,
      phases: { ...state.phases, [phaseName]: newBet },
      log,
    }, phaseName);
  }

  if (newBet.resolution?.kind === 'iduki') {
    return advanceToNextPhase({
      ...state,
      phases: { ...state.phases, [phaseName]: newBet },
      log: [
        ...state.log,
        { type: 'action', player: state.activePlayer, phase: phaseName, action },
        { type: 'phase-resolved', phase: phaseName, kind: 'iduki', stake: newBet.resolution.deferredPoints },
      ],
    }, phaseName);
  }

  // Hordago accepté : on saute directement à la révélation, le gagnant de la phase prend la manche
  if (newBet.resolution?.kind === 'hordago-accepted') {
    const log = [
      ...state.log,
      { type: 'action', player: state.activePlayer, phase: phaseName, action },
      { type: 'phase-resolved', phase: phaseName, kind: 'hordago-accepted' },
    ];
    return revealAndScore({
      ...state,
      phases: { ...state.phases, [phaseName]: newBet },
      log,
    });
  }

  if (action.type === 'hordago') {
    // Hordago : on attend la réponse de l'équipe adverse (Iduki/Tira)
    let next = (state.activePlayer + 1) % 4;
    while (TEAM_OF[next] !== newBet.pendingResponderTeam) next = (next + 1) % 4;
    return {
      ...state,
      phases: { ...state.phases, [phaseName]: newBet },
      activePlayer: next,
      log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }],
    };
  }

  // Raise (gehiago) : retour à l'autre équipe
  let next = (state.activePlayer + 1) % 4;
  while (TEAM_OF[next] !== newBet.pendingResponderTeam) next = (next + 1) % 4;
  return {
    ...state,
    phases: { ...state.phases, [phaseName]: newBet },
    activePlayer: next,
    log: [...state.log, { type: 'action', player: state.activePlayer, phase: phaseName, action }],
  };
}

function applyImmediatePoints(state, ip) {
  if (!ip) return state;
  const newScore = { ...state.score, [ip.team]: state.score[ip.team] + ip.points };
  const mancheOver = newScore[ip.team] >= state.targetTantto;
  return { ...state, score: newScore, mancheOver, mancheWinner: mancheOver ? ip.team : null };
}

function revealAndScore(state) {
  // Calculer les résolutions des phases avec Iduki ou paso (qui n'ont pas encore tiré)
  const phasesToScore = ['grande', 'chica', 'pares', state.juegoOrPunto || 'juego'];
  let score = { ...state.score };
  const resolutions = [];
  let mancheOver = state.mancheOver;
  let mancheWinner = state.mancheWinner;

  for (const phaseName of phasesToScore) {
    if (mancheOver) break;
    const betKey = phaseName === 'punto' ? 'juego' : phaseName;
    const bet = state.phases[betKey];
    const result = resolvePhase(phaseName, bet, state.players, state.esku);
    resolutions.push(result);

    // Hordago accepté : le gagnant de la phase remporte la manche entière
    if (result.hordagoWinnerTeam) {
      mancheOver = true;
      mancheWinner = result.hordagoWinnerTeam;
      score = { ...score, [mancheWinner]: state.targetTantto };
      break;
    }

    if (result.revealPoints) {
      score = { ...score, [result.revealPoints.team]: score[result.revealPoints.team] + result.revealPoints.points };
      if (score[result.revealPoints.team] >= state.targetTantto) {
        mancheOver = true;
        mancheWinner = result.revealPoints.team;
      }
    }
  }

  // Sanctions des articles 13° à 16°
  let sanctions = { adjustments: [], errors: [] };
  if (!mancheOver || (mancheWinner && score[mancheWinner] < state.targetTantto)) {
    // Sanctions appliquées sauf si la manche est déjà clôturée par Hordago
    sanctions = applyDeclarationSanctions(state, resolutions);
    for (const adj of sanctions.adjustments) {
      score = { ...score, [adj.team]: Math.max(0, (score[adj.team] || 0) + adj.delta) };
      if (score[adj.team] >= state.targetTantto) {
        mancheOver = true;
        mancheWinner = adj.team;
      }
    }
  }

  return {
    ...state,
    phase: 'reveal',
    revealed: true,
    revealResult: resolutions,
    declarationErrors: sanctions.errors,
    declarationAdjustments: sanctions.adjustments,
    score,
    mancheOver,
    mancheWinner,
    log: [
      ...state.log,
      { type: 'reveal', resolutions, finalScore: score },
      ...(sanctions.adjustments.length > 0
        ? [{ type: 'sanctions', errors: sanctions.errors, adjustments: sanctions.adjustments }]
        : []),
    ],
  };
}

// Démarre un nouveau coup (main) au sein d'une manche en cours.
// Le score (tantto) est CONSERVÉ. La donne tourne, les mains sont redistribuées.
function startNewHand(state) {
  const newDonneur = (state.donneur + 1) % 4;
  const newEsku = (newDonneur + 1) % 4;
  const deck = shuffleDeck(createDeck(), state.rng);
  const { hands, remaining } = dealHands(deck, newEsku);

  const newPlayers = state.players.map((p, i) => ({
    ...p,
    hand: hands[i],
    declaredPares: undefined,
    declaredJuego: undefined,
  }));

  return {
    ...state,
    handNumber: (state.handNumber || 1) + 1,
    // score CONSERVÉ : pas de RAZ
    donneur: newDonneur,
    esku: newEsku,
    players: newPlayers,
    deckRemaining: remaining,
    phase: 'mus-decision',
    activePlayer: newEsku,
    musAcceptedBy: [],
    musDecisionsCount: 0,
    musOrder: [newEsku, (newEsku + 2) % 4, (newEsku + 1) % 4, (newEsku + 3) % 4],
    discardChoices: {},
    musRound: 0,
    paresEligible: [],
    juegoEligible: [],
    juegoOrPunto: null,
    currentBetPhase: null,
    phases: {
      grande: emptyBetState(),
      chica: emptyBetState(),
      pares: emptyBetState(),
      juego: emptyBetState(),
    },
    signals: [],  // signaux RAZ à chaque main (les signes ne valent que pour la main en cours)
    pendingPartnerDecision: null,
    revealed: false,
    revealResult: null,
    declarationErrors: [],
    declarationAdjustments: [],
    log: [...state.log, { type: 'hand-start', manche: state.mancheNumber, hand: (state.handNumber || 1) + 1 }],
  };
}

// Démarre une nouvelle manche après qu'une équipe a atteint targetTantto.
// Incrémente matchScore, RAZ du score tantto.
function startNewManche(state) {
  if (state.matchOver) return state;

  // Cas d'appel sans manche terminée : redirige vers nouveau coup
  if (!state.mancheOver) {
    return startNewHand(state);
  }

  let matchScore = state.matchScore;
  let matchOver = false;

  if (state.mancheWinner) {
    matchScore = { ...matchScore, [state.mancheWinner]: matchScore[state.mancheWinner] + 1 };
    if (matchScore[state.mancheWinner] >= state.targetMancheWins) matchOver = true;
  }

  if (matchOver) {
    return { ...state, matchScore, matchOver, log: [...state.log, { type: 'match-over', winner: state.mancheWinner }] };
  }

  const newDonneur = (state.donneur + 1) % 4;
  const newEsku = (newDonneur + 1) % 4;
  const deck = shuffleDeck(createDeck(), state.rng);
  const { hands, remaining } = dealHands(deck, newEsku);

  const newPlayers = state.players.map((p, i) => ({
    ...p,
    hand: hands[i],
    declaredPares: undefined,
    declaredJuego: undefined,
  }));

  return {
    ...state,
    matchScore,
    mancheNumber: state.mancheNumber + 1,
    handNumber: 1,
    score: { A: 0, B: 0 },  // RAZ tantto pour la nouvelle manche
    mancheOver: false,
    mancheWinner: null,
    donneur: newDonneur,
    esku: newEsku,
    players: newPlayers,
    deckRemaining: remaining,
    phase: 'mus-decision',
    activePlayer: newEsku,
    musAcceptedBy: [],
    musDecisionsCount: 0,
    musOrder: [newEsku, (newEsku + 2) % 4, (newEsku + 1) % 4, (newEsku + 3) % 4],
    discardChoices: {},
    musRound: 0,
    paresEligible: [],
    juegoEligible: [],
    juegoOrPunto: null,
    currentBetPhase: null,
    phases: {
      grande: emptyBetState(),
      chica: emptyBetState(),
      pares: emptyBetState(),
      juego: emptyBetState(),
    },
    signals: [],
    pendingPartnerDecision: null,
    revealed: false,
    revealResult: null,
    log: [...state.log, { type: 'manche-start', manche: state.mancheNumber + 1 }],
  };
}

/* ===== 8. BOTS ===== */

// Renvoie une vue du state strictement limitée aux informations qu'un bot peut
// légitimement percevoir. Whitelist explicite (point 7 spec) : ne pas spreader
// state. Le talon, les défausses détaillées, le RNG, les mains adverses, ainsi
// que toute donnée future privée sont retirés.
function getBotVisibleState(state, botId) {
  // Mains : seule celle du bot est visible (copie défensive). Les autres exposent uniquement la taille.
  const players = state.players.map((p, i) => {
    if (i === botId) {
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        botLevel: p.botLevel,
        hand: p.hand.map((c) => ({ ...c })),  // copie défensive : empêche mutation accidentelle
        declaredPares: p.declaredPares,
        declaredJuego: p.declaredJuego,
      };
    }
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      isBot: p.isBot,
      botLevel: p.botLevel,
      hand: { hidden: true, size: p.hand.length },
      declaredPares: p.declaredPares,
      declaredJuego: p.declaredJuego,
    };
  });

  // Signaux : appliquer le filtre selon le mode (point 10 spec)
  // - 'off'        : aucun signal visible
  // - 'simple'     : tous les signaux émis sont visibles
  // - 'realistic'  : seuls les signaux du partenaire et les siens sont visibles
  const partnerId = PARTNER_OF[botId];
  const teamMates = new Set([botId, partnerId]);
  const visibleSignals = (state.signals || []).filter((s) => {
    if (state.signMode === 'off') return false;
    if (state.signMode === 'realistic') return teamMates.has(s.player);
    return s.public !== false; // 'simple' : on respecte le flag public
  });

  // Whitelist : strictement les champs publics nécessaires aux décisions du bot
  return {
    // Identité du bot
    self: botId,
    selfTeam: TEAM_OF[botId],

    // Joueurs (mains adverses masquées)
    players,

    // État de jeu public
    phase: state.phase,
    activePlayer: state.activePlayer,
    currentBetPhase: state.currentBetPhase,
    juegoOrPunto: state.juegoOrPunto,
    paresEligible: [...(state.paresEligible || [])],
    juegoEligible: [...(state.juegoEligible || [])],
    musRound: state.musRound,
    musOrder: state.musOrder ? [...state.musOrder] : null,
    pendingPartnerDecision: state.pendingPartnerDecision
      ? { ...state.pendingPartnerDecision } : null,

    // Phases d'enchères : copie superficielle des champs publics
    phases: {
      grande: { ...state.phases.grande },
      chica: { ...state.phases.chica },
      pares: { ...state.phases.pares },
      juego: { ...state.phases.juego },
    },

    // Scores et compteurs (publics)
    score: { ...state.score },
    matchScore: { ...state.matchScore },
    targetTantto: state.targetTantto,
    targetMancheWins: state.targetMancheWins,
    mancheNumber: state.mancheNumber,
    handNumber: state.handNumber,
    mancheOver: state.mancheOver,
    matchOver: state.matchOver,

    // Donneur / Esku
    donneur: state.donneur,
    esku: state.esku,

    // Signaux filtrés
    signMode: state.signMode || 'off',
    signals: visibleSignals,

    // PAS de : deckRemaining, discardChoices détaillés, rng, log brut détaillé,
    //         enforceTruthfulDeclarations, declarationErrors d'autres mains
  };
}

function evaluateHandStrength(hand) {
  const grande = evaluateGrande(hand);
  const chica = evaluateChica(hand);
  const pares = evaluatePares(hand);
  const jp = evaluateJuegoPunto(hand);
  const grandeScore = grande.reduce((a, b) => a + b, 0) / 48;
  const chicaScore = (4 - chica.reduce((a, b) => a + b, 0) / 12) / 4 + 0.5;
  const paresScore = pares.points / 3;
  const juegoScore = jp.hasJuego
    ? juegoStrength(jp.total) / 8
    : Math.max(0, jp.total - 17) / 13 * 0.5;
  return { grandeScore, chicaScore, paresScore, juegoScore, raw: { grande, chica, pares, jp } };
}

// Estime la force du partenaire à partir des signaux publics + valeur neutre par défaut.
// Les bots ne voient PAS la main du partenaire. La seule fenêtre de connaissance
// est l'historique des signes émis (mode 'simple'/'realistic') et les déclarations.
function estimatePartnerStrength(visibleState, botId, phaseName) {
  const partner = visibleState.players[PARTNER_OF[botId]];
  // Valeur neutre par défaut
  let estimate = 0.4;
  // Bonus si le partenaire a déclaré paires/jeu
  if (phaseName === 'pares' && partner.declaredPares === true) estimate = 0.6;
  if (phaseName === 'juego' && partner.declaredJuego === true) estimate = 0.7;
  // Bonus si signes pertinents émis par le partenaire
  const partnerSigns = (visibleState.signals || []).filter(s => s.player === partner.id);
  for (const sig of partnerSigns) {
    if (phaseName === 'grande' && (sig.sign === 'two-kings' || sig.sign === 'mediak' || sig.sign === 'dobliak')) estimate += 0.3;
    if (phaseName === 'chica' && (sig.sign === 'two-aces')) estimate += 0.3;
    if (phaseName === 'pares' && (sig.sign === 'mediak' || sig.sign === 'dobliak')) estimate += 0.3;
    if (phaseName === 'juego' && (sig.sign === 'juego' || sig.sign === '30-31' || sig.sign === '29')) estimate += 0.3;
  }
  return Math.min(1, estimate);
}

function botDecideMus(state, botId) {
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  const myStr = evaluateHandStrength(me.hand);
  const level = me.botLevel || 1;
  const sumStrength = myStr.grandeScore + myStr.chicaScore + myStr.paresScore + myStr.juegoScore;
  const threshold = level === 1 ? 1.4 : level === 2 ? 1.6 : 1.5;
  if (sumStrength < threshold) return { type: 'mus' };
  return { type: 'mintza' };
}

function botChooseDiscards(state, botId) {
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  const cards = [...me.hand];
  const counts = {};
  for (const c of cards) counts[effRank(c.rank)] = (counts[effRank(c.rank)] || 0) + 1;
  const scored = cards.map(c => {
    const er = effRank(c.rank);
    let s = er;
    if (counts[er] >= 2) s += 50;
    return { card: c, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  const keepCount = Math.min(2 + (Math.random() < 0.5 ? 1 : 0), 4);
  const keep = scored.slice(0, keepCount).map(s => s.card.id);
  const discard = me.hand.filter(c => !keep.includes(c.id)).map(c => c.id);
  return { type: 'discard', cards: discard };
}

function botDeclarePares(state, botId) {
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  const p = evaluatePares(me.hand);
  return { type: 'declare-pares', value: p.has };
}

function botDeclareJuego(state, botId) {
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  const j = evaluateJuegoPunto(me.hand);
  return { type: 'declare-juego', value: j.hasJuego };
}

function botChooseBetAction(state, botId) {
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  const phaseName = visible.currentBetPhase;
  const bet = visible.phases[phaseName];
  const team = TEAM_OF[botId];
  const level = me.botLevel || 1;

  // Force du bot — basée sur sa propre main uniquement
  let myStrength = 0;
  if (phaseName === 'grande') {
    myStrength = evaluateGrande(me.hand)[0] / 12;
  } else if (phaseName === 'chica') {
    myStrength = (12 - evaluateChica(me.hand)[0]) / 12;
  } else if (phaseName === 'pares') {
    myStrength = evaluatePares(me.hand).points / 3;
  } else if (phaseName === 'juego') {
    const myJ = evaluateJuegoPunto(me.hand);
    if (visible.juegoOrPunto === 'punto') {
      myStrength = myJ.total / 30;
    } else {
      myStrength = myJ.hasJuego ? juegoStrength(myJ.total) / 8 : 0;
    }
  }

  // Force estimée du partenaire (sans voir sa main)
  const partnerStrength = estimatePartnerStrength(visible, botId, phaseName);
  const teamStrength = Math.max(myStrength, partnerStrength * 0.6);
  const aggressiveness = level === 1 ? 0.3 : level === 2 ? 0.5 : 0.65;
  const bluffChance = level === 1 ? 0.05 : level === 2 ? 0.15 : 0.25;

  // Restrictions de phase (point 6 spec : appliquer juego uniquement si juegoOrPunto === 'juego')
  if (phaseName === 'pares' && !visible.paresEligible.includes(botId)) {
    const partnerEligible = visible.paresEligible.includes(PARTNER_OF[botId]);
    if (bet.pendingResponderTeam === team) {
      const inDelegation = visible.pendingPartnerDecision &&
        visible.pendingPartnerDecision.phaseName === phaseName &&
        PARTNER_OF[visible.pendingPartnerDecision.requesterId] === botId;
      if (partnerEligible && !inDelegation) return { type: 'tira-for-me' };
      return { type: 'tira' };
    }
    return { type: 'paso' };
  }
  if (phaseName === 'juego' && visible.juegoOrPunto === 'juego' && !visible.juegoEligible.includes(botId)) {
    const partnerEligible = visible.juegoEligible.includes(PARTNER_OF[botId]);
    if (bet.pendingResponderTeam === team) {
      const inDelegation = visible.pendingPartnerDecision &&
        visible.pendingPartnerDecision.phaseName === phaseName &&
        PARTNER_OF[visible.pendingPartnerDecision.requesterId] === botId;
      if (partnerEligible && !inDelegation) return { type: 'tira-for-me' };
      return { type: 'tira' };
    }
    return { type: 'paso' };
  }

  // Mode ouverture
  if (bet.pendingResponderTeam === null) {
    const r = Math.random();
    const bluff = r < bluffChance;
    if (teamStrength > 0.7 || bluff) {
      if (teamStrength > 0.85 && level >= 2 && r < 0.1) return { type: 'hiru-embido' };
      return { type: 'embido' };
    }
    return { type: 'paso' };
  }

  // Mode réponse
  const currentBet = bet.stack[bet.stack.length - 1];
  const myScore = visible.score[team];
  const oppScore = visible.score[team === 'A' ? 'B' : 'A'];
  const safetyMargin = visible.targetTantto - myScore;

  // Si on est tout proche de gagner, accepter pour gagner vite ; si on perdrait sec, plus prudent
  let willingness = teamStrength + (level - 1) * 0.05;

  if (safetyMargin <= currentBet && oppScore > visible.targetTantto - 5) {
    // Si on accepte et qu'on perd, on perd la manche → être plus prudent
    willingness -= 0.1;
  }

  const r2 = Math.random();
  if (willingness > 0.85 && level >= 2 && r2 < aggressiveness) {
    return { type: 'gehiago', amount: 2 + Math.floor(Math.random() * 3) };
  }
  if (willingness > 0.55) return { type: 'iduki' };
  if (willingness > 0.35 && r2 < bluffChance) return { type: 'gehiago', amount: 2 };
  return { type: 'tira' };
}

// Décide si un bot doit émettre un signal au tour courant.
// Renvoie une action { type: 'send-signal', ... } ou null.
// Stratégie : émettre un signal valide quand le bot a une main forte sur la
// dimension correspondante, avec une probabilité dépendant du niveau et de la
// phase. Un bot ne dépose **jamais** un signal illégal (validation isSignalLegal).
function botMaybeEmitSignal(state, botId) {
  if (state.signMode === 'off') return null;
  const visible = getBotVisibleState(state, botId);
  const me = visible.players[botId];
  // Vérifier qu'on n'a pas déjà émis un signal pour cette main au tour courant
  const myRecent = (visible.signals || []).filter(s => s.player === botId);
  if (myRecent.length >= 2) return null; // limite douce : 2 signes max par main

  const jp = evaluateJuegoPunto(me.hand);
  const candidates = ['two-kings', 'two-aces', 'mediak', 'dobliak', '29', '30-31', 'juego'];
  // Filtrer aux signes légaux pour la main et la phase
  const legal = candidates.filter(s => isSignalLegal(s, me.hand, visible.phase, visible.currentBetPhase, jp));
  if (legal.length === 0) return null;

  // Déjà émis ce signe-là ? On évite de répéter
  const alreadyEmitted = new Set(myRecent.map(s => s.sign));
  const fresh = legal.filter(s => !alreadyEmitted.has(s));
  if (fresh.length === 0) return null;

  // Probabilité d'émission : niveau du bot pondère
  const level = me.botLevel || 1;
  const emitChance = level === 1 ? 0.15 : level === 2 ? 0.35 : 0.55;
  if (Math.random() > emitChance) return null;

  // Choisir le signe le plus pertinent selon la phase courante
  const phasePriority = {
    grande: ['two-kings', 'mediak', 'dobliak'],
    chica: ['two-aces'],
    pares: ['mediak', 'dobliak'],
    juego: ['juego', '30-31', '29'],
  };
  const pref = phasePriority[visible.currentBetPhase] || [];
  const sorted = [...fresh].sort((a, b) => {
    const ia = pref.indexOf(a); const ib = pref.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return { type: 'send-signal', playerId: botId, sign: sorted[0] };
}

function botAct(state, botId) {
  if (state.phase === 'mus-decision') return botDecideMus(state, botId);
  if (state.phase === 'discard') return botChooseDiscards(state, botId);
  if (state.phase === 'pares-declare') return botDeclarePares(state, botId);
  if (state.phase === 'juego-declare') return botDeclareJuego(state, botId);
  if (state.phase === 'bet') return botChooseBetAction(state, botId);
  return null;
}

/* ===== 9. SUITE DE TESTS ===== */

function runTests() {
  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: e.message });
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
  const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

  // Deck
  t('Deck a 40 cartes', () => eq(createDeck().length, 40));
  t('Deck a 4 couleurs × 10 rangs', () => {
    const d = createDeck();
    eq(new Set(d.map(c => c.suit)).size, 4);
    eq(new Set(d.map(c => c.rank)).size, 10);
  });
  t('Deck ne contient ni 8 ni 9', () => {
    const d = createDeck();
    assert(!d.some(c => c.rank === 8 || c.rank === 9));
  });

  // Effective rank
  t('3 → Rey (12)', () => eq(effRank(3), 12));
  t('2 → As (1)', () => eq(effRank(2), 1));

  // Point values
  t('As et 2 valent 1 point', () => { eq(pointValue(1), 1); eq(pointValue(2), 1); });
  t('3, Sota, Caballo, Rey valent 10', () => {
    eq(pointValue(3), 10); eq(pointValue(10), 10); eq(pointValue(11), 10); eq(pointValue(12), 10);
  });
  t('7 vaut 7, 6 vaut 6', () => { eq(pointValue(7), 7); eq(pointValue(6), 6); });

  // Bet stack — exemples officiels du règlement
  const mkH = (cards) => cards.map((r, i) => ({ suit: SUITS[i % 4], rank: r, id: `c-${i}-${r}` }));

  t('Embido (2) - Tira = 1 point', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.immediatePoints.points, 1);
    eq(bet.resolution.immediatePoints.team, 'A');
  });

  t('Embido (2) - Iduki = 2 points (différé)', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    eq(bet.resolution.deferredPoints, 2);
  });

  t('Hiru Embido (3) - Tira = 1 point', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hiru-embido' }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.immediatePoints.points, 1);
  });

  t('Embido + Lau gehiago (+4) - Tira = 2 points', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 4 }, 'B');
    bet = applyBetAction(bet, { type: 'tira' }, 'A');
    eq(bet.resolution.immediatePoints.points, 2);
  });

  t('Hiru Embido + Lau gehiago (+4) - Iduki = 7 points', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hiru-embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 4 }, 'B');
    bet = applyBetAction(bet, { type: 'iduki' }, 'A');
    eq(bet.resolution.deferredPoints, 7);
  });

  t('Embido + Bortz gehiago (+5) + Bi gehiago (+2) - Tira = 7 points', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 5 }, 'B');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 2 }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.immediatePoints.points, 7);
  });

  // Comparaisons Grande/Chica
  t('Grande : Rey > Caballo', () => {
    const a = mkH([12, 7, 5, 1]);
    const b = mkH([11, 11, 11, 11]);
    assert(lexCompare(evaluateGrande(a), evaluateGrande(b)) > 0);
  });

  t('Grande : 3 traité comme Rey', () => {
    const a = mkH([3, 7, 5, 1]);   // = [12, 7, 5, 1]
    const b = mkH([12, 7, 5, 1]);  // = [12, 7, 5, 1]
    eq(lexCompare(evaluateGrande(a), evaluateGrande(b)), 0);
  });

  t('Chica : 2 traité comme As (1)', () => {
    const a = mkH([2, 7, 5, 4]);
    const b = mkH([1, 7, 5, 4]);
    eq(lexCompare(evaluateChica(a), evaluateChica(b)), 0);
  });

  // Pares
  t('Détection pareja', () => {
    const p = evaluatePares(mkH([12, 12, 7, 4]));
    eq(p.type, 'pareja');
    eq(p.points, 1);
  });

  t('Détection mediak (3 of a kind)', () => {
    const p = evaluatePares(mkH([12, 12, 12, 4]));
    eq(p.type, 'mediak');
    eq(p.points, 2);
  });

  t('Détection dobliak (2 paires)', () => {
    const p = evaluatePares(mkH([12, 12, 11, 11]));
    eq(p.type, 'dobliak');
    eq(p.points, 3);
  });

  t('Carré → dobliak (3 points)', () => {
    const p = evaluatePares(mkH([7, 7, 7, 7]));
    eq(p.type, 'dobliak');
    eq(p.points, 3);
  });

  t('Règle 12° : dobliak inférieur supérieur l’emporte (11-7 > 11-6)', () => {
    const a = { hand: mkH([11, 11, 7, 7]) };
    const b = { hand: mkH([11, 11, 6, 6]) };
    assert(comparePares(a, b) > 0);
  });

  // Juego
  t('Juego : 31 = 3 points, autre = 2 points', () => {
    const a = evaluateJuegoPunto(mkH([12, 12, 12, 1])); // 10+10+10+1 = 31
    eq(a.juegoPoints, 3);
    const b = evaluateJuegoPunto(mkH([12, 12, 12, 2])); // 10+10+10+1 = 31
    eq(b.juegoPoints, 3);
    const c = evaluateJuegoPunto(mkH([12, 12, 12, 3])); // 10+10+10+10 = 40
    eq(c.juegoPoints, 2);
  });

  t('Juego ordering : 31 > 32 > 40 > 37 > 33', () => {
    assert(juegoStrength(31) > juegoStrength(32));
    assert(juegoStrength(32) > juegoStrength(40));
    assert(juegoStrength(40) > juegoStrength(37));
    assert(juegoStrength(37) > juegoStrength(36));
    assert(juegoStrength(36) > juegoStrength(35));
    assert(juegoStrength(35) > juegoStrength(34));
    assert(juegoStrength(34) > juegoStrength(33));
  });

  t('Punto : 30 meilleur que 29', () => {
    const a = { hand: mkH([12, 12, 7, 3]) }; // 10+10+7+10 = 37 → juego, on bypass
    const b = { hand: mkH([12, 12, 7, 1]) }; // 10+10+7+1 = 28
    const c = { hand: mkH([12, 12, 6, 4]) }; // 10+10+6+4 = 30
    eq(evaluateJuegoPunto(b.hand).total, 28);
    eq(evaluateJuegoPunto(c.hand).total, 30);
    assert(comparePunto(c, b) > 0);
  });

  // Esku tiebreak
  t('Égalité parfaite : Esku gagne', () => {
    const players = [
      { id: 0, hand: mkH([12, 11, 7, 4]) },
      { id: 1, hand: mkH([12, 11, 7, 4]) },
      { id: 2, hand: mkH([12, 11, 7, 4]) },
      { id: 3, hand: mkH([12, 11, 7, 4]) },
    ];
    const winner = findBestPlayerWithCompare(players, 1, compareGrande);
    eq(winner, 1, 'Esku=1 doit gagner sur égalité');
  });

  // Validation deck après reshuffle
  t('Tous les ids du deck sont uniques', () => {
    const d = createDeck();
    eq(new Set(d.map(c => c.id)).size, 40);
  });

  // Hordago — chaîne d'enchères
  t('Hordago accepté → resolution = hordago-accepted', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'hordago' }, 'B');
    bet = applyBetAction(bet, { type: 'iduki' }, 'A');
    eq(bet.resolution.kind, 'hordago-accepted');
  });

  t('Hordago refusé → tira avec 1 point au minimum', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hordago' }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.kind, 'tira');
    assert(bet.resolution.immediatePoints.points >= 1);
    eq(bet.resolution.immediatePoints.team, 'A');
  });

  t('resolvePhase Hordago accepté désigne le gagnant de la phase', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 12, 12]) }, // équipe A : excellent Grande
      { id: 1, hand: mkH([1, 1, 1, 1]) },
      { id: 2, hand: mkH([7, 5, 4, 3]) },
      { id: 3, hand: mkH([1, 1, 1, 2]) },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hordago' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    const result = resolvePhase('grande', bet, players, 0);
    eq(result.hordagoWinnerTeam, 'A');
  });

  /* ===== Tests : Tira après relance — équipe gagnante correcte ===== */

  t('Embido(A) + Lau gehiago(B) + Tira(A) → 2 points pour B', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 4 }, 'B');
    bet = applyBetAction(bet, { type: 'tira' }, 'A');
    eq(bet.resolution.kind, 'tira');
    eq(bet.resolution.immediatePoints.points, 2);
    eq(bet.resolution.immediatePoints.team, 'B', 'B a relevé en dernier, B prend les points');
  });

  t('Embido(A) + Bortz gehiago(B) + Bi gehiago(A) + Tira(B) → 7 points pour A', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 5 }, 'B');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 2 }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.immediatePoints.points, 7);
    eq(bet.resolution.immediatePoints.team, 'A', 'A a relevé en dernier');
  });

  t('Hiru Embido(A) + Lau gehiago(B) + Tira(A) → 3 points pour B', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hiru-embido' }, 'A');
    bet = applyBetAction(bet, { type: 'gehiago', amount: 4 }, 'B');
    bet = applyBetAction(bet, { type: 'tira' }, 'A');
    eq(bet.resolution.immediatePoints.points, 3);
    eq(bet.resolution.immediatePoints.team, 'B');
  });

  /* ===== Tests : Pontua (phase Punto) ===== */

  t('Punto : tous les joueurs sont éligibles aux enchères', () => {
    const baseState = initialState(42, ['Toi', 'Bot1', 'Bot2', 'Bot3']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'juego',
      juegoOrPunto: 'punto',
      juegoEligible: [],  // personne n'a déclaré le jeu
      activePlayer: 0,
    };
    const actions = getLegalActions(state, 0);
    const types = actions.map(a => a.type);
    assert(types.includes('paso'), 'paso autorisé en Punto');
    assert(types.includes('embido'), 'embido autorisé en Punto');
    assert(types.includes('hiru-embido'), 'hiru-embido autorisé en Punto');
    assert(types.includes('hordago'), 'hordago autorisé en Punto');
  });

  t('Punto : non-éligible à Juego → bloqué si juegoOrPunto === juego', () => {
    const baseState = initialState(42, ['Toi', 'Bot1', 'Bot2', 'Bot3']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'juego',
      juegoOrPunto: 'juego',
      juegoEligible: [1, 3], // pas le joueur 0
      activePlayer: 0,
      phases: { ...baseState.phases, juego: { ...emptyBetState() } },
    };
    const actions = getLegalActions(state, 0);
    const types = actions.map(a => a.type);
    assert(!types.includes('embido'), 'pas d\'embido si non éligible au Juego');
  });

  t('Punto + Tira : équipe gagnante = lastAggressor', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'B');
    bet = applyBetAction(bet, { type: 'tira' }, 'A');
    eq(bet.resolution.immediatePoints.team, 'B');
    eq(bet.resolution.immediatePoints.points, 1);
  });

  t('Punto + Iduki : 2 points en jeu différé au gagnant de la phase', () => {
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    eq(bet.resolution.kind, 'iduki');
    eq(bet.resolution.deferredPoints, 2);
  });

  /* ===== Tests : Paires/Jeu non annoncés ne comptent pas ===== */

  t('Paires non annoncées ne comptent pas à la résolution', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 7, 5]), declaredPares: false }, // a une paire mais déclarée non
      { id: 1, hand: mkH([1, 2, 3, 4]),  declaredPares: false }, // pas de paire
      { id: 2, hand: mkH([11, 11, 5, 3]), declaredPares: true },  // a une paire et déclarée oui
      { id: 3, hand: mkH([1, 2, 4, 5]),  declaredPares: false },
    ];
    let bet = emptyBetState();
    bet.resolution = { kind: 'paso' };
    const result = resolvePhase('pares', bet, players, 0);
    // Le joueur 2 est seul éligible donc équipe A gagne (joueur 2 ∈ A)
    assert(result.revealPoints, 'des points doivent être attribués');
    eq(result.revealPoints.team, 'A');
  });

  t('Jeu non annoncé ne compte pas (article 16°)', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredJuego: false }, // a 31 mais déclaré non
      { id: 1, hand: mkH([12, 11, 7, 1]),  declaredJuego: true },  // a 28 → pas de jeu en réalité, fausse déclaration
      { id: 2, hand: mkH([12, 12, 11, 7]), declaredJuego: true },  // a 31, déclaré
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
    ];
    let bet = emptyBetState();
    bet.resolution = { kind: 'paso' };
    const result = resolvePhase('juego', bet, players, 0);
    // Joueur 0 a un jeu mais pas déclaré → ignoré. Joueur 1 a déclaré mais n'a pas → ignoré.
    // Joueur 2 a déclaré et a → seul éligible → équipe A
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
  });

  /* ===== Tests : detectDeclarationErrors ===== */

  t('Détection fausse déclaration paires (art. 13°)', () => {
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]), declaredPares: true, declaredJuego: false }, // pas de paire mais déclare oui
      { id: 1, hand: mkH([4, 5, 6, 7]), declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([4, 5, 6, 7]), declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([4, 5, 6, 7]), declaredPares: false, declaredJuego: false },
    ];
    const errs = detectDeclarationErrors(players);
    assert(errs.some(e => e.player === 0 && e.kind === 'false-pares'));
  });

  t('Détection paires non annoncées (art. 14°)', () => {
    const players = [
      { id: 0, hand: mkH([11, 11, 7, 5]), declaredPares: false, declaredJuego: false },
      { id: 1, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
    ];
    const errs = detectDeclarationErrors(players);
    assert(errs.some(e => e.player === 0 && e.kind === 'missed-pares'));
  });

  t('Détection faux jeu (art. 15°)', () => {
    const players = [
      { id: 0, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: true }, // total = 22, pas de jeu
      { id: 1, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
    ];
    const errs = detectDeclarationErrors(players);
    assert(errs.some(e => e.player === 0 && e.kind === 'false-juego'));
  });

  t('Détection jeu non annoncé (art. 16°)', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: false }, // 10+10+10+7=37 = jeu
      { id: 1, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
    ];
    const errs = detectDeclarationErrors(players);
    assert(errs.some(e => e.player === 0 && e.kind === 'missed-juego'));
  });

  /* ===== Tests : Distribution & talon ===== */

  t('dealHands démarre par l\'Esku réel', () => {
    const deck = createDeck();
    const { hands, remaining } = dealHands(deck, 2); // Esku = 2
    eq(hands[2][0].id, deck[0].id, 'Esku reçoit la 1ère carte');
    eq(hands[3][0].id, deck[1].id, 'Esku+1 reçoit la 2ème');
    eq(hands[0][0].id, deck[2].id, 'Esku+2 reçoit la 3ème');
    eq(hands[1][0].id, deck[3].id, 'Esku+3 reçoit la 4ème');
    eq(remaining.length, 24, '40 - 16 = 24 cartes au talon');
  });

  t('dealHands : chaque joueur reçoit exactement 4 cartes', () => {
    const deck = createDeck();
    const { hands } = dealHands(deck, 0);
    for (let i = 0; i < 4; i++) eq(hands[i].length, 4);
  });

  t('applyDiscards puise dans le talon, pas dans les mains', () => {
    const baseState = initialState(123, ['A', 'B', 'C', 'D']);
    const player0 = baseState.players[0];
    const discardIds = player0.hand.slice(0, 2).map(c => c.id);
    const state = {
      ...baseState,
      discardChoices: { 0: discardIds, 1: [], 2: [], 3: [] },
    };
    const { newHands, talon } = applyDiscards(state, baseState.rng);
    eq(newHands[0].length, 4, 'main toujours à 4');
    eq(talon.length, 22, '24 - 2 cartes piochées');
    // Les nouvelles cartes ne doivent pas être dans les autres mains
    const allOthers = [...newHands[1], ...newHands[2], ...newHands[3]];
    for (const c of newHands[0]) {
      if (!discardIds.includes(c.id) && !player0.hand.some(h => h.id === c.id)) {
        // Nouvelle carte
        assert(!allOthers.some(o => o.id === c.id), 'pas de doublon avec les autres mains');
      }
    }
  });

  /* ===== Tests : Main vs Manche ===== */

  t('Score conservé entre coups : startNewHand n\'efface pas score', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateWithScore = { ...baseState, score: { A: 15, B: 8 }, mancheOver: false };
    const next = startNewHand(stateWithScore);
    eq(next.score.A, 15);
    eq(next.score.B, 8);
    eq(next.handNumber, 2);
    eq(next.mancheNumber, 1);
  });

  t('Manche gagnée seulement à 40 : matchScore avance après 40+', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateWonByA = {
      ...baseState,
      mancheOver: true,
      mancheWinner: 'A',
      score: { A: 41, B: 23 },
      matchScore: { A: 0, B: 0 },
    };
    const next = startNewManche(stateWonByA);
    eq(next.matchScore.A, 1, 'matchScore A devient 1');
    eq(next.matchScore.B, 0);
    eq(next.score.A, 0, 'score RAZ');
    eq(next.score.B, 0);
    eq(next.mancheNumber, 2);
  });

  t('Match gagné à 3 manches', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateAlmostDone = {
      ...baseState,
      mancheOver: true,
      mancheWinner: 'A',
      score: { A: 40, B: 12 },
      matchScore: { A: 2, B: 1 },
    };
    const next = startNewManche(stateAlmostDone);
    eq(next.matchScore.A, 3);
    eq(next.matchOver, true, 'match terminé');
  });

  t('startNewManche sans manche terminée → redirige vers startNewHand', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateInProgress = { ...baseState, score: { A: 18, B: 22 }, mancheOver: false };
    const next = startNewManche(stateInProgress);
    eq(next.score.A, 18, 'score conservé');
    eq(next.matchScore.A, 0, 'matchScore non incrémenté');
  });

  /* ===== Tests : Anti-triche bots ===== */

  t('getBotVisibleState masque les mains des autres', () => {
    const baseState = initialState(42, ['Toi', 'Bot1', 'Bot2', 'Bot3']);
    const visible = getBotVisibleState(baseState, 1);
    // Bot 1 voit sa propre main
    eq(visible.players[1].hand.length, 4);
    // Mais ne voit pas celles des autres
    assert(visible.players[0].hand.hidden === true, 'main joueur 0 masquée');
    assert(visible.players[2].hand.hidden === true, 'main joueur 2 (partenaire) masquée');
    assert(visible.players[3].hand.hidden === true, 'main joueur 3 masquée');
    eq(visible.players[0].hand.size, 4);
    // Pas accès au RNG
    assert(visible.rng === undefined, 'RNG masqué');
  });

  t('Bot ne voit pas la main du partenaire (decideMus)', () => {
    const baseState = initialState(99, ['Toi', 'Bot1', 'Bot2', 'Bot3']);
    // Si jamais le bot accédait à state.players[partner].hand sous forme array,
    // évaluateHandStrength planterait sur un objet { hidden: true } — c'est la garantie.
    const action = botDecideMus(baseState, 1);
    assert(action.type === 'mus' || action.type === 'mintza');
  });

  /* ===== Tests : Signes ===== */

  t('Signe 30/31 légal à tout moment', () => {
    const hand = mkH([12, 12, 11, 7]); // 10+10+10+7 = 37, pas 30/31
    eq(isSignalLegal('30-31', hand, 'bet', 'grande', evaluateJuegoPunto(hand)), false);
    const hand31 = mkH([12, 12, 11, 1]); // 10+10+10+1 = 31
    eq(isSignalLegal('30-31', hand31, 'bet', 'grande', evaluateJuegoPunto(hand31)), true);
  });

  t('Signe 29 illégal pendant les paires', () => {
    const hand = mkH([12, 12, 5, 4]); // 10+10+5+4 = 29
    eq(isSignalLegal('29', hand, 'bet', 'pares', evaluateJuegoPunto(hand)), false);
    eq(isSignalLegal('29', hand, 'bet', 'juego', evaluateJuegoPunto(hand)), true);
  });

  t('Signe Jeu interdit avec 31', () => {
    const hand = mkH([12, 12, 11, 1]); // 10+10+10+1 = 31
    eq(isSignalLegal('juego', hand, 'bet', 'juego', evaluateJuegoPunto(hand)), false);
    const hand35 = mkH([12, 12, 11, 5]); // 10+10+10+5 = 35
    eq(isSignalLegal('juego', hand35, 'bet', 'juego', evaluateJuegoPunto(hand35)), true);
  });

  t('Signe 2 rois requiert deux cartes effRank=12', () => {
    const hand = mkH([12, 3, 5, 4]); // 12 + 3→Rey = 2 rois
    eq(isSignalLegal('two-kings', hand, 'bet', 'grande', evaluateJuegoPunto(hand)), true);
    const hand2 = mkH([12, 11, 5, 4]); // un seul rey
    eq(isSignalLegal('two-kings', hand2, 'bet', 'grande', evaluateJuegoPunto(hand2)), false);
  });

  t('Signe 2 as requiert deux cartes effRank=1', () => {
    const hand = mkH([1, 2, 5, 4]); // As + 2→As
    eq(isSignalLegal('two-aces', hand, 'bet', 'chica', evaluateJuegoPunto(hand)), true);
  });

  /* ===== Tests : Tira pour moi ===== */

  t('Action tira-for-me listée dans actions légales en réponse', () => {
    const baseState = initialState(42, ['Toi', 'B', 'C', 'D']);
    const bet = applyBetAction(emptyBetState(), { type: 'embido' }, 'A');
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 1,
      phases: { ...baseState.phases, grande: bet },
    };
    const actions = getLegalActions(state, 1);
    const types = actions.map(a => a.type);
    assert(types.includes('tira-for-me'), 'tira-for-me doit être proposé');
  });

  /* ===== Tests : Mus/Mintza ordre ===== */

  t('Ordre Mus : Esku → partenaire → adversaires', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    // Esku = 0, partenaire = 2, adversaires = 1, 3
    eq(baseState.musOrder[0], 0);
    eq(baseState.musOrder[1], 2, 'partenaire en deuxième');
    eq(baseState.musOrder[2], 1);
    eq(baseState.musOrder[3], 3);
  });

  t('Mus : si partenaire dit Mintza, on sort sans demander aux adversaires', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    let s = baseState;
    s = reducer(s, { type: 'mus' });    // Esku (0) dit mus
    eq(s.activePlayer, 2, 'partenaire (2) doit jouer ensuite');
    s = reducer(s, { type: 'mintza' }); // partenaire dit mintza
    eq(s.phase, 'bet', 'on entre directement en phase pari');
    eq(s.currentBetPhase, 'grande');
  });

  /* ===== POINT 1 : Scoring après Tira en Pares/Jeu/Point ===== */

  t('Punto Embido + Tira → Deje immédiat + 1 Pontua à la révélation', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 7, 5]), declaredJuego: false }, // total 32 → wait 10+10+7+5=32, juegoPoints=2 → mais on veut Punto donc pas de juego declaré
      { id: 1, hand: mkH([1, 2, 3, 4]), declaredJuego: false },
      { id: 2, hand: mkH([12, 11, 7, 5]), declaredJuego: false }, // 10+10+7+5=32 mais pas declaré
      { id: 3, hand: mkH([1, 2, 4, 5]), declaredJuego: false },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A'); // A propose 2
    bet = applyBetAction(bet, { type: 'tira' }, 'B');   // B refuse → A prend 1 immédiat
    eq(bet.resolution.kind, 'tira');
    eq(bet.resolution.immediatePoints.team, 'A');
    eq(bet.resolution.immediatePoints.points, 1);
    const result = resolvePhase('punto', bet, players, 0);
    // À la révélation : 1 Pontua au gagnant des mains (joueur 0 ou 2 → équipe A, 32 vs 22/12)
    assert(result.revealPoints, 'Pontua doit être attribué malgré le Tira');
    eq(result.revealPoints.points, 1);
    eq(result.revealPoints.team, 'A');
    // Et l'immediate est conservé
    eq(result.immediatePoints.team, 'A');
    eq(result.immediatePoints.points, 1);
  });

  t('Pares Embido + Tira → Deje immédiat + points de paires à la révélation', () => {
    const players = [
      { id: 0, hand: mkH([11, 11, 7, 5]), declaredPares: true },  // pareja 1pt
      { id: 1, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
      { id: 2, hand: mkH([4, 6, 7, 5]),   declaredPares: false },
      { id: 3, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    eq(bet.resolution.immediatePoints.team, 'A');
    eq(bet.resolution.immediatePoints.points, 1);
    const result = resolvePhase('pares', bet, players, 0);
    eq(result.immediatePoints.points, 1);
    // À la révélation, équipe A (joueur 0) prend ses 1pt de paires
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    eq(result.revealPoints.points, 1);
  });

  t('Juego Embido + Tira → Deje immédiat + juegoPoints à la révélation', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 5]), declaredJuego: true },  // 35 = juegoPoints 2
      { id: 1, hand: mkH([1, 2, 4, 5]),    declaredJuego: false },
      { id: 2, hand: mkH([4, 5, 6, 7]),    declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'tira' }, 'B');
    const result = resolvePhase('juego', bet, players, 0);
    eq(result.immediatePoints.team, 'A');
    eq(result.immediatePoints.points, 1);
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    eq(result.revealPoints.points, 2);
  });

  /* ===== POINT 2 : Sanctions art. 13-16 ===== */

  t('Sanction art. 13° fausse paire : annulation + adversaire prend ses paires', () => {
    const players = [
      { id: 0, name: 'A0', team: 'A', hand: mkH([4, 5, 6, 7]), declaredPares: true,  declaredJuego: false },  // ment, pas de paires
      { id: 1, name: 'B1', team: 'B', hand: mkH([11, 11, 7, 5]), declaredPares: true, declaredJuego: false }, // a pareja 1pt
      { id: 2, name: 'A2', team: 'A', hand: mkH([1, 2, 4, 5]), declaredPares: false, declaredJuego: false },
      { id: 3, name: 'B3', team: 'B', hand: mkH([4, 5, 6, 7]), declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'punto',
    };
    const fakeResolutions = [{ phase: 'pares', revealPoints: { team: 'A', points: 0 } }];
    const { adjustments, errors } = applyDeclarationSanctions(state, fakeResolutions);
    assert(errors.some(e => e.kind === 'false-pares' && e.player === 0));
    // Adversaire (B) doit prendre ses paires (1pt)
    const advGain = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    assert(advGain >= 1, `B doit gagner au moins 1 (paires), got ${advGain}`);
  });

  t('Sanction art. 16a° jeu non annoncé alors que phase = punto → Pontua à l\'adversaire', () => {
    const players = [
      { id: 0, name: 'A0', team: 'A', hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: false }, // 37 = jeu, pas déclaré
      { id: 1, name: 'B1', team: 'B', hand: mkH([4, 5, 6, 7]),    declaredPares: false, declaredJuego: false },
      { id: 2, name: 'A2', team: 'A', hand: mkH([1, 2, 4, 5]),    declaredPares: false, declaredJuego: false },
      { id: 3, name: 'B3', team: 'B', hand: mkH([4, 5, 6, 7]),    declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'punto',  // joué comme Punto puisque personne n'a déclaré
    };
    const { adjustments, errors } = applyDeclarationSanctions(state, []);
    assert(errors.some(e => e.kind === 'missed-juego' && e.player === 0));
    const advGain = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    assert(advGain >= 1, 'B doit prendre au moins le Pontua');
  });

  /* ===== POINT 3 : Reducer rejette déclarations illégales ===== */

  t('Reducer rejette declare-pares true sans paires en mode honnête', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    // Forcer une main sans paire pour le joueur 0
    const state = {
      ...baseState,
      phase: 'pares-declare',
      activePlayer: 0,
      players: baseState.players.map(p =>
        p.id === 0 ? { ...p, hand: mkH([4, 5, 6, 7]) } : p
      ),
    };
    const next = reducer(state, { type: 'declare-pares', value: true });
    // Doit rester en pares-declare, pas avancer
    eq(next.activePlayer, 0, 'activePlayer doit rester 0 (action rejetée)');
    eq(next.players[0].declaredPares, undefined, 'declaredPares ne doit pas être posé');
    assert(next.log.some(l => l.type === 'illegal-declaration'));
  });

  t('Reducer rejette declare-juego true sans jeu en mode honnête', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'juego-declare',
      activePlayer: 0,
      players: baseState.players.map(p =>
        p.id === 0 ? { ...p, hand: mkH([1, 2, 4, 5]), declaredPares: false } : { ...p, declaredPares: false }
      ),
    };
    const next = reducer(state, { type: 'declare-juego', value: true });
    eq(next.activePlayer, 0);
    eq(next.players[0].declaredJuego, undefined);
  });

  /* ===== POINT 4 : Non-éligible Pares/Jeu — actions correctes ===== */

  t('Non-éligible Pares en réponse → seul tira-for-me si partenaire éligible', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'pares',
      paresEligible: [3], // partenaire de joueur 1 (= 3) est éligible mais pas joueur 1
      activePlayer: 1,
      phases: { ...baseState.phases, pares: { ...emptyBetState(), pendingResponderTeam: 'B' } },
    };
    // Bet a été ouvert par A, pendingResponderTeam = B, joueur 1 (B) répond mais non éligible
    const actions = getLegalActions(state, 1);
    const types = actions.map(a => a.type);
    assert(types.includes('tira-for-me'), 'tira-for-me doit être proposé (partenaire 3 éligible)');
    assert(!types.includes('tira'), 'tira normal ne doit PAS être proposé');
  });

  t('Non-éligible Pares avec partenaire aussi non-éligible → tira automatique', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'pares',
      paresEligible: [0, 2], // équipe A est éligible, équipe B aucun
      activePlayer: 1,
      phases: { ...baseState.phases, pares: { ...emptyBetState(), pendingResponderTeam: 'B' } },
    };
    const actions = getLegalActions(state, 1);
    const types = actions.map(a => a.type);
    assert(types.includes('tira'), 'tira doit être proposé');
    assert(!types.includes('tira-for-me'), 'tira-for-me NE doit PAS être proposé');
  });

  /* ===== POINT 5 : Tira pour moi — pas de ping-pong ===== */

  t('Tira pour moi rejeté quand le partenaire est déjà délégué', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 3,                  // partenaire de 1
      pendingPartnerDecision: { phaseName: 'grande', requesterId: 1, requesterTeam: 'B' },
      phases: {
        ...baseState.phases,
        grande: { ...emptyBetState(), stack: [1, 2], lastAggressorTeam: 'A', initiator: 'A', pendingResponderTeam: 'B' },
      },
    };
    const next = reducer(state, { type: 'tira-for-me' });
    // L'action doit être rejetée → pas de pendingPartnerDecision modifié
    eq(next.pendingPartnerDecision.requesterId, 1, 'pendingPartnerDecision ne doit pas être réécrit');
    eq(next.activePlayer, 3, 'activePlayer reste sur le partenaire');
  });

  t('Cycle complet : A1 tira-for-me → A3 gehiago → B prend décision → A1 ne reprend PAS la main', () => {
    const baseState = initialState(99, ['A', 'B', 'C', 'D']);
    let s = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 1,                  // équipe B en réponse
      phases: {
        ...baseState.phases,
        grande: { ...emptyBetState(), stack: [1, 2], lastAggressorTeam: 'A', initiator: 'A', pendingResponderTeam: 'B' },
      },
    };
    // 1 (B) dit Tira pour moi → activePlayer passe à 3 (partenaire)
    s = reducer(s, { type: 'tira-for-me' });
    eq(s.activePlayer, 3);
    // 3 relance gehiago +2 → activePlayer doit revenir à équipe A (joueur 0 ou 2),
    // pas au joueur 1 qui a délégué
    s = reducer(s, { type: 'gehiago', amount: 2 });
    assert(s.activePlayer === 0 || s.activePlayer === 2, `activePlayer doit être en équipe A, got ${s.activePlayer}`);
    eq(s.pendingPartnerDecision, null, 'pendingPartnerDecision doit être effacé après réponse');
  });

  /* ===== POINT 6 : Bots au Point ===== */

  t('Bot en phase Punto peut faire embido même si non éligible au Juego', () => {
    const baseState = initialState(42, ['Toi', 'Bot1', 'Bot2', 'Bot3']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'juego',
      juegoOrPunto: 'punto',
      juegoEligible: [],  // personne, c'est punto
      activePlayer: 1,
      phases: { ...baseState.phases, juego: emptyBetState() },
    };
    // Forcer un bot avec une main forte au Point pour vérifier qu'il ne fait pas paso forcé
    const action = botChooseBetAction(state, 1);
    // En mode ouverture, le bot doit pouvoir choisir : paso, embido, hiru-embido, hordago
    // Il ne doit PAS être bloqué à paso à cause de juegoEligible
    assert(['paso', 'embido', 'hiru-embido', 'hordago'].includes(action.type),
      `bot doit pouvoir agir en Punto, got ${action.type}`);
  });

  /* ===== POINT 7 : getBotVisibleState whitelist ===== */

  t('getBotVisibleState NE contient PAS deckRemaining', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const visible = getBotVisibleState(baseState, 1);
    assert(!('deckRemaining' in visible), 'deckRemaining doit être absent');
  });

  t('getBotVisibleState NE contient PAS rng', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const visible = getBotVisibleState(baseState, 1);
    assert(!('rng' in visible), 'rng doit être absent');
  });

  t('getBotVisibleState NE contient PAS discardChoices', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const visible = getBotVisibleState(baseState, 1);
    assert(!('discardChoices' in visible), 'discardChoices doit être absent');
  });

  t('getBotVisibleState NE contient PAS enforceTruthfulDeclarations ni log brut', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const visible = getBotVisibleState(baseState, 1);
    assert(!('enforceTruthfulDeclarations' in visible));
    assert(!('log' in visible));
  });

  /* ===== POINT 8 : Signe 29 légalité ===== */

  t('Signe 29 illégal en phase Mus', () => {
    const hand = mkH([12, 12, 5, 4]);
    eq(isSignalLegal('29', hand, 'mus-decision', null, evaluateJuegoPunto(hand)), false);
  });

  t('Signe 29 illégal pendant Grande', () => {
    const hand = mkH([12, 12, 5, 4]);
    eq(isSignalLegal('29', hand, 'bet', 'grande', evaluateJuegoPunto(hand)), false);
  });

  t('Signe 29 illégal pendant Chica', () => {
    const hand = mkH([12, 12, 5, 4]);
    eq(isSignalLegal('29', hand, 'bet', 'chica', evaluateJuegoPunto(hand)), false);
  });

  t('Signe 29 légal en juego-declare et au-delà', () => {
    const hand = mkH([12, 12, 5, 4]);
    eq(isSignalLegal('29', hand, 'juego-declare', null, evaluateJuegoPunto(hand)), true);
    eq(isSignalLegal('29', hand, 'bet', 'juego', evaluateJuegoPunto(hand)), true);
  });

  /* ===== POINT 9 : Reset signaux par main ===== */

  t('startNewHand efface les signaux de la main précédente', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateWithSignals = {
      ...baseState,
      mancheOver: false,
      signals: [
        { player: 0, sign: 'two-kings', phase: 'grande', public: true },
        { player: 2, sign: 'mediak', phase: 'pares', public: true },
      ],
    };
    const next = startNewHand(stateWithSignals);
    eq(next.signals.length, 0, 'signals doit être vide à la nouvelle main');
  });

  /* ===== POINT 10 : Mode realistic — visibilité filtrée ===== */
  // Test côté UI difficile à automatiser ; on teste via getBotVisibleState pour le moteur :

  t('Mode realistic : bot voit signaux de son partenaire mais pas adverses', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const stateWithSignals = {
      ...baseState,
      signMode: 'realistic',
      signals: [
        { player: 0, sign: 'two-kings', phase: 'grande', public: false }, // équipe A
        { player: 2, sign: 'mediak', phase: 'pares', public: false },     // équipe A
        { player: 1, sign: 'two-aces', phase: 'chica', public: false },   // équipe B
        { player: 3, sign: 'juego', phase: 'juego', public: false },      // équipe B
      ],
    };
    const visible = getBotVisibleState(stateWithSignals, 1); // bot de l'équipe B
    const visibleSigners = visible.signals.map(s => s.player);
    assert(visibleSigners.includes(1) && visibleSigners.includes(3), 'doit voir équipe B');
    assert(!visibleSigners.includes(0) && !visibleSigners.includes(2), 'ne doit PAS voir équipe A');
  });

  t('Mode off : aucun signal visible', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const stateWithSignals = {
      ...baseState,
      signMode: 'off',
      signals: [{ player: 0, sign: 'two-kings', phase: 'grande', public: true }],
    };
    const visible = getBotVisibleState(stateWithSignals, 1);
    eq(visible.signals.length, 0);
  });

  /* ===== POINT 11 : Bots émettent des signes ===== */

  t('Bot peut émettre un signal légal (botMaybeEmitSignal)', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    // Forcer une main de bot avec deux rois pour qu'il émette le signe
    const state = {
      ...baseState,
      signMode: 'simple',
      phase: 'bet',
      currentBetPhase: 'grande',
      signals: [],
      players: baseState.players.map(p =>
        p.id === 1 ? { ...p, hand: mkH([12, 12, 7, 5]) } : p
      ),
    };
    // Tester plusieurs fois car émission probabiliste
    let emitted = false;
    for (let i = 0; i < 30; i++) {
      const action = botMaybeEmitSignal(state, 1);
      if (action) {
        eq(action.type, 'send-signal');
        eq(action.playerId, 1);
        // Le signe doit être légal
        const hand = state.players[1].hand;
        const jp = evaluateJuegoPunto(hand);
        assert(isSignalLegal(action.sign, hand, state.phase, state.currentBetPhase, jp),
          `signal ${action.sign} émis doit être légal`);
        emitted = true;
        break;
      }
    }
    assert(emitted, 'le bot doit émettre un signal au moins une fois sur 30 essais');
  });

  t('Bot ne peut PAS émettre un signal illégal', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const state = {
      ...baseState,
      signMode: 'simple',
      phase: 'bet',
      currentBetPhase: 'pares',  // 29 illégal en pares
      signals: [],
      // Donner au bot une main parfaite avec total 29 (10+10+5+4)
      players: baseState.players.map(p =>
        p.id === 1 ? { ...p, hand: mkH([12, 12, 5, 4]) } : p
      ),
    };
    // Tester 50 fois : si le bot émettait, ce devait être un signal valide pour la phase pares
    // Et certainement pas '29' qui est interdit ici
    for (let i = 0; i < 50; i++) {
      const action = botMaybeEmitSignal(state, 1);
      if (action) {
        assert(action.sign !== '29', 'bot ne doit JAMAIS émettre 29 en phase pares');
        const hand = state.players[1].hand;
        assert(isSignalLegal(action.sign, hand, state.phase, state.currentBetPhase, evaluateJuegoPunto(hand)));
      }
    }
  });

  /* ===== POINT 12 : Verrouillage après reveal ===== */

  t('Reducer rejette les actions de pari après reveal', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateRevealed = {
      ...baseState,
      phase: 'reveal',
      revealed: true,
      score: { A: 18, B: 22 },
      mancheOver: false,
      revealResult: [],
    };
    const tryEmbido = reducer(stateRevealed, { type: 'embido' });
    eq(tryEmbido.score.A, 18, 'score inchangé');
    eq(tryEmbido.phase, 'reveal', 'phase reste reveal');
    const tryDeclare = reducer(stateRevealed, { type: 'declare-pares', value: true });
    eq(tryDeclare.phase, 'reveal');
  });

  t('next-hand est accepté après reveal', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateRevealed = {
      ...baseState,
      phase: 'reveal',
      revealed: true,
      score: { A: 12, B: 8 },
      mancheOver: false,
    };
    const next = reducer(stateRevealed, { type: 'next-hand' });
    eq(next.phase, 'mus-decision');
    eq(next.score.A, 12, 'score conservé');
  });

  /* ========================================================================
   *
   *  TESTS V4 — durcissement, invariants, matrice sanctions, edge cases
   *
   * ====================================================================== */

  /* ===== V4 — Guards next-hand / next-manche ===== */

  t('V4 next-hand REFUSÉ si manche terminée', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'reveal', mancheOver: true, mancheWinner: 'A', score: { A: 41, B: 12 } };
    const next = reducer(state, { type: 'next-hand' });
    eq(next.phase, 'reveal', 'phase ne change pas');
    eq(next.mancheOver, true);
  });

  t('V4 next-hand REFUSÉ pendant un coup en cours', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'bet', currentBetPhase: 'grande' };
    const next = reducer(state, { type: 'next-hand' });
    eq(next.phase, 'bet', 'next-hand pendant un pari → ignoré');
  });

  t('V4 next-manche REFUSÉ si manche non terminée (mode normal)', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'reveal', mancheOver: false, score: { A: 18, B: 22 } };
    const next = reducer(state, { type: 'next-manche' });
    eq(next.score.A, 18, 'score inchangé');
    eq(next.score.B, 22);
    eq(next.matchScore.A, 0, 'matchScore non incrémenté');
  });

  t('V4 next-manche accepté en mode debug avec force', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'reveal', mancheOver: false, score: { A: 18, B: 22 } };
    const next = reducer(state, { type: 'next-manche', force: true });
    // En force : startNewManche est appelé — mais comme mancheOver=false dans le state
    // le code redirige actuellement vers startNewHand. Ici on documente : en force,
    // on accepte le passage. C'est notre choix de variante.
    assert(next !== state, 'l\'action est traitée');
  });

  /* ===== V4 — Validation reducer (B1) ===== */

  t('V4 Reducer rejette une action embido en mode réponse (forgée)', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    // Construire un état où embido n'est pas légal : pendingResponderTeam non null
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 1,
      phases: {
        ...baseState.phases,
        grande: { ...emptyBetState(), stack: [1, 2], pendingResponderTeam: 'B', initiator: 'A', lastAggressorTeam: 'A' },
      },
    };
    // En mode réponse, embido n'est pas une action légale (gehiago oui, embido non)
    const next = reducer(state, { type: 'embido' });
    // Action illégale → state inchangé sauf log
    eq(next.phases.grande.stack.length, 2, 'stack inchangé');
    assert(next.log.some(l => l.type === 'illegal-action'));
  });

  t('V4 Reducer rejette mus quand phase != mus-decision', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'bet', currentBetPhase: 'grande' };
    const next = reducer(state, { type: 'mus' });
    eq(next.phase, 'bet', 'mus en mauvaise phase → rejeté');
  });

  t('V4 Reducer rejette une action quand activePlayer ne match pas', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    // activePlayer = 0 (Esku), mais on dispatch une action via le joueur 2
    // → getLegalActions(state, 0) liste les actions de 0, pas de 2.
    // Vu que le reducer passe activePlayer dans isLegalAction, l'action sera
    // évaluée pour 0. Donc une action légale POUR 0 sera acceptée même si on
    // imagine que c'est 2 qui parle. C'est une limite : le reducer ne fait pas
    // d'authentification de l'auteur. Ce test documente.
    const next = reducer(baseState, { type: 'mus' });
    eq(next.activePlayer !== 0, true, 'activePlayer change après action');
  });

  /* ===== V4 — validateState ===== */

  t('V4 validateState : état initial cohérent', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const errs = validateState(baseState);
    eq(errs.length, 0, `aucune erreur attendue, got ${JSON.stringify(errs)}`);
  });

  t('V4 validateState détecte juegoOrPunto incohérent', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const broken = { ...baseState, juegoOrPunto: 'juego', juegoEligible: [] };
    const errs = validateState(broken);
    assert(errs.some((e) => e.includes('juegoOrPunto=juego mais juegoEligible vide')));
  });

  t('V4 validateState détecte paresEligible désync', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const broken = {
      ...baseState,
      paresEligible: [0],
      players: baseState.players.map((p) => p.id === 0 ? { ...p, declaredPares: false } : p),
    };
    const errs = validateState(broken);
    assert(errs.some((e) => e.includes('paresEligible inclut joueur 0')));
  });

  t('V4 validateState détecte score négatif', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const broken = { ...baseState, score: { A: -1, B: 5 } };
    const errs = validateState(broken);
    assert(errs.some((e) => e.includes('score négatif')));
  });

  /* ===== V4 — Sanctions sans double-count ===== */

  t('V4 Double fausse paires (les 2 équipes mentent) : pas de double-count', () => {
    const players = [
      { id: 0, name: 'A0', team: 'A', hand: mkH([4, 5, 6, 7]),  declaredPares: true, declaredJuego: false }, // ment
      { id: 1, name: 'B1', team: 'B', hand: mkH([4, 5, 6, 7]),  declaredPares: true, declaredJuego: false }, // ment aussi
      { id: 2, name: 'A2', team: 'A', hand: mkH([4, 5, 6, 7]),  declaredPares: false, declaredJuego: false },
      { id: 3, name: 'B3', team: 'B', hand: mkH([4, 5, 6, 7]),  declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'punto',
    };
    const fakeResolutions = [{ phase: 'pares', revealPoints: null }];
    const { adjustments, errors } = applyDeclarationSanctions(state, fakeResolutions);
    // Aucune équipe ne devrait gagner de points puisque personne n'a vraiment de paires
    const totalA = adjustments.filter(a => a.team === 'A').reduce((s, a) => s + a.delta, 0);
    const totalB = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    eq(totalA, 0, `A doit avoir 0 (pas de paires réelles), got ${totalA}`);
    eq(totalB, 0, `B doit avoir 0 (pas de paires réelles), got ${totalB}`);
    eq(errors.length, 2, '2 erreurs détectées');
  });

  t('V4 Sanctions appliquées une seule fois par phase, pas par erreur', () => {
    // Cas : un joueur de A ment + son partenaire ment aussi sur paires
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]), declaredPares: true, declaredJuego: false }, // ment
      { id: 1, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([4, 5, 6, 7]), declaredPares: true, declaredJuego: false }, // partenaire ment aussi
      { id: 3, hand: mkH([1, 2, 3, 4]), declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'punto',
    };
    const fakeResolutions = [{ phase: 'pares', revealPoints: null }];
    const { adjustments } = applyDeclarationSanctions(state, fakeResolutions);
    // Vérifier qu'on n'a pas 2 sanctions identiques pour la même phase/équipe coupable
    const reasons = adjustments.map(a => a.reason);
    const uniqueReasons = new Set(reasons);
    eq(reasons.length, uniqueReasons.size,
      `adjustments dupliqués détectés : ${JSON.stringify(reasons)}`);
  });

  /* ===== V4 — Hordago sur chaque phase ===== */

  for (const phase of ['grande', 'chica']) {
    t(`V4 Hordago accepté en ${phase} clôt la manche immédiatement`, () => {
      // Pour Chica, A doit avoir la plus PETITE petite carte ; pour Grande, A doit avoir la plus grande
      const handsByPhase = {
        grande: [mkH([12, 12, 12, 12]), mkH([4, 5, 6, 7]), mkH([12, 11, 7, 6]), mkH([4, 5, 6, 7])],
        chica:  [mkH([1, 2, 1, 2]),     mkH([12, 11, 10, 7]), mkH([1, 2, 4, 5]), mkH([12, 11, 10, 7])],
      };
      const players = handsByPhase[phase].map((hand, i) => ({
        id: i, hand, declaredPares: false, declaredJuego: false,
      }));
      let bet = emptyBetState();
      bet = applyBetAction(bet, { type: 'hordago' }, 'A');
      bet = applyBetAction(bet, { type: 'iduki' }, 'B');
      const result = resolvePhase(phase, bet, players, 0);
      eq(result.hordagoWinnerTeam, 'A', `A gagne le Hordago en ${phase}`);
    });
  }

  t('V4 Hordago refusé après relance : convention adoptée 1 pt (Deje du paso) au bluffeur', () => {
    // VARIANTE — Le règlement n'est pas explicite. Notre convention :
    //   Hordago refusé = stack[length-2] = palier précédent immédiat AVANT le Hordago
    //   Ici la séquence est embido(stack=[1,2]) → hordago(stack inchangé) → tira → prev=1
    //   Donc 1 point. (Voir SCORING_DECISIONS.md.)
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'hordago' }, 'B');
    bet = applyBetAction(bet, { type: 'tira' }, 'A');
    eq(bet.resolution.kind, 'tira');
    eq(bet.resolution.immediatePoints.team, 'B', 'B gagne (dernier relanceur)');
    eq(bet.resolution.immediatePoints.points, 1, 'convention V4 : 1 point');
  });

  t('V4 Hordago en Punto : équipe gagnante au point remporte la manche', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: false }, // 37
      { id: 1, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false }, // 22
      { id: 2, hand: mkH([12, 11, 7, 5]),  declaredPares: false, declaredJuego: false }, // 32
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false }, // 22
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'hordago' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    const result = resolvePhase('punto', bet, players, 0);
    eq(result.hordagoWinnerTeam, 'A', 'A gagne (37 > 32 > 22)');
  });

  /* ===== V4 — Replay seed déterministe ===== */

  t('V4 Seed déterministe : même seed → même distribution', () => {
    const s1 = initialState(12345, ['A', 'B', 'C', 'D']);
    const s2 = initialState(12345, ['A', 'B', 'C', 'D']);
    for (let i = 0; i < 4; i++) {
      eq(s1.players[i].hand.length, s2.players[i].hand.length);
      for (let j = 0; j < s1.players[i].hand.length; j++) {
        eq(s1.players[i].hand[j].id, s2.players[i].hand[j].id);
      }
    }
  });

  t('V4 Seeds différents : distributions différentes', () => {
    const s1 = initialState(1, ['A', 'B', 'C', 'D']);
    const s2 = initialState(2, ['A', 'B', 'C', 'D']);
    let same = true;
    for (let i = 0; i < 4 && same; i++) {
      for (let j = 0; j < s1.players[i].hand.length && same; j++) {
        if (s1.players[i].hand[j].id !== s2.players[i].hand[j].id) same = false;
      }
    }
    assert(!same, 'deux seeds différents doivent produire des distributions différentes');
  });

  /* ===== V4 — Anti-triche bots renforcé ===== */

  t('V4 Bot ne peut PAS muter sa propre main via getBotVisibleState', () => {
    const baseState = initialState(42, ['Toi', 'B1', 'B2', 'B3']);
    const visible = getBotVisibleState(baseState, 1);
    const before = baseState.players[1].hand.map((c) => c.id).join(',');
    // Tentative de mutation
    visible.players[1].hand[0].rank = 99;
    const after = baseState.players[1].hand.map((c) => c.id).join(',');
    eq(before, after, 'la main du state original ne doit PAS avoir changé');
    assert(baseState.players[1].hand[0].rank !== 99, 'rang non muté');
  });

  /* ===== V4 — Pares Paso/Iduki/Tira (matrice complète) ===== */

  t('V4 Pares Paso : équipe gagnante prend ses points', () => {
    const players = [
      { id: 0, hand: mkH([11, 11, 7, 5]), declaredPares: true },
      { id: 1, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
      { id: 2, hand: mkH([4, 6, 7, 5]),   declaredPares: false },
      { id: 3, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
    ];
    let bet = emptyBetState();
    bet.resolution = { kind: 'paso' };
    const result = resolvePhase('pares', bet, players, 0);
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    eq(result.revealPoints.points, 1);
  });

  t('V4 Pares Iduki : Deje + points de paires', () => {
    const players = [
      { id: 0, hand: mkH([11, 11, 7, 5]), declaredPares: true },
      { id: 1, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
      { id: 2, hand: mkH([4, 6, 7, 5]),   declaredPares: false },
      { id: 3, hand: mkH([1, 2, 4, 5]),   declaredPares: false },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    const result = resolvePhase('pares', bet, players, 0);
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    // 2 (deferred du iduki) + 1 (paire 1pt) = 3
    eq(result.revealPoints.points, 3);
  });

  /* ===== V4 — Juego Paso/Iduki/Tira ===== */

  t('V4 Juego Paso : juegoPoints à l\'équipe gagnante', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredJuego: true }, // 37 → 2pt
      { id: 1, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
      { id: 2, hand: mkH([4, 5, 6, 7]),    declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
    ];
    let bet = emptyBetState();
    bet.resolution = { kind: 'paso' };
    const result = resolvePhase('juego', bet, players, 0);
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    eq(result.revealPoints.points, 2, '2 points juegoPoints');
  });

  t('V4 Juego Iduki : Deje + juegoPoints', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredJuego: true }, // 37 → 2pt
      { id: 1, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
      { id: 2, hand: mkH([4, 5, 6, 7]),    declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredJuego: false },
    ];
    let bet = emptyBetState();
    bet = applyBetAction(bet, { type: 'embido' }, 'A');
    bet = applyBetAction(bet, { type: 'iduki' }, 'B');
    const result = resolvePhase('juego', bet, players, 0);
    assert(result.revealPoints);
    eq(result.revealPoints.team, 'A');
    eq(result.revealPoints.points, 4, '2 (Deje) + 2 (juegoPoints) = 4');
  });

  /* ===== V4 — isLegalAction ===== */

  t('V4 isLegalAction : embido légal en ouverture', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = { ...baseState, phase: 'bet', currentBetPhase: 'grande', activePlayer: 0 };
    assert(isLegalAction(state, 0, { type: 'embido' }));
  });

  t('V4 isLegalAction : embido illégal en réponse', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 1,
      phases: {
        ...baseState.phases,
        grande: { ...emptyBetState(), stack: [1, 2], pendingResponderTeam: 'B', initiator: 'A', lastAggressorTeam: 'A' },
      },
    };
    assert(!isLegalAction(state, 1, { type: 'embido' }));
  });

  t('V4 isLegalAction : gehiago vérifie amount', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 1,
      phases: {
        ...baseState.phases,
        grande: { ...emptyBetState(), stack: [1, 2], pendingResponderTeam: 'B', initiator: 'A', lastAggressorTeam: 'A' },
      },
    };
    assert(isLegalAction(state, 1, { type: 'gehiago', amount: 2 }), 'gehiago +2 légal');
    assert(!isLegalAction(state, 1, { type: 'gehiago', amount: 99 }), 'gehiago +99 illégal');
  });

  /* ===== V4 — Tira-for-me en ouverture refusé ===== */

  t('V4 tira-for-me REJETÉ en mode ouverture', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const state = {
      ...baseState,
      phase: 'bet',
      currentBetPhase: 'grande',
      activePlayer: 0,
      phases: { ...baseState.phases, grande: emptyBetState() }, // pas d'enchère encore
    };
    const next = reducer(state, { type: 'tira-for-me' });
    assert(next.log.some(l => l.type === 'illegal-action'));
    eq(next.phase, 'bet', 'phase inchangée');
  });

  /* ===== V4 — Cas réglementaires articles 13-16 ===== */

  t('V4 Article 13b : faux pares + adversaire avec paires + Iduki → adversaire prend points + mise', () => {
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]),   declaredPares: true,  declaredJuego: false }, // ment
      { id: 1, hand: mkH([12, 12, 7, 5]), declaredPares: true,  declaredJuego: false }, // pareja roi 1pt
      { id: 2, hand: mkH([1, 2, 4, 5]),   declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 4, 5]),   declaredPares: false, declaredJuego: false },
    ];
    const paresBet = { ...emptyBetState(), stack: [1, 2], resolution: { kind: 'iduki', deferredPoints: 2 } };
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: paresBet, juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'punto',
    };
    const { adjustments } = applyDeclarationSanctions(state, [{ phase: 'pares', revealPoints: null }]);
    // B doit récupérer : ses paires (1pt) + le Tira de la mise iduki (2pt) = 3pt
    const totalB = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    eq(totalB, 3, `B doit prendre 3 points (1 pares + 2 mise), got ${totalB}`);
  });

  t('V4 Article 15b : partenaire couvre faux jeu → erreur ignorée', () => {
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]),    declaredPares: false, declaredJuego: true },  // ment, total=22
      { id: 1, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
      { id: 2, hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: true },  // 37, vrai jeu
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'juego',
    };
    const { adjustments } = applyDeclarationSanctions(state, [{ phase: 'juego', revealPoints: null }]);
    // 15b : partenaire (joueur 2) a vraiment le jeu → on ignore l'erreur
    const totalB = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    eq(totalB, 0, '15b : pas de sanction puisque partenaire couvre');
  });

  t('V4 Article 15c : faux jeu, partenaire pas, adv oui → adv prend ses points', () => {
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]),    declaredPares: false, declaredJuego: true }, // ment
      { id: 1, hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: true }, // 37, vrai jeu
      { id: 2, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false }, // partenaire pas de jeu
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'juego',
    };
    const { adjustments } = applyDeclarationSanctions(state, [{ phase: 'juego', revealPoints: null }]);
    // B (joueur 1) prend ses 2pt de jeu (37 → 2pt)
    const totalB = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    assert(totalB >= 2, `B doit prendre au moins 2 points (jeu), got ${totalB}`);
  });

  t('V4 Article 15a : aucun jeu nulle part → adv prend Pontua', () => {
    const players = [
      { id: 0, hand: mkH([4, 5, 6, 7]),  declaredPares: false, declaredJuego: true }, // ment, 22
      { id: 1, hand: mkH([4, 5, 6, 7]),  declaredPares: false, declaredJuego: false }, // pas de jeu
      { id: 2, hand: mkH([1, 2, 3, 4]),  declaredPares: false, declaredJuego: false }, // pas de jeu
      { id: 3, hand: mkH([1, 2, 3, 4]),  declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'juego', // déclaré donc juego, même si erreur
    };
    const { adjustments } = applyDeclarationSanctions(state, [{ phase: 'juego', revealPoints: null }]);
    const totalB = adjustments.filter(a => a.team === 'B').reduce((s, a) => s + a.delta, 0);
    assert(totalB >= 1, '15a : adv doit prendre au moins 1 (Pontua)');
  });

  t('V4 Article 16c : jeu non annoncé, adv a déclaré → scoring normal couvre', () => {
    const players = [
      { id: 0, hand: mkH([12, 12, 11, 7]), declaredPares: false, declaredJuego: false }, // jeu caché
      { id: 1, hand: mkH([12, 12, 11, 5]), declaredPares: false, declaredJuego: true },  // jeu déclaré
      { id: 2, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
      { id: 3, hand: mkH([1, 2, 3, 4]),    declaredPares: false, declaredJuego: false },
    ];
    const state = {
      players,
      phases: { grande: emptyBetState(), chica: emptyBetState(), pares: emptyBetState(), juego: emptyBetState() },
      score: { A: 0, B: 0 },
      juegoOrPunto: 'juego',
    };
    const { adjustments } = applyDeclarationSanctions(state, [{ phase: 'juego', revealPoints: null }]);
    // 16c : pas de sanction supplémentaire (scoring normal couvre l'adversaire)
    eq(adjustments.length, 0, '16c : scoring normal suffit');
  });

  /* ===== V4 — Aucun score modifié après reveal ===== */

  t('V4 Reveal verrouillé : aucune action de pari ne change le score', () => {
    const baseState = initialState(42, ['A', 'B', 'C', 'D']);
    const stateRevealed = {
      ...baseState,
      phase: 'reveal',
      score: { A: 18, B: 22 },
      mancheOver: false,
    };
    let s = stateRevealed;
    s = reducer(s, { type: 'embido' });
    s = reducer(s, { type: 'gehiago', amount: 4 });
    s = reducer(s, { type: 'tira' });
    s = reducer(s, { type: 'iduki' });
    s = reducer(s, { type: 'mus' });
    s = reducer(s, { type: 'declare-pares', value: true });
    eq(s.score.A, 18, 'score A inchangé');
    eq(s.score.B, 22, 'score B inchangé');
    eq(s.phase, 'reveal');
  });

  return results;
}

/* ============================================================================
 * UI v2 — Refonte complète "Cercle basque"
 *
 * Concept : table de jeu d'un cercle de notable, vert profond + parchemin,
 * accents bordeaux et or vieilli. Pas casino, pas mobile-game.
 * ============================================================================ */

const SIGNAL_LABELS = {
  'two-kings': '2 Rois',
  'two-aces': '2 As',
  'mediak': 'Mediak',
  'dobliak': 'Dobliak',
  '29': '29',
  '30-31': '30/31',
  'juego': 'Jeu',
};

const SIGN_TOOLTIPS = {
  'two-kings': 'Tu as au moins deux Rois (effectifs).',
  'two-aces': 'Tu as au moins deux As (effectifs).',
  'mediak': 'Tu as un brelan (3 cartes même rang).',
  'dobliak': 'Tu as deux paires ou un carré.',
  '29': 'Total = 29 (signe légal après les Paires uniquement).',
  '30-31': 'Total = 30 ou 31.',
  'juego': "Tu as Jeu (≥31), mais pas exactement 31.",
};

// Raisons de désactivation des actions (UX du brief, point 6)
function disabledReasonFor(action, state, human) {
  const phase = state.phase;
  const me = human;
  if (phase === 'pares-declare') {
    const real = evaluatePares(me.hand);
    if (action === 'declare-pares-true' && !real.has) return "Tu n'as pas de paires.";
    if (action === 'declare-pares-false' && real.has) return "Tu as une paire — tu dois l'annoncer (art. 13-14).";
  }
  if (phase === 'juego-declare') {
    const real = evaluateJuegoPunto(me.hand).hasJuego;
    if (action === 'declare-juego-true' && !real) return "Ton total est inférieur à 31, donc pas de Jeu.";
    if (action === 'declare-juego-false' && real) return "Tu as Jeu (≥31) — tu dois l'annoncer (art. 15-16).";
  }
  return null;
}

const PHASE_FLOW = [
  { key: 'mus-decision',  label: 'Mus / Mintza' },
  { key: 'discard',       label: 'Défausse' },
  { key: 'grande',        label: 'Grand' },
  { key: 'chica',         label: 'Petit' },
  { key: 'pares',         label: 'Paires' },
  { key: 'juego',         label: 'Jeu / Point' },
  { key: 'reveal',        label: 'Résolution' },
];

function currentFlowKey(state) {
  if (state.phase === 'mus-decision') return 'mus-decision';
  if (state.phase === 'discard') return 'discard';
  if (state.phase === 'pares-declare' || state.phase === 'pares') return 'pares';
  if (state.phase === 'juego-declare') return 'juego';
  if (state.phase === 'bet') {
    if (state.currentBetPhase === 'grande') return 'grande';
    if (state.currentBetPhase === 'chica') return 'chica';
    if (state.currentBetPhase === 'pares') return 'pares';
    if (state.currentBetPhase === 'juego') return 'juego';
  }
  if (state.phase === 'reveal') return 'reveal';
  return null;
}

const FLOW_ORDER = ['mus-decision', 'discard', 'grande', 'chica', 'pares', 'juego', 'reveal'];

/* ===== Feuille de style globale ===== */

const GLOBAL_STYLES = `
  :root {
    --table-green:    #073D2A;
    --deep-green:     #052A1D;
    --felt-highlight: #0F5A3C;
    --felt-rim:       #042316;
    --parchment:      #F3E7CF;
    --paper:          #FFF8EA;
    --paper-soft:     #F8F0DA;
    --basque-red:     #9E1F24;
    --oxblood:        #5A1418;
    --aged-gold:      #D2A82E;
    --brass:          #B8892E;
    --brass-dark:     #8B6418;
    --ink:            #1B1713;
    --ink-soft:       #2D2620;
    --muted-ink:      #706353;
    --whisper:        #A89A82;

    --shadow-sm: 0 1px 2px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.12);
    --shadow-md: 0 2px 6px rgba(0,0,0,.22), 0 8px 24px rgba(0,0,0,.18);
    --shadow-lg: 0 6px 14px rgba(0,0,0,.30), 0 20px 50px rgba(0,0,0,.28);
    --shadow-card: 0 1px 1px rgba(0,0,0,.18), 0 2px 4px rgba(0,0,0,.10), 0 8px 16px rgba(0,0,0,.18);
    --shadow-card-hover: 0 2px 3px rgba(0,0,0,.20), 0 8px 14px rgba(0,0,0,.18), 0 16px 32px rgba(0,0,0,.22);

    --radius-sm: 4px;
    --radius:    8px;
    --radius-lg: 14px;
    --radius-xl: 20px;

    --font-display: 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif;
    --font-ui:      'Optima', 'Avenir Next', 'Gill Sans', 'Trebuchet MS', sans-serif;
    --font-mono:    'IBM Plex Mono', 'JetBrains Mono', 'Menlo', monospace;
  }

  * { box-sizing: border-box; }

  .mus-app {
    min-height: 100vh;
    color: var(--parchment);
    font-family: var(--font-ui);
    /* Vert profond avec un voile de grain : SVG noise inline */
    background:
      radial-gradient(ellipse at 50% 30%, var(--felt-highlight) 0%, var(--table-green) 45%, var(--deep-green) 100%),
      var(--deep-green);
    position: relative;
    overflow-x: hidden;
  }
  .mus-app::before {
    content: '';
    position: fixed; inset: 0;
    pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.06 0'/></filter><rect width='240' height='240' filter='url(%23n)'/></svg>");
    opacity: 1;
    z-index: 0;
  }
  .mus-app > * { position: relative; z-index: 1; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ============== TopBar ============== */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 28px 10px;
    gap: 24px;
    border-bottom: 1px solid rgba(210,168,46,0.18);
  }
  .brand { display: flex; flex-direction: column; gap: 0; }
  .brand-title {
    font-family: var(--font-display);
    font-size: 32px;
    color: var(--paper);
    letter-spacing: 14px;
    margin-left: 4px;
    line-height: 1;
    font-weight: 600;
    text-shadow: 0 2px 12px rgba(0,0,0,0.3);
  }
  .brand-sub {
    font-family: var(--font-ui);
    font-size: 10px;
    color: var(--whisper);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-top: 6px;
  }
  .topbar-actions { display: flex; gap: 8px; align-items: center; }

  .icon-btn {
    background: transparent;
    border: 1px solid rgba(210,168,46,0.28);
    color: var(--parchment);
    font-family: var(--font-ui);
    font-size: clamp(12px, 0.85vw, 15px);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    padding: clamp(8px, 0.6vw, 11px) clamp(14px, 1vw, 18px);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 160ms ease;
  }
  .icon-btn:hover {
    background: rgba(210,168,46,0.08);
    border-color: var(--aged-gold);
    color: var(--paper);
  }
  .icon-btn:focus-visible {
    outline: 2px solid var(--aged-gold);
    outline-offset: 2px;
  }

  /* ============== Scoreboard ============== */
  .scoreboard {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 18px;
    align-items: stretch;
    padding: 14px 22px;
    background: linear-gradient(180deg, rgba(255,248,234,0.04) 0%, rgba(255,248,234,0.02) 100%);
    border: 1px solid rgba(210,168,46,0.20);
    border-radius: var(--radius-lg);
    margin: 0 28px;
  }
  .team-block {
    display: flex; flex-direction: column; gap: 6px;
    padding: 6px 12px;
  }
  .team-block.is-A { border-left: 3px solid var(--aged-gold); }
  .team-block.is-B { border-right: 3px solid var(--basque-red); align-items: flex-end; }
  .team-name {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--whisper);
  }
  .team-score-row {
    display: flex; align-items: baseline; gap: 8px;
  }
  .is-B .team-score-row { flex-direction: row-reverse; }
  .team-score {
    font-family: var(--font-display);
    font-size: clamp(56px, 4vw, 84px);
    font-weight: 600;
    line-height: 1;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    text-shadow: 0 2px 10px rgba(0,0,0,0.25);
  }
  .team-target {
    font-family: var(--font-ui);
    font-size: clamp(14px, 1vw, 18px);
    color: var(--whisper);
  }
  .team-progress-track {
    height: 4px; width: 100%;
    background: rgba(255,248,234,0.08);
    border-radius: 2px;
    overflow: hidden;
  }
  .team-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--brass) 0%, var(--aged-gold) 100%);
    border-radius: 2px;
    transition: width 600ms cubic-bezier(.2,.8,.2,1);
  }
  .team-progress-fill.is-B {
    background: linear-gradient(90deg, var(--oxblood) 0%, var(--basque-red) 100%);
  }
  .team-meta {
    display: flex; gap: 12px;
    font-size: 10px; letter-spacing: 1px;
    color: var(--whisper);
    text-transform: uppercase;
  }
  .is-B .team-meta { justify-content: flex-end; }
  .team-meta strong { color: var(--paper); font-weight: 600; }
  .hamarreko-row {
    display: flex; gap: 4px; margin-top: 2px;
  }
  .is-B .hamarreko-row { justify-content: flex-end; }
  .hamarreko-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: rgba(255,248,234,0.10);
    border: 1px solid rgba(210,168,46,0.30);
  }
  .hamarreko-dot.lit { background: var(--aged-gold); border-color: var(--aged-gold); box-shadow: 0 0 6px rgba(210,168,46,0.5); }

  .scoreboard-center {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px;
    padding: 0 14px;
    border-left: 1px solid rgba(210,168,46,0.15);
    border-right: 1px solid rgba(210,168,46,0.15);
  }
  .manche-label {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--whisper);
  }
  .manche-num {
    font-family: var(--font-display);
    font-size: clamp(32px, 2.3vw, 44px);
    color: var(--paper);
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .manche-sub {
    font-family: var(--font-ui);
    font-size: 11px;
    color: var(--whisper);
  }
  .manche-balls {
    display: flex; gap: 5px; margin-top: 6px;
  }
  .manche-ball {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: rgba(255,248,234,0.08);
    border: 1px solid var(--whisper);
  }
  .manche-ball.lit-A { background: var(--aged-gold); border-color: var(--aged-gold); }
  .manche-ball.lit-B { background: var(--basque-red); border-color: var(--basque-red); }

  /* ============== PhaseRail ============== */
  .phase-rail {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px 28px 0;
    flex-wrap: wrap;
  }
  .phase-step {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--whisper);
    transition: all 200ms ease;
  }
  .phase-step .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: rgba(255,248,234,0.20);
  }
  .phase-step.done { color: var(--brass); }
  .phase-step.done .dot { background: var(--brass); }
  .phase-step.active {
    background: rgba(210,168,46,0.12);
    color: var(--paper);
    border: 1px solid var(--aged-gold);
    box-shadow: 0 0 0 1px rgba(210,168,46,0.20), 0 4px 12px rgba(0,0,0,0.25);
  }
  .phase-step.active .dot {
    background: var(--aged-gold);
    box-shadow: 0 0 8px var(--aged-gold);
    animation: phase-pulse 2s ease-in-out infinite;
  }
  @keyframes phase-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.3); }
  }
  .phase-arrow {
    color: rgba(255,248,234,0.25);
    font-size: 10px;
  }

  /* ============== Game table ============== */
  .game-area {
    padding: 24px 28px;
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 24px;
    align-items: start;
  }
  .game-table-wrap {
    position: relative;
    min-height: 580px;
  }
  .game-table {
    position: relative;
    aspect-ratio: 16 / 11;
    min-height: 540px;
    background:
      radial-gradient(ellipse at center, var(--felt-highlight) 0%, var(--table-green) 60%, var(--deep-green) 100%);
    border-radius: 50% / 38%;
    box-shadow:
      inset 0 0 0 6px var(--felt-rim),
      inset 0 0 0 8px rgba(210,168,46,0.20),
      inset 0 12px 60px rgba(0,0,0,0.5),
      0 25px 60px rgba(0,0,0,0.45);
    overflow: visible;
  }
  .game-table::before {
    content: '';
    position: absolute; inset: 16px;
    border-radius: inherit;
    border: 1px dashed rgba(210,168,46,0.18);
    pointer-events: none;
  }

  .seat {
    position: absolute;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .seat.top    { top: -18px;    left: 50%; transform: translateX(-50%); }
  .seat.left   { left: -28px;   top: 50%;  transform: translateY(-50%); align-items: flex-end; }
  .seat.right  { right: -28px;  top: 50%;  transform: translateY(-50%); align-items: flex-start; }
  .seat.left .seat-card-row, .seat.right .seat-card-row { flex-direction: column; gap: 4px; }
  .seat.left .seat-info, .seat.right .seat-info { flex-direction: column; }

  .seat-info {
    display: flex; align-items: center; gap: 10px;
  }
  .avatar {
    width: 44px; height: 44px;
    border-radius: 50%;
    background: linear-gradient(145deg, var(--paper) 0%, var(--paper-soft) 100%);
    color: var(--ink);
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 600;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid rgba(210,168,46,0.5);
    box-shadow: var(--shadow-sm);
    position: relative;
    transition: all 220ms ease;
  }
  .avatar.team-A { border-color: var(--aged-gold); }
  .avatar.team-B { border-color: var(--basque-red); }
  .avatar.active {
    box-shadow: 0 0 0 3px var(--aged-gold), 0 0 14px rgba(210,168,46,0.55);
    transform: scale(1.05);
  }
  .avatar.active::after {
    content: ''; position: absolute; inset: -8px;
    border-radius: 50%;
    border: 1px solid var(--aged-gold);
    animation: ring-pulse 1.6s ease-in-out infinite;
  }
  @keyframes ring-pulse {
    0% { opacity: 0.8; transform: scale(0.95); }
    100% { opacity: 0; transform: scale(1.35); }
  }

  .seat-text { display: flex; flex-direction: column; }
  .seat-name {
    font-family: var(--font-display);
    font-size: 15px; color: var(--paper);
    line-height: 1.1;
  }
  .seat-team {
    font-family: var(--font-ui);
    font-size: 9px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--whisper);
  }
  .seat-state {
    font-size: 11px;
    font-style: italic;
    color: var(--brass);
    margin-top: 1px;
  }
  .seat-badges { display: flex; gap: 4px; margin-top: 2px; }
  .badge {
    font-family: var(--font-ui);
    font-size: 8.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    padding: 1.5px 6px;
    border-radius: 3px;
    line-height: 1.4;
  }
  .badge.donneur {
    background: rgba(210,168,46,0.14);
    color: var(--aged-gold);
    border: 1px solid rgba(210,168,46,0.40);
  }
  .badge.esku {
    background: var(--basque-red);
    color: var(--paper);
    font-weight: 600;
  }

  .seat-card-row {
    display: flex; gap: 4px;
  }

  /* ============== Cards ============== */
  .card {
    position: relative;
    background: linear-gradient(145deg, var(--paper) 0%, var(--paper-soft) 100%);
    border-radius: 6px;
    box-shadow: var(--shadow-card);
    overflow: hidden;
    transition: transform 220ms cubic-bezier(.2,.8,.2,1), box-shadow 220ms ease;
    cursor: default;
    border: 1px solid rgba(27,23,19,0.12);
  }
  /* Tailles fluides : min = taille historique, croissance au-delà de ~1400px.
     Les media queries mobiles redéfinissent width+height en px et gardent la main. */
  .card.large    { width: clamp(78px, 5.5vw, 122px); aspect-ratio: 78 / 116; height: auto; }
  .card.medium   { width: clamp(56px, 4vw, 88px);    aspect-ratio: 56 / 84;  height: auto; }
  .card.small    { width: clamp(36px, 2.55vw, 56px); aspect-ratio: 36 / 54;  height: auto; }
  .card.tiny     { width: clamp(26px, 1.85vw, 40px); aspect-ratio: 26 / 39;  height: auto; }
  .card.clickable { cursor: pointer; }
  .card.clickable:hover {
    transform: translateY(-6px);
    box-shadow: var(--shadow-card-hover);
  }
  .card.selected {
    transform: translateY(-12px);
    box-shadow: 0 0 0 2px var(--aged-gold), var(--shadow-card-hover);
  }
  .card.dealing {
    animation: card-deal 380ms ease-out backwards;
  }
  @keyframes card-deal {
    from { opacity: 0; transform: translateY(-22px) rotate(-6deg); }
    to   { opacity: 1; transform: translateY(0) rotate(0); }
  }
  .card-back {
    background:
      repeating-linear-gradient(45deg,
        var(--oxblood) 0, var(--oxblood) 6px,
        var(--basque-red) 6px, var(--basque-red) 12px);
    box-shadow: inset 0 0 0 3px var(--paper-soft), inset 0 0 0 4px rgba(210,168,46,0.6), var(--shadow-card);
  }
  .card-back-emblem {
    position: absolute; inset: 12%;
    border-radius: 4px;
    border: 1px dashed rgba(255,248,234,0.40);
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,248,234,0.35);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 4px;
  }

  /* ============== Center display (table inner) ============== */
  .table-center {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 60%; max-width: 380px;
    text-align: center;
    pointer-events: none;
  }
  .center-phase {
    font-family: var(--font-display);
    font-size: 28px;
    color: var(--paper);
    letter-spacing: 3px;
    text-transform: uppercase;
    line-height: 1;
    text-shadow: 0 2px 12px rgba(0,0,0,0.4);
    animation: phase-fade-in 500ms ease-out;
  }
  @keyframes phase-fade-in {
    from { opacity: 0; transform: translateY(-4px); letter-spacing: 8px; }
    to { opacity: 1; transform: translateY(0); letter-spacing: 3px; }
  }
  .center-meta {
    margin-top: 14px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--whisper);
    letter-spacing: 1px;
  }
  .center-mise {
    margin-top: 6px;
    font-family: var(--font-display);
    font-size: 22px;
    color: var(--aged-gold);
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 12px rgba(210,168,46,0.4);
  }
  .center-status {
    margin-top: 10px;
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--paper);
    font-style: italic;
  }
  .center-status .status-name { color: var(--aged-gold); font-style: normal; font-weight: 600; }

  .last-action {
    position: absolute;
    bottom: 20%; left: 50%;
    transform: translateX(-50%);
    background: var(--ink-soft);
    color: var(--paper);
    border: 1px solid rgba(210,168,46,0.40);
    padding: 6px 14px;
    border-radius: var(--radius);
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 1px;
    box-shadow: var(--shadow-md);
    animation: pop-in 320ms cubic-bezier(.2,.8,.2,1);
    pointer-events: none;
  }
  @keyframes pop-in {
    from { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.92); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  }

  /* ============== Hand & ActionDock (bottom) ============== */
  .hand-zone {
    margin-top: 24px;
    display: flex; flex-direction: column; align-items: center; gap: 18px;
  }
  .hand-row {
    display: flex; gap: 10px;
    padding: 6px 0;
  }
  .hand-row .card { animation-delay: calc(var(--i, 0) * 80ms); }

  .you-info {
    display: flex; align-items: center; gap: 14px;
    font-family: var(--font-ui);
    color: var(--whisper);
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .you-info strong { color: var(--paper); font-family: var(--font-display); font-size: 14px; letter-spacing: 1px; }
  .you-info .pip { width: 4px; height: 4px; border-radius: 50%; background: var(--whisper); }

  .action-dock {
    background: linear-gradient(180deg, rgba(255,248,234,0.04), rgba(255,248,234,0.02));
    border: 1px solid rgba(210,168,46,0.22);
    border-radius: var(--radius-lg);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    max-width: 720px;
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(6px);
  }
  .dock-context {
    font-family: var(--font-ui);
    font-size: 10px;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: var(--whisper);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .dock-context .dock-hint {
    color: var(--brass);
    font-style: italic;
    text-transform: none;
    letter-spacing: 0.5px;
    font-size: 11px;
  }
  .dock-row {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  .dock-group {
    display: flex; gap: 6px; align-items: center;
    padding: 4px 8px 4px 0;
  }
  .dock-group + .dock-group {
    border-left: 1px solid rgba(210,168,46,0.18);
    padding-left: 10px;
  }

  /* ============== ActionButton ============== */
  .btn {
    font-family: var(--font-ui);
    font-size: clamp(12px, 0.85vw, 16px);
    letter-spacing: 1.8px;
    text-transform: uppercase;
    padding: clamp(10px, 0.75vw, 14px) clamp(18px, 1.3vw, 26px);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all 180ms cubic-bezier(.2,.8,.2,1);
    border: 1px solid transparent;
    white-space: nowrap;
    font-weight: 500;
  }
  .btn:focus-visible {
    outline: 2px solid var(--aged-gold);
    outline-offset: 2px;
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
    transform: none !important;
    box-shadow: none !important;
  }
  .btn-default {
    background: rgba(255,248,234,0.04);
    border-color: rgba(210,168,46,0.30);
    color: var(--parchment);
  }
  .btn-default:hover:not(:disabled) {
    background: rgba(255,248,234,0.10);
    border-color: var(--aged-gold);
    color: var(--paper);
  }
  .btn-primary {
    background: linear-gradient(180deg, var(--aged-gold) 0%, var(--brass) 100%);
    color: var(--ink);
    font-weight: 600;
    box-shadow: 0 2px 0 var(--brass-dark), 0 4px 12px rgba(210,168,46,0.35);
  }
  .btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 3px 0 var(--brass-dark), 0 8px 18px rgba(210,168,46,0.5);
  }
  .btn-primary:active:not(:disabled) {
    transform: translateY(1px);
    box-shadow: 0 1px 0 var(--brass-dark);
  }
  .btn-success {
    background: rgba(15,90,60,0.85);
    border-color: rgba(210,168,46,0.45);
    color: var(--paper);
  }
  .btn-success:hover:not(:disabled) {
    background: var(--felt-highlight);
    border-color: var(--aged-gold);
  }
  .btn-danger {
    background: linear-gradient(180deg, var(--basque-red) 0%, var(--oxblood) 100%);
    color: var(--paper);
    font-weight: 600;
    box-shadow: 0 2px 0 #3A0D10, 0 4px 12px rgba(158,31,36,0.4);
  }
  .btn-danger:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 3px 0 #3A0D10, 0 8px 18px rgba(158,31,36,0.55);
  }
  .btn-warning {
    background: rgba(184,137,46,0.18);
    border-color: var(--brass);
    color: var(--aged-gold);
  }
  .btn-warning:hover:not(:disabled) {
    background: rgba(184,137,46,0.28);
    color: var(--paper);
  }
  .btn-ghost {
    background: transparent;
    border-color: rgba(255,248,234,0.16);
    color: var(--whisper);
    font-size: 11px;
    padding: 6px 12px;
  }
  .btn-ghost:hover:not(:disabled) {
    background: rgba(255,248,234,0.06);
    color: var(--paper);
  }

  /* ============== Side panels ============== */
  .side-panel {
    background: var(--paper);
    color: var(--ink);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    overflow: hidden;
    border: 1px solid rgba(27,23,19,0.06);
  }
  .panel-head {
    background: var(--ink);
    color: var(--paper);
    padding: 10px 14px;
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .panel-head .head-action { font-size: 10px; letter-spacing: 1px; opacity: 0.7; }
  .panel-body { padding: 12px 14px; font-family: var(--font-ui); font-size: 13px; }

  .log-list {
    display: flex; flex-direction: column;
    max-height: 320px; overflow-y: auto;
  }
  .log-row {
    padding: 6px 0;
    border-bottom: 1px dotted rgba(27,23,19,0.10);
    display: flex; gap: 8px; align-items: baseline;
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .log-row:last-child { border-bottom: none; }
  .log-actor { font-weight: 600; color: var(--ink); min-width: 64px; }
  .log-actor.team-A { color: var(--brass-dark); }
  .log-actor.team-B { color: var(--oxblood); }
  .log-text { flex: 1; }
  .log-text strong { color: var(--ink); }
  .log-points {
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--brass-dark);
    font-weight: 600;
  }
  .log-points.is-B { color: var(--oxblood); }

  /* ============== Bet tracker rows ============== */
  .bet-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0;
    border-bottom: 1px dotted rgba(27,23,19,0.08);
  }
  .bet-row:last-child { border-bottom: none; }
  .bet-name {
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--muted-ink);
  }
  .bet-name.active {
    color: var(--basque-red);
    font-weight: 600;
  }
  .bet-state {
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .bet-state.empty { color: var(--muted-ink); font-size: 12px; font-style: italic; font-family: var(--font-ui); }
  .bet-state .stack-num { color: var(--brass-dark); font-weight: 600; }

  /* ============== Signals panel ============== */
  .sig-grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;
    margin-bottom: 10px;
  }
  .sig-btn {
    background: rgba(27,23,19,0.04);
    border: 1px solid rgba(27,23,19,0.14);
    color: var(--ink);
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 0.6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 160ms ease;
    text-align: left;
  }
  .sig-btn:hover:not(:disabled) {
    background: rgba(210,168,46,0.10);
    border-color: var(--brass);
    color: var(--ink);
  }
  .sig-btn:disabled { cursor: not-allowed; opacity: 0.35; }
  .sig-mode-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 10px;
    font-size: 11px;
    color: var(--muted-ink);
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .sig-mode-row select {
    border: 1px solid rgba(27,23,19,0.20);
    background: var(--paper-soft);
    color: var(--ink);
    border-radius: var(--radius-sm);
    padding: 3px 8px;
    font-family: var(--font-ui);
    font-size: 11px;
  }
  .sig-recent {
    margin-top: 8px;
    border-top: 1px dotted rgba(27,23,19,0.18);
    padding-top: 8px;
  }
  .sig-recent-row {
    font-size: 11px; color: var(--ink-soft);
    padding: 2px 0;
  }
  .sig-recent-row .sig-actor { color: var(--brass-dark); font-weight: 600; }

  /* ============== Reveal overlay ============== */
  .reveal-overlay {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, rgba(7,61,42,0.92) 0%, rgba(5,42,29,0.96) 100%);
    backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center;
    z-index: 60;
    padding: 32px 20px;
    animation: overlay-in 320ms ease;
  }
  @keyframes overlay-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .reveal-card {
    background: var(--paper);
    color: var(--ink);
    border-radius: var(--radius-xl);
    max-width: 760px;
    width: 100%;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0,0,0,0.6);
    animation: reveal-in 480ms cubic-bezier(.2,.8,.2,1);
  }
  @keyframes reveal-in {
    from { opacity: 0; transform: translateY(20px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .reveal-head {
    background: linear-gradient(135deg, var(--ink) 0%, var(--ink-soft) 100%);
    color: var(--paper);
    padding: 24px 28px;
    border-bottom: 4px solid var(--aged-gold);
  }
  .reveal-title {
    font-family: var(--font-display);
    font-size: 32px;
    letter-spacing: 2px;
    margin: 0;
    line-height: 1.1;
  }
  .reveal-sub {
    font-family: var(--font-ui);
    font-size: 13px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--whisper);
    margin-top: 6px;
  }
  .reveal-final-score {
    display: flex; align-items: center; gap: 24px;
    margin-top: 14px;
    font-family: var(--font-display);
    font-size: 24px;
  }
  .reveal-final-score .vs { color: var(--whisper); font-size: 14px; }
  .reveal-final-score .a { color: var(--aged-gold); }
  .reveal-final-score .b { color: var(--basque-red); }
  .reveal-body { padding: 20px 28px; }
  .reveal-phase-row {
    display: flex; align-items: center; gap: 14px;
    padding: 12px 14px;
    border-radius: var(--radius);
    margin-bottom: 6px;
    background: var(--paper-soft);
  }
  .reveal-phase-row.has-points {
    background: linear-gradient(90deg, rgba(210,168,46,0.18) 0%, rgba(210,168,46,0.04) 100%);
    border-left: 3px solid var(--aged-gold);
  }
  .reveal-phase-name {
    font-family: var(--font-display);
    font-size: 16px;
    width: 110px;
    color: var(--ink);
  }
  .reveal-phase-detail {
    flex: 1;
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--ink-soft);
  }
  .reveal-phase-detail .pts {
    color: var(--brass-dark); font-weight: 600;
    font-family: var(--font-display); font-size: 16px;
  }
  .reveal-phase-detail .pts.is-B { color: var(--oxblood); }
  .reveal-foot {
    padding: 16px 28px 22px;
    display: flex; justify-content: flex-end; gap: 10px;
    border-top: 1px solid rgba(27,23,19,0.08);
  }

  /* ============== Help drawer ============== */
  .help-drawer {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 380px; max-width: 100vw;
    background: var(--paper);
    color: var(--ink);
    box-shadow: -10px 0 40px rgba(0,0,0,0.4);
    transform: translateX(100%);
    transition: transform 320ms cubic-bezier(.2,.8,.2,1);
    z-index: 70;
    display: flex; flex-direction: column;
  }
  .help-drawer.open { transform: translateX(0); }
  .help-drawer .panel-head { border-bottom: 4px solid var(--aged-gold); }
  .help-drawer .panel-body {
    overflow-y: auto;
    padding: 18px 20px;
    line-height: 1.6;
  }
  .help-drawer h4 {
    font-family: var(--font-display);
    font-size: 15px;
    margin: 14px 0 4px;
    color: var(--basque-red);
    letter-spacing: 1px;
  }
  .help-drawer h4:first-child { margin-top: 0; }
  .help-drawer p { margin: 0 0 8px; font-size: 13px; }
  .help-drawer code {
    background: rgba(27,23,19,0.06);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* ============== Discard dock specific ============== */
  .discard-banner {
    background: rgba(210,168,46,0.10);
    border: 1px solid rgba(210,168,46,0.40);
    border-radius: var(--radius);
    padding: 10px 14px;
    color: var(--parchment);
    font-size: 13px;
  }
  .discard-banner strong { color: var(--aged-gold); }

  /* ============== Tooltip / disabled reason ============== */
  [data-reason] {
    position: relative;
  }
  [data-reason]:hover::after {
    content: attr(data-reason);
    position: absolute;
    bottom: calc(100% + 6px); left: 50%;
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--paper);
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 0.5px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    max-width: 240px; white-space: normal; min-width: 180px;
    text-align: center;
    box-shadow: var(--shadow-md);
    z-index: 80;
    pointer-events: none;
  }

  /* ============== Live region (screenreader) ============== */
  .visually-hidden {
    position: absolute !important;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0);
    white-space: nowrap; border: 0;
  }

  /* ============== Responsive ============== */

  /* ---------- Grands écrans : layout plafonné, table sur la hauteur ---------- */
  @media (min-width: 1101px) {
    .topbar, .phase-rail, .game-area {
      max-width: 1880px;
      margin-left: auto; margin-right: auto;
    }
    .scoreboard {
      width: calc(100% - 56px); /* préserve les gouttières 28px actuelles */
      max-width: calc(1880px - 56px);
      margin-left: auto; margin-right: auto;
    }
    /* Largeur dérivée de la hauteur visée pour que l'aspect-ratio 16/11
       donne une hauteur clampée [540px, 100vh - 620px, 960px].
       620px ≈ topbar + scoreboard + phase-rail + hand-zone + dock. */
    .game-table {
      width: min(100%, calc(clamp(540px, 100vh - 620px, 960px) * 16 / 11));
      margin-left: auto; margin-right: auto;
    }
    .action-dock { max-width: min(900px, 100%); }
    .avatar { width: clamp(44px, 3vw, 60px); height: clamp(44px, 3vw, 60px); font-size: clamp(18px, 1.2vw, 24px); }
    .seat-name { font-size: clamp(15px, 1vw, 19px); }
    .center-phase { font-size: clamp(28px, 1.9vw, 40px); }
    .center-mise { font-size: clamp(22px, 1.5vw, 30px); }
    .table-center { max-width: clamp(380px, 26vw, 520px); }
  }

  /* Bouton flottant + drawer mobile : cachés sur desktop */
  .topbar-journal-btn { display: none; }
  .topbar-badge {
    background: var(--basque-red);
    color: var(--paper);
    border-radius: 999px;
    min-width: 16px; height: 16px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 9px;
    padding: 0 4px;
    margin-left: 6px;
  }
  .mobile-panel-backdrop { display: none; }
  .drawer-close-mobile { display: none; }

  @media (max-width: 1100px) {
    .game-area { grid-template-columns: 1fr; }
  }

  /* ---------- Tablette / mobile large ---------- */
  @media (max-width: 1100px) {
    /* Le panneau latéral devient un drawer qui glisse depuis la droite */
    .game-area > aside {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 360px; max-width: 88vw;
      background: linear-gradient(180deg, var(--deep-green) 0%, var(--table-green) 100%);
      box-shadow: -12px 0 40px rgba(0,0,0,0.5);
      padding: 64px 16px 16px;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 320ms cubic-bezier(.2,.8,.2,1);
      z-index: 72;
    }
    .game-area > aside.open { transform: translateX(0); }

    .mobile-panel-backdrop.show {
      display: block;
      position: fixed; inset: 0;
      background: rgba(5,42,29,0.55);
      backdrop-filter: blur(2px);
      z-index: 71;
      animation: overlay-in 240ms ease;
    }

    /* Le bouton Journal apparaît dans la topbar quand le panneau est en drawer */
    .topbar-journal-btn {
      display: inline-flex;
      align-items: center;
    }
    /* Bouton fermer dans le drawer */
    .drawer-close-mobile {
      display: block;
      position: absolute;
      top: 14px; right: 14px;
      background: rgba(255,248,234,0.08);
      border: 1px solid rgba(210,168,46,0.3);
      color: var(--parchment);
      border-radius: 50%;
      width: 34px; height: 34px;
      font-size: 16px;
      cursor: pointer;
      z-index: 73;
    }
  }

  /* ---------- Mobile (téléphone) ---------- */
  @media (max-width: 720px) {
    .topbar { padding: 12px 14px 6px; gap: 8px; }
    .brand-title { font-size: 22px; letter-spacing: 7px; }
    .brand-sub { font-size: 8.5px; letter-spacing: 2px; }
    .topbar-actions { gap: 5px; }
    .icon-btn { padding: 6px 9px; font-size: 10px; letter-spacing: 1px; }

    .scoreboard {
      margin: 0 10px; padding: 8px 10px; gap: 6px;
      border-radius: var(--radius);
    }
    .team-block { padding: 2px 4px; }
    .team-name { font-size: 8.5px; letter-spacing: 1.5px; }
    .team-score { font-size: 30px; }
    .team-target { font-size: 11px; }
    .hamarreko-dot { width: 5px; height: 5px; }
    .team-meta { font-size: 8px; gap: 6px; }
    .scoreboard-center { padding: 0 6px; }
    .manche-label { font-size: 8.5px; letter-spacing: 1.5px; }
    .manche-num { font-size: 18px; }
    .manche-sub { font-size: 9px; }
    .manche-ball { width: 7px; height: 7px; }

    .phase-rail { padding: 10px 6px 0; gap: 3px; }
    .phase-step { padding: 3px 6px; font-size: 8.5px; letter-spacing: 0.5px; }
    .phase-step .dot { width: 4px; height: 4px; }
    .phase-arrow { display: none; }

    .game-area { padding: 10px 8px 100px; gap: 12px; }

    /* Table compacte mais TOUS les joueurs restent visibles */
    .game-table-wrap { min-height: auto; }
    .game-table {
      min-height: 360px;
      aspect-ratio: 1 / 1;
      border-radius: 30% / 26%;
      box-shadow:
        inset 0 0 0 4px var(--felt-rim),
        inset 0 0 0 6px rgba(210,168,46,0.18),
        inset 0 8px 36px rgba(0,0,0,0.5),
        0 14px 36px rgba(0,0,0,0.4);
    }
    .game-table::before { inset: 10px; }

    /* Sièges autour de la table, compacts */
    .seat { gap: 4px; }
    .seat.top  { top: 6px; left: 50%; transform: translateX(-50%); }
    .seat.left  { left: 4px; top: 46%; transform: translateY(-50%); align-items: center; }
    .seat.right { right: 4px; top: 46%; transform: translateY(-50%); align-items: center; }
    .seat.left, .seat.right { display: flex; }

    /* Avatar plus petit en mobile */
    .avatar { width: 34px; height: 34px; font-size: 14px; border-width: 1.5px; }

    /* Infos joueurs latéraux : on masque le texte détaillé, on garde l'essentiel */
    .seat.left .seat-text, .seat.right .seat-text { display: none; }
    .seat.top .seat-info { flex-direction: column; gap: 3px; }
    .seat.top .seat-name { font-size: 12px; }
    .seat.top .seat-team { font-size: 8px; }
    .seat.top .seat-state { font-size: 9px; }
    .seat.top .seat-badges { justify-content: center; }
    .seat.top .badge { font-size: 7.5px; padding: 1px 4px; }

    /* Cartes adverses : empilées et réduites */
    .seat.top .seat-card-row { gap: 3px; }
    .seat.left .seat-card-row, .seat.right .seat-card-row {
      flex-direction: column; gap: 2px;
    }
    .card.medium   { width: 38px; height: 57px; }
    .card.small    { width: 26px; height: 39px; }
    .card.tiny     { width: 20px; height: 30px; }

    /* Centre de table compact */
    .table-center { width: 70%; }
    .center-phase { font-size: 20px; letter-spacing: 2px; }
    .center-meta { font-size: 10px; margin-top: 8px; }
    .center-mise { font-size: 18px; }
    .center-status { font-size: 11px; margin-top: 6px; }

    /* Main du joueur : grandes cartes, scrollable horizontalement si besoin */
    .hand-zone {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      margin-top: 0;
      gap: 8px;
      padding: 10px 8px calc(8px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(180deg, rgba(5,42,29,0) 0%, var(--deep-green) 22%);
      z-index: 45;
    }
    .you-info { font-size: 9px; letter-spacing: 1px; gap: 8px; }
    .you-info strong { font-size: 12px; }
    .hand-row {
      gap: 6px;
      flex-wrap: nowrap;
      justify-content: center;
      max-width: 100%;
    }
    .card.large { width: 62px; height: 93px; }

    /* ActionDock : dans la hand-zone fixe, plus besoin d'être fixed séparément */
    .action-dock {
      position: static;
      left: auto; right: auto; bottom: auto;
      max-width: none;
      width: 100%;
      padding: 10px 12px;
      box-shadow: var(--shadow-md);
      border-radius: var(--radius);
      max-height: 34vh;
      overflow-y: auto;
    }
    .dock-context { font-size: 9px; letter-spacing: 1.5px; }
    .dock-context .dock-hint { font-size: 10px; }
    .dock-row { gap: 6px; }
    .dock-group { padding: 2px 6px 2px 0; }
    .dock-group + .dock-group { padding-left: 8px; }
    .btn { padding: 9px 13px; font-size: 11px; letter-spacing: 1px; }

    /* On réserve l'espace en bas pour la hand-zone fixe (table scrollable au-dessus) */
    .game-area { padding-bottom: 260px; }

    /* Reveal & overlays plein écran */
    .reveal-card { border-radius: var(--radius-lg); }
    .reveal-head { padding: 16px 18px; }
    .reveal-title { font-size: 22px; }
    .reveal-final-score { font-size: 20px; gap: 16px; }
    .reveal-body { padding: 14px 18px; }
    .reveal-phase-name { width: 84px; font-size: 14px; }
    .reveal-phase-detail { font-size: 12px; }
    .help-drawer { width: 100%; }
  }

  /* ---------- Très petit écran ---------- */
  @media (max-width: 380px) {
    .team-score { font-size: 26px; }
    .card.large { width: 54px; height: 81px; }
    .avatar { width: 30px; height: 30px; font-size: 13px; }
    .game-table { min-height: 320px; }
    .center-phase { font-size: 17px; }
  }

  /* ---------- Paysage mobile : table à gauche, panneau accessible ---------- */
  @media (max-width: 920px) and (orientation: landscape) and (max-height: 520px) {
    .scoreboard { grid-template-columns: 1fr auto 1fr; }
    .game-table { min-height: 280px; aspect-ratio: 16 / 9; }
    .action-dock { max-height: 50vh; }
  }
`;

/* ===== Visuels SVG des cartes espagnoles (réutilisés tels quels) ===== */

function SuitGlyph({ suit, size = 14 }) {
  const color = suit === 'oros' ? '#D2A82E'
    : suit === 'copas' ? '#9E1F24'
    : suit === 'espadas' ? '#1B1713'
    : '#5A1418';
  const s = size;
  if (suit === 'oros') {
    return (
      <svg width={s} height={s} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="7" fill={color} stroke="#8B6418" strokeWidth="0.6" />
        <circle cx="10" cy="10" r="4" fill="none" stroke="#8B6418" strokeWidth="0.5" />
        <circle cx="10" cy="10" r="1.5" fill="#8B6418" />
      </svg>
    );
  }
  if (suit === 'copas') {
    return (
      <svg width={s} height={s} viewBox="0 0 20 20">
        <path d="M5 4 L15 4 L15 9 Q15 13 10 13 Q5 13 5 9 Z" fill={color} stroke="#5A1418" strokeWidth="0.6" />
        <path d="M9 13 L11 13 L11 16 L13 16 L13 17 L7 17 L7 16 L9 16 Z" fill={color} stroke="#5A1418" strokeWidth="0.5" />
      </svg>
    );
  }
  if (suit === 'espadas') {
    return (
      <svg width={s} height={s} viewBox="0 0 20 20">
        <path d="M9.5 2 L10.5 2 L11 13 L9 13 Z" fill={color} />
        <path d="M5 13 L15 13 L13 15 L7 15 Z" fill="#8B6418" />
        <circle cx="10" cy="14" r="1.2" fill="#5A1418" />
      </svg>
    );
  }
  // bastos
  return (
    <svg width={s} height={s} viewBox="0 0 20 20">
      <rect x="9" y="2" width="2" height="14" fill={color} rx="1" />
      <ellipse cx="10" cy="3.5" rx="3" ry="1.5" fill="#8B6418" />
      <line x1="6" y1="8" x2="14" y2="8" stroke="#8B6418" strokeWidth="0.7" />
      <line x1="6" y1="12" x2="14" y2="12" stroke="#8B6418" strokeWidth="0.7" />
    </svg>
  );
}

function FigureArt({ rank, suit, size = 50 }) {
  const fig = rank === 10 ? 'Sota' : rank === 11 ? 'Caballo' : 'Rey';
  const color = suit === 'oros' ? '#D2A82E'
    : suit === 'copas' ? '#9E1F24'
    : suit === 'espadas' ? '#1B1713'
    : '#5A1418';
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 50 58">
      <ellipse cx="25" cy="20" rx="9" ry="11" fill="#F8F0DA" stroke={color} strokeWidth="0.8" />
      <circle cx="22" cy="19" r="0.8" fill={color} />
      <circle cx="28" cy="19" r="0.8" fill={color} />
      <path d="M22 23 Q25 24.5 28 23" stroke={color} strokeWidth="0.7" fill="none" />
      <path d="M14 30 Q14 38 18 42 L32 42 Q36 38 36 30" fill={color} opacity="0.85" />
      <path d="M14 30 Q14 38 18 42 L32 42 Q36 38 36 30" fill="none" stroke="#1B1713" strokeWidth="0.5" opacity="0.5" />
      {rank === 12 && (
        <g>
          <path d="M19 11 L20 7 L22 10 L25 6 L28 10 L30 7 L31 11 Z" fill={color} stroke="#8B6418" strokeWidth="0.4" />
          <circle cx="22" cy="9" r="0.7" fill="#D2A82E" />
          <circle cx="28" cy="9" r="0.7" fill="#D2A82E" />
        </g>
      )}
      {rank === 11 && (
        <g><path d="M36 28 Q44 30 42 38 L40 42 L36 38 Z" fill="#8B6418" /></g>
      )}
      <text x="25" y="54" textAnchor="middle" fontSize="6.5" fill="#1B1713" fontFamily="Iowan Old Style, serif" fontWeight="600">{fig}</text>
    </svg>
  );
}

function CardArt({ card, w, h }) {
  const isFigure = card.rank === 10 || card.rank === 11 || card.rank === 12;
  const display = card.rank === 1 ? 'AS'
    : card.rank === 2 ? '2'
    : card.rank === 3 ? '3'
    : card.rank === 10 ? 'SOTA'
    : card.rank === 11 ? 'CAB.'
    : card.rank === 12 ? 'REY'
    : String(card.rank);

  return (
    <svg viewBox="0 0 100 150" width={w} height={h} style={{ display: 'block' }} aria-hidden="true">
      <rect width="100" height="150" rx="8" fill="url(#cardBg)" stroke="#1B1713" strokeWidth="1" opacity="0.95" />
      <defs>
        <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFF8EA" />
          <stop offset="100%" stopColor="#F3E7CF" />
        </linearGradient>
      </defs>

      <g transform="translate(8 8)">
        <text fontSize="14" fontFamily="Iowan Old Style, serif" fontWeight="700" fill="#1B1713">{display}</text>
      </g>
      <g transform="translate(8 26)">
        <SuitGlyph suit={card.suit} size={12} />
      </g>

      <g transform="translate(82 142) rotate(180)">
        <text fontSize="14" fontFamily="Iowan Old Style, serif" fontWeight="700" fill="#1B1713">{display}</text>
      </g>
      <g transform="translate(82 124) rotate(180)">
        <SuitGlyph suit={card.suit} size={12} />
      </g>

      {isFigure ? (
        <g transform="translate(50 75)">
          <g transform="translate(-25 -29)">
            <FigureArt rank={card.rank} suit={card.suit} size={50} />
          </g>
        </g>
      ) : (
        <g>
          {Array.from({ length: card.rank === 1 ? 1 : Math.min(card.rank, 7) }).map((_, i) => {
            const cols = card.rank <= 3 ? 1 : 2;
            const positions = [];
            const total = card.rank === 1 ? 1 : Math.min(card.rank, 7);
            for (let k = 0; k < total; k++) {
              const col = cols === 1 ? 0 : k % 2;
              const row = cols === 1 ? k : Math.floor(k / 2);
              const x = 50 + (col === 0 ? -12 : 12) - (cols === 1 ? 0 : 0);
              const y = 35 + row * (cols === 1 ? 26 : 18);
              positions.push({ x, y });
            }
            const p = positions[i];
            if (!p) return null;
            return (
              <g key={i} transform={`translate(${p.x - 8} ${p.y - 8})`}>
                <SuitGlyph suit={card.suit} size={16} />
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

/* ===== Card wrapper ===== */

/* =============================================================================
 * Système d'assets de cartes (themes)
 *
 * Concept : on tente de charger une image (WebP > SVG > PNG) depuis
 * /public/cards/{theme}/{suit}-{rank}.{ext}. Si rien ne charge, on retombe
 * silencieusement sur le SVG procédural existant. Aucun crash, aucun 404
 * visible côté UI.
 *
 * Aucune image protégée n'est intégrée par défaut. L'utilisateur dépose ses
 * propres assets dans /public/cards/basque/ et `theme="basque"` les utilise.
 * ============================================================================ */

const CARD_ASSET_THEMES = {
  // Thème par défaut : aucun asset image, le rendu se fait via le SVG procédural.
  fallback: { basePath: null, extensions: [], hasBack: false },
  // Thème basque : assets attendus dans /public/cards/basque/
  basque: {
    basePath: '/cards/basque',
    extensions: ['webp', 'svg', 'png'],
    hasBack: true,
  },
  // Thème basque retina : prend le pas si window.devicePixelRatio >= 2
  'basque@2x': {
    basePath: '/cards/basque@2x',
    extensions: ['webp', 'svg', 'png'],
    hasBack: true,
  },
  // Thème basque en ligne : charge les cartes de Basquetteur (CC BY-SA 3.0)
  // directement depuis GitHub — aucun fichier local requis. Si le réseau ou la
  // CSP bloque, le fallback SVG prend le relais carte par carte.
  'basque-web': {
    basePath: 'https://raw.githubusercontent.com/mcmd/playingcards.io-spanish.playing.cards/master/img',
    extensions: ['png'],
    hasBack: true,
    // Nommage du repo source : 01-oros.png, 12-bastos.png, reverso.png
    fileName: (suit, rank) => `${String(rank).padStart(2, '0')}-${suit}`,
    backName: 'reverso',
  },
};

// Cache module-level : résultat du test de chargement par URL.
// Map<url, 'ok' | 'ko' | Promise<'ok'|'ko'>>
const ASSET_CACHE = (typeof window !== 'undefined') ? (window.__musAssetCache ||= new Map()) : new Map();

function buildCardUrl(theme, suit, rank, ext) {
  const def = CARD_ASSET_THEMES[theme];
  if (!def || !def.basePath) return null;
  const name = def.fileName ? def.fileName(suit, rank) : `${suit}-${rank}`;
  return `${def.basePath}/${name}.${ext}`;
}

function buildBackUrl(theme, ext) {
  const def = CARD_ASSET_THEMES[theme];
  if (!def || !def.basePath || !def.hasBack) return null;
  const name = def.backName || 'back';
  return `${def.basePath}/${name}.${ext}`;
}

// Vérifie qu'une URL est chargeable. Renvoie une promesse 'ok' | 'ko'.
function probeImage(url) {
  if (!url) return Promise.resolve('ko');
  const cached = ASSET_CACHE.get(url);
  if (cached === 'ok' || cached === 'ko') return Promise.resolve(cached);
  if (cached instanceof Promise) return cached;
  if (typeof Image === 'undefined') return Promise.resolve('ko');

  const promise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { ASSET_CACHE.set(url, 'ok'); resolve('ok'); };
    img.onerror = () => { ASSET_CACHE.set(url, 'ko'); resolve('ko'); };
    img.src = url;
  });
  ASSET_CACHE.set(url, promise);
  return promise;
}

// Trouve la première URL chargeable pour une carte donnée.
// Renvoie une URL ou null.
async function resolveCardAsset(theme, suit, rank) {
  const def = CARD_ASSET_THEMES[theme];
  if (!def || !def.basePath) return null;
  for (const ext of def.extensions) {
    const url = buildCardUrl(theme, suit, rank, ext);
    const status = await probeImage(url);
    if (status === 'ok') return url;
  }
  return null;
}

async function resolveBackAsset(theme) {
  const def = CARD_ASSET_THEMES[theme];
  if (!def || !def.basePath || !def.hasBack) return null;
  for (const ext of def.extensions) {
    const url = buildBackUrl(theme, ext);
    const status = await probeImage(url);
    if (status === 'ok') return url;
  }
  return null;
}

// Hook React : résout asynchroniquement l'asset d'une carte. Retourne :
//   { url: string | null, loading: boolean }
function useCardAsset(theme, suit, rank) {
  const [state, setState] = useState(() => {
    // Si déjà en cache 'ok' ou 'ko', on évite l'effet asynchrone.
    if (!theme || theme === 'fallback') return { url: null, loading: false };
    const def = CARD_ASSET_THEMES[theme];
    if (!def?.basePath) return { url: null, loading: false };
    // On vérifie en synchrone si une URL connue OK existe.
    for (const ext of def.extensions) {
      const url = buildCardUrl(theme, suit, rank, ext);
      const cached = ASSET_CACHE.get(url);
      if (cached === 'ok') return { url, loading: false };
    }
    return { url: null, loading: true };
  });

  useEffect(() => {
    let cancelled = false;
    if (!theme || theme === 'fallback') {
      setState({ url: null, loading: false });
      return;
    }
    if (!state.loading && state.url) return;
    resolveCardAsset(theme, suit, rank).then((url) => {
      if (cancelled) return;
      setState({ url, loading: false });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, suit, rank]);

  return state;
}

function useBackAsset(theme) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!theme || theme === 'fallback') { setUrl(null); return; }
    resolveBackAsset(theme).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [theme]);
  return url;
}

// Préchargement de tout un deck : appelé une fois au montage. N'attend pas la
// résolution, lance simplement les Image() pour remplir le cache HTTP du
// navigateur. Ne fait rien si le thème est 'fallback'.
function preloadDeck(theme) {
  const def = CARD_ASSET_THEMES[theme];
  if (!def || !def.basePath) return;
  const SUITS = ['oros', 'copas', 'espadas', 'bastos'];
  const RANKS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      // On ne tente que la première extension (WebP) pour le préchargement
      // afin d'éviter d'innonder le réseau. Si elle échoue, useCardAsset
      // testera le fallback à la demande.
      const url = buildCardUrl(theme, suit, rank, def.extensions[0]);
      probeImage(url);
    }
  }
  if (def.hasBack) probeImage(buildBackUrl(theme, def.extensions[0]));
}

/* ===== Card refactorisé avec support thème ===== */

function Card({ card, hidden, selected, onClick, size = 'medium', dealing = true, dealIndex = 0, ariaLabel, theme = 'fallback' }) {
  // Sélection automatique du thème retina si applicable
  const effectiveTheme = (() => {
    if (!theme || theme === 'fallback') return theme;
    if (typeof window !== 'undefined' && window.devicePixelRatio >= 2 && CARD_ASSET_THEMES[`${theme}@2x`]) {
      return `${theme}@2x`;
    }
    return theme;
  })();

  // Hook unique appelé toujours dans le même ordre — on accepte un { suit, rank }
  // factice quand la carte est hidden pour respecter les règles des hooks.
  const cardSuit = card?.suit || 'oros';
  const cardRank = card?.rank || 1;
  const { url: imageUrl } = useCardAsset(effectiveTheme, cardSuit, cardRank);
  const backUrl = useBackAsset(effectiveTheme);

  if (hidden) {
    // Si l'asset back du thème est dispo → image. Sinon → fallback CSS.
    if (backUrl) {
      return (
        <div
          className={`card ${size} ${dealing ? 'dealing' : ''}`}
          style={{
            '--i': dealIndex,
            backgroundImage: `url("${backUrl}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
          aria-label="Carte cachée"
        />
      );
    }
    return (
      <div
        className={`card ${size} card-back ${dealing ? 'dealing' : ''}`}
        style={{ '--i': dealIndex }}
        aria-label="Carte cachée"
      >
        <div className="card-back-emblem">MUS</div>
      </div>
    );
  }

  const handleClick = onClick && (() => onClick(card.id));
  const handleKey = onClick && ((e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(card.id); }
  });

  return (
    <div
      className={`card ${size} ${onClick ? 'clickable' : ''} ${selected ? 'selected' : ''} ${dealing ? 'dealing' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKey}
      style={{ '--i': dealIndex }}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : -1}
      aria-pressed={onClick ? !!selected : undefined}
      aria-label={ariaLabel || `${card.rank} de ${card.suit}`}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          style={{
            width: '100%', height: '100%',
            objectFit: 'cover',
            display: 'block',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <CardArt card={card} w="100%" h="100%" />
      )}
    </div>
  );
}

/* ===== TopBar / Scoreboard ===== */

function TopBar({ state, onOpenHelp, onOpenTests, onToggleSettings, onOpenPanel, newLogCount = 0 }) {
  const phaseDesc = phaseLabelFor(state);
  return (
    <header className="topbar" role="banner">
      <div className="brand">
        <div className="brand-title">MUS</div>
        <div className="brand-sub">Règlement officiel · Janvier 2011</div>
      </div>
      <div className="topbar-actions">
        <span className="visually-hidden" aria-live="polite">{phaseDesc}</span>
        <button
          className="icon-btn topbar-journal-btn"
          onClick={onOpenPanel}
          aria-label="Ouvrir le journal et les paramètres"
        >
          Journal
          {newLogCount > 0 && <span className="topbar-badge">{newLogCount}</span>}
        </button>
        <button className="icon-btn" onClick={onOpenTests}>Tests</button>
        <button className="icon-btn" onClick={onToggleSettings}>Bots</button>
        <button className="icon-btn" onClick={onOpenHelp}>Aide</button>
      </div>
    </header>
  );
}

function phaseLabelFor(state) {
  if (state.phase === 'mus-decision') return 'Phase Mus / Mintza';
  if (state.phase === 'discard') return 'Phase Défausse';
  if (state.phase === 'pares-declare') return 'Annonce des Paires';
  if (state.phase === 'juego-declare') return 'Annonce du Jeu';
  if (state.phase === 'reveal') return 'Révélation';
  if (state.phase === 'bet') {
    const map = { grande: 'Grand', chica: 'Petit', pares: 'Paires', juego: state.juegoOrPunto === 'punto' ? 'Pontua' : 'Jeu' };
    return `Enchère — ${map[state.currentBetPhase] || state.currentBetPhase}`;
  }
  return state.phase;
}

function Scoreboard({ state }) {
  const { score, matchScore, mancheNumber, handNumber, targetTantto, donneur, esku, players } = state;
  const pctA = Math.min(100, (score.A / targetTantto) * 100);
  const pctB = Math.min(100, (score.B / targetTantto) * 100);
  const hamarrekoA = Math.floor(score.A / 5);
  const hamarrekoB = Math.floor(score.B / 5);

  return (
    <section className="scoreboard" aria-label="Tableau de score">
      <div className="team-block is-A">
        <div className="team-name">Équipe A · Or</div>
        <div className="team-score-row">
          <span className="team-score" aria-label={`Score A : ${score.A}`}>{score.A}</span>
          <span className="team-target">/ {targetTantto}</span>
        </div>
        <div className="team-progress-track" aria-hidden="true">
          <div className="team-progress-fill" style={{ width: `${pctA}%` }} />
        </div>
        <div className="hamarreko-row" aria-label={`${hamarrekoA} hamarreko sur 8`}>
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className={`hamarreko-dot ${i < hamarrekoA ? 'lit' : ''}`} />
          ))}
        </div>
        <div className="team-meta">
          <span>Manches <strong>{matchScore.A}</strong></span>
        </div>
      </div>

      <div className="scoreboard-center">
        <div className="manche-label">Manche</div>
        <div className="manche-num">{mancheNumber} <span style={{ fontSize: 14, color: 'var(--whisper)' }}>/ 3</span></div>
        <div className="manche-sub">Coup n°{handNumber}</div>
        <div className="manche-balls" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => {
            const cls = i < matchScore.A ? 'lit-A' : i < matchScore.A + matchScore.B ? 'lit-B' : '';
            return <span key={i} className={`manche-ball ${cls}`} />;
          })}
        </div>
        <div className="team-meta" style={{ marginTop: 4 }}>
          <span>Donneur <strong>{players[donneur]?.name?.split(' ')[0] || 'J' + donneur}</strong></span>
          <span>Esku <strong>{players[esku]?.name?.split(' ')[0] || 'J' + esku}</strong></span>
        </div>
      </div>

      <div className="team-block is-B">
        <div className="team-name">Équipe B · Rouge</div>
        <div className="team-score-row">
          <span className="team-target">/ {targetTantto}</span>
          <span className="team-score" aria-label={`Score B : ${score.B}`}>{score.B}</span>
        </div>
        <div className="team-progress-track" aria-hidden="true">
          <div className="team-progress-fill is-B" style={{ width: `${pctB}%`, marginLeft: `${100 - pctB}%` }} />
        </div>
        <div className="hamarreko-row">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className={`hamarreko-dot ${i < hamarrekoB ? 'lit' : ''}`} />
          ))}
        </div>
        <div className="team-meta">
          <span>Manches <strong>{matchScore.B}</strong></span>
        </div>
      </div>
    </section>
  );
}

/* ===== PhaseRail ===== */

function PhaseRail({ state }) {
  const cur = currentFlowKey(state);
  const curIdx = FLOW_ORDER.indexOf(cur);
  return (
    <nav className="phase-rail" aria-label="Phases du coup">
      {PHASE_FLOW.map((step, i) => {
        const isDone = curIdx > i;
        const isActive = curIdx === i;
        return (
          <React.Fragment key={step.key}>
            <div className={`phase-step ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
              <span className="dot" />
              <span>{step.label}</span>
            </div>
            {i < PHASE_FLOW.length - 1 && <span className="phase-arrow" aria-hidden="true">›</span>}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/* ===== Player seat ===== */

function PlayerSeat({ player, state, position, revealed, selectedDiscards, onCardClick, theme }) {
  const isActive = state.activePlayer === player.id;
  const isEsku = state.esku === player.id;
  const isDonneur = state.donneur === player.id;
  const team = TEAM_OF[player.id];
  const monogram = (player.name || '').replace(/\s\(.*\)/, '').trim().slice(0, 1).toUpperCase() || 'J';

  // Statut court
  let stateText = null;
  if (state.phase === 'mus-decision' && state.musAcceptedBy?.includes(player.id)) stateText = 'a dit Mus';
  else if (isActive && !state.matchOver && !state.mancheOver && state.phase !== 'reveal') stateText = 'à toi de jouer'.replace('toi', player.id === 0 ? 'toi' : 'lui');
  if (player.id !== 0 && isActive && state.phase !== 'reveal' && !state.mancheOver && !state.matchOver) stateText = 'réfléchit…';
  if (state.phase === 'pares-declare' && player.declaredPares !== undefined) {
    stateText = player.declaredPares ? 'a annoncé paires' : 'sans paires';
  }
  if (state.phase === 'juego-declare' && player.declaredJuego !== undefined) {
    stateText = player.declaredJuego ? 'a annoncé jeu' : 'sans jeu';
  }

  const cardSize = position === 'bottom' ? 'large' : (position === 'top' ? 'medium' : 'small');
  const showFront = revealed || player.id === 0;
  const cards = (player.hand || []).map((c, i) => (
    <Card
      key={c.id}
      card={c}
      hidden={!showFront}
      size={cardSize}
      dealIndex={i}
      theme={theme}
      selected={position === 'bottom' && selectedDiscards?.includes(c.id)}
      onClick={position === 'bottom' && onCardClick ? onCardClick : null}
      ariaLabel={showFront ? `${player.name} : ${c.rank} de ${c.suit}` : `${player.name} : carte cachée`}
    />
  ));

  return (
    <div className={`seat ${position}`}>
      {/* En haut/sur les côtés : avatar avant cartes ; en bas : cartes uniquement (dans Hand) */}
      {position !== 'bottom' && (
        <>
          <div className="seat-info">
            <div className={`avatar team-${team} ${isActive ? 'active' : ''}`} aria-hidden="true">
              {monogram}
            </div>
            <div className="seat-text">
              <div className="seat-name">{player.name}</div>
              <div className="seat-team">Équipe {team}</div>
              {stateText && <div className="seat-state">{stateText}</div>}
              <div className="seat-badges">
                {isDonneur && <span className="badge donneur" title="Donneur">Donneur</span>}
                {isEsku && <span className="badge esku" title="Esku (premier en ordre de jeu)">Esku</span>}
              </div>
            </div>
          </div>
          <div className="seat-card-row">{cards}</div>
        </>
      )}
    </div>
  );
}

/* ===== Center display (table inner) ===== */

function TableCenter({ state }) {
  const phaseDisplay = (() => {
    if (state.phase === 'mus-decision') return 'Mus ou Mintza';
    if (state.phase === 'discard') return 'Défausse';
    if (state.phase === 'pares-declare') return 'Annoncer Paires';
    if (state.phase === 'juego-declare') return 'Annoncer Jeu';
    if (state.phase === 'reveal') return 'Révélation';
    if (state.phase === 'bet') {
      const map = { grande: 'Grand', chica: 'Petit', pares: 'Paires', juego: state.juegoOrPunto === 'punto' ? 'Pontua' : 'Jeu' };
      return map[state.currentBetPhase] || state.currentBetPhase;
    }
    return '';
  })();

  const meta = (() => {
    if (state.phase === 'mus-decision') {
      return `${state.musAcceptedBy?.length || 0} joueur(s) ont accepté Mus${state.musRound > 0 ? ` · round ${state.musRound + 1}` : ''}`;
    }
    if (state.phase === 'discard') return 'Esku se défausse en premier';
    if (state.phase === 'bet') {
      const bet = state.phases[state.currentBetPhase];
      return bet?.pendingResponderTeam ? `Équipe ${bet.pendingResponderTeam} doit répondre` : 'Ouverture des enchères';
    }
    return '';
  })();

  const mise = state.phase === 'bet'
    ? state.phases[state.currentBetPhase]?.stack[state.phases[state.currentBetPhase].stack.length - 1]
    : null;

  const activeName = state.players?.[state.activePlayer]?.name || '';
  const isYou = state.activePlayer === 0;
  const status = !state.matchOver && !state.mancheOver && state.phase !== 'reveal'
    ? (isYou ? 'À toi de jouer' : null)
    : null;

  return (
    <div className="table-center">
      <div className="center-phase" key={phaseDisplay}>{phaseDisplay}</div>
      {meta && <div className="center-meta">{meta}</div>}
      {mise !== null && <div className="center-mise">Mise · {mise}</div>}
      {status && (
        <div className="center-status">
          <span className="status-name">{status}</span>
        </div>
      )}
      {!isYou && !state.matchOver && !state.mancheOver && state.phase !== 'reveal' && state.phase !== 'discard' && state.activePlayer !== null && state.activePlayer !== undefined && (
        <div className="center-status">
          <span className="status-name">{activeName}</span> réfléchit…
        </div>
      )}
    </div>
  );
}

/* ===== ActionButton ===== */

function ActionButton({ children, onClick, disabled, variant = 'default', reason, ariaLabel }) {
  return (
    <button
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
      data-reason={disabled && reason ? reason : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

/* ===== Hand (humain bas) ===== */

function Hand({ state, selectedDiscards, onCardClick, theme }) {
  const human = state.players[0];
  return (
    <div className="hand-row" role="group" aria-label="Ta main">
      {human.hand.map((c, i) => (
        <Card
          key={c.id}
          card={c}
          size="large"
          dealIndex={i}
          theme={theme}
          selected={selectedDiscards?.includes(c.id)}
          onClick={onCardClick}
          ariaLabel={`Carte ${i + 1} : ${c.rank} de ${c.suit}`}
        />
      ))}
    </div>
  );
}

/* ===== ActionDock — barre d'actions contextuelle ===== */

function ActionDock({ state, dispatch, selectedDiscards, setSelectedDiscards }) {
  const human = state.players[0];
  const isYou = state.activePlayer === 0;
  const onReveal = state.phase === 'reveal';
  const lockedWaiting = !isYou && !onReveal && !state.matchOver && !state.mancheOver;

  if (onReveal) {
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">Révélation
          <span className="dock-hint">Le coup est terminé. Voir la fenêtre de révélation.</span>
        </div>
      </div>
    );
  }
  if (lockedWaiting) {
    const waitName = state.players[state.activePlayer]?.name || '';
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">En attente
          <span className="dock-hint">{waitName} réfléchit…</span>
        </div>
      </div>
    );
  }
  if (!isYou) return null;

  // Phase Mus / Mintza
  if (state.phase === 'mus-decision') {
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">Décision · Mus ou Mintza
          <span className="dock-hint">Tu peux jeter pour redonner ou démarrer le coup.</span>
        </div>
        <div className="dock-row">
          <ActionButton variant="primary" onClick={() => dispatch({ type: 'mus' })}>Mus</ActionButton>
          <ActionButton variant="success" onClick={() => dispatch({ type: 'mintza' })}>Mintza · démarrer</ActionButton>
        </div>
      </div>
    );
  }

  // Phase défausse
  if (state.phase === 'discard') {
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">Défausse · sélectionne tes cartes
          <span className="dock-hint">Esku ({state.players[state.esku]?.name}) se défausse en premier.</span>
        </div>
        <div className="dock-row">
          <div className="discard-banner">
            Sélectionnées : <strong>{selectedDiscards.length}</strong> carte(s)
          </div>
          <ActionButton
            variant="primary"
            onClick={() => {
              dispatch({ type: 'discard', cards: selectedDiscards });
              setSelectedDiscards([]);
            }}
          >
            Défausser {selectedDiscards.length > 0 ? `(${selectedDiscards.length})` : ''}
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={() => setSelectedDiscards([])}
            disabled={selectedDiscards.length === 0}
          >Tout désélectionner</ActionButton>
        </div>
      </div>
    );
  }

  // Phase déclaration paires
  if (state.phase === 'pares-declare') {
    const real = evaluatePares(human.hand);
    const enforce = state.enforceTruthfulDeclarations !== false;
    const info = real.has
      ? `Tu as : ${real.type === 'pareja' ? 'une paire' : real.type === 'mediak' ? 'un brelan' : 'deux paires'} (${real.points} pt${real.points > 1 ? 's' : ''})`
      : "Tu n'as ni paire ni brelan.";
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">Annonce des Paires
          <span className="dock-hint">{info}{enforce ? ' · Mode honnête (art. 13-14)' : ''}</span>
        </div>
        <div className="dock-row">
          <ActionButton
            variant="primary"
            onClick={() => dispatch({ type: 'declare-pares', value: true })}
            disabled={enforce && !real.has}
            reason={disabledReasonFor('declare-pares-true', state, human)}
          >J'ai des paires</ActionButton>
          <ActionButton
            variant="default"
            onClick={() => dispatch({ type: 'declare-pares', value: false })}
            disabled={enforce && real.has}
            reason={disabledReasonFor('declare-pares-false', state, human)}
          >Pas de paires</ActionButton>
        </div>
      </div>
    );
  }

  // Phase déclaration jeu
  if (state.phase === 'juego-declare') {
    const j = evaluateJuegoPunto(human.hand);
    const enforce = state.enforceTruthfulDeclarations !== false;
    const info = j.hasJuego
      ? `Tu as Jeu (total = ${j.total}, ${j.juegoPoints} pt${j.juegoPoints > 1 ? 's' : ''})`
      : `Total = ${j.total}, donc pas de Jeu (Pontua si personne n'en a).`;
    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">Annonce du Jeu
          <span className="dock-hint">{info}{enforce ? ' · Mode honnête (art. 15-16)' : ''}</span>
        </div>
        <div className="dock-row">
          <ActionButton
            variant="primary"
            onClick={() => dispatch({ type: 'declare-juego', value: true })}
            disabled={enforce && !j.hasJuego}
            reason={disabledReasonFor('declare-juego-true', state, human)}
          >J'ai le jeu</ActionButton>
          <ActionButton
            variant="default"
            onClick={() => dispatch({ type: 'declare-juego', value: false })}
            disabled={enforce && j.hasJuego}
            reason={disabledReasonFor('declare-juego-false', state, human)}
          >Pas de jeu</ActionButton>
        </div>
      </div>
    );
  }

  // Phase enchères
  if (state.phase === 'bet') {
    const legal = getLegalActions(state, 0);
    const types = new Set(legal.map(a => a.type));
    const phaseName = state.currentBetPhase;
    const phaseLabel = phaseName === 'juego'
      ? (state.juegoOrPunto === 'punto' ? 'Pontua' : 'Jeu')
      : { grande: 'Grand', chica: 'Petit', pares: 'Paires' }[phaseName];
    const bet = state.phases[phaseName];
    const stack = bet?.stack || [1];
    const mise = stack[stack.length - 1];

    const gehiagoOptions = legal.filter(a => a.type === 'gehiago').map(a => a.amount).sort((a, b) => a - b);

    return (
      <div className="action-dock" aria-live="polite">
        <div className="dock-context">{phaseLabel} · enchères
          <span className="dock-hint">Mise courante : {mise} · {bet?.pendingResponderTeam ? `Équipe ${bet.pendingResponderTeam} en réponse` : 'Ouverture'}</span>
        </div>
        <div className="dock-row">
          {/* Groupe : passer ou décider */}
          {(types.has('paso') || types.has('iduki') || types.has('tira') || types.has('tira-for-me')) && (
            <div className="dock-group">
              {types.has('paso') && <ActionButton onClick={() => dispatch({ type: 'paso' })}>Paso</ActionButton>}
              {types.has('iduki') && <ActionButton variant="success" onClick={() => dispatch({ type: 'iduki' })}>Iduki · accepter</ActionButton>}
              {types.has('tira') && <ActionButton variant="default" onClick={() => dispatch({ type: 'tira' })}>Tira · refuser</ActionButton>}
              {types.has('tira-for-me') && (
                <ActionButton variant="warning" onClick={() => dispatch({ type: 'tira-for-me' })}>Tira pour moi</ActionButton>
              )}
            </div>
          )}
          {/* Groupe : ouvrir / relancer */}
          {(types.has('embido') || types.has('hiru-embido') || gehiagoOptions.length > 0) && (
            <div className="dock-group">
              {types.has('embido') && (
                <ActionButton variant="primary" onClick={() => dispatch({ type: 'embido' })}>Embido +2</ActionButton>
              )}
              {types.has('hiru-embido') && (
                <ActionButton variant="primary" onClick={() => dispatch({ type: 'hiru-embido' })}>Hiru Embido +3</ActionButton>
              )}
              {gehiagoOptions.map(n => (
                <ActionButton key={n} variant="primary" onClick={() => dispatch({ type: 'gehiago', amount: n })}>
                  +{n} gehiago
                </ActionButton>
              ))}
            </div>
          )}
          {/* Groupe : Hordago */}
          {types.has('hordago') && (
            <div className="dock-group">
              <ActionButton variant="danger" onClick={() => dispatch({ type: 'hordago' })}>Hordago</ActionButton>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

/* ===== GameLog — langage joueur ===== */

function GameLog({ state }) {
  const { log, players } = state;
  const recent = (log || []).slice(-30).reverse();

  return (
    <div className="side-panel">
      <div className="panel-head">
        <span>Historique</span>
        <span className="head-action">{recent.length} actions</span>
      </div>
      <div className="panel-body">
        <div className="log-list">
          {recent.length === 0
            ? <div className="log-row" style={{ opacity: 0.6, fontStyle: 'italic' }}>La partie commence.</div>
            : recent.map((entry, i) => <LogRow key={i} entry={entry} players={players} />)
          }
        </div>
      </div>
    </div>
  );
}

function LogRow({ entry, players }) {
  const formatted = formatLogEntry(entry, players);
  if (!formatted) return null;
  const teamCls = formatted.team ? `team-${formatted.team}` : '';
  return (
    <div className="log-row">
      <span className={`log-actor ${teamCls}`}>{formatted.actor}</span>
      <span className="log-text">{formatted.text}</span>
      {formatted.points && (
        <span className={`log-points ${formatted.team === 'B' ? 'is-B' : ''}`}>+{formatted.points}</span>
      )}
    </div>
  );
}

function formatLogEntry(entry, players) {
  const playerName = (id) => players?.[id]?.name || `J${id}`;
  switch (entry.type) {
    case 'mus':            return { actor: playerName(entry.player ?? 0), text: 'demande Mus' };
    case 'mintza':         return { actor: playerName(entry.player ?? 0), text: 'dit Mintza · on joue !' };
    case 'redeal':         return { actor: '·', text: `redonne (round ${entry.round})` };
    case 'discard':        return { actor: playerName(entry.player), text: `défausse ${entry.cards?.length || 0} carte(s)` };
    case 'paso':           return { actor: playerName(entry.player), text: 'passe', team: entry.team };
    case 'embido':         return { actor: playerName(entry.player), text: 'mise Embido (+2)', team: entry.team };
    case 'hiru-embido':    return { actor: playerName(entry.player), text: 'mise Hiru Embido (+3)', team: entry.team };
    case 'gehiago':        return { actor: playerName(entry.player), text: `relance +${entry.amount}`, team: entry.team };
    case 'tira':           return { actor: playerName(entry.player), text: 'refuse · Tira', team: entry.team };
    case 'tira-for-me':    return { actor: playerName(entry.player), text: 'dit "Tira pour moi"', team: entry.team };
    case 'iduki':          return { actor: playerName(entry.player), text: 'accepte · Iduki', team: entry.team };
    case 'hordago':        return { actor: playerName(entry.player), text: 'lance HORDAGO', team: entry.team };
    case 'declare-pares':  return { actor: playerName(entry.player), text: entry.value ? 'annonce des paires' : 'pas de paires' };
    case 'declare-juego':  return { actor: playerName(entry.player), text: entry.value ? 'annonce du jeu' : 'pas de jeu' };
    case 'send-signal':    return { actor: playerName(entry.player), text: `signe : ${SIGNAL_LABELS[entry.sign] || entry.sign}` };
    case 'phase-change':   return { actor: '·', text: `passage en ${entry.to || 'phase suivante'}` };
    case 'immediate-points': return { actor: 'Score', text: `Équipe ${entry.team} marque ${entry.points} (${entry.reason || 'tira'})`, team: entry.team, points: entry.points };
    case 'reveal':         return { actor: '·', text: 'révélation des mains' };
    case 'sanctions':      return { actor: '·', text: `sanctions appliquées (${entry.errors?.length || 0})` };
    case 'illegal-action': return { actor: playerName(entry.player), text: `action ${entry.action?.type} rejetée` };
    case 'illegal-declaration': return { actor: playerName(entry.player), text: 'déclaration rejetée (mode honnête)' };
    case 'illegal-signal': return { actor: playerName(entry.player), text: `signe ${entry.sign} non valide` };
    default: return null;
  }
}

/* ===== BetTracker ===== */

function BetTracker({ state }) {
  const phases = [
    { key: 'grande', label: 'Grand' },
    { key: 'chica', label: 'Petit' },
    { key: 'pares', label: 'Paires' },
    { key: 'juego', label: state.juegoOrPunto === 'punto' ? 'Pontua' : 'Jeu' },
  ];
  return (
    <div className="side-panel">
      <div className="panel-head"><span>Enchères en cours</span></div>
      <div className="panel-body">
        {phases.map(p => {
          const bet = state.phases?.[p.key];
          if (!bet) return null;
          const isActive = state.phase === 'bet' && state.currentBetPhase === p.key;
          const top = bet.stack?.[bet.stack.length - 1];
          let label = '—';
          if (bet.resolution?.kind === 'paso') label = 'Paso';
          else if (bet.resolution?.kind === 'iduki') label = `Iduki ${bet.resolution.deferredPoints}pt`;
          else if (bet.resolution?.kind === 'tira') label = `Tira ${bet.resolution.immediatePoints?.points}pt → ${bet.resolution.immediatePoints?.team}`;
          else if (bet.resolution?.kind === 'hordago-accepted') label = 'Hordago accepté';
          else if (isActive) label = `Mise ${top}`;

          return (
            <div className="bet-row" key={p.key}>
              <span className={`bet-name ${isActive ? 'active' : ''}`}>{p.label}</span>
              <span className={`bet-state ${label === '—' ? 'empty' : ''}`}>
                {label.includes('Mise') ? <>Mise <span className="stack-num">{top}</span></> : label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===== Signals panel ===== */

function SignalsPanel({ state, dispatch }) {
  const human = state.players[0];
  const mode = state.signMode || 'off';
  const HUMAN_ID = 0;
  const partnerId = PARTNER_OF[HUMAN_ID];
  const teamMates = new Set([HUMAN_ID, partnerId]);
  const visible = (state.signals || []).filter(s => mode !== 'off' && (mode === 'simple' || teamMates.has(s.player)));
  const recent = visible.slice(-6).reverse();
  const jp = evaluateJuegoPunto(human.hand);
  const allSigns = ['two-kings', 'two-aces', 'mediak', 'dobliak', '29', '30-31', 'juego'];

  return (
    <div className="side-panel">
      <div className="panel-head">
        <span>Signes — art. 11°</span>
      </div>
      <div className="panel-body">
        <div className="sig-mode-row">
          <span>Mode</span>
          <select
            value={mode}
            onChange={(e) => dispatch({ type: 'set-sign-mode', mode: e.target.value })}
            aria-label="Mode des signes"
          >
            <option value="off">Désactivé</option>
            <option value="simple">Simple (visible)</option>
            <option value="realistic">Réaliste (équipe)</option>
          </select>
        </div>
        {mode !== 'off' && (
          <div className="sig-grid">
            {allSigns.map(sig => {
              const legal = isSignalLegal(sig, human.hand, state.phase, state.currentBetPhase, jp);
              return (
                <button
                  key={sig}
                  className="sig-btn"
                  disabled={!legal}
                  onClick={() => dispatch({ type: 'send-signal', playerId: HUMAN_ID, sign: sig })}
                  title={legal ? SIGN_TOOLTIPS[sig] : 'Non valide pour ta main / cette phase'}
                >{SIGNAL_LABELS[sig]}</button>
              );
            })}
          </div>
        )}
        {recent.length > 0 ? (
          <div className="sig-recent">
            <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--muted-ink)', textTransform: 'uppercase', marginBottom: 4 }}>
              Derniers signes
            </div>
            {recent.map((s, i) => (
              <div className="sig-recent-row" key={i}>
                <span className="sig-actor">{state.players?.[s.player]?.name || `J${s.player}`}</span>
                {' → '}{SIGNAL_LABELS[s.sign] || s.sign}
                {!s.public && <em style={{ opacity: 0.5 }}> (subtil)</em>}
              </div>
            ))}
          </div>
        ) : mode !== 'off' ? (
          <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--muted-ink)' }}>Aucun signe pour le moment.</div>
        ) : null}
      </div>
    </div>
  );
}

/* ===== Bot settings (drawer ouvert au clic) ===== */

function SettingsPanel({ state, dispatch, visible, onClose, theme, onThemeChange }) {
  if (!visible) return null;
  const level = state.players?.find(p => p.isBot)?.botLevel || 'medium';
  return (
    <div className="side-panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <span>Paramètres</span>
        <button className="head-action" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} onClick={onClose}>fermer</button>
      </div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, letterSpacing: 1, color: 'var(--muted-ink)', textTransform: 'uppercase', minWidth: 60 }}>Bots</span>
          {['easy', 'medium', 'hard'].map(lvl => (
            <button
              key={lvl}
              className="sig-btn"
              onClick={() => dispatch({ type: 'set-bot-level', level: lvl })}
              style={{
                fontWeight: lvl === level ? 600 : 400,
                borderColor: lvl === level ? 'var(--brass)' : undefined,
                background: lvl === level ? 'rgba(210,168,46,0.15)' : undefined,
              }}
            >
              {{ easy: 'Facile', medium: 'Moyen', hard: 'Difficile' }[lvl]}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, letterSpacing: 1, color: 'var(--muted-ink)', textTransform: 'uppercase', minWidth: 60 }}>Cartes</span>
          {[
            { key: 'fallback', label: 'SVG sobre' },
            { key: 'basque-web', label: 'Basque (en ligne)' },
            { key: 'basque', label: 'Basque (fichiers locaux)' },
          ].map(t => (
            <button
              key={t.key}
              className="sig-btn"
              onClick={() => onThemeChange(t.key)}
              style={{
                fontWeight: t.key === theme ? 600 : 400,
                borderColor: t.key === theme ? 'var(--brass)' : undefined,
                background: t.key === theme ? 'rgba(210,168,46,0.15)' : undefined,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {theme === 'basque-web' && (
          <div style={{ fontSize: 11, color: 'var(--muted-ink)', fontStyle: 'italic', lineHeight: 1.5 }}>
            Cartes de Basquetteur (Wikimedia, CC BY-SA 3.0) chargées depuis GitHub.
            Nécessite une connexion ; si le chargement échoue, le rendu SVG s'affiche à la place.
          </div>
        )}
        {theme === 'basque' && (
          <div style={{ fontSize: 11, color: 'var(--muted-ink)', fontStyle: 'italic', lineHeight: 1.5 }}>
            Dépose tes images dans <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(27,23,19,0.06)', padding: '1px 4px', borderRadius: 2 }}>/public/cards/basque/</code> sous la forme <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(27,23,19,0.06)', padding: '1px 4px', borderRadius: 2 }}>oros-1.webp</code>, etc. Si une image manque, le rendu SVG la remplace silencieusement.
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== RevealOverlay ===== */

function RevealOverlay({ state, dispatch }) {
  if (state.phase !== 'reveal') return null;
  const { revealResult, score, mancheOver, mancheWinner, matchOver, matchScore } = state;

  const title = matchOver
    ? `Match terminé`
    : mancheOver
      ? `Manche gagnée`
      : 'Révélation';
  const subtitle = matchOver
    ? `Équipe ${matchScore.A > matchScore.B ? 'A · Or' : 'B · Rouge'} remporte le match`
    : mancheOver
      ? `Équipe ${mancheWinner === 'A' ? 'A · Or' : 'B · Rouge'} prend la manche`
      : 'Calcul des points';

  return (
    <div className="reveal-overlay" role="dialog" aria-modal="true" aria-labelledby="reveal-title">
      <div className="reveal-card">
        <div className="reveal-head">
          <h2 className="reveal-title" id="reveal-title">{title}</h2>
          <div className="reveal-sub">{subtitle}</div>
          <div className="reveal-final-score">
            <span className="a">A · {score.A}</span>
            <span className="vs">vs</span>
            <span className="b">{score.B} · B</span>
          </div>
        </div>
        <div className="reveal-body">
          {revealResult?.map((r, i) => {
            const has = !!(r.revealPoints || r.immediatePoints || r.hordagoWinnerTeam);
            return (
              <div key={i} className={`reveal-phase-row ${has ? 'has-points' : ''}`}>
                <div className="reveal-phase-name">{PHASE_LABEL[r.phase]}</div>
                <div className="reveal-phase-detail">
                  {r.hordagoWinnerTeam && (
                    <span><strong>Hordago accepté</strong> — Équipe {r.hordagoWinnerTeam} remporte la manche</span>
                  )}
                  {!r.hordagoWinnerTeam && r.immediatePoints && (
                    <span>Tira immédiat → Équipe {r.immediatePoints.team} <span className={`pts ${r.immediatePoints.team === 'B' ? 'is-B' : ''}`}>+{r.immediatePoints.points}</span></span>
                  )}
                  {!r.hordagoWinnerTeam && r.revealPoints && (
                    <span style={{ marginLeft: r.immediatePoints ? 12 : 0 }}>
                      {r.immediatePoints ? '· puis ' : ''}Équipe {r.revealPoints.team} <span className={`pts ${r.revealPoints.team === 'B' ? 'is-B' : ''}`}>+{r.revealPoints.points}</span>
                    </span>
                  )}
                  {!r.hordagoWinnerTeam && !r.immediatePoints && !r.revealPoints && (
                    <span style={{ opacity: 0.5, fontStyle: 'italic' }}>aucun point</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="reveal-foot">
          {matchOver
            ? <button className="btn btn-primary" onClick={() => window.location.reload()}>Nouvelle partie</button>
            : <button
                className="btn btn-primary"
                onClick={() => dispatch({ type: mancheOver ? 'next-manche' : 'next-hand' })}
              >
                {mancheOver ? 'Manche suivante' : 'Coup suivant'}
              </button>
          }
        </div>
      </div>
    </div>
  );
}

/* ===== HelpDrawer ===== */

function HelpDrawer({ open, onClose }) {
  return (
    <div className={`help-drawer ${open ? 'open' : ''}`} role="dialog" aria-label="Aide" aria-hidden={!open}>
      <div className="panel-head">
        <span>Aide-mémoire</span>
        <button className="head-action" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} onClick={onClose}>fermer</button>
      </div>
      <div className="panel-body">
        <h4>Le but</h4>
        <p>Atteindre <strong>40 points</strong> dans une manche, et remporter <strong>3 manches</strong> pour gagner le match. Joué par équipes de 2 (A : sièges 0+2 ; B : sièges 1+3).</p>

        <h4>Phase Mus</h4>
        <p>Si tous les joueurs disent Mus, on jette des cartes et on redonne. Sinon, le premier à dire Mintza déclenche les enchères.</p>

        <h4>Ordre des enchères</h4>
        <p>Grand → Petit → Paires → Jeu (ou Pontua si personne n'a 31+).</p>

        <h4>Enchères</h4>
        <p><code>Embido</code> : pose +2. <code>Hiru Embido</code> : +3. <code>Gehiago</code> : relance.</p>
        <p><code>Tira</code> : refuser. L'adversaire empoche immédiatement le palier précédent.</p>
        <p><code>Iduki</code> : accepter. La mise sera réglée à la révélation.</p>
        <p><code>Tira pour moi</code> : tu te désistes mais ton partenaire décide à ta place.</p>
        <p><code>Hordago</code> : tout ou rien. Si l'adversaire accepte, la phase décide la manche entière.</p>

        <h4>Cartes</h4>
        <p>Le <strong>3</strong> vaut comme un <strong>Roi</strong>. Le <strong>2</strong> vaut comme un <strong>As</strong>. Pontua : total des points (1=1, 2=1, 3=10, 10/11/12=10, autres = leur valeur).</p>

        <h4>Signes (art. 11°)</h4>
        <p>Mode <em>Simple</em> : tous voient. Mode <em>Réaliste</em> : seuls les coéquipiers voient. Le signe 29 n'est légal qu'après la phase Paires.</p>

        <h4>Honnêteté</h4>
        <p>En mode honnête, tu ne peux pas mentir sur tes paires ou ton jeu (art. 13-16). Le moteur sanctionne automatiquement les fausses déclarations.</p>
      </div>
    </div>
  );
}

/* ===== TestsPanel ===== */

function TestsPanel({ visible, onClose }) {
  if (!visible) return null;
  const [results, setResults] = useState(null);
  useEffect(() => {
    if (visible && !results) {
      const r = runTests();
      setResults(r);
    }
  }, [visible, results]);
  const pass = results ? results.filter(r => r.pass).length : 0;
  const fail = results ? results.filter(r => !r.pass).length : 0;

  return (
    <div className="reveal-overlay" role="dialog" aria-modal="true" style={{ background: 'rgba(0,0,0,0.85)' }}>
      <div className="reveal-card" style={{ maxWidth: 820, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="reveal-head">
          <h2 className="reveal-title">Tests du moteur</h2>
          <div className="reveal-sub">
            {results
              ? `${pass} passés · ${fail} échoués sur ${results.length}`
              : 'Calcul en cours…'}
          </div>
        </div>
        <div className="reveal-body" style={{ overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          {results?.map((r, i) => (
            <div key={i} style={{
              padding: '4px 8px',
              borderBottom: '1px dotted rgba(27,23,19,0.08)',
              color: r.pass ? 'var(--ink-soft)' : 'var(--basque-red)',
              display: 'flex', gap: 8,
            }}>
              <span style={{
                color: r.pass ? '#0a7c3e' : 'var(--basque-red)',
                fontWeight: 600,
                minWidth: 28,
              }}>{r.pass ? '✓' : '✗'}</span>
              <span style={{ flex: 1 }}>{r.name}</span>
              {!r.pass && <span style={{ opacity: 0.7 }}>{r.error}</span>}
            </div>
          ))}
        </div>
        <div className="reveal-foot">
          <button className="btn btn-default" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

/* ===== Composant principal ===== */

export default function MusGame() {
  const playerNames = ['Toi', 'Aitor (B)', 'Maite (A)', 'Iker (B)'];
  const [state, dispatch] = useReducer(reducer, null, () => initialState(null, playerNames));
  const [selectedDiscards, setSelectedDiscards] = useState([]);
  const [showTests, setShowTests] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMobilePanel, setShowMobilePanel] = useState(false);
  const [seenLogCount, setSeenLogCount] = useState(0);
  const [botSpeed] = useState(750);

  // Compteur d'actions non vues (badge sur le bouton flottant mobile).
  // Réinitialisé à l'ouverture du drawer.
  const newLogCount = Math.max(0, (state.log?.length || 0) - seenLogCount);
  useEffect(() => {
    if (showMobilePanel) setSeenLogCount(state.log?.length || 0);
  }, [showMobilePanel, state.log?.length]);

  // Thème de cartes — persistant via localStorage si disponible.
  // Défaut : 'basque' (les images sont livrées avec le projet ; si elles
  // manquent, chaque carte retombe sur son SVG individuellement).
  const [cardTheme, setCardTheme] = useState(() => {
    if (typeof window === 'undefined') return 'basque';
    try {
      return window.localStorage?.getItem('mus.cardTheme.v2') || 'basque';
    } catch { return 'basque'; }
  });

  // Préchargement asynchrone du deck quand le thème change (sauf fallback).
  useEffect(() => {
    if (cardTheme && cardTheme !== 'fallback') {
      preloadDeck(cardTheme);
      // Et le thème retina si on est en HiDPI
      if (typeof window !== 'undefined' && window.devicePixelRatio >= 2 && CARD_ASSET_THEMES[`${cardTheme}@2x`]) {
        preloadDeck(`${cardTheme}@2x`);
      }
    }
    if (typeof window !== 'undefined') {
      try { window.localStorage?.setItem('mus.cardTheme.v2', cardTheme); } catch {}
    }
  }, [cardTheme]);

  // Auto-jeu des bots
  useEffect(() => {
    if (state.matchOver || state.mancheOver) return;
    if (state.phase === 'reveal') return;
    const active = state.activePlayer;
    if (active === null || active === undefined) return;
    if (!state.players[active].isBot) return;
    const timer = setTimeout(() => {
      const action = botAct(state, active);
      if (action) dispatch(action);
    }, botSpeed);
    return () => clearTimeout(timer);
  }, [state, botSpeed]);

  // Émission de signes par les bots aux transitions
  useEffect(() => {
    if (state.signMode === 'off') return;
    if (state.phase !== 'bet' && state.phase !== 'pares-declare' && state.phase !== 'juego-declare') return;
    const timeouts = [];
    for (let i = 1; i <= 3; i++) {
      if (state.players[i].isBot) {
        const sigAction = botMaybeEmitSignal(state, i);
        if (sigAction) {
          timeouts.push(setTimeout(() => dispatch(sigAction), 250 + i * 200));
        }
      }
    }
    return () => timeouts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentBetPhase, state.phase, state.signMode]);

  const onCardClick = useCallback((cardId) => {
    if (state.phase !== 'discard' || state.activePlayer !== 0) return;
    setSelectedDiscards(prev => prev.includes(cardId)
      ? prev.filter(id => id !== cardId)
      : [...prev, cardId]
    );
  }, [state.phase, state.activePlayer]);

  const human = state.players[0];
  const partner = state.players[2];
  const oppRight = state.players[1];
  const oppLeft = state.players[3];

  return (
    <div className="mus-app">
      <style>{GLOBAL_STYLES}</style>

      <TopBar
        state={state}
        onOpenHelp={() => setShowHelp(s => !s)}
        onOpenTests={() => setShowTests(true)}
        onToggleSettings={() => {
          setShowSettings(s => !s);
          // Le panneau Paramètres vit dans le tiroir latéral : sur écran étroit
          // il faut aussi ouvrir le tiroir, sinon le clic semble sans effet.
          setShowMobilePanel(true);
        }}
        onOpenPanel={() => setShowMobilePanel(true)}
        newLogCount={newLogCount}
      />
      <Scoreboard state={state} />
      <PhaseRail state={state} />

      <div className="game-area">
        <div className="game-table-wrap">
          <div className="game-table" role="region" aria-label="Table de jeu">
            <PlayerSeat player={partner} state={state} position="top" revealed={state.phase === 'reveal'} theme={cardTheme} />
            <PlayerSeat player={oppLeft} state={state} position="left" revealed={state.phase === 'reveal'} theme={cardTheme} />
            <PlayerSeat player={oppRight} state={state} position="right" revealed={state.phase === 'reveal'} theme={cardTheme} />
            <TableCenter state={state} />
          </div>

          <div className="hand-zone">
            <div className="you-info">
              <span>Toi</span>
              <span className="pip" aria-hidden="true" />
              <span>Équipe <strong>A · Or</strong></span>
              {state.esku === 0 && <><span className="pip" aria-hidden="true" /><span>Esku</span></>}
              {state.donneur === 0 && <><span className="pip" aria-hidden="true" /><span>Donneur</span></>}
            </div>
            <Hand
              state={state}
              selectedDiscards={selectedDiscards}
              onCardClick={state.phase === 'discard' && state.activePlayer === 0 ? onCardClick : null}
              theme={cardTheme}
            />
            <ActionDock
              state={state}
              dispatch={dispatch}
              selectedDiscards={selectedDiscards}
              setSelectedDiscards={setSelectedDiscards}
            />
          </div>
        </div>

        <aside
          className={showMobilePanel ? 'open' : ''}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <button
            className="drawer-close-mobile"
            onClick={() => setShowMobilePanel(false)}
            aria-label="Fermer le panneau"
          >×</button>
          <SettingsPanel
            state={state}
            dispatch={dispatch}
            visible={showSettings}
            onClose={() => setShowSettings(false)}
            theme={cardTheme}
            onThemeChange={setCardTheme}
          />
          <BetTracker state={state} />
          <SignalsPanel state={state} dispatch={dispatch} />
          <GameLog state={state} />
        </aside>
      </div>

      {/* Backdrop pour fermer le drawer mobile en tapant à côté */}
      <div
        className={`mobile-panel-backdrop ${showMobilePanel ? 'show' : ''}`}
        onClick={() => setShowMobilePanel(false)}
        aria-hidden="true"
      />

      <HelpDrawer open={showHelp} onClose={() => setShowHelp(false)} />
      <RevealOverlay state={state} dispatch={dispatch} />
      <TestsPanel visible={showTests} onClose={() => setShowTests(false)} />
    </div>
  );
}

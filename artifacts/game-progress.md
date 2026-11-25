# MSF Supply Kart — suivi

## Intention
Kart arcade multijoueur (1–6) dans un entrepôt, chariots élévateurs, rayonnages bleus/orange,
bonus = caisses blanches MSF Supply. Navigateur, Three.js. Validation utilisateur entre chaque étape.

## Décisions
- Monorepo : `client/` (Vite + TS + Three.js), `shared/` (simulation pure TS), `server/` (étape 5).
- Physique arcade maison dans `shared/` (pas de Rapier) : déterministe, pas fixe 60 Hz,
  réutilisée par le serveur autoritaire et la prédiction client.
- Chariot = 2 cercles de collision ; décor = boîtes orientées / cercles.
- Touches par code physique (ZQSD AZERTY = WASD QWERTY). Bonus : E / Ctrl / Entrée.
- Logo réel : `client/public/assets/logo-msfsupply.svg` (nom différent du cahier des charges).

- Piste = ligne centrale lissée + largeur ; collisions via champ de distance signé (SDF) partagé,
  hauteur (rampes / mezzanine) via grille. Rayonnages placés automatiquement hors piste (visuel).
- Anti-triche : portes de checkpoint dans l'ordre, saut de progression > 30 m ignoré.
- Respawn auto : bloqué 2,5 s en accélérant, ou hors piste 0,6 s ; manuel avec R.
- Bonus : touche E ou Entrée (jamais Ctrl : Ctrl+W ferme l'onglet). Entrée relance la course seulement après l'arrivée.
- Système de bonus partagé (`shared/src/items.ts`), RNG seedé, tirage pondéré par position ;
  caisses = 25 emplacements (5 rangées + 1 dans le raccourci), réapparition 4 s.
- Logo : essaie `logo-msf-supply.svg` puis `logo-msfsupply.svg`, sinon texture provisoire.
- Accroche de test `autopilot` (poursuite pure) : base des bots de l'étape 4.

- `RaceSession` (shared/src/session.ts) = simulation complète d'une course (compte à rebours,
  départ canon / calage, bots, bonus, arrivée, résultats). Le client solo la fait tourner ;
  le serveur de l'étape 5 la réutilisera telle quelle. Déterministe pour une graine donnée.
- Bots : `shared/src/bot.ts` (ligne + couloir perso, freinage par courbure, drift, évitement,
  raccourci, bonus tactiques). 5 profils (Amina, Lucas, Fatou, Karim, Sofia). Léger rattrapage
  (±6 % de vitesse max selon l'écart avec le meilleur humain).
- Solo : le joueur part dernier (6e). `?bots=0..5`, `?diff=facile|normal|difficile`.
- Après son arrivée, le joueur est piloté par l'IA ; classement 3 s après, mis à jour en direct.

- Multijoueur : serveur Node (`server/`, ws) qui fait tourner `RaceSession` à 60 Hz et envoie
  des snapshots à 20 Hz (~1 Ko, ~20 Ko/s par joueur). Protocole dans `shared/src/net.ts`.
- Client en ligne : prédiction du chariot local (`shared/src/predict.ts`, rejoue les entrées non
  acquittées) + lissage des corrections ; autres chariots interpolés avec 100 ms de retard.
- Le client prédictif doit utiliser exactement les mêmes obstacles que le serveur (piste,
  poteaux, palettes posées), sinon la prédiction diverge.
- Déconnexion en course = l'IA conduit, étiquette « déconnecté » ; reconnexion par jeton
  (sessionStorage, par onglet). Sans entrées 0,5 s (onglet masqué) → entrées neutres.
- Ports : client Vite 5188 (proxy /ws), serveur 8787 (`GAME_PORT`, pas `PORT`).
  `npm run dev` lance les deux ; `npm start` = build + serveur unique sur 0.0.0.0:8787 (LAN).

## Étapes
1. [validé] Prototype de conduite + caméra.
2. [validé] Circuit entrepôt, checkpoints, tours, respawn.
3. [validé] Bonus + caisses MSF Supply.
4. [validé] Bots IA + course solo complète.
5. [validé] Multijoueur.
6. [validé] HUD, sons (moteur adouci + réglage « Moteurs » validés à l'oreille) (Web Audio procédural), menus pause / options,
   qualité basse / haute / auto (ombres, DPR, halo UnrealBloom). Bilan : artifacts/final-evidence.md.

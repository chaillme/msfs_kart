# MSF Supply Kart — bilan de vérification (étapes 1 à 6)

## Tests automatisés (`npm test`, tous verts au 23/11/2026)

| Suite | Vérifications | Couvre |
| --- | --- | --- |
| `shared/tests/kart.test.ts` | 16 | accélération, freinage, marche arrière, drift 3 niveaux, mini-turbo, murs, poussettes |
| `shared/tests/track.test.ts` | 10 | piste (SDF), grille, mezzanine, 3 tours au pilote auto, raccourci, anti-triche, respawn |
| `shared/tests/items.test.ts` | 25 | tirage pondéré, caisses, roulette, 6 bonus, bouclier, palette |
| `shared/tests/session.test.ts` | 17 | compte à rebours, départ canon / calage, course complète 6 bots, déterminisme |
| `shared/tests/predict.test.ts` | 4 | prédiction à 33 / 100 / 250 ms de latence (correction max < 4 mm) |
| `server/tests/online.test.ts` | 18 | salons, codes, hôte, course en ligne, snapshots 20 Hz, déconnexion / reconnexion, résultats |

## Vérifications dans le navigateur

- Étape 1–2 : conduite, drift, turbo, circuit complet ; course au pilote auto 3 tours à 60 fps,
  ~90 draw calls, ~240 k triangles (qualité haute, sans halo).
- Étape 3 : caisses avec le vrai logo, roulette, carton / huile / film / palette observés.
- Étape 4 : intro, compte à rebours, course complète, classement, Entrée = rejouer.
- Étape 5 : deux onglets (créer / rejoindre / lancer), déconnexion en course signalée,
  prédiction à 60 fps : correction max 0,1 mm.
- Étape 6 : accueil avec commandes et options, halo des néons (qualité haute), menu pause,
  bascule qualité basse (DPR 1, réglage mémorisé), contexte audio actif après un clic.

## Limites connues / non vérifié

- Pas testé sur deux ordinateurs distincts (seulement deux onglets sur un même PC).
- Le panneau navigateur de l'environnement de test tournait souvent en arrière-plan (~1 fps) :
  le coût du halo lumineux (qualité haute) n'a pas été mesuré à 60 fps ; le mode « auto »
  repasse en qualité basse si la médiane descend sous 45 fps.
- Les sons sont synthétisés (pas d'enregistrements) ; leur rendu n'a pas pu être écouté ici,
  seul l'état du contexte audio a été vérifié.
- Collisions entre chariots non prédites côté client (petits recalages pendant les poussettes).
- Pas de chiffrement (WSS) ni de comptes : prévu pour un réseau local ou un serveur de confiance.

# MSF Supply Kart

Course arcade de chariots élévateurs dans un entrepôt (rayonnages bleus et orange), de 1 à 6
pilotes, dans le navigateur. Three.js + TypeScript, serveur Node pour le multijoueur.

## Lancer

Prérequis : Node.js 20+.

```powershell
npm install
npm --prefix client install
npm --prefix server install
```

| Usage | Commande | Adresse |
| --- | --- | --- |
| Développement (client + serveur) | `npm run dev` | http://127.0.0.1:5188 |
| Partie en réseau local | `npm start` | http://&lt;IP du PC&gt;:8787 (affichée au démarrage) |
| Tests | `npm test` | — |

`npm start` construit le client puis lance un serveur unique (jeu + WebSocket) ouvert sur le
réseau local. Autorisez Node dans le pare-feu Windows si les autres postes ne se connectent pas.

## Jouer

- **Z Q S D** ou flèches : accélérer, tourner, freiner / reculer
- **Espace** maintenu en virage : drift ; relâcher = mini-turbo (bleu → orange → rouge)
- **E** ou **Entrée** : utiliser le bonus (caisses blanches MSF Supply)
- Départ canon : accélérer juste après le « 1 » (trop tôt = calé)
- **R** se replacer (solo) · **Échap** pause / menu · **H** aide

Bonus : Livraison express (turbo 3 s), Flaque d'huile, Carton lancé (rebondit), Colis tracké
(poursuit le pilote devant), Film étirable (bouclier), Palette qui tombe (rare).

Multijoueur : « Créer un salon » donne un code de 4 lettres, les autres le saisissent dans
« Rejoindre ». L'hôte lance la course (2 à 6 pilotes, option « compléter avec des bots »).

## Structure

- `shared/` : simulation commune client/serveur (physique, piste, bonus, bots, course, réseau,
  prédiction). Déterministe, testée dans `shared/tests/`.
- `client/` : rendu Three.js, HUD, menus, sons procéduraux (Web Audio), client réseau.
- `server/` : salons et course autoritaire (WebSocket), tests de bout en bout dans `server/tests/`.
- Logo : `client/public/assets/logo-msfsupply.svg` (ou `logo-msf-supply.svg`).

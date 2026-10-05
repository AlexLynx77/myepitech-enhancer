# My Epitech Enhancer

Extension de navigateur (Manifest V3) qui améliore l'interface de [My Epitech](https://my.epitech.eu) : pagination et colonnes des modules, badges d'inscription, filtre de projets et simulateur de GPA.

## Fonctionnalités

| Fonctionnalité | Page | Description |
| --- | --- | --- |
| **Statut d'inscription** | Modules | Affiche un badge d'inscription dans la colonne *Nom*. |
| **Code module complet** | Projets | Affiche le code complet du module (ex. `G-SEC-500`) sur les cartes de projets. |
| **Filtrer mes modules** | Projets | N'affiche que les projets des modules auxquels vous êtes inscrit. |
| **Masquer mon identité** | Toutes | Masque le prénom et le nom dans le bandeau supérieur. |
| **Simulateur GPA** | `/me/academic` | Ajoute un onglet pour estimer son GPA en choisissant des grades (A à E) par module, par semestre. |
| **Lignes par page** | Modules | Choix du nombre de lignes affichées : 20, 30, 50, 100 ou 150. |
| **Colonnes affichées** | Modules | Choix des colonnes visibles du tableau. |

Toutes les options se règlent depuis le popup de l'extension, qui permet aussi de l'activer ou la désactiver globalement et de réinitialiser les réglages.

### Simulateur GPA

L'onglet GPA part de votre GPA officiel et de vos crédits déjà acquis, puis recalcule le GPA global à partir des grades que vous simulez pour les modules du semestre sélectionné. Seuls les modules pour lesquels vous avez choisi un grade entrent dans le calcul. Les UEs sont rattachées à vos modules inscrits.

Barème utilisé : A = 4, B = 3, C = 2, D = 1, E = 0.

## Installation

L'extension n'est pas publiée sur un store ; elle s'installe en mode développeur.

1. Cloner le dépôt :
   ```bash
   git clone https://github.com/AlexLynx77/myepitech-enhancer.git
   ```
2. Ouvrir `chrome://extensions` (ou `edge://extensions`) et activer le **mode développeur**.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner le dossier du projet.
4. Se rendre sur [my.epitech.eu](https://my.epitech.eu) et ouvrir le popup de l'extension pour régler les options.

## Structure du projet

```
├── manifest.json    # Manifest V3 (permissions, content scripts)
├── bridge.js        # Script exécuté dans le monde MAIN de la page : accès à l'arbre React
│                    # et au contexte API de My Epitech, détection des changements de route
├── content.js       # Content script : badges, filtres, pagination, colonnes, simulateur GPA
├── content.css      # Styles injectés dans la page
├── popup/           # Interface de réglages (HTML, CSS, JS)
└── icons/           # Icônes de l'extension
```

`bridge.js` et `content.js` communiquent par `CustomEvent` sur `window` : le pont lit les données de l'application dans le contexte de la page, et le content script se charge de l'affichage.

## Permissions

- `storage` : sauvegarde des réglages et du cache des modules inscrits.
- `activeTab` : détection de l'onglet My Epitech depuis le popup.
- Accès à `https://my.epitech.eu/*` uniquement.

Les données sont lues via l'API de My Epitech avec votre session existante ; l'extension n'envoie rien à un serveur tiers (hormis le chargement des polices Google Fonts dans le popup).

## Avertissement

Projet non officiel, sans lien avec Epitech. Il dépend de la structure actuelle de My Epitech et peut cesser de fonctionner si le site évolue. Le GPA simulé n'est qu'une estimation.

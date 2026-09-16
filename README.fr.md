# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

Le code et la documentation sont actuellement en anglais. Les PR de traduction sont les bienvenues ; consultez le [guide de contribution aux traductions](CONTRIBUTING.md#translations-and-localization) (en anglais). Cette page traduit le README ; elle ne signifie pas que l’interface ou les documents liés sont disponibles en français.

<!-- Translation source: README.md; SHA-256: 9b60bbbe2574e6ca26450ce9087884705ee319256bc1591e9a256f3db66971c4 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### L’IA passe en multijoueur.

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**Votre propre super-agent. Vos proches, votre équipe et leurs Genies. L’intelligence vous appartient.**

Voici votre Genie : un agent que vous pouvez personnaliser en profondeur, avec la personnalité, la mémoire, le visage et la voix de votre choix. Confiez-lui de l’écriture, des recherches, de la navigation web, la coordination d’agents de programmation ou la création d’un film. Réunissez vos amis, votre équipe et leurs Genies dans la même Room. Travaillez ensemble. Reprenez les commandes dès que vous voulez faire vous-même.

Voilà Nautilo. Multi-utilisateur dès sa conception. Pour les humains et leurs compagnons machines. Sur ordinateur, mobile et web. Votre serveur, vos modèles, vos règles. Open source. Sous licence MIT.

[Site et démos](https://nautilo.ai) ·
[Premiers pas](#get-started) ·
[Documentation](https://nautilo.ai/docs) ·
[Télécharger](https://nautilo.ai/download) ·
[Packages](#explore-the-code) ·
[Contribuer](CONTRIBUTING.md)

<a id="get-started"></a>

## Premiers pas

Chaque client Nautilo se connecte à un serveur Nautilo. Choisissez le chemin qui vous convient :

Vous découvrez Nautilo sur un Mac ? Commencez par le [démarrage rapide du déploiement local](https://nautilo.ai/docs/operator/deploy/local). Cette configuration permet d’évaluer Nautilo sur une seule machine. Pour un accès mobile ou un serveur accessible à votre équipe, choisissez une option d’hébergement ci-dessous.

| Vous voulez… | Commencez ici |
| --- | --- |
| Rejoindre un serveur existant | [Téléchargez Nautilo](https://nautilo.ai/download), puis suivez [Installation et connexion](https://nautilo.ai/docs/use/install-and-connect) avec l’adresse de votre serveur ou votre invitation. |
| Faire tourner votre premier serveur sur votre Mac | Suivez le [démarrage rapide du déploiement local](https://nautilo.ai/docs/operator/deploy/local), avec Docker Desktop et la CLI Nautilo signée. |
| Donner à votre équipe un serveur dans le cloud | Utilisez le [guide de déploiement Railway](https://nautilo.ai/docs/operator/deploy/railway). |
| Utiliser votre propre infrastructure Docker | Suivez le [guide Docker Compose](https://nautilo.ai/docs/operator/deploy/docker-compose), ou [comparez les options de déploiement](https://nautilo.ai/docs/operator/choose-a-deployment). |
| Modifier le code | Passez à [Développer à partir du code source](#develop-from-source). |

La page de téléchargement présente les options actuelles pour Desktop, le mobile et la CLI. Vous pouvez aussi ouvrir le client web de votre serveur. Desktop se connecte à votre serveur ; son installation n’installe ni le serveur ni sa base de données. Le mobile a besoin d’un serveur accessible en HTTPS.

Pour un nouveau serveur, terminez la configuration du propriétaire et [ajoutez vos clés de fournisseurs](https://nautilo.ai/docs/operator/provider-keys). Personnalisez ensuite votre Genie, ouvrez une Room et apportez quelque chose que vous avez vraiment envie de faire. [Votre première heure](https://nautilo.ai/docs/use/first-hour) vous accompagne pour créer un document ensemble, le modifier vous-même et enregistrer le résultat.

Nautilo est en **alpha**.

## Venez avec vos gens. Et leurs Genies.

Des personnes et leurs Genies, au travail dans la même Room. Parlez naturellement. Smart Routing fait entrer la bonne Genie dans la conversation ; interpellez directement quelqu’un pour attirer son attention. Partagez un document. Démontez une idée. Construisez mieux, ensemble.

Envoyez votre Genie chercher la réponse de quelqu’un, déléguez une tâche en arrière-plan ou programmez du travail pour plus tard. Continuez d’avancer pendant qu’elle travaille.

## Parfois, vous voulez juste le faire vous-même, bon sang

Réécrivez le paragraphe. Déplacez le texte. Reprenez le terminal. Votre Genie et vous travaillez sur la même chose, en vous passant les commandes au fil des besoins.

Vous ne devriez pas avoir besoin d’un meilleur prompt pour déplacer un mot de quelques centimètres vers la gauche.

## Donnez-lui quelque chose qui mérite d’être fait

Façonnez sa personnalité. Choisissez son visage, sa voix et ses modèles. Donnez-lui des outils et du travail : explorer le web, coordonner des agents de programmation, créer des images, de la vidéo et de la musique. Connectez des services et des outils MCP pour étendre son champ d’action.

La mémoire donne une continuité à votre travail commun. Les permissions et les approbations vous laissent aux commandes.

Les outils disponibles dépendent du client, de l’environnement connecté, des permissions et des fournisseurs configurés. L’utilisation des modèles et des services peut entraîner des frais chez les fournisseurs ; le [guide des clés API](https://nautilo.ai/docs/operator/provider-keys) explique ce que chaque connexion permet.

Regardez les films sur [nautilo.ai](https://nautilo.ai), ou lancez-vous avec [Votre première heure](https://nautilo.ai/docs/use/first-hour).

## Gardez les clés de votre maison

Plus votre IA vous connaît, plus il importe de savoir qui contrôle cette relation. Vos habitudes de travail, vos conversations, ce que vous avez créé ensemble : tout cela prend une place croissante dans votre vie.

Nautilo place le serveur et sa base de données sous votre contrôle. Vous choisissez où il tourne, quels modèles il utilise, qui le rejoint et comment les données sont sauvegardées. Le code est sous licence MIT. Lisez-le. Modifiez-le. Construisez dessus.

Partager un serveur suppose aussi de poser les bonnes limites. Les Humans et les Genies ont une identité ; les Rooms ont des membres ; la mémoire a des périmètres ; les outils ont des permissions et des étapes d’approbation. Inviter quelqu’un dans une conversation ne devrait jamais revenir à lui donner les clés de tout le reste.

Les fournisseurs de modèles et d’outils connectés reçoivent les données nécessaires à leur travail. L’auto-hébergement vous permet de choisir ces connexions ; leurs propres politiques de données continuent de s’appliquer. Lisez la [documentation de sécurité](https://nautilo.ai/docs/security) et le [guide de sécurisation du serveur](https://nautilo.ai/docs/operator/security-hardening) au moment de choisir votre installation.

## Trouvez votre chemin

| Guide | Ce qu’il vous aide à faire |
| --- | --- |
| [Documentation](https://nautilo.ai/docs) | Trouver le parcours utilisateur, opérateur ou développeur. |
| [Utiliser Nautilo](https://nautilo.ai/docs/use) | Découvrir les Rooms, les Genies, les outils créatifs et les usages quotidiens. |
| [Exploiter Nautilo](https://nautilo.ai/docs/operator) | Déployer, configurer, administrer et maintenir un serveur. |
| [Développer sur Nautilo](https://nautilo.ai/docs/build) | Comprendre l’architecture et travailler à partir du code source. |
| [Pack de compétences](https://nautilo.ai/skills) | Trouver les guides Nautilo destinés aux assistants IA. |
| [Principes de conception](https://nautilo.ai/principles) | Comprendre les choix qui façonnent le produit. |
| [Index de la documentation versionnée](DOCS.md) | Trouver les contrats du code source, le packaging, les versions et les procédures d’exploitation. |

<a id="explore-the-code"></a>

## Explorez le code

Ce monorepo contient les applications et les packages partagés qui font fonctionner Nautilo. Suivez les liens jusqu’à la partie que vous voulez comprendre ou modifier.

### Applications

| Application | Rôle |
| --- | --- |
| [Workbench](apps/workbench) | L’interface web partagée, également utilisée dans Desktop. |
| [Desktop](apps/desktop/README.md) | Client Electron, intégration au poste de travail local et packaging. |
| [Mobile](apps/mobile/README.md) | Le client mobile React Native / Expo. |
| [CLI](apps/cli/README.md) | Déploiement et administration du serveur depuis le terminal. |
| [Applications internes](packages/first-party-apps) | Applications créatives intégrées, dont [Writer](packages/first-party-apps/writer) et [Design](packages/first-party-apps/design). |

### Packages principaux

| Package | Contenu |
| --- | --- |
| [Agent](packages/agent) | Graphes d’agents, prompts, fournisseurs de modèles et [outils intégrés](packages/agent/src/tools/register-all.ts). |
| [Runtime](packages/runtime) | Coordination des conversations, exécution des tâches, jobs, sessions et événements. |
| [Server](packages/server) | API HTTP et WebSocket Fastify pour les clients. |
| [Database](packages/db) | Schéma Drizzle, migrations et persistance. |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | Réflexion sur la mémoire et intégration dans Nautilo. |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | Intégration de la mémoire chiffrée et primitives cryptographiques. |
| [Trust](packages/trust) / [Security](packages/security) | Identité, capacités, politique des outils et contrôles de sécurité des actions. |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | Exécution sur les postes de travail connectés et automatisation du bureau. |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | Découverte et enregistrement des outils, connexions MCP. |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | Couches de transport partagées entre les clients. |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | Contrats partagés et composants d’interface. |

Pour le déploiement et la maintenance, consultez [deploy](deploy/README.md), [le pilote Compose](deploy/compose-driver/README.md), [packaging](packaging) et [operations](ops/README.md). Le [pont applicatif](docs/genie-application-bridge.md) explique comment les Genies interagissent avec les interfaces des applications.

<a id="develop-from-source"></a>

## Développer à partir du code source

Le dépôt fixe **Bun 1.3.11** et **Node 24.x**. Installez Docker pour l’infrastructure locale PostgreSQL et Logto. La préparation de Desktop peut aussi nécessiter Rust pour son composant auxiliaire natif.

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

Choisissez un nom d’instance inutilisé pour un environnement neuf. Laissez ce terminal ouvert, puis suivez le [guide de développement depuis les sources](https://nautilo.ai/docs/build/development/local-development) pour prendre possession de l’instance, configurer un modèle et connecter un client. Ce guide couvre aussi les instances existantes, les clones isolés et les profils Desktop.

Avant de soumettre un changement de code, lancez les vérifications adaptées. Les vérifications standard du dépôt sont :

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

Consultez le [guide des tests](https://nautilo.ai/docs/build/development/testing) pour les vérifications ciblées et les exigences d’intégration. Les assistants de programmation doivent lire [AGENTS.md](AGENTS.md) et [README.ai](README.ai) avant toute modification.

## Aidez à le construire

Il reste énormément à inventer. Apportez ce que vous comprenez mieux que quiconque : le processus pénible contre lequel vous vous battez depuis des années, le détail de design qui vous agace toujours, le bug que vous avez refusé de laisser tomber. C’est ce jugement que nous voulons dans le projet.

Les petites corrections sont les bienvenues. Pour les changements plus importants, partez du problème et mettez-vous d’accord sur la conception avant de construire. Une montagne de code généré ne rendra pas une idée confuse plus claire. Un problème bien compris donne une direction.

Lisez le [guide de contribution](CONTRIBUTING.md), explorez les [problèmes sélectionnés](https://nautilo.ai/community/problems) ou trouvez de l’[aide et du support](https://nautilo.ai/community/support). Signalez les vulnérabilités en privé, conformément à [SECURITY.md](SECURITY.md).

## Licence

Nautilo est [sous licence MIT](LICENSE). Consultez les [mentions des tiers](THIRD_PARTY_NOTICES.md) pour les licences et attributions des dépendances, et la [provenance des ressources](ASSET_PROVENANCE.md) pour les créations graphiques, les médias générés et les documents de test.

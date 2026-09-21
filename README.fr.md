# Nautilo

<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

Le code et la documentation sont actuellement en anglais. Les PR de traduction sont les bienvenues ; consultez le [guide de contribution aux traductions](CONTRIBUTING.md#translations-and-localization) (en anglais). Cette page traduit le README ; elle ne signifie pas que l’interface ou les documents liés sont disponibles en français.

<!-- Translation source: README.md; SHA-256: f499f48faf14451b0ad789240586834589134f100874f840e4d6eb1db9d29cf4 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### L’IA passe en multijoueur.

</div>

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**Votre propre super-agent. Vos proches, votre équipe et leurs Genies. L’intelligence vous appartient.**

Voici votre Genie. Choisissez sa personnalité, sa mémoire, son visage et sa voix. Écrivez, explorez et créez ensemble. Réunissez vos proches et leurs Genies dans la même Room. Votre serveur. Vos modèles. Vos règles. Open source. Sous licence MIT.

<a id="get-started"></a>

## Premiers pas

**Votre premier Nautilo. D’un serveur vide à votre première création ensemble.**

[![Elias et Lyra travaillent ensemble dans Writer, avec des modifications à examiner. Ouvrir le guide illustré d’installation locale.](https://nautilo.ai/docs/operator/first-nautilo/writer-review.png)](https://nautilo.ai/docs/operator/deploy/local)

### [Essayez-le en local sur votre Mac →](https://nautilo.ai/docs/operator/deploy/local)

Rencontrez votre Genie, façonnez-la à votre goût et créez votre premier document ensemble. Suivez le guide illustré (en anglais).

Il vous faut **Docker Desktop** et **une clé API de fournisseur de modèles**. Nautilo est en **alpha**.

**Pour votre équipe :** [Déployez dans votre datacenter ou sur un VPS →](https://nautilo.ai/docs/operator/deploy/linux-server)

**Vous avez déjà un serveur ?** [Télécharger Desktop pour Mac →](https://nautilo.ai/download/mac) · [Télécharger Mobile →](https://nautilo.ai/download#download-platforms-title)

## Venez avec vos gens. Et leurs Genies.

Réunissez vos proches et leurs Genies dans la même Room. Décortiquez une idée, écrivez un premier jet, envoyez une Genie chercher la pièce manquante. Donnez à la vôtre une personnalité avec laquelle vous avez envie de passer du temps.

Puis reprenez les commandes. Réécrivez le paragraphe. Déplacez le texte. Vous ne devriez pas avoir besoin d’un meilleur prompt pour déplacer un mot de quelques centimètres vers la gauche.

Et gardez les clés de votre maison. Vous choisissez les modèles, gérez le serveur et décidez qui y a accès. Partager une Room ne devrait pas vouloir dire livrer toute votre vie.

[Modèles et clés API](https://nautilo.ai/docs/operator/provider-keys) · [Sécurité et confidentialité](https://nautilo.ai/docs/security)

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
| [Applications internes](packages/first-party-apps) | Applications créatives intégrées : [Writer](packages/first-party-apps/writer), [Sheets](packages/first-party-apps/spreadsheet), [Slides](packages/first-party-apps/presentation), [Board](packages/first-party-apps/board), [Design](packages/first-party-apps/design), [Video](packages/first-party-apps/video). |

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

[![Soutenez Nautilo sur GitHub Sponsors.](assets/brand/donation-banner.png)](https://github.com/sponsors/agentsea)

[Soutenez Nautilo via agentsea sur GitHub Sponsors](https://github.com/sponsors/agentsea) · Don ponctuel ou mensuel.

[![Merci à la communauté Bankr](https://nautilo.ai/community/bankr-thanks-fr.png)](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3)

L’open source avance grâce aux gens qui se soutiennent. La communauté Bankr a créé un [jeton Nautilo](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3) indépendant et affecté une part de ses frais de transaction au soutien de notre travail. Merci de nous aider à continuer à construire.

Ce jeton communautaire n’est ni émis ni cautionné par Nautilo. Il n’a aucun rôle dans le logiciel et ne confère aucun droit d’accès au produit, de propriété ou de gouvernance.

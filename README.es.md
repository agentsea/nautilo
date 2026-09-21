# Nautilo

<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

El código y la documentación están actualmente en inglés. Damos la bienvenida a los PR de traducción; consulta la [guía para contribuir traducciones](CONTRIBUTING.md#translations-and-localization) (en inglés). Esta página traduce el README; no implica que la interfaz ni la documentación enlazada estén disponibles en español.

<!-- Translation source: README.md; SHA-256: f6e926f3616a846368e6ef24840b4ea15615b72b0d8a1821ef614448bd7d9115 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### La IA se vuelve multijugador.

</div>

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**Tu propio superagente. Tu gente y sus Genies. La inteligencia es tuya.**

Conoce a tu Genie. Dale personalidad, memoria, cara y voz. Escribid, investigad y cread juntos. Reúne a tu gente y a sus Genies en la misma Room. Tu servidor. Tus modelos. Tus reglas. Código abierto. Licencia MIT.

<a id="get-started"></a>

## Primeros pasos

**Tu primer Nautilo. De un servidor vacío a algo que habéis creado juntos.**

[![Elias y Lyra trabajan juntos en Writer, con cambios listos para revisar. Abre la guía ilustrada de instalación local.](https://nautilo.ai/docs/operator/first-nautilo/writer-review.png)](https://nautilo.ai/docs/operator/deploy/local)

### [Pruébalo en local en tu Mac →](https://nautilo.ai/docs/operator/deploy/local)

Conoce a tu Genie, hazla tuya y cread vuestro primer documento juntos. Sigue la guía ilustrada (en inglés).

Necesitarás **Docker Desktop** y **una clave API de un proveedor de modelos**. Nautilo está en **alpha**.

**Para tu equipo:** [Despliega en tu centro de datos o en un VPS →](https://nautilo.ai/docs/operator/deploy/linux-server)

**¿Ya tienes un servidor?** [Descargar Desktop para Mac →](https://nautilo.ai/download/mac) · [Descargar Mobile →](https://nautilo.ai/download#download-platforms-title)

## Trae a tu gente. Y a sus Genies.

Reúne a tu gente y a sus Genies en la misma Room. Desmontad una idea, escribid el primer borrador, mandad a una Genie a investigar la pieza que falta. Dale a la tuya una personalidad con la que te apetezca pasar tiempo.

Luego toma los mandos. Reescribe el párrafo. Mueve el texto. No deberías necesitar un prompt mejor para mover una palabra unos centímetros a la izquierda.

Y quédate con las llaves de tu casa. Tú eliges los modelos, gestionas el servidor y decides quién tiene acceso. Compartir una Room no debería significar entregar tu vida entera.

[Modelos y claves API](https://nautilo.ai/docs/operator/provider-keys) · [Seguridad y privacidad](https://nautilo.ai/docs/security)

## Encuentra lo que necesitas

| Guía | Para qué sirve |
| --- | --- |
| [Documentación](https://nautilo.ai/docs) | Encontrar el recorrido para usuarios, operadores o desarrolladores. |
| [Usar Nautilo](https://nautilo.ai/docs/use) | Aprender sobre Rooms, Genies, herramientas creativas y flujos de trabajo cotidianos. |
| [Operar Nautilo](https://nautilo.ai/docs/operator) | Desplegar, configurar, administrar y mantener un servidor. |
| [Desarrollar sobre Nautilo](https://nautilo.ai/docs/build) | Entender la arquitectura y desarrollar a partir del código fuente. |
| [Paquete de habilidades](https://nautilo.ai/skills) | Encontrar orientación sobre Nautilo para asistentes de IA. |
| [Principios de diseño](https://nautilo.ai/principles) | Entender las decisiones que dan forma al producto. |
| [Índice de documentación versionada](DOCS.md) | Encontrar contratos del código fuente, empaquetado, versiones y procedimientos de operaciones. |

<a id="explore-the-code"></a>

## Explora el código

Este monorepo contiene las aplicaciones y los paquetes compartidos que hacen funcionar Nautilo. Sigue los enlaces hasta la parte que quieras entender o modificar.

### Aplicaciones

| Aplicación | Función |
| --- | --- |
| [Workbench](apps/workbench) | La interfaz web compartida, también utilizada dentro de Desktop. |
| [Desktop](apps/desktop/README.md) | Cliente Electron, integración con el equipo local y empaquetado. |
| [Mobile](apps/mobile/README.md) | El cliente móvil de React Native / Expo. |
| [CLI](apps/cli/README.md) | Despliegue y administración de servidores desde el terminal. |
| [Aplicaciones propias](packages/first-party-apps) | Aplicaciones creativas incluidas: [Writer](packages/first-party-apps/writer), [Sheets](packages/first-party-apps/spreadsheet), [Slides](packages/first-party-apps/presentation), [Board](packages/first-party-apps/board), [Design](packages/first-party-apps/design), [Video](packages/first-party-apps/video). |

### Paquetes principales

| Paquete | Contenido |
| --- | --- |
| [Agent](packages/agent) | Grafos de agentes, prompts, proveedores de modelos y [herramientas integradas](packages/agent/src/tools/register-all.ts). |
| [Runtime](packages/runtime) | Coordinación de conversaciones, ejecución de tareas, trabajos, sesiones y eventos. |
| [Server](packages/server) | API HTTP y WebSocket de Fastify para los clientes. |
| [Database](packages/db) | Esquema Drizzle, migraciones y persistencia. |
| [Reflection](packages/reflection) / [Reflection bridge](packages/reflection-bridge) | Reflexión sobre la memoria y su integración con Nautilo. |
| [Lattice bridge](packages/lattice-bridge) / [Lattice crypto](packages/lattice-crypto) | Integración de memoria cifrada y primitivas criptográficas. |
| [Trust](packages/trust) / [Security](packages/security) | Identidad, capacidades, política de herramientas y controles de seguridad de las acciones. |
| [Relay](packages/relay) / [Computer Use Host](packages/computer-use-host) | Ejecución en equipos conectados y automatización del escritorio. |
| [Tool catalog](packages/catalog) / [MCP client](packages/mcp-client) | Descubrimiento y registro de herramientas, y conexiones MCP. |
| [API client](packages/api-client) / [Realtime client](packages/realtime-client) | Capas de transporte compartidas entre clientes. |
| [Types](packages/types) / [Workbench components](packages/workbench-components) | Contratos compartidos y componentes de interfaz. |

Para despliegue y mantenimiento, consulta [deploy](deploy/README.md), [el controlador de Compose](deploy/compose-driver/README.md), [packaging](packaging) y [operations](ops/README.md). El [puente de aplicaciones](docs/genie-application-bridge.md) explica cómo interactúan las Genies con las interfaces de las aplicaciones.

<a id="develop-from-source"></a>

## Desarrollar desde el código fuente

El repositorio fija **Bun 1.3.11** y **Node 24.x**. Instala Docker para la infraestructura local de PostgreSQL y Logto. La preparación de Desktop también puede necesitar Rust para su componente auxiliar nativo.

```bash
git clone https://github.com/agentsea/nautilo.git
cd nautilo
bun install --frozen-lockfile
bun run dev-stack --instance my-nautilo-dev
```

Elige un nombre de instancia que no esté en uso para crear un entorno nuevo. Mantén ese terminal abierto y sigue la [guía de desarrollo desde el código fuente](https://nautilo.ai/docs/build/development/local-development) para reclamar la instancia, configurar un modelo y conectar un cliente. La guía también cubre instancias existentes, clones aislados y perfiles de Desktop.

Antes de enviar un cambio de código, ejecuta las comprobaciones adecuadas. Las comprobaciones estándar del repositorio son:

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run lint:unused
```

Consulta la [guía de pruebas](https://nautilo.ai/docs/build/development/testing) para las comprobaciones específicas y los requisitos de integración. Los asistentes de programación deben leer [AGENTS.md](AGENTS.md) y [README.ai](README.ai) antes de editar.

## Ayuda a construirlo

Queda muchísimo por inventar. Trae eso que entiendes mejor que nadie: el flujo de trabajo horrible con el que llevas años peleándote, el detalle de diseño que no deja de molestarte, el bug que te negaste a abandonar. Queremos ese criterio en el proyecto.

Las pequeñas correcciones son bienvenidas. Para cambios mayores, empieza por el problema y acordad el diseño antes de construir. Una montaña de código generado no aclarará una idea confusa. Entender bien el problema nos da una dirección.

Lee la [guía de contribución](CONTRIBUTING.md), explora los [problemas seleccionados](https://nautilo.ai/community/problems) o busca [ayuda y soporte](https://nautilo.ai/community/support). Informa de las vulnerabilidades en privado siguiendo [SECURITY.md](SECURITY.md).

## Licencia

Nautilo tiene [licencia MIT](LICENSE). Consulta los [avisos de terceros](THIRD_PARTY_NOTICES.md) para las licencias y atribuciones de las dependencias, y la [procedencia de los recursos](ASSET_PROVENANCE.md) para las ilustraciones, los medios generados y los documentos de prueba.

[![Apoya Nautilo en GitHub Sponsors.](assets/brand/donation-banner.png)](https://github.com/sponsors/agentsea)

[Apoya Nautilo a través de agentsea en GitHub Sponsors](https://github.com/sponsors/agentsea) · Aportación única o mensual.

### Gracias a la comunidad Bankr

El código abierto avanza cuando la gente se apoya. La comunidad Bankr creó un [token Nautilo](https://hoodscan.co/token/0xddd4947010496b500abe96ab0965c38584413ba3) independiente y destinó parte de sus comisiones de negociación a apoyar nuestro trabajo. Gracias por ayudarnos a seguir construyendo.

Es un token de la comunidad, no emitido ni respaldado por Nautilo. No tiene ninguna función en el software ni otorga derechos de acceso al producto, de propiedad o de gobernanza.

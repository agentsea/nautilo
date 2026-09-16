# Nautilo

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [한국어](README.ko.md)

El código y la documentación están actualmente en inglés. Damos la bienvenida a los PR de traducción; consulta la [guía para contribuir traducciones](CONTRIBUTING.md#translations-and-localization) (en inglés). Esta página traduce el README; no implica que la interfaz ni la documentación enlazada estén disponibles en español.

<!-- Translation source: README.md; SHA-256: 9b60bbbe2574e6ca26450ce9087884705ee319256bc1591e9a256f3db66971c4 -->
<!-- Review status: AI-assisted translation; fluent-speaker review pending. -->

### La IA se vuelve multijugador.

https://github.com/user-attachments/assets/79a6c37f-ea01-4e95-afd5-85d4b9b55e0d

**Tu propio superagente. Tu gente y sus Genies. La inteligencia es tuya.**

Conoce a tu Genie: un agente que puedes personalizar a fondo, con la personalidad, la memoria, la cara y la voz que tú elijas. Ponla a escribir, investigar, navegar, coordinar agentes de programación o hacer una película. Trae a tus amigos, a tu equipo y a sus Genies a la misma Room. Trabajad juntos. Toma los mandos cuando quieras hacerlo tú.

Eso es Nautilo. Multiusuario desde el principio. Hecho para personas y compañeros de silicio. Escritorio, móvil y web. Tu servidor, tus modelos, tus reglas. Código abierto. Licencia MIT.

[Web y demos](https://nautilo.ai) ·
[Primeros pasos](#get-started) ·
[Documentación](https://nautilo.ai/docs) ·
[Descargar](https://nautilo.ai/download) ·
[Paquetes](#explore-the-code) ·
[Contribuir](CONTRIBUTING.md)

<a id="get-started"></a>

## Primeros pasos

Cada cliente de Nautilo se conecta a un servidor Nautilo. Elige el camino que encaje contigo:

¿Vas a probar Nautilo por primera vez en un Mac? Empieza con el [inicio rápido de despliegue local](https://nautilo.ai/docs/operator/deploy/local). Es una configuración para evaluar Nautilo en un solo equipo. Para acceder desde el móvil o dar acceso a tu equipo, elige una de las opciones de alojamiento de abajo.

| Quieres… | Empieza aquí |
| --- | --- |
| Unirte a un servidor existente | [Descarga Nautilo](https://nautilo.ai/download) y sigue la guía de [instalación y conexión](https://nautilo.ai/docs/use/install-and-connect) con la dirección de tu servidor o una invitación. |
| Ejecutar tu primer servidor en tu Mac | Sigue el [inicio rápido de despliegue local](https://nautilo.ai/docs/operator/deploy/local), con Docker Desktop y la CLI firmada de Nautilo. |
| Darle a tu equipo un servidor en la nube | Usa la [guía de despliegue en Railway](https://nautilo.ai/docs/operator/deploy/railway). |
| Ejecutarlo en tu propia infraestructura Docker | Sigue la [guía de Docker Compose](https://nautilo.ai/docs/operator/deploy/docker-compose) o [compara las opciones de despliegue](https://nautilo.ai/docs/operator/choose-a-deployment). |
| Modificar el código | Ve a [Desarrollar desde el código fuente](#develop-from-source). |

La página de descarga incluye las opciones actuales de Desktop, móvil y CLI. También puedes abrir el cliente web de tu servidor. Desktop se conecta a tu servidor; instalarlo no instala el servidor ni su base de datos. El móvil necesita un servidor accesible por HTTPS.

En un servidor nuevo, completa la configuración del propietario y [añade las claves de tus proveedores](https://nautilo.ai/docs/operator/provider-keys). Después personaliza tu Genie, abre una Room y trae algo que de verdad quieras hacer. [Tu primera hora](https://nautilo.ai/docs/use/first-hour) te guía para crear un documento juntos, editarlo tú y guardar el resultado.

Nautilo está en **alpha**.

## Trae a tu gente. Y a sus Genies.

Personas y sus Genies, trabajando en la misma Room. Hablad con naturalidad. Smart Routing incorpora a la Genie adecuada a la conversación; dirígete a alguien directamente cuando quieras su atención. Comparte un documento. Desmonta una idea. Construid algo mejor juntos.

Envía a tu Genie a buscar la respuesta de alguien, delega una tarea en segundo plano o programa trabajo para más tarde. Sigue avanzando mientras ella trabaja.

## A veces quieres hacerlo tú, qué demonios

Reescribe el párrafo. Mueve el texto. Toma el control del terminal. Tu Genie y tú trabajáis sobre lo mismo, cediéndoos los mandos según lo pida el trabajo.

No deberías necesitar un prompt mejor para mover una palabra unos centímetros a la izquierda.

## Dale algo que merezca la pena hacer

Da forma a su personalidad. Elige su cara, su voz y sus modelos. Dale herramientas y ponla a trabajar: investigar en la web, coordinar agentes de programación, crear imágenes, vídeo y música. Conecta servicios y herramientas MCP para ampliar lo que puede hacer.

La memoria da continuidad a vuestro trabajo. Los permisos y las aprobaciones te mantienen al mando.

La disponibilidad de las herramientas depende del cliente, del entorno conectado, de los permisos y de los proveedores configurados. El uso de modelos y servicios puede generar cargos de los proveedores; la [guía de claves API](https://nautilo.ai/docs/operator/provider-keys) explica qué permite cada conexión.

Mira los vídeos en [nautilo.ai](https://nautilo.ai), o empieza a hacerlo tú con [Tu primera hora](https://nautilo.ai/docs/use/first-hour).

## Quédate con las llaves de tu casa

Cuanto mejor te conoce tu IA, más importa quién controla esa relación. Tus hábitos de trabajo, tus conversaciones, lo que habéis creado juntos: todo eso ocupa una parte cada vez mayor de tu vida.

Nautilo pone el servidor y su base de datos bajo tu control. Tú decides dónde se ejecuta, qué modelos usa, quién entra y cómo se hacen las copias de seguridad. El código tiene licencia MIT. Léelo. Cámbialo. Construye sobre él.

Compartir un servidor también exige marcar bien los límites. Los Humans y las Genies tienen identidad; las Rooms tienen miembros; la memoria tiene ámbitos; las herramientas tienen permisos y controles de aprobación. Invitar a alguien a una conversación nunca debería significar darle las llaves de todo lo demás.

Los proveedores de modelos y herramientas conectados reciben los datos necesarios para hacer su trabajo. Alojarlo tú mismo te permite elegir esas conexiones; las políticas de datos de cada proveedor siguen aplicándose. Lee la [documentación de seguridad](https://nautilo.ai/docs/security) y la [guía de refuerzo de seguridad del servidor](https://nautilo.ai/docs/operator/security-hardening) al elegir tu configuración.

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
| [Aplicaciones propias](packages/first-party-apps) | Aplicaciones creativas incluidas, como [Writer](packages/first-party-apps/writer) y [Design](packages/first-party-apps/design). |

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

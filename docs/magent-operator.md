# mAgent operator bindings

`NAUTILO_MAGENT_CONFIG_FILE` selects an absolute path to a private operator
configuration file. Existing single-binding configurations continue to work.
To run independent Genie bindings in one server, point it to a manifest:

```json
{
  "version": 1,
  "configFiles": [
    "/path/to/private/first-operator.json",
    "/path/to/private/second-operator.json"
  ]
}
```

The manifest and every configuration must be regular files owned by the server
user, with no group or other permissions and no symlink components. Paths must
be canonical and absolute. Each file must have a private parent directory owned
by the server user. Higher directories must be owned by that user or root and
must prevent group/other writes; root-owned sticky temporary directories are
allowed above the private parent. Each configuration retains the existing operator schema and its
own random capability, operator binding ID, and Unix socket. Socket directories
must also be private and owned by the server user.

Give each binding a distinct external route (origin, receiving provider agent,
and chat). Reusing a binding ID, socket, credential, or route fails startup.
Changing the sender does not make an overlapping receiving route independent.
All configuration files are validated before any binding activates. If socket
startup fails, sockets already opened during that attempt are closed. Server
shutdown closes every binding.

Each socket authenticates only its own capability and fixes its sponsor, Genie,
private Room, and Namespace on the server. Requests cannot select another
identity or route. Status, avatar, receipt, cancellation and publication routes
require that socket's capability. Existing persisted binding and receipt
checks continue to apply independently to each operator configuration.

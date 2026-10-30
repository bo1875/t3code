# Private Connect deployment

This fork is based on T3 Code v0.1.2. It adds a private connection directory to the
existing server and a `t3 connect --server` registration flow. It preserves the
upstream database schema. The directory is stored with T3's other protected
server secrets, not in a managed database.

Install Vite+ following its official instructions, then build from the repository
root:

```sh
vp install
vp env install 26.12.1
vp env exec --node 26.12.1 vp run --filter @t3tools/web build
vp env exec --node 26.12.1 vp run --filter t3 build:exe
```

Do not copy upstream's `.env.example`: that enables its hosted Connect service.
The default source build has no cloud account configuration. Set
`T3CODE_TELEMETRY_ENABLED=false` on the server to disable upstream usage reporting.

The executable is `apps/server/dist-exe/t3`. It needs the built web app under
`client/` alongside it, plus the native runtime dependencies and resource monitor.
The upstream `scripts/build-cli-archive.ts` assembles distributable installations.
For an upgrade on this machine, keep the existing runtime dependencies and
resource monitor from the matching v0.1.2 installation, and replace only the
executable and client directory in a new installation directory.

Before changing an existing installation, back up its service definition, CLI
symlink, secrets, settings, and a consistent SQLite snapshot. Keep the original
installation for rollback. Test the new executable against an isolated T3 home,
then point the service and CLI symlink at it. Run it with `serve` directly when
you want to manage fork updates yourself; the upstream service launcher can select
an official pinned runtime instead. Preserve the existing T3 home, listener, and
HTTPS proxy configuration.

The directory server is an ordinary T3 server. Pair your browsers to its HTTPS
address and follow [Private Connect setup](../user/remote-access.md#private-connect-in-this-fork)
to register other machines. Protect and back up its secrets directory: it holds
revocable access grants to registered machines. All directory operations require
an authenticated T3 session; changing the directory also requires access and relay
management permissions. Keep HTTPS on connections between machines.

To return to the original installation, restore the old CLI symlink and service
definition, reload the user service manager, and restart T3. No database migration
is introduced by Private Connect.

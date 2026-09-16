import { afterAll, describe, expect, test } from "bun:test";

const enabled = process.env["NAUTILO_REMOTE_FS_OWNER_INTEGRATION"] === "1";
const image = `nautilo-remote-fs-owner-test:${process.pid}`;

async function run(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

afterAll(async () => {
  if (enabled) await run(["docker", "image", "rm", "-f", image]);
});

describe.skipIf(!enabled)("RemoteFs receiver ownership integration", () => {
  test("keeps new and repeated sync entries owned by root and non-root receivers", async () => {
    const built = await run(
      ["docker", "build", "--quiet", "--tag", image, "-"],
      "FROM alpine:3.22\nRUN apk add --no-cache rsync\n",
    );
    expect(built.code, built.stderr).toBe(0);

    const script = String.raw`
set -eu
ifconfig lo up
addgroup -g 1301 receiver
adduser -D -u 1301 -G receiver receiver
mkdir -p /fixture/source/runtime-config /fixture/root-target /fixture/user-target
printf 'SECRET=synthetic\n' > /fixture/source/runtime-config/instance.env
ln -s runtime-config/instance.env /fixture/source/instance.env
chown -R 505:50 /fixture/source
chmod 700 /fixture/source /fixture/source/runtime-config
chmod 600 /fixture/source/runtime-config/instance.env
chown 0:0 /fixture/root-target
chown 1301:1301 /fixture/user-target
cat >/etc/rsyncd.conf <<'EOF'
pid file = /tmp/rsyncd.pid
use chroot = no
[source]
path = /fixture/source
read only = yes
uid = root
gid = root
EOF
rsync --daemon --no-detach --config=/etc/rsyncd.conf >/tmp/rsyncd.log 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true' EXIT
ready=false
for _ in 1 2 3 4 5; do
  if rsync rsync://127.0.0.1/ >/dev/null 2>&1; then ready=true; break; fi
done
test "$ready" = true

assert_target() {
  target="$1" expected="$2"
  test "$(stat -c %u:%g "$target")" = "$expected"
  test "$(stat -c %u:%g "$target/runtime-config")" = "$expected"
  test "$(stat -c %u:%g "$target/runtime-config/instance.env")" = "$expected"
  test "$(stat -c %a "$target/runtime-config/instance.env")" = 600
  test "$(readlink "$target/instance.env")" = runtime-config/instance.env
}

rsync -az --no-owner --no-group --delete rsync://127.0.0.1/source/ /fixture/root-target/
assert_target /fixture/root-target 0:0
rsync -az --no-owner --no-group --delete rsync://127.0.0.1/source/ /fixture/root-target/
assert_target /fixture/root-target 0:0

su receiver -s /bin/sh -c 'rsync -az --no-owner --no-group --delete rsync://127.0.0.1/source/ /fixture/user-target/'
assert_target /fixture/user-target 1301:1301
su receiver -s /bin/sh -c 'rsync -az --no-owner --no-group --delete rsync://127.0.0.1/source/ /fixture/user-target/'
assert_target /fixture/user-target 1301:1301
`;
    const checked = await run([
      "docker", "run", "--rm", "--network", "none", "--cap-add", "NET_ADMIN", image, "sh", "-c", script,
    ]);
    expect(checked.code, checked.stderr).toBe(0);
  }, 120_000);
});
